import crypto from "node:crypto";

import { buildContext } from "./context.js";
import { getCommitMessages, getDiff, getDiffStats, listTrackedFiles } from "./git.js";
import { createJob } from "./jobs.js";
import type { ReviewOptions, ReviewRequest, SecretMatch } from "./types.js";
import { scanForSecrets } from "./secrets.js";

export interface PreparationResult {
  readonly request: ReviewRequest;
  readonly matches: SecretMatch[];
  readonly omittedContext: string[];
}

export async function prepareReview(
  repoRoot: string,
  kind: "range" | "staged",
  oldRevision: string | undefined,
  newRevision: string | undefined,
  options: ReviewOptions,
): Promise<PreparationResult> {
  const diff = await getDiff(oldRevision, newRevision, kind === "staged");
  const stats = await getDiffStats(oldRevision, newRevision, kind === "staged");
  const tracked = await listTrackedFiles();
  const context = await buildContext(repoRoot, tracked, options.projectContext);
  const commitMessages = await getCommitMessages(oldRevision, newRevision);

  const jobKey = generateJobKey();
  const createdAt = new Date().toISOString();

  let redactedDiff = diff;
  const matches: SecretMatch[] = [];
  const diffScan = scanForSecrets(diff);
  if (diffScan.matches.length > 0) {
    matches.push(...diffScan.matches);
    redactedDiff = diffScan.redactedText;
  }

  const contextFiles = [];
  let redacted = diffScan.matches.length > 0;
  for (const file of context.files) {
    const scan = scanForSecrets(file.content);
    if (scan.matches.length > 0) {
      matches.push(...scan.matches.map((match) => ({ ...match, pattern: `${match.pattern} (${file.path})` })));
      contextFiles.push({ ...file, content: scan.redactedText });
      redacted = true;
    } else {
      contextFiles.push(file);
    }
  }

  if (matches.length > 0 && !options.dangerouslyAllowSecrets) {
    const report = matches.map((match) => `- ${match.pattern} at line ${match.line}: ${match.excerpt}`).join("\n");
    throw Object.assign(new Error(`Potential secrets detected:\n${report}`), { exitCode: 1 });
  }

  const request: ReviewRequest = {
    kind,
    oldRevision,
    newRevision,
    diff: redactedDiff,
    summary: {
      additions: stats.additions,
      deletions: stats.deletions,
      files: stats.files,
      bytes: Buffer.byteLength(diff, "utf8"),
    },
    contextFiles,
    omittedContext: context.omitted,
    redacted,
    createdAt,
    jobKey,
    commitMessages,
    projectContext: options.projectContext,
    objective: options.objective,
    preview: options.preview,
    dryRun: options.dryRun,
    dangerouslyAllowSecrets: options.dangerouslyAllowSecrets,
  };

  return { request, matches, omittedContext: context.omitted };
}

export async function createReviewJob(repoRoot: string, request: ReviewRequest) {
  return createJob(repoRoot, request);
}

function generateJobKey(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const random = crypto.randomBytes(3).toString("hex");
  return `${timestamp}-${random}`;
}
