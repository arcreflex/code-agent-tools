import { promises as fs } from "node:fs";
import path from "node:path";

import { ensureDir, getJobsDir, getReviewsDir } from "./paths.ts";
import type { FinalReview, ReviewJob, ReviewRequest } from "./types.ts";

export async function createJob(repoRoot: string, request: ReviewRequest): Promise<{ job: ReviewJob; path: string }> {
  const dir = getJobsDir(repoRoot);
  await ensureDir(dir);
  const key = request.jobKey;
  const job: ReviewJob = { key, status: "pending", request, log: [] };
  const file = path.join(dir, `${key}.json`);
  await fs.writeFile(file, JSON.stringify(job, null, 2), "utf8");
  return { job, path: file };
}

export async function updateJob(repoRoot: string, job: ReviewJob, changes: Partial<ReviewJob>): Promise<ReviewJob> {
  const merged = { ...job, ...changes };
  const file = path.join(getJobsDir(repoRoot), `${job.key}.json`);
  await fs.writeFile(file, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export async function appendJobLog(repoRoot: string, job: ReviewJob, message: string): Promise<ReviewJob> {
  const next: Partial<ReviewJob> = { log: [...job.log, message] };
  return updateJob(repoRoot, job, next);
}

export async function loadJob(repoRoot: string, key: string): Promise<ReviewJob> {
  const file = path.join(getJobsDir(repoRoot), `${key}.json`);
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as ReviewJob;
}

export async function saveReview(repoRoot: string, job: ReviewJob, review: FinalReview): Promise<string> {
  const dir = getReviewsDir(repoRoot);
  await ensureDir(dir);
  const file = path.join(dir, `${job.key}.json`);
  await fs.writeFile(file, JSON.stringify({ review, request: job.request }, null, 2), "utf8");
  return file;
}
