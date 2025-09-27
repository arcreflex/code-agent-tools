import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RepoInfo, SandboxConfig } from "./types.ts";

const REPO_MARKER_FILENAME = "marker.txt";

export async function resolveRepoPath(rawPath?: string): Promise<string> {
  const absolute = path.resolve(rawPath ?? ".");
  const stat = await fs.stat(absolute).catch(() => {
    throw new Error(`Repository path not found: ${absolute}`);
  });
  if (!stat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${absolute}`);
  }
  const gitDir = path.join(absolute, ".git");
  const gitStat = await fs.stat(gitDir).catch(() => null);
  if (!gitStat || !gitStat.isDirectory()) {
    throw new Error(`Expected ${absolute} to be a git repository (missing .git directory)`);
  }
  return absolute;
}

export async function loadRepoAndConfigInfo(repoPath: string): Promise<RepoInfo> {
  const name = path.basename(repoPath);
  const hash = createHash("md5").update(repoPath).digest("hex").slice(0, 12);

  let configPath;
  for (const p of [repoPath, homedir()]) {
    try {
      const config = path.join(p, ".agent-sandbox", "config.json");
      await fs.access(config);
      configPath = config;
    } catch {
      // pass
    }
  }

  if (!configPath) {
    throw new Error(`Could not find config file in ${repoPath} or home directory`);
  }

  let image: RepoInfo["image"] = { type: "base" as const };
  try {
    const dockerFilePath = path.join(repoPath, ".agent-sandbox/Dockerfile");
    await fs.access(dockerFilePath);
    image = {
      type: "repo",
      dockerFilePath,
      name: `agent-sbx-image-${name}-${hash}`,
    };
  } catch {
    // pass
  }

  return {
    name,
    repoPath,
    hash,
    configPath,
    image,
  };
}

export function getRepoShelfVolume(info: RepoInfo): string {
  return `agent-sbx-repo-${info.hash}`;
}

export function getHistoryVolume(info: RepoInfo): string {
  return `agent-sandbox-history-${info.name}-${info.hash}`;
}

export function getConfigVolume(): string {
  return "agent-sandbox-config";
}

export function getContainerName(info: RepoInfo): string {
  return `agent-sbx-${info.name}-${info.hash}`;
}

export function getMarkerFilePath(repoPath: string): string {
  return path.join(repoPath, ".agent-sandbox", REPO_MARKER_FILENAME);
}

function currentDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function getTemplateDir(): string {
  return path.resolve(currentDir(), "../template");
}

export function getBaseImageDir(): string {
  return path.resolve(currentDir(), "../base-image");
}

export async function loadSandboxConfig(repoInfo: RepoInfo): Promise<SandboxConfig> {
  const raw = await fs.readFile(repoInfo.configPath, "utf8");
  return JSON.parse(raw) as SandboxConfig;
}

export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[\s/\\]+/g, "-");
}

export function getWorktreePath(branch: string): string {
  return `/repo-shelf/worktrees/${sanitizeBranchName(branch)}`;
}
