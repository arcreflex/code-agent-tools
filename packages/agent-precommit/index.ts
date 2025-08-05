#!/usr/bin/env node

// Inspired by https://gist.github.com/huntcsg/c4fe3acf4f7d2fe1ca16e5518a27a23e
// via https://x.com/xlatentspace

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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

/**
 * Get the current git status and staged diff.
 */
function getGitContext(): [string, string] {
  const gitStatus = execSync("git status --porcelain", { encoding: "utf8" });
  const stagedDiff = execSync("git diff --staged", { encoding: "utf8" });
  return [gitStatus, stagedDiff];
}

/**
 * Find the path path relative to either {repo root}/.agent-precommit or {home dir}/.agent-precommit
 * If the file exists in both locations, the repo path is preferred.
 */
function resolveDataPath(rel: string): string {
  const repoPath = path.join(process.cwd(), ".agent-precommit", rel);
  if (fs.existsSync(repoPath)) {
    return repoPath;
  }
  return path.join(os.homedir(), ".agent-precommit", rel);
}

function getSystemPrompt(): string {
  const filepath = resolveDataPath("system-prompt.md");

  let systemPrompt;
  if (fs.existsSync(filepath)) {
    systemPrompt = fs.readFileSync(filepath, "utf8");
  } else {
    const defaultPath = path.join(__dirname, "default-system-prompt.md");
    if (!fs.existsSync(defaultPath)) {
      throw new Error(`Default system prompt not found: ${defaultPath}`);
    }
    systemPrompt = fs.readFileSync(defaultPath, "utf8");
  }

  return systemPrompt;
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
      { role: "system", content: getSystemPrompt() },
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

function saveReview(
  objective: string | undefined,
  gitStatus: string,
  diff: string,
  result: ReviewResult,
): void {
  const reviewsDir = resolveDataPath("reviews");

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

async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      objective: {
        type: "string",
        short: "m",
      },
    },
  });

  loadEnvFile(".env");

  const objective = args.values.objective;

  const [gitStatus, diff] = getGitContext();

  if (!diff.trim()) {
    console.log("No changes to review");
    process.exit(0);
  }

  const result = await requestReview(objective, gitStatus, diff);

  saveReview(objective, gitStatus, diff, result);

  // Majority wins
  const status = result.pass ? "PASSED" : "FAILED";
  console.log(status);

  if (result.feedback.trim()) {
    console.log(`Feedback:\n${result.feedback}`);
  }

  process.exit(result.pass ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Unhandled error`);
    console.error(error);
    process.exit(2);
  });
}
