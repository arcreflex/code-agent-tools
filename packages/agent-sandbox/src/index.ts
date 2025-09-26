#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

import { Command } from "commander";

import {
  buildBaseImage,
  buildRepoImage,
  containerRunning,
  ensureContainerStopped,
  listContainers,
  listSharedVolumes,
  listVolumes,
  openShell,
  showRunCommand,
  startContainer,
  buildRunCommand,
  imageExists,
} from "./docker.js";
import { ensureSandboxInitialized } from "./fs.js";
import { ensureRepoProvisioned } from "./provision.js";
import { getContainerName, getRepoImageName, getRepoInfo, loadSandboxConfig, resolveRepoPath } from "./paths.js";
import { initCodexConfig } from "./codex.js";
import type { BuildBaseOptions, BuildOptions, ShellOptions, StartOptions } from "./types.js";

const program = new Command();
program.name("agent-sandbox").description("Docker-based sandbox manager for coding agents");

program
  .command("build-base")
  .description("Build the shared agent-sandbox base image")
  .option("--tag <tag>", "Tag for the base image", "latest")
  .option("--claude-code-version <version>", "Version of @anthropic-ai/claude-code to install")
  .option("--codex-version <version>", "Version of @openai/codex to install")
  .option("--git-delta-version <version>", "Version of git-delta to install")
  .option("--ast-grep-version <version>", "Version of @ast-grep/cli to install")
  .action(async (opts: BuildBaseOptions) => {
    await buildBaseImage(opts);
  });

program
  .command("init [path]")
  .description("Initialize the sandbox template for a repository")
  .option("--build", "Build the per-repo image after initialization", false)
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .action(async (pathArg: string | undefined, options: { build?: boolean; baseTag: string }) => {
    const repoPath = await resolveRepoPath(pathArg);
    await ensureSandboxInitialized(repoPath);
    if (options.build) {
      const info = getRepoInfo(repoPath);
      await buildRepoImage(info, { baseTag: options.baseTag });
    }
  });

program
  .command("build [path]")
  .description("Build the per-repository sandbox image")
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .action(async (pathArg: string | undefined, options: BuildOptions) => {
    const repoPath = await resolveRepoPath(pathArg);
    const info = getRepoInfo(repoPath);
    await ensureSandboxInitialized(repoPath);
    await buildRepoImage(info, { baseTag: options.baseTag });
  });

program
  .command("start [path]")
  .description("Start the sandbox container in the background")
  .option("--branch <branch>", "Worktree branch to provision")
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .option("--build", "Build the per-repo image before starting", false)
  .action(async (pathArg: string | undefined, options: StartOptions) => {
    const repoPath = await resolveRepoPath(pathArg);
    await ensureSandboxInitialized(repoPath);
    const info = getRepoInfo(repoPath);
    const image = await resolveImage(info, options);
    const config = await loadSandboxConfig(repoPath);
    await startContainer(info, image, config, options);
    await ensureRepoProvisioned(repoPath, options.branch);
    console.log(`Container ${getContainerName(info)} started using ${image}.`);
  });

program
  .command("stop [path]")
  .description("Stop the sandbox container")
  .action(async (pathArg?: string) => {
    const repoPath = await resolveRepoPath(pathArg);
    const info = getRepoInfo(repoPath);
    await ensureContainerStopped(info);
    console.log(`Stopped container ${getContainerName(info)}.`);
  });

program
  .command("shell [path]")
  .description("Open an interactive shell in the sandbox")
  .option("--branch <branch>", "Worktree branch to provision")
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .option("--build", "Build the per-repo image before starting", false)
  .action(async (pathArg: string | undefined, options: ShellOptions) => {
    const exitCode = await handleShellCommand(pathArg, { ...options, admin: false, asRoot: false });
    process.exitCode = exitCode;
  });

program
  .command("admin [path]")
  .description("Open an admin shell with relaxed guardrails")
  .option("--root", "Run the shell as root", false)
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .option("--build", "Build the per-repo image before starting", false)
  .action(async (pathArg: string | undefined, options: { root?: boolean; baseTag: string; build?: boolean }) => {
    const exitCode = await handleShellCommand(pathArg, {
      branch: undefined,
      baseTag: options.baseTag,
      build: options.build,
      admin: true,
      asRoot: Boolean(options.root),
      repoPath: await resolveRepoPath(pathArg),
    });
    process.exitCode = exitCode;
  });

program
  .command("show-run [path]")
  .description("Print the docker run command that would be used")
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .action(async (pathArg: string | undefined, options: StartOptions) => {
    const repoPath = await resolveRepoPath(pathArg);
    await ensureSandboxInitialized(repoPath);
    const info = getRepoInfo(repoPath);
    const image = await resolveImage(info, options);
    const config = await loadSandboxConfig(repoPath);
    await showRunCommand(info, image, config, options);
  });

program
  .command("volumes [path]")
  .description("List volumes used by this repository sandbox")
  .action(async (pathArg?: string) => {
    const repoPath = await resolveRepoPath(pathArg);
    const info = getRepoInfo(repoPath);
    await listVolumes(info);
  });

program
  .command("shared-volumes")
  .description("List shared sandbox volumes")
  .action(async () => {
    await listSharedVolumes();
  });

program
  .command("list")
  .description("List running agent-sandbox containers")
  .action(async () => {
    await listContainers();
  });

program
  .command("codex-init-config")
  .description("Initialize the shared Codex configuration volume")
  .option("--auth", "Copy host auth.json into the volume", false)
  .option("--force", "Overwrite existing configuration files", false)
  .action(async (options: { auth?: boolean; force?: boolean }) => {
    await initCodexConfig({ auth: options.auth, force: options.force });
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function handleShellCommand(pathArg: string | undefined, options: ShellOptions): Promise<number> {
  const repoPath = options.repoPath ?? (await resolveRepoPath(pathArg));
  await ensureSandboxInitialized(repoPath);
  const info = getRepoInfo(repoPath);
  const config = await loadSandboxConfig(repoPath);
  const image = await resolveImage(info, options);
  if (options.admin) {
    return runAdminShell(info, image, config, options);
  }
  if (!(await containerRunning(info))) {
    await startContainer(info, image, config, options);
  }
  await ensureRepoProvisioned(repoPath, options.branch);
  return openShell(info, options.branch, options.asRoot);
}

function runAdminShell(
  info: ReturnType<typeof getRepoInfo>,
  image: string,
  config: Awaited<ReturnType<typeof loadSandboxConfig>>,
  options: ShellOptions,
): Promise<number> {
  const run = buildRunCommand(info, image, config, options, {
    admin: true,
    root: options.asRoot,
  });
  return new Promise<number>((resolve) => {
    const child = spawn("docker", run.args, { stdio: "inherit" });
    child.on("close", (code: number | null) => resolve(code ?? 0));
  });
}

async function resolveImage(info: ReturnType<typeof getRepoInfo>, options: StartOptions): Promise<string> {
  const desired = `${getRepoImageName(info)}:${options.baseTag}`;
  if (await imageExists(desired)) {
    return desired;
  }
  if (options.build) {
    await buildRepoImage(info, { baseTag: options.baseTag });
    return desired;
  }
  const fallback = `agent-sandbox-base:${options.baseTag}`;
  return fallback;
}
