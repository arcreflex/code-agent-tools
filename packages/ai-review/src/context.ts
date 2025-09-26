import { promises as fs } from "node:fs";
import path from "node:path";

import { minimatch } from "minimatch";

import type { ContextFile } from "./types.ts";

const DEFAULT_MAX_BYTES = 200 * 1024;

export async function buildContext(
  repoRoot: string,
  trackedFiles: readonly string[],
  patterns: readonly string[],
): Promise<{ files: ContextFile[]; omitted: string[] }> {
  if (patterns.length === 0) {
    return { files: [], omitted: [] };
  }
  const maxBytes = getMaxBytes();
  const included = new Set<string>();
  const files: ContextFile[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (const pattern of patterns) {
    for (const file of trackedFiles) {
      if (included.has(file)) {
        continue;
      }
      if (!minimatch(file, pattern, { dot: true })) {
        continue;
      }
      const absolute = path.join(repoRoot, file);
      const content = await fs.readFile(absolute, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      if (used + bytes > maxBytes) {
        omitted.push(file);
        continue;
      }
      included.add(file);
      used += bytes;
      files.push({ path: file, content, truncated: false });
    }
  }
  return { files, omitted };
}

function getMaxBytes(): number {
  const raw = process.env.AI_REVIEW_MAX_CONTEXT_BYTES;
  if (!raw) {
    return DEFAULT_MAX_BYTES;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_MAX_BYTES;
  }
  return parsed;
}
