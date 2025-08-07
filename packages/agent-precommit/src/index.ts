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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ReviewResult {
  feedback: string;
  pass: boolean;
}

interface ReviewData {
  timestamp: string;
  objective: string | undefined;
  user_context: string | undefined;
  git_status: string;
  diff: string;
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
      console.log(
        chalk.yellow("Force removing existing .agent-sandbox directory"),
      );
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
  console.log(chalk.yellow(`Initialized agent-precommit in ${dataDir}`));

  const command = process.argv.slice(0, process.argv.indexOf("init")).join(" ");
  console.log(
    chalk.yellow(`Set environment variables in ${dataDir}/.env and add:`),
  );
  console.log(chalk.white(command));
  console.log(chalk.yellow(`to your precommit hook`));
}

async function review(args: { objective?: string; "sandbox-only": boolean }) {
  if (args["sandbox-only"] && !fs.existsSync(`/.agent-sandbox`)) {
    console.log(
      chalk.yellow(
        `Skipping agent-precommit review because /.agent-sandbox doesn't exist`,
      ),
    );
    return;
  }

  const [gitStatus, diff] = await getGitContext();

  if (!diff.trim()) {
    console.log("No changes to review");
    process.exit(0);
  }

  const result = await spinner(chalk.blue(`Requesting review...`), () =>
    requestReview(args.objective, gitStatus, diff),
  );

  // Get user context for saving in review data
  const userContext = await getUserContext();
  await saveReview(
    args.objective,
    gitStatus,
    diff,
    result,
    userContext?.message,
  );

  console.log(result.pass ? chalk.green("✅ PASSED") : chalk.red("❌ FAILED"));

  if (result.feedback.trim()) {
    console.log(`Feedback:\n${result.feedback}`);
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

async function handleContext(
  args: string[],
  options: { clear?: boolean; show?: boolean },
): Promise<void> {
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
      const age = Math.floor(
        (Date.now() - new Date(context.timestamp).getTime()) / 1000 / 60,
      );
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
    console.error(
      chalk.red("Cannot set user context from within agent-sandbox."),
    );
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

async function getSystemPrompt(): Promise<string> {
  const filepath = path.join(await getDataDir(), "system-prompt.md");
  return fs.readFileSync(filepath, "utf8");
}

async function requestReview(
  objective: string | undefined,
  gitStatus: string,
  diff: string,
): Promise<ReviewResult> {
  const apiKey = process.env.AGENT_PRECOMMIT_OPENAI_KEY;
  if (!apiKey) {
    throw new Error(
      "Error: AGENT_PRECOMMIT_OPENAI_KEY environment variable not set",
    );
  }

  const baseURL =
    process.env.AGENT_PRECOMMIT_OPENAI_BASE_URL || "https://api.openai.com/v1";

  const openai = new OpenAI({
    apiKey,
    baseURL,
  });

  const extraContextFile = process.env.AGENT_PRECOMMIT_EXTRA_CONTEXT_FILE;
  let extraContext = "";
  if (extraContextFile && fs.existsSync(extraContextFile)) {
    extraContext = `CONTEXT:\n${fs.readFileSync(extraContextFile, "utf8")}\n\n`;
  }

  const userContext = await getUserContext();
  let userContextString = "";
  if (userContext) {
    userContextString = `USER PROVIDED CONTEXT (AUTHORITATIVE):\n${userContext.message}\n\n`;
  }

  const userMessage = `${objective ? `OBJECTIVE:\n${objective}\n\n` : ""}
${userContextString}${extraContext}
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
        description:
          "Provide structured review feedback with pass/fail determination",
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

  const response = await openai.chat.completions.create({
    model: process.env.AGENT_PRECOMMIT_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: await getSystemPrompt() },
      { role: "user", content: userMessage },
    ],
    temperature: 1,
    tools,
    tool_choice: {
      type: "function",
      function: { name: "provide_review_feedback" },
    },
    max_tokens: 1000,
  });

  const choice = response.choices[0];
  if (!choice) {
    throw new Error("Error: No choices returned from OpenAI");
  }

  const toolCall = choice.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    throw new Error(
      "Error: OpenAI did not return expected function call response",
    );
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
    user_context: userContext,
    git_status: gitStatus,
    diff,
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
