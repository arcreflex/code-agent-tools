import path from "node:path";
import { parseArgs } from "util";
import { $, chalk } from "zx";
import fs from "node:fs";
import crypto from "node:crypto";

const __dirname = new URL(".", import.meta.url).pathname;
const image = "agent-sandbox";
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
  } else if (args.positionals[0] === "shell") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await shell({ localWorkspaceFolder });
  } else if (args.positionals[0] === "stop") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await stop({ localWorkspaceFolder });
  } else {
    const localWorkspaceFolder = args.positionals[0] || process.cwd();
    const containerName = getContainerName({ localWorkspaceFolder });
    const containerExists =
      await $`docker ps -q --filter name=${containerName}`.quiet();
    if (containerExists) {
      console.log(
        chalk.yellow(`Container ${containerName} is already running.`),
      );
      console.log(
        chalk.yellow(`Use 'agent-sandbox shell' to enter the container.`),
      );
      process.exit(0);
    }
  }
}

function configPath(args: { localWorkspaceFolder: string }) {
  return path.join(args.localWorkspaceFolder, ".agent-sandbox");
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

  await $`docker build -t ${image} ${buildArgs} -f ${dockerfilePath} ${agentSandboxPath}`;
}

async function init(args: { localWorkspaceFolder: string; force: boolean }) {
  const agentSandboxPath = configPath(args);

  if (fs.existsSync(agentSandboxPath) && !args.force) {
    console.error("Error: .agent-sandbox directory already exists.");
    console.error("Remove it first if you want to reinitialize.");
    process.exit(1);
  }

  const templatePath = path.join(__dirname, "template");

  await $`cp -r ${templatePath}/ ${agentSandboxPath}/`;

  console.log(
    chalk.green(
      `Initialized .agent-sandbox directory in ${args.localWorkspaceFolder}`,
    ),
  );
}

function getContainerName(args: { localWorkspaceFolder: string }) {
  // hash the full path just in case
  const fullPath = path.resolve(args.localWorkspaceFolder);
  const hash = crypto.createHash("md5").update(fullPath).digest("hex");
  return `agent-sandbox-${path.basename(args.localWorkspaceFolder)}-${hash}`;
}

async function start(args: { localWorkspaceFolder: string }) {
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

  const mounts = [
    "source=agent-sandbox-bashhistory,target=/commandhistory,type=volume",
    `source=${configVolume},target=/home/node/.claude,type=volume`,
    "source=/etc/localtime,target=/etc/localtime,type=bind,readonly",
  ];

  const env = {
    NODE_OPTIONS: "--max-old-space-size=4096",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
    POWERLEVEL9K_DISABLE_GITSTATUS: "true",
  };

  const workspaceName = path.basename(args.localWorkspaceFolder);
  const workspaceMount = `source=${args.localWorkspaceFolder},target=/workspace/${workspaceName},type=bind,consistency=delegated`;

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
    "--workdir",
    `/workspace/${workspaceName}`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  ];

  await $`docker run ${runArgs} ${image} tail -f /dev/null`.quiet();
  console.log(`Started container: ${containerName}`);
}

async function shell(args: { localWorkspaceFolder: string }) {
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
