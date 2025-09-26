import { $ } from "zx";
import semver from "semver";

import type { BuildBaseOptions } from "./types.js";

$.verbose = false;

const DEFAULT_GIT_DELTA_VERSION = "0.18.2";

export interface BaseImageVersions {
  readonly claudeCode: string;
  readonly codex: string;
  readonly gitDelta: string;
  readonly astGrep: string;
}

export async function resolveBaseImageVersions(options: BuildBaseOptions): Promise<BaseImageVersions> {
  const claudeSpec = options.claudeCodeVersion ?? "latest";
  const codexSpec = options.codexVersion ?? "latest";
  const astGrepSpec = options.astGrepVersion ?? "latest";
  const gitDeltaSpec = options.gitDeltaVersion ?? DEFAULT_GIT_DELTA_VERSION;

  const [claudeCode, codex, astGrep, gitDelta] = await Promise.all([
    resolveNpmSpec("@anthropic-ai/claude-code", claudeSpec),
    resolveNpmSpec("@openai/codex", codexSpec),
    resolveNpmSpec("@ast-grep/cli", astGrepSpec),
    resolveGitDeltaSpec(gitDeltaSpec),
  ]);

  return { claudeCode, codex, astGrep, gitDelta } satisfies BaseImageVersions;
}

async function resolveNpmSpec(pkg: string, spec: string): Promise<string> {
  const concrete = semver.valid(spec, { loose: true });
  if (concrete) {
    return concrete;
  }
  if (spec === "latest") {
    const result = await $`npm view ${pkg} version`;
    return result.stdout.trim();
  }
  const range = semver.validRange(spec, { loose: true });
  if (!range) {
    return spec;
  }
  const versionsRaw = await $`npm view ${pkg} versions --json`;
  const versions = JSON.parse(versionsRaw.stdout.trim() || "[]") as string[];
  const resolved = semver.maxSatisfying(versions, range, { loose: true });
  if (!resolved) {
    throw new Error(`No published version of ${pkg} satisfies ${spec}`);
  }
  return resolved;
}

let gitDeltaCache: string[] | undefined;

async function resolveGitDeltaSpec(spec: string): Promise<string> {
  const concrete = semver.valid(spec, { loose: true });
  if (concrete) {
    return concrete;
  }
  const range = spec === "latest" ? "*" : semver.validRange(spec, { loose: true });
  if (!range) {
    return spec;
  }
  const versions = await loadGitDeltaVersions();
  const target =
    spec === "latest"
      ? semver.maxSatisfying(versions, "*", { loose: true })
      : semver.maxSatisfying(versions, range, { loose: true });
  if (!target) {
    throw new Error(`No git-delta release satisfies ${spec}`);
  }
  return target;
}

async function loadGitDeltaVersions(): Promise<string[]> {
  if (gitDeltaCache) {
    return gitDeltaCache;
  }
  const result = await $`git ls-remote --tags https://github.com/dandavison/delta.git`;
  const lines = result.stdout.trim().split(/\r?\n/);
  const versions = new Set<string>();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    let ref = parts[1];
    if (!ref.startsWith("refs/tags/")) {
      continue;
    }
    ref = ref.slice("refs/tags/".length);
    if (ref.endsWith("^{}")) {
      ref = ref.slice(0, -3);
    }
    const cleaned = semver.valid(ref, { loose: true });
    if (cleaned) {
      versions.add(cleaned);
    }
  }
  gitDeltaCache = Array.from(versions);
  return gitDeltaCache;
}

export { DEFAULT_GIT_DELTA_VERSION };
