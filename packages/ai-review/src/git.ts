import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export interface DiffStats {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

export async function getDiff(
  oldRevision: string | undefined,
  newRevision: string | undefined,
  staged: boolean,
): Promise<string> {
  if (staged) {
    return runGit(["diff", "--cached", "--binary"]);
  }
  const args = ["diff", "--binary"];
  if (oldRevision && newRevision) {
    args.push(`${oldRevision}..${newRevision}`);
  } else if (oldRevision) {
    args.push(oldRevision);
  }
  return runGit(args);
}

export async function getDiffStats(
  oldRevision: string | undefined,
  newRevision: string | undefined,
  staged: boolean,
): Promise<DiffStats> {
  const args = staged ? ["diff", "--cached", "--stat"] : ["diff", "--stat"];
  if (!staged && oldRevision && newRevision) {
    args.push(`${oldRevision}..${newRevision}`);
  } else if (!staged && oldRevision) {
    args.push(oldRevision);
  }
  const output = await runGit(args);
  const match = output
    .trim()
    .split("\n")
    .pop()
    ?.match(/(\d+) files? changed, (\d+) insertions?\(\+\), (\d+) deletions?\(-\)/);
  if (!match) {
    return { files: 0, additions: 0, deletions: 0 };
  }
  return {
    files: Number(match[1]),
    additions: Number(match[2]),
    deletions: Number(match[3]),
  };
}

export async function listTrackedFiles(): Promise<string[]> {
  const output = await runGit(["ls-files"]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function getCommitMessages(
  oldRevision: string | undefined,
  newRevision: string | undefined,
): Promise<string[]> {
  if (!oldRevision) {
    return [];
  }
  const range = newRevision ? `${oldRevision}..${newRevision}` : `${oldRevision}..HEAD`;
  const output = await runGit(["log", "--pretty=format:%s", range]).catch(() => ({ stdout: "" }));
  const stdout = typeof output === "string" ? output : output.stdout;
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" });
  return stdout;
}
