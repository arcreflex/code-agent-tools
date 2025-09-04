import path from "node:path";
import { parseArgs } from "util";
import { $, chalk } from "zx";
import fs from "node:fs";
import crypto from "node:crypto";

interface SandboxConfig {
  ports?: string[];
  readonly?: string[];
}

const __dirname = new URL(".", import.meta.url).pathname;
const configVolume = "agent-sandbox-claude-code-config";
const codexConfigVolume = "agent-sandbox-codex-config";

async function main() {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      force: {
        type: "boolean",
        default: false,
      },
      "base-tag": {
        type: "string",
        default: "latest",
      },
      build: {
        type: "boolean",
      },
      tag: {
        type: "string",
        default: "latest",
      },
      "claude-code-version": {
        type: "string",
        default: "latest",
      },
      "codex-version": {
        type: "string",
        default: "latest",
      },
      "git-delta-version": {
        type: "string",
        default: "0.18.2",
      },
      "ast-grep-version": {
        type: "string",
        default: "latest",
      },
    },
  });

  if (args.positionals[0] === "build-base") {
    await buildBase({
      tag: args.values.tag,
      claudeCodeVersion: args.values["claude-code-version"],
      codexVersion: args.values["codex-version"],
      gitDeltaVersion: args.values["git-delta-version"],
      astGrepVersion: args.values["ast-grep-version"],
    });
  } else if (args.positionals[0] === "build") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await build({
      localWorkspaceFolder,
      baseTag: args.values["base-tag"],
    });
  } else if (args.positionals[0] === "init") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await init({ localWorkspaceFolder, force: args.values.force });
  } else if (args.positionals[0] === "volume") {
    console.log(configVolume);
  } else if (args.positionals[0] === "restart") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await start({ localWorkspaceFolder, restart: true, build: !!args.values.build });
  } else if (args.positionals[0] === "start") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await start({ localWorkspaceFolder, restart: false, build: !!args.values.build });
  } else if (args.positionals[0] === "stop") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await stop({ localWorkspaceFolder });
  } else if (args.positionals[0] === "shell") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await shell({ localWorkspaceFolder, restart: !!args.values.build, build: !!args.values.build });
  } else if (args.positionals[0] === "show-run") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await showRun({ localWorkspaceFolder });
  } else if (args.positionals[0] === "codex-import-auth") {
    await codexImportAuth();
  } else if (args.positionals[0] === "codex-logout") {
    await codexLogout();
  } else {
    const localWorkspaceFolder = process.cwd();
    await shell({ localWorkspaceFolder, restart: !!args.values.build, build: !!args.values.build });
  }
}

function configPath(args: { localWorkspaceFolder: string }) {
  return path.join(args.localWorkspaceFolder, ".agent-sandbox");
}

async function loadConfig(args: { localWorkspaceFolder: string }): Promise<SandboxConfig> {
  const configFile = path.join(configPath(args), "config.json");
  if (!fs.existsSync(configFile)) {
    return {};
  }
  const content = fs.readFileSync(configFile, "utf8");
  const parsed = JSON.parse(content);
  for (const port of parsed.ports) {
    if (typeof port !== "string" || !/^\d+(:\d+)?$/.test(port)) {
      throw new Error(`Invalid port: ${port}`);
    }
  }
  for (const readonly of parsed.readonly) {
    if (typeof readonly !== "string") {
      throw new Error(`Invalid readonly path: ${readonly}`);
    }
    // Make sure it's a reasonable-looking relative path
    if (readonly.startsWith("/")) {
      throw new Error(`Readonly paths should be relative: ${readonly}`);
    }
  }
  return parsed;
}

async function containerExists(localWorkspaceFolder: string) {
  const containerName = getContainerName({ localWorkspaceFolder });
  const containerExists = await $`docker ps -q --filter name=${containerName}`.quiet();
  return !!containerExists.stdout.trim();
}

async function buildBase(args: {
  tag: string;
  claudeCodeVersion: string;
  codexVersion: string;
  gitDeltaVersion: string;
  astGrepVersion: string;
}) {
  // Resolve floating versions to concrete versions so Docker cache can be reused
  async function resolveNpmVersion(pkg: string, requested: string): Promise<string> {
    if (requested !== "latest") return requested;
    try {
      const result = await $`npm view ${pkg} version`.quiet();
      const version = result.stdout.trim();
      if (!version) throw new Error("empty version");
      return version;
    } catch {
      console.log(
        chalk.yellow(
          `Warning: failed to resolve latest for ${pkg}. Falling back to 'latest' which may reduce cache reuse.`,
        ),
      );
      return requested;
    }
  }

  const baseDockerfilePath = path.join(__dirname, "..", "base-image", "Dockerfile");

  if (!fs.existsSync(baseDockerfilePath)) {
    console.error("Error: " + baseDockerfilePath + " not found.");
    process.exit(1);
  }

  const imageName = `agent-sandbox-base:${args.tag}`;

  // Resolve any 'latest' tags to concrete versions
  const resolvedClaude = await resolveNpmVersion("@anthropic-ai/claude-code", args.claudeCodeVersion);
  const resolvedCodex = await resolveNpmVersion("@openai/codex", args.codexVersion);
  const resolvedAstGrep = await resolveNpmVersion("@ast-grep/cli", args.astGrepVersion);

  const buildArgValues = {
    CLAUDE_CODE_VERSION: resolvedClaude,
    CODEX_VERSION: resolvedCodex,
    GIT_DELTA_VERSION: args.gitDeltaVersion,
    AST_GREP_VERSION: resolvedAstGrep,
  };

  const buildArgs = Object.entries(buildArgValues).flatMap(([key, value]) => [`--build-arg`, `${key}=${value}`]);

  console.log(chalk.cyan(`Building base image: ${imageName}`));
  console.log(
    chalk.gray(
      `Claude Code version: ${args.claudeCodeVersion}${
        args.claudeCodeVersion === "latest" ? ` -> ${resolvedClaude}` : ""
      }`,
    ),
  );
  console.log(
    chalk.gray(`Codex version: ${args.codexVersion}${args.codexVersion === "latest" ? ` -> ${resolvedCodex}` : ""}`),
  );
  console.log(chalk.gray(`Git Delta version: ${args.gitDeltaVersion}`));
  console.log(
    chalk.gray(
      `ast-grep version: ${args.astGrepVersion}${args.astGrepVersion === "latest" ? ` -> ${resolvedAstGrep}` : ""}`,
    ),
  );

  // No need to force --no-cache; resolved versions keep cache deterministic

  const contextPath = path.dirname(baseDockerfilePath);
  await $`docker build -t ${imageName} ${buildArgs} -f ${baseDockerfilePath} ${contextPath}`;

  console.log(chalk.green(`Successfully built base image: ${imageName}`));
}

async function build(args: { localWorkspaceFolder: string; baseTag?: string }) {
  const agentSandboxPath = configPath(args);
  const dockerfilePath = path.join(agentSandboxPath, "Dockerfile");

  if (!fs.existsSync(dockerfilePath)) {
    console.error("Error: .agent-sandbox/Dockerfile not found.");
    console.error(`Please run 'agent-sandbox init' in ${args.localWorkspaceFolder} first.`);
    process.exit(1);
  }

  const baseTag = args.baseTag || "latest";
  const buildArgValues = {
    BASE_IMAGE_TAG: baseTag,
  };

  const buildArgs = Object.entries(buildArgValues).flatMap(([key, value]) => [`--build-arg`, `${key}=${value}`]);

  const image = getImageName(args);

  console.log(chalk.cyan(`Building image: ${image}`));
  console.log(chalk.gray(`Using base image tag: ${baseTag}`));

  await $`docker build -t ${image} ${buildArgs} -f ${dockerfilePath} ${agentSandboxPath}`;

  console.log(chalk.green(`Successfully built image: ${image}`));
}

async function init(args: { localWorkspaceFolder: string; force: boolean }) {
  const agentSandboxPath = configPath(args);

  if ((await containerExists(args.localWorkspaceFolder)) && args.force) {
    console.log(chalk.yellow(`Container is running. Stopping...`));
    await stop(args);
  }

  if (fs.existsSync(agentSandboxPath)) {
    if (args.force) {
      console.log(chalk.yellow("Force removing existing .agent-sandbox directory"));
      await $`rm -r ${agentSandboxPath}`;
    } else {
      console.error("Error: .agent-sandbox directory already exists.");
      console.error("Remove it first if you want to reinitialize.");
      process.exit(1);
    }
  }

  const templatePath = path.join(__dirname, "..", "template");

  await $`cp -RL ${templatePath}/ ${agentSandboxPath}/`;

  console.log(chalk.green(`Initialized .agent-sandbox directory in ${args.localWorkspaceFolder}`));

  await build(args);
}

function getWorkspaceHash(localWorkspaceFolder: string): string {
  const fullPath = path.resolve(localWorkspaceFolder);
  return crypto.createHash("md5").update(fullPath).digest("hex");
}

function getImageName(args: { localWorkspaceFolder: string }) {
  const workspaceName = path.basename(args.localWorkspaceFolder);
  const hash = getWorkspaceHash(args.localWorkspaceFolder);
  return `agent-sandbox-${workspaceName}-${hash}`;
}

function getContainerName(args: { localWorkspaceFolder: string }) {
  const workspaceName = path.basename(args.localWorkspaceFolder);
  const hash = getWorkspaceHash(args.localWorkspaceFolder);
  return `agent-sandbox-${workspaceName}-${hash}`;
}

function getHistoryVolumeName(args: { localWorkspaceFolder: string }) {
  const workspaceName = path.basename(args.localWorkspaceFolder);
  const hash = getWorkspaceHash(args.localWorkspaceFolder);
  return `agent-sandbox-history-${workspaceName}-${hash}`;
}

async function getDockerRunArgs(args: { localWorkspaceFolder: string }) {
  const containerName = getContainerName(args);
  const historyVolume = getHistoryVolumeName(args);
  const config = await loadConfig(args);
  const workspaceName = path.basename(args.localWorkspaceFolder);

  const mounts = [
    `source=${historyVolume},target=/commandhistory,type=volume`,
    `source=${configVolume},target=/home/node/.claude,type=volume`,
    `source=${codexConfigVolume},target=/home/node/.codex,type=volume`,
    "source=/etc/localtime,target=/etc/localtime,type=bind,readonly",
  ];

  const env = {
    NODE_OPTIONS: "--max-old-space-size=4096",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
  };

  const workspaceMount = `source=${args.localWorkspaceFolder},target=/workspace/${workspaceName},type=bind,consistency=delegated`;

  const readonlyMounts = [];
  if (config.readonly) {
    for (const readonlyPath of config.readonly) {
      const sourcePath = path.join(args.localWorkspaceFolder, readonlyPath);
      if (fs.existsSync(sourcePath)) {
        const targetPath = `/workspace/${workspaceName}/${readonlyPath}`;
        readonlyMounts.push(`source=${sourcePath},target=${targetPath},type=bind,readonly`);
      }
    }
  }

  readonlyMounts.push(`source=${configPath(args)},target=/.agent-sandbox,type=bind,readonly`);

  const ports = config.ports || [];

  const runArgs = [
    "--name",
    containerName,
    "--label",
    `workspace=${args.localWorkspaceFolder}`,
    "-d",
    "--cap-add=NET_ADMIN",
    "--cap-add=NET_RAW",
    ...mounts.flatMap((mount) => ["--mount", mount]),
    "--mount",
    workspaceMount,
    ...readonlyMounts.flatMap((mount) => ["--mount", mount]),
    "--workdir",
    `/workspace/${workspaceName}`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...ports.flatMap((port) => ["-p", port]),
  ];

  return { runArgs, containerName };
}

async function start(args: { localWorkspaceFolder: string; build: boolean; restart: boolean }) {
  const image = getImageName(args);
  const imageExists = await $`docker images -q ${image}`.quiet();
  if (!imageExists.stdout.trim() || args.build) {
    await build(args);
  }

  const containerName = getContainerName(args);
  if (await containerExists(args.localWorkspaceFolder)) {
    if (args.restart) {
      await stop(args);
    } else {
      console.log(`Container ${containerName} is already running`);
      return;
    }
  }

  const { runArgs } = await getDockerRunArgs(args);

  await $`docker run ${runArgs} ${image} tail -f /dev/null`.quiet();
  console.log(`Started container: ${containerName}`);
}

async function showRun(args: { localWorkspaceFolder: string }) {
  const image = getImageName(args);
  const imageExists = await $`docker images -q ${image}`.quiet();
  if (!imageExists.stdout.trim()) {
    console.log(chalk.yellow(`Image ${image} not found. Run 'agent-sandbox build' first.`));
    return;
  }

  const { runArgs } = await getDockerRunArgs(args);

  // Use JSON.stringify for proper shell escaping
  const escapeArg = (arg: string) => {
    // If arg contains spaces, quotes, or special shell characters, escape it
    if (/[ "'$`\\\n\t;|&()<>]/.test(arg)) {
      return JSON.stringify(arg);
    }
    return arg;
  };

  const command = `docker run ${runArgs.map(escapeArg).join(" ")} ${image} tail -f /dev/null`;
  console.log(chalk.cyan("Docker run command:"));
  console.log(command);
}

async function shell(args: { localWorkspaceFolder: string; restart: boolean; build: boolean }) {
  const exists = await containerExists(args.localWorkspaceFolder);
  if (!exists || args.restart) {
    await start(args);
  }

  const containerName = getContainerName(args);
  await $({
    stdio: "inherit",
  })`docker exec -it ${containerName} bash`;
}

async function stop(args: { localWorkspaceFolder: string }) {
  const containerName = getContainerName(args);
  await $`docker stop ${containerName}`.quiet();
  await $`docker rm ${containerName}`.quiet();
  console.log(`Container ${containerName} stopped and removed`);
}

async function codexImportAuth() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    console.error("Unable to determine HOME directory on host.");
    process.exit(1);
  }

  const hostCodexDir = path.join(home, ".codex");
  if (!fs.existsSync(hostCodexDir)) {
    console.error(`No host Codex directory found at ${hostCodexDir}`);
    process.exit(1);
  }

  const authPath = path.join(hostCodexDir, "auth.json");
  if (!fs.existsSync(authPath)) {
    console.error(`No auth.json found at ${hostCodexDir}. Run \`codex login\` on the host first.`);
    process.exit(1);
  }

  console.log(chalk.cyan("Importing host Codex auth into shared volume..."));
  const baseImage = "agent-sandbox-base:latest";
  const script = [
    "cp -f /src/auth.json /dst/ 2>/dev/null || true",
    "cp -f /src/profile.json /dst/ 2>/dev/null || true",
    "echo 'Current files in shared volume:'",
    "ls -la /dst",
  ].join("; ");
  const result =
    await $`docker run --rm --entrypoint /bin/bash -v ${hostCodexDir}:/src:ro -v ${codexConfigVolume}:/dst ${baseImage} -lc ${script}`.quiet();

  console.log(chalk.green("Codex auth import completed."));
  process.stdout.write(result.stdout);
}

async function codexLogout() {
  console.log(chalk.cyan("Removing local Codex credentials from shared volume..."));
  const baseImage = "agent-sandbox-base:latest";
  const script = "rm -f /dst/auth.json /dst/profile.json; echo 'Remaining files in shared volume:'; ls -la /dst";
  const result =
    await $`docker run --rm --entrypoint /bin/bash -v ${codexConfigVolume}:/dst ${baseImage} -lc ${script}`.quiet();
  console.log(chalk.green("Local Codex credentials deleted from the volume."));
  process.stdout.write(result.stdout);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
