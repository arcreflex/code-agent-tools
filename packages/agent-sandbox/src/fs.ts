import { promises as fs } from "node:fs";
import path from "node:path";

import { getTemplateDir, getMarkerFilePath } from "./paths.ts";

export async function initializeSandboxConfig(repoPath: string): Promise<void> {
  const sandboxDir = path.join(repoPath, ".agent-sandbox");
  await fs.mkdir(sandboxDir, { recursive: true });

  const templateDir = getTemplateDir();
  const templateEntries = await fs.readdir(templateDir);
  await Promise.all(
    templateEntries.map(async (entry) => {
      const source = path.join(templateDir, entry);
      const target = path.join(sandboxDir, entry);
      await copyIfMissing(source, target);
    }),
  );

  await ensureMarkerFile(repoPath);
}

async function copyIfMissing(source: string, target: string): Promise<void> {
  try {
    await fs.stat(target);
    return;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    const entries = await fs.readdir(source);
    for (const entry of entries) {
      await copyIfMissing(path.join(source, entry), path.join(target, entry));
    }
  } else {
    await fs.copyFile(source, target);
  }
}

async function ensureMarkerFile(repoPath: string): Promise<void> {
  const markerPath = getMarkerFilePath(repoPath);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  const content = `This repository is configured for agent-sandbox.\n`;
  await fs.writeFile(markerPath, content, { encoding: "utf8" });
}
