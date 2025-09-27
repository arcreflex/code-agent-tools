import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { $ } from "zx";

import type {
  BuildBaseOptions,
  BuildOptions,
  ExecCommandInfo,
  MountSpec,
  RepoInfo,
  RunCommandInfo,
  SandboxConfig,
  StartOptions,
} from "./types.ts";
import {
  getBaseImageDir,
  getConfigVolume,
  getContainerName,
  getHistoryVolume,
  getRepoImageName,
  getRepoShelfVolume,
  getSandboxDirPath,
  getWorktreePath,
} from "./paths.ts";
import { resolveBaseImageVersions } from "./versions.ts";
import type { BaseImageVersions } from "./versions.ts";

$.verbose = false;

export async function buildBaseImage(options: BuildBaseOptions): Promise<void> {
  const baseDir = getBaseImageDir();
  const versions = await resolveBaseImageVersions(options);
  printResolvedVersions(versions);
  const args = ["build", "-t", `agent-sandbox-base:${options.tag}`];
  args.push("--build-arg", `CLAUDE_CODE_VERSION=${versions.claudeCode}`);
  args.push("--build-arg", `CODEX_VERSION=${versions.codex}`);
  args.push("--build-arg", `GIT_DELTA_VERSION=${versions.gitDelta}`);
  args.push("--build-arg", `AST_GREP_VERSION=${versions.astGrep}`);
  args.push(baseDir);
  await $`docker ${args}`;
}

export async function buildRepoImage(info: RepoInfo, options: BuildOptions): Promise<string> {
  const dockerfile = `${info.path}/.agent-sandbox/Dockerfile`;
  const image = `${getRepoImageName(info)}:${options.baseTag}`;
  await $`docker build -f ${dockerfile} -t ${image} --build-arg BASE_IMAGE_TAG=${options.baseTag} ${info.path}`;
  return image;
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await $`docker image inspect ${image}`;
    return true;
  } catch {
    return false;
  }
}

export async function ensureContainerStopped(info: RepoInfo): Promise<void> {
  const name = getContainerName(info);
  const ids = await $`docker ps -aq --filter name=${name}`;
  if (!ids.stdout.trim()) {
    return;
  }
  await $`docker rm -f ${name}`;
}

export async function startContainer(
  info: RepoInfo,
  image: string,
  config: SandboxConfig,
  options: StartOptions,
  extra?: { admin?: boolean },
): Promise<RunCommandInfo> {
  const run = buildRunCommand(info, image, config, options, {
    detached: true,
    admin: extra?.admin,
  });
  await ensureContainerStopped(info);
  await ensureVolumes(info, image);
  await $`docker ${run.args}`;
  await delay(500);
  if (!(await containerRunning(info))) {
    const name = getContainerName(info);
    const logs = await $`docker logs ${name}`.catch(() => ({ stdout: "" }));
    await ensureContainerStopped(info).catch(() => undefined);
    const message = logs.stdout.trim();
    throw new Error(
      message
        ? `Container failed to start. Recent logs:\n${message}`
        : "Container failed to start. Check docker logs for details.",
    );
  }
  return run;
}

export function buildMounts(info: RepoInfo, config: SandboxConfig, extra?: { admin?: boolean }): MountSpec[] {
  const mounts: MountSpec[] = [];
  if (!extra?.admin) {
    const sandboxDir = getSandboxDirPath(info.path);
    mounts.push({
      description: "Sandbox configuration overlay",
      dst: "/.agent-sandbox",
      mode: "ro",
      src: sandboxDir,
      type: "bind",
    });
  }
  const repoShelfVolume = getRepoShelfVolume(info);
  mounts.push({
    description: "Persistent repo shelf",
    dst: "/repo-shelf",
    mode: "rw",
    src: repoShelfVolume,
    type: "volume",
  });
  const historyVolume = getHistoryVolume(info);
  mounts.push({
    description: "Command history volume",
    dst: "/commandhistory",
    mode: "rw",
    src: historyVolume,
    type: "volume",
  });
  mounts.push({
    description: "Configuration volume",
    dst: "/config",
    mode: "rw",
    src: getConfigVolume(),
    type: "volume",
  });

  const repoMountSrc = info.path;
  const repoMountDst = `/workspace/${info.name}`;
  mounts.push({
    description: "Host repository",
    dst: repoMountDst,
    mode: "rw",
    src: repoMountSrc,
    type: "bind",
  });

  if (!extra?.admin) {
    for (const readonly of config.readonly) {
      const src = `${info.path}/${readonly}`;
      const dst = `/workspace/${info.name}/${readonly}`;
      if (existsSync(src)) {
        mounts.push({
          description: `Read-only overlay for ${readonly}`,
          dst,
          mode: "ro",
          src,
          type: "bind",
        });
      }
    }
  }

  return mounts;
}

export function buildRunCommand(
  info: RepoInfo,
  image: string,
  config: SandboxConfig,
  options: StartOptions,
  extra?: { detached?: boolean; admin?: boolean; root?: boolean },
): RunCommandInfo {
  const args: string[] = ["run"];
  if (extra?.detached) {
    args.push("-d");
  } else {
    args.push("-it");
  }
  if (!extra?.detached) {
    args.push("--rm");
  }
  const containerName = getContainerName(info);
  if (extra?.detached) {
    args.push("--name", containerName);
  }
  args.push("--label", "agent-sandbox=1");
  args.push("--label", `repo-path=${info.path}`);
  args.push("--label", `repo-name=${info.name}`);
  args.push("--env", `REPO_NAME=${info.name}`);
  args.push("--env", `SANDBOX_REPO_PATH=${info.path}`);
  args.push("--env", "CONFIG_VOLUME=/config");
  args.push("--cap-add", "NET_ADMIN");
  args.push("--cap-add", "NET_RAW");
  if (config.egress_allow_domains.length > 0) {
    args.push("--env", `EXTRA_EGRESS_ALLOW=${config.egress_allow_domains.join(",")}`);
  }
  const mounts = buildMounts(info, config, extra);
  for (const mount of mounts) {
    if (mount.type === "bind") {
      const readonlyFlag = mount.mode === "ro" ? ",readonly=true" : "";
      args.push("--mount", `type=bind,src=${mount.src},dst=${mount.dst}${readonlyFlag}`);
    } else if (mount.type === "volume") {
      args.push("--mount", `type=volume,src=${mount.src},dst=${mount.dst}`);
    }
  }
  for (const port of config.ports) {
    args.push("-p", `${port}:${port}`);
  }
  if (extra?.root) {
    args.push("--user", "root");
  }
  if (extra?.detached) {
    args.push(image, "tail", "-f", "/dev/null");
  } else {
    args.push(image, "/bin/bash");
  }
  return { image, args, mounts };
}

export async function containerRunning(info: RepoInfo): Promise<boolean> {
  const name = getContainerName(info);
  const result = await $`docker ps --filter name=${name} --format {{.ID}}`;
  return Boolean(result.stdout.trim());
}

export async function execInContainer(info: RepoInfo, command: string): Promise<void> {
  const name = getContainerName(info);
  await $({ stdio: "inherit" })`docker exec ${name} bash -lc ${command}`;
}

export async function openShell(info: RepoInfo, branch: string | undefined, asRoot: boolean): Promise<number> {
  const args = ["exec", "-it"];
  if (asRoot) {
    args.push("--user", "root");
  }
  args.push(getContainerName(info));
  const workdir = branch ? getWorktreePath(branch) : `/workspace/${info.name}`;
  args.push("--workdir", workdir);
  args.push("bash");
  return runDockerCommand(args);
}

export function buildExecCommand(
  info: RepoInfo,
  branch: string,
  command: readonly string[],
  options?: { env?: readonly string[] },
): ExecCommandInfo {
  const args = ["exec", "--workdir", getWorktreePath(branch)];
  for (const entry of options?.env ?? []) {
    args.push("--env", entry);
  }
  args.push(getContainerName(info));
  args.push("--");
  args.push(...command);
  return { args };
}

export async function runDockerCommand(args: string[]): Promise<number> {
  const child = spawn("docker", args, { stdio: "inherit" });
  const [code] = (await once(child, "close")) as [number];
  return code ?? 0;
}

export async function showRunCommand(
  info: RepoInfo,
  image: string,
  config: SandboxConfig,
  options: StartOptions,
): Promise<void> {
  const command = buildRunCommand(info, image, config, options, {});
  const mountSummary = describeMounts(command.mounts);
  if (mountSummary.length > 0) {
    console.log("Mount summary:");
    for (const entry of mountSummary) {
      console.log(`  ${entry}`);
    }
  }
  const allowlistCount = await countAllowlistDomains(info.path);
  console.log(`Using allowlist from /.agent-sandbox/config.json (${allowlistCount} domains)`);
  console.log(formatDockerCommand(["docker", ...command.args]));
}

function describeMounts(mounts: readonly MountSpec[]): string[] {
  const entries: string[] = [];
  for (const mount of mounts) {
    const source = mount.type === "volume" ? `volume:${mount.src ?? ""}` : (mount.src ?? "");
    const target = mount.dst ?? "";
    const mode = mount.mode ?? "rw";
    const prettySource = source || "(unspecified)";
    const prettyTarget = target || "(unspecified)";
    entries.push(`[${mode}] ${prettySource} -> ${prettyTarget} (${mount.description})`);
  }
  return entries;
}

async function countAllowlistDomains(repoPath: string): Promise<number> {
  const configPath = path.join(repoPath, ".agent-sandbox", "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { egress_allow_domains?: unknown };
    const domains = Array.isArray(parsed.egress_allow_domains) ? parsed.egress_allow_domains : [];
    return domains.length;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

export function formatDockerCommand(args: readonly string[]): string {
  return (
    args
      .map(quoteArg)
      // .map((a) => (a.startsWith("--") ? ` \\\n  ${a}` : a))
      .join(" ")
  );
}

function quoteArg(arg: string): string {
  if (/^[-A-Za-z0-9._/:=+,]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function printResolvedVersions(versions: BaseImageVersions): void {
  const entries: Array<[string, string]> = [
    ["@anthropic-ai/claude-code", versions.claudeCode],
    ["@openai/codex", versions.codex],
    ["git-delta", versions.gitDelta],
    ["@ast-grep/cli", versions.astGrep],
  ];
  const width = Math.max(...entries.map(([name]) => name.length));
  console.log("Resolved versions:");
  for (const [name, value] of entries) {
    const padded = name.padEnd(width, " ");
    console.log(`${padded} ->  ${value}`);
  }
}

export async function listContainers(): Promise<void> {
  const output = await $`docker ps --filter label=agent-sandbox=1 --format {{.ID}}\t{{.Image}}\t{{.Names}}`;
  console.log(output.stdout.trim());
}

export async function listVolumes(info: RepoInfo): Promise<void> {
  const volumes = [getRepoShelfVolume(info), getHistoryVolume(info)];
  for (const volume of volumes) {
    const result = await $`docker volume inspect ${volume}`;
    console.log(result.stdout.trim());
  }
}

export async function listSharedVolumes(): Promise<void> {
  const result = await $`docker volume inspect ${getConfigVolume()}`.catch(() => ({ stdout: "[]" }));
  console.log(result.stdout.trim());
}

async function ensureVolumes(info: RepoInfo, image: string): Promise<void> {
  const volumes = [getRepoShelfVolume(info), getHistoryVolume(info), getConfigVolume()];
  for (const volume of volumes) {
    await $`docker volume create ${volume}`;
    await ensureVolumeOwnership(volume, image);
  }
}

async function ensureVolumeOwnership(volume: string, image: string): Promise<void> {
  try {
    const chownScript = "chown -R node:node /volume || chown -R 1000:1000 /volume";
    await $`docker run --rm --user root --entrypoint /bin/sh --mount type=volume,src=${volume},dst=/volume ${image} -c ${chownScript}`;
  } catch (error) {
    throw new Error(
      `Failed to set ownership for volume ${volume}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
