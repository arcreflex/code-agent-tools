#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

import { Command } from "commander";

import {
  buildBaseImage,
  buildExecCommand,
  buildRepoImage,
  containerRunning,
  ensureContainerStopped,
  listContainers,
  listSharedVolumes,
  listVolumes,
  openShell,
  formatDockerCommand,
  showRunCommand,
  startContainer,
  buildRunCommand,
  runDockerCommand,
  imageExists,
  BASE_IMAGE_NAME,
} from "./docker.ts";
import { initializeSandboxConfig } from "./fs.ts";
import { ensureRepoProvisioned } from "./provision.ts";
import { getContainerName, loadRepoAndConfigInfo, loadSandboxConfig, resolveRepoPath } from "./paths.ts";
import { initCodexConfig } from "./codex.ts";
import type { BuildBaseOptions, BuildOptions, ExecOptions, RepoInfo, ShellOptions, StartOptions } from "./types.ts";

const program = new Command();
program.name("agent-sandbox").description("Docker-based sandbox manager for coding agents");

const collectEnv = (value: string, previous: string[]) => {
  previous.push(value);
  return previous;
};

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
    await initializeSandboxConfig(repoPath);
    if (options.build) {
      const info = await loadRepoAndConfigInfo(repoPath);
      await buildRepoImage(info, { baseTag: options.baseTag });
    }
  });

program
  .command("build [path]")
  .description(
    "Build the per-repository sandbox image. If no .agent-sandbox/Dockerfile exists, use shell --build or exec --build to fall back to the base image.",
  )
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .action(async (pathArg: string | undefined, options: BuildOptions) => {
    const repoPath = await resolveRepoPath(pathArg);
    const info = await loadRepoAndConfigInfo(repoPath);
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
    const info = await loadRepoAndConfigInfo(repoPath);
    const image = await resolveImage(info, options);
    const config = await loadSandboxConfig(info);
    await startContainer(info, image, config, options);
    await ensureRepoProvisioned(repoPath, options.branch);
    console.log(`Container ${getContainerName(info)} started using ${image}.`);
  });

program
  .command("stop [path]")
  .description("Stop the sandbox container")
  .action(async (pathArg?: string) => {
    const repoPath = await resolveRepoPath(pathArg);
    const info = await loadRepoAndConfigInfo(repoPath);
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
  .command("exec [path]")
  .description("Execute a non-interactive command in the sandbox")
  .allowExcessArguments(true)
  .option("--branch <branch>", "Worktree branch to provision")
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .option("--build", "Build the per-repo image before starting", false)
  .option("--env <key=value>", "Environment variable to set", collectEnv, [] as string[])
  .option("--print-cmd", "Print the docker run/exec invocations", false)
  .option("--admin", "Disable read-only overlays", false)
  .action(
    async (
      pathArg: string | undefined,
      options: ExecOptions & { env: string[]; admin?: boolean; printCmd?: boolean },
      command: Command,
    ) => {
      const exitCode = await handleExecCommand(pathArg, options, command);
      process.exitCode = exitCode;
    },
  );

program
  .command("show-run [path]")
  .description("Print the docker run command that would be used")
  .option("--base-tag <tag>", "Base image tag to use", "latest")
  .action(async (pathArg: string | undefined, options: StartOptions) => {
    const repoPath = await resolveRepoPath(pathArg);
    const info = await loadRepoAndConfigInfo(repoPath);
    const image = await resolveImage(info, options);
    const config = await loadSandboxConfig(info);
    await showRunCommand(info, image, config, options);
  });

program
  .command("volumes [path]")
  .description("List volumes used by this repository sandbox")
  .action(async (pathArg?: string) => {
    const repoPath = await resolveRepoPath(pathArg);
    const info = await loadRepoAndConfigInfo(repoPath);
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
  const info = await loadRepoAndConfigInfo(repoPath);
  const config = await loadSandboxConfig(info);
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
  info: RepoInfo,
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

async function resolveImage(info: RepoInfo, options: StartOptions): Promise<string> {
  if (info.image.type === "base") {
    return `${BASE_IMAGE_NAME}:${options.baseTag}`;
  }

  const desired = `${info.image.name}:${options.baseTag}`;
  if (await imageExists(desired)) {
    return desired;
  }
  if (options.build) {
    await buildRepoImage(info, { baseTag: options.baseTag });
    return desired;
  } else {
    throw new Error(`Image ${desired} not found and build option is disabled`);
  }
}

async function handleExecCommand(
  pathArg: string | undefined,
  options: ExecOptions & { env: string[]; admin?: boolean; printCmd?: boolean },
  command: Command,
): Promise<number> {
  const parentCommand = command.parent as (Command & { rawArgs?: string[] }) | undefined;
  const rawArgs = parentCommand?.rawArgs ?? [];
  const doubleDashIndex = rawArgs.indexOf("--");
  const commandArgs = doubleDashIndex === -1 ? command.args : rawArgs.slice(doubleDashIndex + 1);
  if (commandArgs.length === 0) {
    console.error("agent-sandbox exec requires a command to run.");
    return 2;
  }

  const repoCandidate = doubleDashIndex !== -1 ? pathArg : undefined;
  let repoPath: string;
  try {
    repoPath = await resolveRepoPath(repoCandidate);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const envEntries: string[] = [];
  for (const entry of options.env ?? []) {
    if (!entry.includes("=") || entry.startsWith("=")) {
      console.error(`Invalid --env value: ${entry}`);
      return 2;
    }
    envEntries.push(entry);
  }

  const info = await loadRepoAndConfigInfo(repoPath);
  const config = await loadSandboxConfig(info);
  const image = await resolveImage(info, options);
  const admin = Boolean(options.admin);
  let containerIsRunning = await containerRunning(info);
  if (admin && containerIsRunning) {
    await ensureContainerStopped(info);
    containerIsRunning = false;
  }
  let startedRunArgs: string[] | undefined;
  if (!containerIsRunning) {
    const runInfo = await startContainer(info, image, config, options, { admin });
    startedRunArgs = runInfo.args;
    containerIsRunning = true;
  }
  const branchName = await ensureRepoProvisioned(repoPath, options.branch);
  const execCommand = buildExecCommand(info, branchName, commandArgs, { env: envEntries });
  if (options.printCmd) {
    if (startedRunArgs) {
      console.log(formatDockerCommand(["docker", ...startedRunArgs]));
    }
    console.log(formatDockerCommand(["docker", ...execCommand.args]));
  }
  const exitCode = await runDockerCommand(execCommand.args);
  return exitCode;
}
