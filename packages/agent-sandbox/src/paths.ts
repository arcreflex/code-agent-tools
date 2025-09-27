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

export function getRepoInfo(repoPath: string): RepoInfo {
  const name = path.basename(repoPath);
  const hash = createHash("md5").update(repoPath).digest("hex").slice(0, 12);
  return { name, path: repoPath, hash };
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

export function getRepoImageName(info: RepoInfo): string {
  return `agent-sbx-image-${info.name}-${info.hash}`;
}

export function getMarkerFilePath(repoPath: string): string {
  return path.join(repoPath, ".agent-sandbox", REPO_MARKER_FILENAME);
}

export function getSandboxDirPath(repoPath: string): string {
  return path.join(repoPath, ".agent-sandbox");
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

export async function loadSandboxConfig(repoPath: string): Promise<SandboxConfig> {
  const repoConfigPath = path.join(getSandboxDirPath(repoPath), "config.json");
  const homeConfigPath = path.join(homedir(), ".agent-sandbox", "config.json");
  const baseConfig: SandboxConfig = {
    ports: [],
    readonly: [".git/hooks", ".husky", ".agent-sandbox", ".ai-review/user-context.json"],
    egress_allow_domains: [],
  };
  const repoConfig = await readJson<SandboxConfig>(repoConfigPath);
  const homeConfig = await readJson<SandboxConfig>(homeConfigPath);
  return mergeSandboxConfig(baseConfig, mergeSandboxConfig(homeConfig, repoConfig));
}

async function readJson<T>(filename: string): Promise<Partial<T>> {
  try {
    const raw = await fs.readFile(filename, "utf8");
    return JSON.parse(raw) as Partial<T>;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function mergeSandboxConfig(base: Partial<SandboxConfig>, override: Partial<SandboxConfig>): SandboxConfig {
  return {
    ports: unique([...toArray(base.ports), ...toArray(override.ports)]).map((value) => Number(value)),
    readonly: unique([...toArray(base.readonly), ...toArray(override.readonly)]),
    egress_allow_domains: unique([...toArray(base.egress_allow_domains), ...toArray(override.egress_allow_domains)]),
  } satisfies SandboxConfig;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isReadonlyArray<T>(value: T | readonly T[]): value is readonly T[] {
  return Array.isArray(value);
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return isReadonlyArray(value) ? [...value] : [value];
}

export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[\s/\\]+/g, "-");
}

export function getWorktreePath(branch: string): string {
  return `/repo-shelf/worktrees/${sanitizeBranchName(branch)}`;
}
