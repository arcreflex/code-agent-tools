#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { initAiReview } from "./init.js";
import { ensureDir, getJobsDir, getReviewsDir, resolveRepoRoot } from "./paths.js";
import { prepareReview, createReviewJob } from "./review.js";
import type { ReviewOptions, ReviewRequest } from "./types.js";
import { previewMessages } from "./openai.js";
import { runWorker } from "./worker.js";

const program = new Command();
program.name("ai-review").description("AI-powered code review assistant");

const collect = (value: string, previous: string[]) => {
  previous.push(value);
  return previous;
};

program
  .command("init")
  .description("Initialize .ai-review from the template")
  .option("--force", "Reinitialize while preserving env and data directories", false)
  .action(async (options: { force?: boolean }) => {
    const repoRoot = await resolveRepoRoot();
    await initAiReview(repoRoot, { force: options.force });
    console.log("Initialized .ai-review directory.");
  });

program
  .command("staged")
  .description("Review staged changes")
  .option("--project-context <glob>", "Glob for project context (repeatable)", collect, [] as string[])
  .option("--objective <message>", "Objective for the review")
  .option("--preview", "Preview the messages without sending")
  .option("--dry-run", "Run pipeline without contacting the API")
  .option("--dangerously-allow-secrets", "Redact secrets and continue")
  .action(async (options) => {
    const repoRoot = await resolveRepoRoot();
    await handleReview(repoRoot, "staged", undefined, undefined, normalizeOptions(options));
  });

program
  .command("tail <jobKey>")
  .description("Attach to a running review job")
  .action(async (jobKey: string) => {
    const repoRoot = await resolveRepoRoot();
    await tailJob(repoRoot, jobKey);
  });

program
  .command("show-review [file]")
  .description("Show a saved review (defaults to most recent)")
  .action(async (file?: string) => {
    const repoRoot = await resolveRepoRoot();
    const reviewFile = await resolveReviewFile(repoRoot, file);
    const contents = await fs.readFile(reviewFile, "utf8");
    console.log(contents);
  });

program
  .command("worker <jobKey>")
  .description("Internal worker command")
  .option("--repo <path>", "Repository root")
  .action(async (jobKey: string, options: { repo?: string }) => {
    const repoRoot = options.repo ? path.resolve(options.repo) : await resolveRepoRoot();
    const exit = await runWorker(repoRoot, jobKey);
    process.exit(exit);
  });

program
  .argument("[old]")
  .argument("[new]")
  .option("--project-context <glob>", "Glob for project context (repeatable)", collect, [] as string[])
  .option("--objective <message>", "Objective for the review")
  .option("--preview", "Preview the messages without sending")
  .option("--dry-run", "Run pipeline without contacting the API")
  .option("--dangerously-allow-secrets", "Redact secrets and continue")
  .action(async (oldArg: string | undefined, newArg: string | undefined, options) => {
    const repoRoot = await resolveRepoRoot();
    const oldRevision = oldArg ?? (await defaultOldRevision());
    const newRevision = newArg ?? "HEAD";
    await handleReview(repoRoot, "range", oldRevision, newRevision, normalizeOptions(options));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = (error as { exitCode?: number })?.exitCode ?? 1;
});

async function handleReview(
  repoRoot: string,
  kind: "range" | "staged",
  oldRevision: string | undefined,
  newRevision: string | undefined,
  options: ReviewOptions,
): Promise<void> {
  const { request, matches, omittedContext } = await prepareReview(repoRoot, kind, oldRevision, newRevision, options);
  printSummary(request, omittedContext, matches.length);
  console.log("Note: Reviews may take upwards of 3 minutes to complete.");

  if (options.preview) {
    const preview = await previewMessages(repoRoot, request);
    console.log(JSON.stringify(preview.envelope, null, 2));
    console.log("\n--- SYSTEM PROMPT ---\n");
    console.log(preview.system);
    console.log("\n--- USER MESSAGE ---\n");
    console.log(preview.user);
    return;
  }

  if (options.dryRun) {
    console.log("Dry run complete. No request was sent.");
    return;
  }

  const { job, path: jobPath } = await createReviewJob(repoRoot, request);
  console.log(`Created review job ${job.key} at ${jobPath}`);
  await ensureDir(getJobsDir(repoRoot));
  const exitCode = await spawnWorker(repoRoot, job.key);
  process.exitCode = exitCode;
}

function printSummary(request: ReviewRequest, omittedContext: string[], secretCount: number): void {
  const summary = request.summary;
  console.log("Review request summary:");
  if (request.kind === "range") {
    console.log(`- Range: ${request.oldRevision} -> ${request.newRevision}`);
  } else {
    console.log("- Reviewing staged changes");
  }
  if (request.objective) {
    console.log(`- Objective: ${request.objective}`);
  }
  console.log(`- Diff: ${summary.files} files, +${summary.additions} / -${summary.deletions}, ${summary.bytes} bytes`);
  console.log(`- Context files: ${request.contextFiles.length}`);
  if (omittedContext.length > 0) {
    console.log(`  (omitted: ${omittedContext.join(", ")})`);
  }
  if (secretCount > 0) {
    console.log(`- ${secretCount} potential secrets redacted`);
  }
  if (request.redacted) {
    console.log("- Sensitive values were redacted before sending.");
  }
}

async function spawnWorker(repoRoot: string, jobKey: string): Promise<number> {
  const scriptPath = fileURLToPath(new URL(import.meta.url));
  const child = spawn(process.execPath, [scriptPath, "worker", jobKey, "--repo", repoRoot], {
    stdio: "inherit",
  });
  const [code] = (await once(child, "close")) as [number];
  return code ?? 0;
}

async function defaultOldRevision(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { encoding: "utf8" });
  return stdout.trim();
}

interface RawReviewOptions {
  projectContext?: string | string[];
  objective?: string;
  preview?: boolean;
  dryRun?: boolean;
  dangerouslyAllowSecrets?: boolean;
}

function normalizeOptions(options: RawReviewOptions): ReviewOptions {
  return {
    projectContext: Array.isArray(options.projectContext)
      ? options.projectContext
      : options.projectContext
        ? [options.projectContext]
        : [],
    objective: options.objective,
    preview: Boolean(options.preview),
    dryRun: Boolean(options.dryRun),
    dangerouslyAllowSecrets: Boolean(options.dangerouslyAllowSecrets),
  };
}

async function tailJob(repoRoot: string, jobKey: string): Promise<void> {
  const jobFile = path.join(getJobsDir(repoRoot), `${jobKey}.json`);
  await ensureDir(path.dirname(jobFile));
  console.log(`Tailing job ${jobKey}...`);
  let done = false;
  const printStatus = async () => {
    const raw = await fs.readFile(jobFile, "utf8").catch(() => undefined);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    console.log(`Status: ${data.status}`);
    if (data.error) {
      console.log(`Error: ${data.error}`);
    }
    if (data.reviewPath) {
      console.log(`Review stored at ${data.reviewPath}`);
    }
    if (data.status === "completed" || data.status === "failed") {
      done = true;
    }
  };
  await printStatus();
  while (!done) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await printStatus();
  }
}

async function resolveReviewFile(repoRoot: string, file?: string): Promise<string> {
  const dir = getReviewsDir(repoRoot);
  await ensureDir(dir);
  if (file) {
    const candidate = path.isAbsolute(file) ? file : path.join(dir, file);
    return candidate;
  }
  const entries = await fs.readdir(dir);
  if (entries.length === 0) {
    throw new Error("No reviews saved yet.");
  }
  let latest: { file: string; mtime: number } | undefined;
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (!latest || stat.mtimeMs > latest.mtime) {
      latest = { file: full, mtime: stat.mtimeMs };
    }
  }
  return latest!.file;
}
