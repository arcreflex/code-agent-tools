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
    if (typeof port !== "number") {
      throw new Error(`Invalid port number: ${port}`);
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

  const config = await loadConfig(args);

  const mounts = [
    "source=agent-sandbox-bashhistory,target=/commandhistory,type=volume",
    `source=${configVolume},target=/home/node/.claude,type=volume`,
    "source=/etc/localtime,target=/etc/localtime,type=bind,readonly",
  ];

  const env = {
    NODE_OPTIONS: "--max-old-space-size=4096",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
  };

  const workspaceName = path.basename(args.localWorkspaceFolder);
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

  // This is a little funny: mount .agent-sandbox into the container as /.agent-sandbox, even though it's already
  // mounted in as part of the workspace itself.
  // This lets other tools look for that path as a way to check if they're running in the agent sandbox.
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
