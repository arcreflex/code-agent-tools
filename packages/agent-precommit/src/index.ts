#!/usr/bin/env node

// Inspired by https://gist.github.com/huntcsg/c4fe3acf4f7d2fe1ca16e5518a27a23e
// via https://x.com/xlatentspace

import * as fs from "fs";
import * as path from "path";
import { $, chalk, spinner } from "zx";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { parseArgs } from "util";
import { loadEnvFile } from "process";
import { glob } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ReviewResult {
  feedback: string;
  pass: boolean;
}

interface ReviewData {
  timestamp: string;
  objective: string | undefined;
  userContext: string | undefined;
  projectContext: string | undefined;
  gitStatus: string;
  gitDiff: string;
  review: ReviewResult;
}

interface UserContext {
  message: string;
  timestamp: string;
}

const CONTEXT_FILE = "user-context.json";
const CONTEXT_MAX_AGE_MINUTES = 10;

async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      objective: {
        type: "string",
        short: "m",
      },
      force: {
        type: "boolean",
        default: false,
      },
      "sandbox-only": {
        type: "boolean",
        default: false,
      },
      clear: {
        type: "boolean",
        default: false,
      },
      show: {
        type: "boolean",
        default: false,
      },
      "project-context": {
        type: "string",
        multiple: true,
      },
    },
  });

  for (const env of [path.join(await getDataDir(), ".env"), ".env"]) {
    if (fs.existsSync(env)) {
      loadEnvFile(env);
    }
  }

  const command = args.positionals[0];

  if (command === "init") {
    await init({ force: args.values.force });
  } else if (command === "context") {
    await handleContext(args.positionals.slice(1), args.values);
  } else {
    await review(args.values);
  }
}

async function init(args: { force: boolean }) {
  const dataDir = await getDataDir();
  if (fs.existsSync(dataDir)) {
    if (args.force) {
      console.log(chalk.yellow("Force removing existing .agent-precommit directory"));
      await $`rm -r ${dataDir}`;
    } else {
      console.error(`Error: ${dataDir} directory already exists.`);
      console.error("Remove it first if you want to reinitialize.");
      process.exit(1);
    }
  }

  fs.mkdirSync(dataDir, { recursive: true });
  await $`cp -RL ${path.join(__dirname, "..", "template")}/ ${dataDir}/`;
  await $`mv ${dataDir}/.env.example ${dataDir}/.env`;
  let repoRoot;
  try {
    repoRoot = await $`git rev-parse --show-toplevel`;
  } catch {
    console.error(chalk.yellow("ERROR: not in a git repository"));
    process.exitCode = 1;
    return;
  }

  const gitignorePath = path.join(repoRoot.stdout.trim(), ".gitignore");
  const gitignoreEntries = [".agent-precommit/reviews", ".agent-precommit/user-context.json"];

  let gitignoreContent = "";
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
  }

  const entriesToAdd = gitignoreEntries.filter((entry) => !gitignoreContent.includes(entry));

  if (entriesToAdd.length > 0) {
    const hasAgentPrecommitSection = gitignoreContent.includes("# Agent Precommit");
    const newContent =
      gitignoreContent +
      (gitignoreContent && !gitignoreContent.endsWith("\n") ? "\n" : "") +
      (hasAgentPrecommitSection ? "" : "\n# Agent Precommit\n") +
      entriesToAdd.join("\n") +
      "\n";
    fs.writeFileSync(gitignorePath, newContent);
    console.log(chalk.yellow(`Added ${entriesToAdd.length} entries to .gitignore`));
  }

  console.log(chalk.yellow(`Initialized agent-precommit in ${dataDir}`));

  const command = process.argv.slice(0, process.argv.indexOf("init")).join(" ");
  console.log(chalk.yellow(`Set environment variables in ${dataDir}/.env and add:`));
  console.log(chalk.white(command));
  console.log(chalk.yellow(`to your precommit hook`));
}

async function review(args: { objective?: string; "sandbox-only": boolean; "project-context"?: string[] }) {
  if (args["sandbox-only"] && !fs.existsSync(`/.agent-sandbox`)) {
    console.log(chalk.yellow(`Skipping agent-precommit review because /.agent-sandbox doesn't exist`));
    return;
  }

  const [gitStatus, diff] = await getGitContext();

  if (!diff.trim()) {
    console.log("No changes to review");
    process.exit(0);
  }

  const projectContext = await getProjectContext(args["project-context"]);
  const result = await spinner(chalk.blue(`Requesting review...`), () =>
    requestReview(args.objective, gitStatus, diff, projectContext),
  );

  // Get user context for saving in review data
  const userContext = await getUserContext();
  await saveReview(args.objective, gitStatus, diff, result, userContext?.message, projectContext);

  if (result.feedback.trim()) {
    console.log(result.pass ? chalk.green(`✓ ${result.feedback}`) : chalk.red(`✗ ${result.feedback}`));
  } else {
    console.log(result.pass ? chalk.green("✓ PASSED") : chalk.red("✗ FAILED"));
  }

  if (!result.pass) {
    console.log(
      `\nPlease address any valid points in the feedback above.

If you feel the reviewer might be missing important context, you can ask the human user
to provide additional context with "agent-precommit context <message>" and then resubmit
your changes.`,
    );
  }

  if (!result.pass) {
    process.exitCode = 1;
  } else {
    // Clear user context after successful review to prevent staleness
    await clearUserContext();
  }
}

/**
 * Get the current git status and staged diff.
 */
async function getGitContext(): Promise<[string, string]> {
  const gitStatus = await $`git status --porcelain`;
  const stagedDiff = await $`git diff --staged`;
  return [gitStatus.stdout, stagedDiff.stdout];
}

async function getDataDir(): Promise<string> {
  const repoRoot = await $`git rev-parse --show-toplevel`;
  return path.join(repoRoot.stdout.trim(), ".agent-precommit");
}

async function getProjectContext(globs?: string[]): Promise<string> {
  if (!globs || globs.length === 0) {
    return "";
  }

  const repoRoot = await $`git rev-parse --show-toplevel`;
  const rootPath = repoRoot.stdout.trim();

  const contextFiles: string[] = [];

  for (const pattern of globs) {
    try {
      for await (const entry of glob(pattern, { cwd: rootPath })) {
        contextFiles.push(entry);
      }
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Failed to process glob pattern "${pattern}": ${error}`));
    }
  }

  if (contextFiles.length === 0) {
    return "";
  }

  const MAX_CONTEXT_BYTES = process.env.AGENT_PRECOMMIT_MAX_CONTEXT_BYTES
    ? parseInt(process.env.AGENT_PRECOMMIT_MAX_CONTEXT_BYTES, 10)
    : 200000; // ~200KB limit to avoid overlong prompts

  let totalBytes = 0;
  const contextSections: string[] = [];

  for (const filePath of contextFiles) {
    try {
      const fullPath = path.join(rootPath, filePath);
      const content = await fs.promises.readFile(fullPath, "utf8");
      const section = `## ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;

      if (totalBytes + section.length > MAX_CONTEXT_BYTES) {
        contextSections.push(`## ${filePath}\n\n\`\`\`\n[TRUNCATED: File too large for context]\n\`\`\``);
        console.warn(chalk.yellow(`Warning: Context truncated - ${filePath} too large`));
        break;
      }

      contextSections.push(section);
      totalBytes += section.length;
    } catch (error: unknown) {
      if (
        !(typeof error === "object" && error && "code" in error) ||
        (error.code !== "ENOENT" && error.code !== "EISDIR")
      ) {
        console.warn(chalk.yellow(`Warning: Failed to read context file "${filePath}": ${error}`));
      }
    }
  }

  if (contextSections.length === 0) {
    return "";
  }

  return `CODEBASE CONTEXT:\n\n${contextSections.join("\n\n")}\n\n`;
}

async function handleContext(args: string[], options: { clear?: boolean; show?: boolean }): Promise<void> {
  if (options.clear) {
    await clearUserContext();
    console.log(chalk.green("✓ User context cleared"));
    return;
  }

  if (options.show) {
    const context = await getUserContext();
    if (context) {
      console.log(chalk.blue("Current user context:"));
      console.log(context.message);
      const age = Math.floor((Date.now() - new Date(context.timestamp).getTime()) / 1000 / 60);
      console.log(chalk.gray(`(set ${age} minutes ago)`));
    } else {
      console.log(chalk.yellow("No active user context"));
    }
    return;
  }

  // Join all positional args to handle both quoted and unquoted input:
  // - Quoted: agent-precommit context "multi word message" -> ["multi word message"]
  // - Unquoted: agent-precommit context multi word message -> ["multi", "word", "message"]
  const message = args.join(" ").trim();
  if (!message) {
    console.error(chalk.red("Error: Please provide a context message"));
    console.log("Usage: agent-precommit context <message>");
    console.log("       agent-precommit context --show");
    console.log("       agent-precommit context --clear");
    process.exit(1);
  }

  // Block setting context when running inside agent-sandbox
  if (fs.existsSync("/.agent-sandbox")) {
    console.error(chalk.red("Cannot set user context from within agent-sandbox."));
    console.log("Please ask the human user to set context.");
    process.exit(1);
  }

  await setUserContext(message);
  console.log(chalk.green("✓ User context set:"));
  console.log(message);
}

async function setUserContext(message: string): Promise<void> {
  const dataDir = await getDataDir();
  const contextPath = path.join(dataDir, CONTEXT_FILE);

  const context: UserContext = {
    message,
    timestamp: new Date().toISOString(),
  };

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));
}

async function getUserContext(): Promise<UserContext | null> {
  const dataDir = await getDataDir();
  const contextPath = path.join(dataDir, CONTEXT_FILE);

  if (!fs.existsSync(contextPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(contextPath, "utf8");
    const context: UserContext = JSON.parse(content);

    const age = Date.now() - new Date(context.timestamp).getTime();
    const maxAge = CONTEXT_MAX_AGE_MINUTES * 60 * 1000;

    if (age > maxAge) {
      await clearUserContext();
      return null;
    }

    return context;
  } catch {
    console.error(chalk.yellow("Warning: Failed to read user context"));
    return null;
  }
}

async function clearUserContext(): Promise<void> {
  const dataDir = await getDataDir();
  const contextPath = path.join(dataDir, CONTEXT_FILE);

  if (fs.existsSync(contextPath)) {
    fs.unlinkSync(contextPath);
  }
}

async function getSystemPrompt(projectContext?: string): Promise<string> {
  const filepath = path.join(await getDataDir(), "system-prompt.md");
  let prompt = fs.readFileSync(filepath, "utf8");

  if (projectContext && projectContext.trim()) {
    prompt += `\n\n${projectContext}`;
  }

  const userContext = await getUserContext();
  if (userContext) {
    prompt += `CONTEXT PROVIDED BY PROJECT OWNER (AUTHORITATIVE):\n${userContext.message}\n\n`;
  }

  return prompt;
}

async function requestReview(
  objective: string | undefined,
  gitStatus: string,
  diff: string,
  projectContext?: string,
): Promise<ReviewResult> {
  const apiKey = process.env.AGENT_PRECOMMIT_OPENAI_KEY;
  if (!apiKey) {
    throw new Error("Error: AGENT_PRECOMMIT_OPENAI_KEY environment variable not set");
  }

  const baseURL = process.env.AGENT_PRECOMMIT_OPENAI_BASE_URL || "https://api.openai.com/v1";

  const openai = new OpenAI({
    apiKey,
    baseURL,
  });

  const developerMessage = await getSystemPrompt(projectContext);

  const userMessage = `${objective ? `OBJECTIVE:\n${objective}\n\n` : ""}
GIT STATUS:
${gitStatus}

DIFF TO REVIEW:
${diff}

Review this diff, and be uncompromising about quality standards.`;

  const tools: OpenAI.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "provide_review_feedback",
        description: "Provide structured review feedback with pass/fail determination",
        parameters: {
          type: "object",
          properties: {
            feedback: {
              type: "string",
              description:
                "Brief feedback written in first person as the developer user. For PASS: minimal, no praise. For FAIL: direct actionable advice with prodding language to fix issues.",
            },
            pass: {
              type: "boolean",
              description: "Whether the code changes meet quality standards",
            },
          },
          required: ["feedback", "pass"],
        },
      },
    },
  ];

  const model = process.env.AGENT_PRECOMMIT_MODEL;
  if (!model) {
    throw new Error("Error: AGENT_PRECOMMIT_MODEL environment variable not set");
  }

  const extraParams = process.env.AGENT_PRECOMMIT_EXTRA_PARAMS
    ? JSON.parse(process.env.AGENT_PRECOMMIT_EXTRA_PARAMS)
    : {};

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "developer", content: developerMessage },
      { role: "user", content: userMessage },
    ],
    temperature: 1,
    tools,
    tool_choice: {
      type: "function",
      function: { name: "provide_review_feedback" },
    },
    max_completion_tokens: 10000,
    ...extraParams,
  });

  const choice = response.choices[0];
  if (!choice) {
    throw new Error("Error: No choices returned from OpenAI");
  }

  const toolCall = choice.message?.tool_calls?.[0];
  if (toolCall?.type !== "function" || !toolCall.function.arguments) {
    console.error(JSON.stringify(choice.message));
    throw new Error("Error: OpenAI did not return expected function call response");
  }

  const parsed = JSON.parse(toolCall.function.arguments);
  // The API already enforces the structure of the response, so we can safely assume
  // the parsed result matches the expected type.
  return parsed;
}

async function saveReview(
  objective: string | undefined,
  gitStatus: string,
  diff: string,
  result: ReviewResult,
  userContext?: string,
  projectContext?: string,
): Promise<void> {
  const reviewsDir = path.join(await getDataDir(), "reviews");
  if (!fs.existsSync(reviewsDir)) {
    fs.mkdirSync(reviewsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const filename = `review_${timestamp}.json`;

  const reviewData: ReviewData = {
    timestamp: new Date().toISOString(),
    objective,
    userContext,
    projectContext,
    gitStatus,
    gitDiff: diff,
    review: result,
  };

  const reviewFile = path.join(reviewsDir, filename);
  fs.writeFileSync(reviewFile, JSON.stringify(reviewData, null, 2));
}

main().catch((error) => {
  console.error(`Unhandled error`);
  console.error(error);
  process.exit(2);
});
