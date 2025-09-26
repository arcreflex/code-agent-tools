import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { $ } from "zx";

import type { BuildBaseOptions, BuildOptions, RepoInfo, RunCommandInfo, SandboxConfig, StartOptions } from "./types.js";
import {
  getBaseImageDir,
  getConfigVolume,
  getContainerName,
  getHistoryVolume,
  getRepoImageName,
  getRepoShelfVolume,
  getSandboxDirPath,
  getWorktreePath,
} from "./paths.js";

$.verbose = false;

export async function buildBaseImage(options: BuildBaseOptions): Promise<void> {
  const baseDir = getBaseImageDir();
  const args = ["build", "-t", `agent-sandbox-base:${options.tag}`];
  const buildArgs: Array<[string, string | undefined]> = [
    ["CLAUDE_CODE_VERSION", options.claudeCodeVersion],
    ["CODEX_VERSION", options.codexVersion],
    ["GIT_DELTA_VERSION", options.gitDeltaVersion],
    ["AST_GREP_VERSION", options.astGrepVersion],
  ];
  for (const [name, value] of buildArgs) {
    if (value) {
      args.push("--build-arg", `${name}=${value}`);
    }
  }
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
): Promise<void> {
  const run = buildRunCommand(info, image, config, options, { detached: true });
  await ensureContainerStopped(info);
  await ensureVolumes(info);
  await $`docker ${["run", ...run.args]}`;
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
  args.push("--security-opt", "no-new-privileges");
  if (config.egress_allow_domains.length > 0) {
    args.push("--env", `EXTRA_EGRESS_ALLOW=${config.egress_allow_domains.join(",")}`);
  }
  if (!extra?.admin) {
    const sandboxDir = getSandboxDirPath(info.path);
    args.push("--mount", `type=bind,src=${sandboxDir},dst=/.agent-sandbox,ro`);
  }
  const repoShelfVolume = getRepoShelfVolume(info);
  args.push("--mount", `type=volume,src=${repoShelfVolume},dst=/repo-shelf`);
  const historyVolume = getHistoryVolume(info);
  args.push("--mount", `type=volume,src=${historyVolume},dst=/commandhistory`);
  args.push("--mount", `type=volume,src=${getConfigVolume()},dst=/config`);

  const repoMountSrc = info.path;
  const repoMountDst = `/workspace/${info.name}`;
  const repoFlags = extra?.admin ? "" : ",rw";
  args.push("--mount", `type=bind,src=${repoMountSrc},dst=${repoMountDst}${repoFlags}`);

  if (!extra?.admin) {
    for (const readonly of config.readonly) {
      const src = `${info.path}/${readonly}`;
      const dst = `/workspace/${info.name}/${readonly}`;
      args.push("--mount", `type=bind,src=${src},dst=${dst},ro`);
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
  return { image, args };
}

export async function containerRunning(info: RepoInfo): Promise<boolean> {
  const name = getContainerName(info);
  const result = await $`docker ps --filter name=${name} --format {{.ID}}`;
  return Boolean(result.stdout.trim());
}

export async function execInContainer(info: RepoInfo, command: string): Promise<void> {
  const name = getContainerName(info);
  await $`docker exec ${name} bash -lc ${command}`;
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
  return runInteractiveDocker(args);
}

async function runInteractiveDocker(args: string[]): Promise<number> {
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
  console.log(["docker", ...command.args].join(" "));
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

async function ensureVolumes(info: RepoInfo): Promise<void> {
  const volumes = [getRepoShelfVolume(info), getHistoryVolume(info), getConfigVolume()];
  for (const volume of volumes) {
    await $`docker volume create ${volume}`;
  }
}
