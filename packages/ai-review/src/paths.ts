import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = fileURLToPath(new URL("../template", import.meta.url));

export async function resolveRepoRoot(start: string = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    const gitDir = path.join(current, ".git");
    try {
      const stat = await fs.stat(gitDir);
      if (stat.isDirectory()) {
        return current;
      }
    } catch {
      // ignore
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate repository root (missing .git directory)");
    }
    current = parent;
  }
}

export function getAiReviewDir(repoRoot: string): string {
  return path.join(repoRoot, ".ai-review");
}

export function getJobsDir(repoRoot: string): string {
  return path.join(getAiReviewDir(repoRoot), "jobs");
}

export function getReviewsDir(repoRoot: string): string {
  return path.join(getAiReviewDir(repoRoot), "reviews");
}

export function getTemplateDir(): string {
  return TEMPLATE_DIR;
}

export function getSystemPromptPaths(repoRoot: string): string[] {
  const home = process.env.HOME || process.cwd();
  return [
    path.join(getAiReviewDir(repoRoot), "system-prompt.md"),
    path.join(home, ".ai-review", "system-prompt.md"),
    path.join(getTemplateDir(), "system-prompt.md"),
  ];
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function loadEnv(repoRoot: string): Promise<void> {
  for (const file of [`${repoRoot}/.env`, `${getAiReviewDir(repoRoot)}/.env`]) {
    try {
      await fs.access(file);
      process.loadEnvFile(file);
    } catch {
      // pass
    }
  }
}
