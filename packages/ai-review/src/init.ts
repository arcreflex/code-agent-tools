import { promises as fs } from "node:fs";
import path from "node:path";

import { ensureDir, getAiReviewDir, getJobsDir, getReviewsDir, getTemplateDir } from "./paths.js";

export interface InitOptions {
  readonly force?: boolean;
}

const PRESERVE_FILES = new Set([".env", "reviews", "jobs"]);

export async function initAiReview(repoRoot: string, options: InitOptions = {}): Promise<void> {
  const targetDir = getAiReviewDir(repoRoot);
  const templateDir = getTemplateDir();
  await ensureDir(targetDir);
  const entries = await fs.readdir(templateDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(templateDir, entry.name);
    const destination = path.join(targetDir, entry.name);
    if (!options.force && PRESERVE_FILES.has(entry.name) && (await exists(destination))) {
      continue;
    }
    if (entry.isDirectory()) {
      await copyDir(source, destination, options.force ?? false);
    } else {
      if (!options.force && (await exists(destination))) {
        continue;
      }
      await fs.copyFile(source, destination);
    }
  }
  await ensureDir(getJobsDir(repoRoot));
  await ensureDir(getReviewsDir(repoRoot));
  await ensureGitignore(repoRoot);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(source: string, destination: string, overwrite: boolean): Promise<void> {
  await ensureDir(destination);
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dst, overwrite);
    } else if (overwrite || !(await exists(dst))) {
      await fs.copyFile(src, dst);
    }
  }
}

async function ensureGitignore(repoRoot: string): Promise<void> {
  const gitignore = path.join(repoRoot, ".gitignore");
  const required = [".ai-review/reviews", ".ai-review/jobs"];
  let contents = "";
  try {
    contents = await fs.readFile(gitignore, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
  const lines = new Set(contents.split(/\r?\n/).filter((line) => line.trim().length > 0));
  let changed = false;
  for (const entry of required) {
    if (!lines.has(entry)) {
      lines.add(entry);
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  const next = Array.from(lines).sort();
  await fs.writeFile(gitignore, `${next.join("\n")}\n`, "utf8");
}
