import { appendJobLog, loadJob, saveReview, updateJob } from "./jobs.js";
import { executeReview } from "./openai.js";
import type { FinalReview } from "./types.js";

export async function runWorker(repoRoot: string, jobKey: string): Promise<number> {
  let job = await loadJob(repoRoot, jobKey);
  job = await updateJob(repoRoot, job, { status: "running" });
  try {
    job = await appendJobLog(repoRoot, job, "Starting review worker.");
    const result = await executeReview({ repoRoot, request: job.request });
    const reviewPath = await saveReview(repoRoot, job, result);
    job = await updateJob(repoRoot, job, { status: "completed", result, reviewPath });
    job = await appendJobLog(repoRoot, job, `Review stored at ${reviewPath}`);
    printFinalResult(result);
    return result.status === "pass" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateJob(repoRoot, job, { status: "failed", error: message });
    console.error(`Review failed: ${message}`);
    return (error as { exitCode?: number })?.exitCode ?? 2;
  }
}

function printFinalResult(result: FinalReview): void {
  if (result.status === "pass") {
    console.log("✓ PASSED");
  } else {
    console.log("✗ FAILED");
    for (const blocker of result.blockers) {
      console.log(`- [${blocker.rule}] ${blocker.title} (${blocker.file}:${blocker.line_start}-${blocker.line_end})`);
      console.log(`  ${blocker.why}`);
      if (blocker.suggested_fix) {
        console.log(`  Suggested fix: ${blocker.suggested_fix}`);
      }
    }
  }
  if (result.notes.length > 0) {
    console.log("Notes:");
    for (const note of result.notes) {
      console.log(`- ${note}`);
    }
  }
}
