import { promises as fs } from "node:fs";

import OpenAI from "openai";

import type { FinalReview, ReviewRequest } from "./types.ts";
import { getSystemPromptPaths } from "./paths.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface ReviewExecutionOptions {
  readonly repoRoot: string;
  readonly request: ReviewRequest;
}

export interface PreviewEnvelope {
  readonly model: string;
  readonly baseURL: string;
  readonly extraParams: Record<string, unknown>;
  readonly toolSchema: string;
}

export async function executeReview(options: ReviewExecutionOptions): Promise<FinalReview> {
  const { repoRoot, request } = options;
  const systemPrompt = await loadSystemPrompt(repoRoot);
  const client = new OpenAI({
    apiKey: process.env.AI_REVIEW_OPENAI_KEY ?? process.env.AGENT_PRECOMMIT_OPENAI_KEY,
    baseURL: resolveBaseURL(),
  });
  if (!client.apiKey) {
    throw new Error("AI_REVIEW_OPENAI_KEY environment variable is required.");
  }
  const model = resolveModel();

  const extraParams = parseExtraParams();

  const messages = buildMessages(systemPrompt, request);

  const response = await client.chat.completions.create({
    model,
    messages,
    tools: [
      {
        type: "function",
        function: {
          name: "finalize_review",
          description: "Return the final review decision",
          parameters: {
            type: "object",
            properties: {
              status: { enum: ["pass", "block"] },
              blockers: {
                type: "array",
                items: {
                  type: "object",
                  required: ["rule", "title", "file", "line_start", "line_end", "why"],
                  properties: {
                    rule: { type: "string" },
                    title: { type: "string" },
                    file: { type: "string" },
                    line_start: { type: "integer" },
                    line_end: { type: "integer" },
                    why: { type: "string" },
                    suggested_fix: { type: "string" },
                  },
                },
              },
              notes: { type: "array", items: { type: "string" } },
            },
            required: ["status", "blockers", "notes"],
          },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: "finalize_review" },
    },
    ...extraParams,
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.find(
    (call) => call?.type === "function" && call.function?.name === "finalize_review",
  );
  if (!toolCall || toolCall.type !== "function" || !toolCall.function) {
    throw new Error("Model response did not call finalize_review");
  }
  const payload = JSON.parse(toolCall.function.arguments ?? "{}");
  return validateFinalReview(payload);
}

export async function previewMessages(
  repoRoot: string,
  request: ReviewRequest,
): Promise<{
  system: string;
  user: string;
  envelope: PreviewEnvelope;
}> {
  const systemPrompt = await loadSystemPrompt(repoRoot);
  const [systemMessage, userMessage] = buildMessages(systemPrompt, request);
  return {
    system: String(systemMessage.content),
    user: String(userMessage.content),
    envelope: getPreviewEnvelope(),
  };
}

function buildMessages(systemPrompt: string, request: ReviewRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const blocks: string[] = [];
  blocks.push("# REVIEW CONTEXT");
  if (request.objective) {
    blocks.push(`Objective: ${request.objective}`);
  }
  if (request.commitMessages.length > 0) {
    blocks.push("Recent commits:");
    for (const message of request.commitMessages) {
      blocks.push(`- ${message}`);
    }
  }
  blocks.push("", "# DIFF");
  blocks.push(request.diff);
  if (request.contextFiles.length > 0) {
    blocks.push("", "# CODEBASE CONTEXT");
    for (const file of request.contextFiles) {
      blocks.push(`## ${file.path}`);
      blocks.push(file.content);
    }
  }
  if (request.omittedContext.length > 0) {
    blocks.push("", "# OMITTED CONTEXT (file paths)");
    for (const file of request.omittedContext) {
      blocks.push(`- ${file}`);
    }
  }
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: blocks.join("\n") },
  ];
}

async function loadSystemPrompt(repoRoot: string): Promise<string> {
  const candidates = getSystemPromptPaths(repoRoot);
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to load system prompt. Run ai-review init first.");
}

function resolveBaseURL(): string {
  return process.env.AI_REVIEW_OPENAI_BASE_URL ?? process.env.AGENT_PRECOMMIT_OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
}

function resolveModel(): string {
  const model = process.env.AI_REVIEW_MODEL ?? process.env.AGENT_PRECOMMIT_MODEL;
  if (!model) {
    throw new Error("AI_REVIEW_MODEL environment variable is required.");
  }
  return model;
}

export function getPreviewEnvelope(): PreviewEnvelope {
  const extraParams = parseExtraParams();
  const model = process.env.AI_REVIEW_MODEL ?? process.env.AGENT_PRECOMMIT_MODEL ?? "(unset)";
  return {
    model,
    baseURL: resolveBaseURL(),
    extraParams,
    toolSchema: "finalize_review (required)",
  };
}

function parseExtraParams(): Record<string, unknown> {
  const raw = process.env.AI_REVIEW_EXTRA_PARAMS ?? process.env.AGENT_PRECOMMIT_EXTRA_PARAMS;
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to parse AI_REVIEW_EXTRA_PARAMS: ${(error as Error).message}`);
  }
}

function validateFinalReview(payload: unknown): FinalReview {
  if (!payload || typeof payload !== "object") {
    throw new Error("finalize_review payload is not an object");
  }
  const { status, blockers, notes } = payload as Record<string, unknown>;
  if (status !== "pass" && status !== "block") {
    throw new Error('status must be "pass" or "block"');
  }
  if (!Array.isArray(blockers)) {
    throw new Error("blockers must be an array");
  }
  const parsedBlockers = blockers.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("blocker must be an object");
    }
    const typed = item as Record<string, unknown>;
    const required = ["rule", "title", "file", "line_start", "line_end", "why"];
    for (const key of required) {
      if (!(key in typed)) {
        throw new Error(`blocker missing ${key}`);
      }
    }
    return {
      rule: String(typed.rule),
      title: String(typed.title),
      file: String(typed.file),
      line_start: Number(typed.line_start),
      line_end: Number(typed.line_end),
      why: String(typed.why),
      suggested_fix: typed.suggested_fix ? String(typed.suggested_fix) : undefined,
    };
  });
  const parsedNotes = Array.isArray(notes) ? notes.map((note) => String(note)) : [];
  if (parsedBlockers.length > 0 && status === "pass") {
    throw new Error('status must be "block" when blockers are present');
  }
  return { status, blockers: parsedBlockers, notes: parsedNotes } as FinalReview;
}
