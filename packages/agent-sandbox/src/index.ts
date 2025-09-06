import path from "node:path";
import { parseArgs } from "util";
import { $, chalk } from "zx";
import fs from "node:fs";
import os from "node:os";
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
      auth: {
        type: "boolean",
        default: false,
      },
      branch: {
        type: "string",
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
    await start({
      localWorkspaceFolder,
      restart: true,
      build: !!args.values.build,
      branch: args.values.branch,
      baseTag: args.values["base-tag"],
    });
  } else if (args.positionals[0] === "start") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await start({
      localWorkspaceFolder,
      restart: false,
      build: !!args.values.build,
      branch: args.values.branch,
      baseTag: args.values["base-tag"],
    });
  } else if (args.positionals[0] === "stop") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await stop({ localWorkspaceFolder, branch: args.values.branch });
  } else if (args.positionals[0] === "shell") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await shell({
      localWorkspaceFolder,
      restart: !!args.values.build,
      build: !!args.values.build,
      branch: args.values.branch,
      baseTag: args.values["base-tag"],
    });
  } else if (args.positionals[0] === "show-run") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await showRun({
      localWorkspaceFolder,
      branch: args.values.branch,
      baseTag: args.values["base-tag"],
    });
  } else if (args.positionals[0] === "checkout") {
    const branch = args.positionals[1];
    if (!branch) {
      console.error("Usage: agent-sandbox checkout <branch> [--base-tag <tag>]");
      process.exit(1);
    }
    const localWorkspaceFolder = process.cwd();
    await ensureShelfAndWorktree({
      localWorkspaceFolder,
      branch,
      baseTag: args.values["base-tag"],
    });
    console.log(chalk.green(`Provisioned worktree for '${branch}'.`));
  } else if (args.positionals[0] === "list") {
    await listContainers();
  } else if (args.positionals[0] === "codex-init-config") {
    await codexInitConfig({ auth: args.values.auth, force: args.values.force });
  } else if (args.positionals[0] === "codex-logout") {
    await codexLogout();
  } else {
    const localWorkspaceFolder = process.cwd();
    await shell({
      localWorkspaceFolder,
      restart: !!args.values.build,
      build: !!args.values.build,
      branch: args.values.branch,
      baseTag: args.values["base-tag"],
    });
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

async function containerExists(localWorkspaceFolder: string, branchSan?: string | null) {
  const containerName = getContainerName({ localWorkspaceFolder, branchSan });
  const nameFilter = `^/?${escapeRegex(containerName)}$`;
  const containerExists = await $`docker ps -q --filter name=${nameFilter}`.quiet();
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

function getContainerName(args: { localWorkspaceFolder: string; branchSan?: string | null }) {
  const workspaceName = path.basename(args.localWorkspaceFolder);
  const hash = getWorkspaceHash(args.localWorkspaceFolder);
  if (args.branchSan) {
    return `agent-sandbox-${workspaceName}-${args.branchSan}-${hash}`;
  }
  return `agent-sandbox-${workspaceName}-${hash}`;
}

function getHistoryVolumeName(args: { localWorkspaceFolder: string }) {
  const workspaceName = path.basename(args.localWorkspaceFolder);
  const hash = getWorkspaceHash(args.localWorkspaceFolder);
  return `agent-sandbox-history-${workspaceName}-${hash}`;
}

async function getDockerRunArgs(args: {
  localWorkspaceFolder: string;
  branch?: string | null;
  baseTag?: string | null;
}) {
  const branch = args.branch || null;
  const branchSan = branch ? sanitizeBranch(branch) : null;
  const containerName = getContainerName({ localWorkspaceFolder: args.localWorkspaceFolder, branchSan });
  const historyVolume = getHistoryVolumeName(args);
  const config = await loadConfig(args);
  const workspaceName = path.basename(args.localWorkspaceFolder);
  const repoShelfVolume = getRepoShelfVolumeNameFromPath(args.localWorkspaceFolder);

  const mounts = [
    `source=${historyVolume},target=/commandhistory,type=volume`,
    `source=${configVolume},target=/home/node/.claude,type=volume`,
    `source=${codexConfigVolume},target=/home/node/.codex,type=volume`,
    "source=/etc/localtime,target=/etc/localtime,type=bind,readonly",
    `source=${repoShelfVolume},target=/repo-shelf,type=volume`,
  ];

  const env = {
    NODE_OPTIONS: "--max-old-space-size=4096",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
  };

  const workspaceMount = `source=${args.localWorkspaceFolder},target=/workspace/${workspaceName},type=bind,consistency=delegated`;

  const readonlyMounts: string[] = [];
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
    ...(branchSan ? ["--label", `branch=${branchSan}`] : []),
    "--label",
    `repoShelfVolume=${repoShelfVolume}`,
    "-d",
    "--cap-add=NET_ADMIN",
    "--cap-add=NET_RAW",
    ...mounts.flatMap((mount) => ["--mount", mount]),
    "--mount",
    workspaceMount,
    ...readonlyMounts.flatMap((mount) => ["--mount", mount]),
    "--workdir",
    branchSan ? `/repo-shelf/worktrees/${branchSan}` : `/workspace/${workspaceName}`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...ports.flatMap((port) => ["-p", port]),
  ];

  return { runArgs, containerName };
}

async function start(args: {
  localWorkspaceFolder: string;
  build: boolean;
  restart: boolean;
  branch?: string | null;
  baseTag?: string | null;
}) {
  const branchSan = args.branch ? sanitizeBranch(args.branch) : null;
  if (args.branch) {
    await ensureShelfAndWorktree({
      localWorkspaceFolder: args.localWorkspaceFolder,
      branch: args.branch,
      baseTag: args.baseTag || "latest",
    });
  }

  const image = getImageName({ localWorkspaceFolder: args.localWorkspaceFolder });
  const imageExists = await $`docker images -q ${image}`.quiet();
  if (!imageExists.stdout.trim() || args.build) {
    await build({ localWorkspaceFolder: args.localWorkspaceFolder, baseTag: args.baseTag || undefined });
  }

  const containerName = getContainerName({ localWorkspaceFolder: args.localWorkspaceFolder, branchSan });
  if (await containerExists(args.localWorkspaceFolder, branchSan)) {
    if (args.restart) {
      await stop(args);
    } else {
      console.log(`Container ${containerName} is already running`);
      return;
    }
  }

  const { runArgs } = await getDockerRunArgs({
    localWorkspaceFolder: args.localWorkspaceFolder,
    branch: args.branch,
    baseTag: args.baseTag,
  });

  await $`docker run ${runArgs} ${image} tail -f /dev/null`.quiet();
  console.log(`Started container: ${containerName}`);
}

async function showRun(args: { localWorkspaceFolder: string; branch?: string | null; baseTag?: string | null }) {
  const image = getImageName({ localWorkspaceFolder: args.localWorkspaceFolder });
  const imageExists = await $`docker images -q ${image}`.quiet();
  if (!imageExists.stdout.trim()) {
    console.log(chalk.yellow(`Image ${image} not found. Run 'agent-sandbox build' first.`));
    return;
  }

  const { runArgs } = await getDockerRunArgs({
    localWorkspaceFolder: args.localWorkspaceFolder,
    branch: args.branch,
    baseTag: args.baseTag,
  });

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

async function shell(args: {
  localWorkspaceFolder: string;
  restart: boolean;
  build: boolean;
  branch?: string | null;
  baseTag?: string | null;
}) {
  const branchSan = args.branch ? sanitizeBranch(args.branch) : null;
  const exists = await containerExists(args.localWorkspaceFolder, branchSan);
  if (!exists || args.restart) {
    await start(args);
  }

  const containerName = getContainerName({ localWorkspaceFolder: args.localWorkspaceFolder, branchSan });
  await $({
    stdio: "inherit",
  })`docker exec -it ${containerName} bash`;
}

async function stop(args: { localWorkspaceFolder: string; branch?: string | null }) {
  const branchSan = args.branch ? sanitizeBranch(args.branch) : null;
  const containerName = getContainerName({ localWorkspaceFolder: args.localWorkspaceFolder, branchSan });
  await $`docker stop ${containerName}`.quiet();
  await $`docker rm ${containerName}`.quiet();
  console.log(`Container ${containerName} stopped and removed`);
}

async function codexInitConfig(args: { auth: boolean; force: boolean }) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    console.error("Unable to determine HOME directory on host.");
    process.exit(1);
  }

  // Prepare template files for config.toml and AGENTS.md in a temp dir
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-init-"));
  const templatesDir = path.join(tmpBase, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });

  const configToml = ["[profiles.high]", 'model = "gpt-5"', 'model_reasoning_effort = "high"', ""].join("\n");

  const agentsMd = `# Context for AI agents (sandbox)

You are working within a containerized sandbox environment ("agent-sandbox"), intended to be a space where you can exercise autonomy more freely.

## Installed Tools
- git, node, npm
- ast-grep: Structural search and rewrite tool. Available in the agent-sandbox base image as \`ast-grep\` (help: \`ast-grep --help\`, docs: https://ast-grep.github.io/llms.txt).
`;

  fs.writeFileSync(path.join(templatesDir, "config.toml"), configToml, "utf8");
  fs.writeFileSync(path.join(templatesDir, "AGENTS.md"), agentsMd, "utf8");

  // Optional host auth directory
  const hostCodexDir = path.join(home, ".codex");
  if (args.auth) {
    if (!fs.existsSync(hostCodexDir)) {
      console.error(`No host Codex directory found at ${hostCodexDir}`);
      console.error("Run 'codex login' on the host first or omit --auth.");
      process.exit(1);
    }
  }

  console.log(chalk.cyan("Initializing Codex config volume..."));
  const baseImage = "agent-sandbox-base:latest";

  const scriptLines: string[] = [];
  scriptLines.push(
    // Create destination directory if it doesn't exist
    "mkdir -p /dst",
    // config.toml
    'if [ -f /dst/config.toml ] && [ "$FORCE" != "1" ]; then echo \'config.toml exists; leaving as-is\'; else cp -f /src-templates/config.toml /dst/config.toml; fi',
    // AGENTS.md
    'if [ -f /dst/AGENTS.md ] && [ "$FORCE" != "1" ]; then echo \'AGENTS.md exists; leaving as-is\'; else cp -f /src-templates/AGENTS.md /dst/AGENTS.md; fi',
  );

  if (args.auth) {
    // auth.json
    scriptLines.push("cp -f /src-auth/auth.json /dst/");
    // profile.json
    scriptLines.push(
      "if [ -f /src-auth/profile.json ]; then ",
      '  if [ -f /dst/profile.json ] && [ "$FORCE" != "1" ]; then echo \'profile.json exists; leaving as-is\'; else cp -f /src-auth/profile.json /dst/; fi; ',
      "else echo 'No profile.json on host; skipping'; fi",
    );
  }

  scriptLines.push("echo 'Current files in shared volume:'", "ls -la /dst");
  const script = scriptLines.join("; ");

  const dockerArgs = [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/bash",
    "-v",
    `${templatesDir}:/src-templates:ro`,
    "-v",
    `${codexConfigVolume}:/dst`,
  ];
  if (args.auth) {
    dockerArgs.push("-v", `${hostCodexDir}:/src-auth:ro`);
  }
  dockerArgs.push("-e", `FORCE=${args.force ? "1" : "0"}`);
  dockerArgs.push(baseImage, "-lc", script);

  try {
    const result = await $`docker ${dockerArgs}`.quiet();
    process.stdout.write(result.stdout);
    console.log(chalk.green("Codex config initialization complete."));
  } finally {
    // Best-effort cleanup of temporary templates directory
    try {
      await fs.promises.rm(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
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

// --- Branch-aware helpers ---
function sanitizeBranch(name: string): string {
  return name.replace(/[\s/]+/g, "__");
}

// Repo-shelf volume naming: hash the absolute host path
function getRepoShelfVolumeNameFromPath(localWorkspaceFolder: string): string {
  const fullPath = path.resolve(localWorkspaceFolder);
  const hash = crypto.createHash("md5").update(fullPath).digest("hex");
  return `agent-sbx-repo-${hash}`;
}

async function ensureShelfAndWorktree(args: { localWorkspaceFolder: string; branch: string; baseTag?: string | null }) {
  const repoName = path.basename(args.localWorkspaceFolder);
  const branchSan = sanitizeBranch(args.branch);
  const repoShelfVolume = getRepoShelfVolumeNameFromPath(args.localWorkspaceFolder);
  const baseImage = `agent-sandbox-base:${args.baseTag || "latest"}`;

  await $`docker volume create ${repoShelfVolume}`.quiet();

  const script = [
    "set -euo pipefail",
    "mkdir -p /repo-shelf/worktrees",
    'HOST_URL="file:///workspace/$REPO_NAME"',
    '[ -d /repo-shelf/repo/.git ] || git clone --no-checkout "$HOST_URL" /repo-shelf/repo',
    'git -C /repo-shelf/repo remote add host "$HOST_URL" || git -C /repo-shelf/repo remote set-url host "$HOST_URL"',
    // Intentionally do not set an 'origin' remote inside the shelf repo (host-only provisioning)
    "git -C /repo-shelf/repo fetch --prune host",
    'BR_DIR="/repo-shelf/worktrees/$BRANCH_SAN"',
    "if git -C /repo-shelf/repo rev-parse --verify --quiet refs/remotes/host/$BRANCH_NAME; then",
    '  git -C /repo-shelf/repo worktree add -B "$BRANCH_NAME" "$BR_DIR" "host/$BRANCH_NAME" || true',
    "else",
    '  DEFAULT_BRANCH=$(git -C /repo-shelf/repo symbolic-ref --short -q refs/remotes/host/HEAD | sed "s#^host/##" || true)',
    '  [ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH=$(git -C /workspace/$REPO_NAME symbolic-ref --short -q refs/remotes/origin/HEAD | sed "s#^origin/##" || true)',
    '  [ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH=main',
    '  git -C /repo-shelf/repo worktree add -b "$BRANCH_NAME" "$BR_DIR" "host/$DEFAULT_BRANCH" || true',
    "fi",
    'test -d "$BR_DIR" || { echo >&2 "Failed to create worktree at $BR_DIR"; exit 1; }',
    "# Ensure consistent ownership to avoid Git 'dubious ownership' errors",
    "# 1) Always fix ownership of the just-created worktree directory",
    "if ! su -s /bin/sh -c 'test -w \"$BR_DIR\"' node; then",
    '  chown -R node:node "$BR_DIR" || true',
    "fi",
    "# 2) Best-effort sweep if parent paths aren't writable by node (covers first-time setup)",
    "NEED_CHOWN=0",
    "su -s /bin/sh -c 'test -w /repo-shelf/repo' node || NEED_CHOWN=1",
    "su -s /bin/sh -c 'test -w /repo-shelf/worktrees' node || NEED_CHOWN=1",
    'if [ "$NEED_CHOWN" = "1" ]; then',
    "  # Constrain ownership change to the volume and avoid following symlinks",
    "  find /repo-shelf/repo /repo-shelf/worktrees -xdev '(' -not -user node -o -not -group node ')' -exec chown -h node:node {} +",
    "fi",
  ].join("\n");

  const dockerArgs = [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/bash",
    "-u",
    "0:0",
    // no ORIGIN_URL exported; we avoid wiring upstream remote inside the shelf repo
    "-e",
    `REPO_NAME=${repoName}`,
    "-e",
    `BRANCH_NAME=${args.branch}`,
    "-e",
    `BRANCH_SAN=${branchSan}`,
    "-v",
    `${repoShelfVolume}:/repo-shelf`,
    "-v",
    `${args.localWorkspaceFolder}:/workspace/${repoName}:ro`,
    baseImage,
    "-lc",
    script,
  ];

  await $`docker ${dockerArgs}`.quiet();
}

async function listContainers() {
  const fmt = '{{.Names}}\t{{.Label "workspace"}}\t{{.Label "branch"}}\t{{.Label "repoShelfVolume"}}';
  const ps = await $`docker ps --format ${fmt}`.quiet();
  const lines = ps.stdout.trim().split("\n").filter(Boolean);
  if (!lines.length) {
    console.log("No running agent-sandbox containers.");
    return;
  }
  const rows: Array<{ name: string; mode: string; workdir: string; volume: string; hostPath: string }> = [];
  for (const line of lines) {
    const [name, hostPath, , volumeLabel] = line.split("\t");
    if (!name || !hostPath) continue;
    const inspect = await $`docker inspect -f ${"{{.Config.WorkingDir}}"} ${name}`.quiet();
    const workdir = inspect.stdout.trim();
    const mode = workdir.startsWith("/repo-shelf/worktrees/") ? "branch" : "bind";
    let volume = volumeLabel || "";
    if (!volume) {
      volume = getRepoShelfVolumeNameFromPath(hostPath);
    }
    rows.push({ name, mode, workdir, volume, hostPath });
  }
  // Print header
  console.log(["CONTAINER", "MODE", "WORKDIR", "REPO-SHELF-VOLUME", "HOST-PATH"].join("\t"));
  for (const r of rows) {
    console.log([r.name, r.mode, r.workdir, r.volume, r.hostPath].join("\t"));
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
