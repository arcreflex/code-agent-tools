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

async function main() {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      force: {
        type: "boolean",
        default: false,
      },
    },
  });

  if (args.positionals[0] === "build") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await build({ localWorkspaceFolder });
  } else if (args.positionals[0] === "init") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await init({ localWorkspaceFolder, force: args.values.force });
  } else if (args.positionals[0] === "volume") {
    console.log(configVolume);
  } else if (args.positionals[0] === "start") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await start({ localWorkspaceFolder });
  } else if (args.positionals[0] === "stop") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await stop({ localWorkspaceFolder });
  } else if (args.positionals[0] === "shell") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await shell({ localWorkspaceFolder });
  } else if (args.positionals[0] === "show-run") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await showRun({ localWorkspaceFolder });
  } else {
    const localWorkspaceFolder = process.cwd();
    await shell({ localWorkspaceFolder });
  }
}

function configPath(args: { localWorkspaceFolder: string }) {
  return path.join(args.localWorkspaceFolder, ".agent-sandbox");
}

async function loadConfig(args: {
  localWorkspaceFolder: string;
}): Promise<SandboxConfig> {
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
  const containerExists =
    await $`docker ps -q --filter name=${containerName}`.quiet();
  return !!containerExists.stdout.trim();
}

async function build(args: { localWorkspaceFolder: string }) {
  const agentSandboxPath = configPath(args);
  const dockerfilePath = path.join(agentSandboxPath, "Dockerfile");

  if (!fs.existsSync(dockerfilePath)) {
    console.error("Error: .agent-sandbox/Dockerfile not found.");
    console.error(
      `Please run 'agent-sandbox init' in ${args.localWorkspaceFolder} first.`,
    );
    process.exit(1);
  }

  const buildArgValues = {
    CLAUDE_CODE_VERSION: "latest",
    GIT_DELTA_VERSION: "0.18.2",
  };

  const buildArgs = Object.entries(buildArgValues).flatMap(([key, value]) => [
    `--build-arg`,
    `${key}=${value}`,
  ]);

  const image = getImageName(args);

  await $`docker build -t ${image} ${buildArgs} -f ${dockerfilePath} ${agentSandboxPath}`;
}

async function init(args: { localWorkspaceFolder: string; force: boolean }) {
  const agentSandboxPath = configPath(args);

  if ((await containerExists(args.localWorkspaceFolder)) && args.force) {
    console.log(chalk.yellow(`Container is running. Stopping...`));
    await stop(args);
  }

  if (fs.existsSync(agentSandboxPath)) {
    if (args.force) {
      console.log(
        chalk.yellow("Force removing existing .agent-sandbox directory"),
      );
      await $`rm -r ${agentSandboxPath}`;
    } else {
      console.error("Error: .agent-sandbox directory already exists.");
      console.error("Remove it first if you want to reinitialize.");
      process.exit(1);
    }
  }

  const templatePath = path.join(__dirname, "..", "template");

  await $`cp -RL ${templatePath}/ ${agentSandboxPath}/`;

  console.log(
    chalk.green(
      `Initialized .agent-sandbox directory in ${args.localWorkspaceFolder}`,
    ),
  );

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
        readonlyMounts.push(
          `source=${sourcePath},target=${targetPath},type=bind,readonly`,
        );
      }
    }
  }

  readonlyMounts.push(
    `source=${configPath(args)},target=/.agent-sandbox,type=bind,readonly`,
  );

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

async function start(args: { localWorkspaceFolder: string }) {
  const image = getImageName(args);
  const imageExists = await $`docker images -q ${image}`.quiet();
  if (!imageExists) {
    console.log(chalk.yellow(`Image ${image} not found. Building...`));
    await build(args);
  }

  const containerName = getContainerName(args);

  // Check if already running
  const running = await $`docker ps -q --filter name=${containerName}`.quiet();
  if (running.stdout.trim()) {
    console.log(`Container ${containerName} is already running`);
    return;
  }

  const { runArgs } = await getDockerRunArgs(args);

  await $`docker run ${runArgs} ${image} tail -f /dev/null`.quiet();
  console.log(`Started container: ${containerName}`);
}

async function showRun(args: { localWorkspaceFolder: string }) {
  const image = getImageName(args);
  const imageExists = await $`docker images -q ${image}`.quiet();
  if (!imageExists) {
    console.log(
      chalk.yellow(
        `Image ${image} not found. Run 'agent-sandbox build' first.`,
      ),
    );
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

async function shell(args: { localWorkspaceFolder: string }) {
  if (!(await containerExists(args.localWorkspaceFolder))) {
    console.log(chalk.yellow(`Container is not running. Starting...`));
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
