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

interface Messages {
  system: string;
  user: string;
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
      preview: {
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
  } else if (command === "show-review") {
    try {
      await showReview(args.positionals[1]);
      process.exit(0);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(errorMessage));
      process.exit(1);
    }
  } else {
    const result = await review(args.values);
    if (result.kind === "skipped" || result.kind === "no-changes" || result.kind === "preview-shown") {
      process.exit(0);
    } else if (result.kind === "review-done" && !result.pass) {
      process.exit(1);
    }
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

async function review(args: {
  objective?: string;
  "sandbox-only": boolean;
  "project-context"?: string[];
  preview?: boolean;
}): Promise<
  { kind: "skipped" } | { kind: "no-changes" } | { kind: "preview-shown" } | { kind: "review-done"; pass: boolean }
> {
  if (args["sandbox-only"] && !fs.existsSync(`/.agent-sandbox`)) {
    console.log(chalk.yellow(`Skipping agent-precommit review because /.agent-sandbox doesn't exist`));
    return { kind: "skipped" };
  }

  const [gitStatus, diff] = await getGitContext();

  if (!diff.trim()) {
    console.log("No changes to review");
    return { kind: "no-changes" };
  }

  const projectContext = await getProjectContext(args["project-context"]);

  // Handle preview mode
  if (args.preview) {
    await showPreview(args.objective, gitStatus, diff, projectContext);
    return { kind: "preview-shown" };
  }

  const result = await spinner(chalk.blue(`Requesting review...`), () =>
    requestReview(args.objective, gitStatus, diff, projectContext),
  );

  // Get user context for saving in review data
  const userContext = await getUserContext();
  const reviewData: ReviewData = {
    timestamp: new Date().toISOString(),
    objective: args.objective,
    userContext: userContext?.message,
    projectContext,
    gitStatus,
    gitDiff: diff,
    review: result,
  };
  await saveReview(reviewData);
  renderReview(reviewData);

  if (result.pass) {
    // Clear user context after successful review to prevent staleness
    await clearUserContext();
  }

  return { kind: "review-done", pass: result.pass };
}

/**
 * Build the messages that will be sent to the model provider API
 */
async function buildMessages(
  objective: string | undefined,
  gitStatus: string,
  diff: string,
  projectContext?: string,
): Promise<Messages> {
  const systemPrompt = await getSystemPrompt(projectContext);

  const userMessage = `${objective ? `OBJECTIVE:\n${objective}\n\n` : ""}GIT STATUS:
${gitStatus}

DIFF TO REVIEW:
${diff}

Review this diff, and be uncompromising about quality standards.`;

  return { system: systemPrompt, user: userMessage };
}

/**
 * Display a preview of what would be sent to the model provider API
 */
async function showPreview(
  objective: string | undefined,
  gitStatus: string,
  diff: string,
  projectContext?: string,
): Promise<void> {
  console.log(chalk.blue("=== PREVIEW MODE ==="));
  console.log(chalk.gray("The following messages would be sent to the model provider API:\n"));

  const messages = await buildMessages(objective, gitStatus, diff, projectContext);

  console.log(chalk.cyan("=== SYSTEM MESSAGE ==="));
  console.log(messages.system);

  console.log(chalk.cyan("\n=== USER MESSAGE ==="));
  console.log(messages.user);

  console.log(chalk.gray("\n=== END PREVIEW ==="));
  console.log(chalk.gray("No API call was made. Exit code: 0"));
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
  const omittedFiles: string[] = [];

  for (const filePath of contextFiles) {
    try {
      const fullPath = path.join(rootPath, filePath);
      const content = await fs.promises.readFile(fullPath, "utf8");
      const section = `## ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
      const sectionBytes = Buffer.byteLength(section, "utf8");

      if (totalBytes + sectionBytes > MAX_CONTEXT_BYTES) {
        // Skip this file and add a placeholder
        const placeholder = `## ${filePath}\n\n\`\`\`\n[OMITTED: Including this file would exceed the context byte limit]\n\`\`\``;
        const placeholderBytes = Buffer.byteLength(placeholder, "utf8");

        // Only add placeholder if it fits
        if (totalBytes + placeholderBytes <= MAX_CONTEXT_BYTES) {
          contextSections.push(placeholder);
          totalBytes += placeholderBytes;
        }
        omittedFiles.push(filePath);
        // Continue to try other files that might fit
        continue;
      }

      contextSections.push(section);
      totalBytes += sectionBytes;
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

  let result = `CODEBASE CONTEXT:\n\n${contextSections.join("\n\n")}`;

  if (omittedFiles.length > 0) {
    result += `\n\n[NOTE: The following files were omitted because including them would exceed the ${MAX_CONTEXT_BYTES} byte context limit: ${omittedFiles.join(", ")}]`;
  }

  result += "\n\n";

  return result;
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

  const messages = await buildMessages(objective, gitStatus, diff, projectContext);

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
      { role: "developer", content: messages.system },
      { role: "user", content: messages.user },
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

async function saveReview(reviewData: ReviewData): Promise<void> {
  const reviewsDir = path.join(await getDataDir(), "reviews");
  if (!fs.existsSync(reviewsDir)) {
    fs.mkdirSync(reviewsDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const filename = `review_${timestamp}.json`;
  const reviewFile = path.join(reviewsDir, filename);
  fs.writeFileSync(reviewFile, JSON.stringify(reviewData, null, 2));
}

function isValidReviewData(data: unknown): data is ReviewData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;

  // Check required fields
  if (typeof d.timestamp !== "string") return false;
  // Validate strict ISO 8601 timestamp format
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
  if (!iso8601Regex.test(d.timestamp) || new Date(d.timestamp).toString() === "Invalid Date") return false;
  if (typeof d.gitStatus !== "string") return false;
  if (typeof d.gitDiff !== "string") return false;

  // Check optional fields
  if (d.objective !== undefined && typeof d.objective !== "string") return false;
  if (d.userContext !== undefined && typeof d.userContext !== "string") return false;
  if (d.projectContext !== undefined && typeof d.projectContext !== "string") return false;

  // Check review object
  if (!d.review || typeof d.review !== "object") return false;
  const review = d.review as Record<string, unknown>;
  if (typeof review.pass !== "boolean") return false;
  if (typeof review.feedback !== "string") return false;

  return true;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.promises
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function resolveLatestReviewFile(reviewsDir: string): Promise<string> {
  const dirEntries = await fs.promises.readdir(reviewsDir, { withFileTypes: true });
  const reviewFiles = dirEntries
    .filter((entry) => entry.isFile() && entry.name.match(/^review_.*\.json$/))
    .map((entry) => entry.name);

  if (reviewFiles.length === 0) {
    throw new Error("No reviews found.");
  }

  // Read and validate all review files, collecting valid ones with their timestamps
  const validReviews: Array<{ filename: string; timestamp: Date }> = [];

  for (const file of reviewFiles) {
    try {
      const filePath = path.join(reviewsDir, file);
      const content = await fs.promises.readFile(filePath, "utf8");
      const data = JSON.parse(content);

      if (isValidReviewData(data)) {
        validReviews.push({
          filename: file,
          timestamp: new Date(data.timestamp),
        });
      } else {
        console.warn(chalk.yellow(`Warning: Skipping invalid review file: ${file}`));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(chalk.yellow(`Warning: Skipping unreadable review file ${file}: ${errorMessage}`));
    }
  }

  if (validReviews.length === 0) {
    throw new Error("No valid reviews found.");
  }

  // Sort by timestamp and get the latest
  validReviews.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return path.join(reviewsDir, validReviews[validReviews.length - 1].filename);
}

async function readAndValidateReview(reviewFile: string): Promise<ReviewData> {
  const content = await fs.promises.readFile(reviewFile, "utf8");
  const rawData = JSON.parse(content);

  if (!isValidReviewData(rawData)) {
    throw new Error("Invalid review file format. The file may be corrupted or from an incompatible version.");
  }

  return rawData;
}

function renderReview(reviewData: ReviewData): void {
  const feedback = reviewData.review.feedback || "";
  if (reviewData.review.pass) {
    console.log(chalk.green(`✓ PASSED`));
  } else {
    console.log(chalk.red("✗ FAILED"));
  }

  if (feedback.trim()) {
    console.log(chalk.blue(`=== FEEDBACK ===`));
    console.log(feedback);
  }

  console.log(
    `\nPlease address any valid points in the feedback above.

If you feel the reviewer might be missing important context, you can ask the human user
to provide additional context with "agent-precommit context <message>" and then resubmit
your changes.`,
  );
}

async function showReview(filename?: string): Promise<void> {
  const reviewsDir = path.join(await getDataDir(), "reviews");

  if (!(await pathExists(reviewsDir))) {
    console.log(chalk.yellow("No reviews found. The reviews directory does not exist."));
    return;
  }

  let reviewFile: string;
  let reviewFilename: string;

  if (filename) {
    if (path.basename(filename) !== filename) {
      reviewFile = path.resolve(filename);
      if (!reviewFile.startsWith(reviewsDir)) {
        throw new Error("Invalid filename. Path traversal not allowed.");
      }
    } else {
      reviewFile = path.join(reviewsDir, filename);
    }

    reviewFilename = path.basename(reviewFile);

    if (!(await pathExists(reviewFile))) {
      throw new Error(`Review file "${filename}" not found.`);
    }
  } else {
    // Show the last review
    reviewFile = await resolveLatestReviewFile(reviewsDir);
    reviewFilename = path.basename(reviewFile);
  }

  const reviewData = await readAndValidateReview(reviewFile);
  console.error(chalk.gray(`File: ${reviewFilename}`));
  console.error(chalk.gray(`Timestamp: ${reviewData.timestamp}`));
  renderReview(reviewData);
}

main().catch((error) => {
  console.error(`Unhandled error`);
  console.error(error);
  process.exit(2);
});
