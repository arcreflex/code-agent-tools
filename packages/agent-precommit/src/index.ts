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
  git_status: string;
  diff: string;
  review: ReviewResult;
}

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
    },
  });

  for (const env of [path.join(await getDataDir(), ".env"), ".env"]) {
    if (fs.existsSync(env)) {
      loadEnvFile(env);
    }
  }

  if (args.positionals[0] === "init") {
    await init({ force: args.values.force });
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

  await saveReview(args.objective, gitStatus, diff, result);

  console.log(result.pass ? chalk.green("✅ PASSED") : chalk.red("❌ FAILED"));

  if (result.feedback.trim()) {
    console.log(`Feedback:\n${result.feedback}`);
  }

  if (!result.pass) {
    process.exitCode = 1;
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

  const userMessage = `${objective ? `OBJECTIVE:\n${objective}\n\n` : ""}
${extraContext}
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
