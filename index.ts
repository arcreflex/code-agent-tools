import path from "node:path";
import { parseArgs } from "util";
import { $ } from "zx";
import fs from "node:fs";

const __dirname = new URL(".", import.meta.url).pathname;
const image = "claude-code-sandbox";

async function main() {
  const args = parseArgs({
    allowPositionals: true,
  });

  if (args.positionals[0] === "build") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await build({ localWorkspaceFolder });
  } else if (args.positionals[0] === "init") {
    const localWorkspaceFolder = args.positionals[1] || process.cwd();
    await init({ localWorkspaceFolder });
  } else {
    const localWorkspaceFolder = args.positionals[0] || process.cwd();

    await run({ localWorkspaceFolder });
  }
}

async function build(args: { localWorkspaceFolder: string }) {
  const ccsbPath = path.join(args.localWorkspaceFolder, ".ccsb");
  const dockerfilePath = path.join(ccsbPath, "Dockerfile");

  if (!fs.existsSync(dockerfilePath)) {
    console.error("Error: .ccsb/Dockerfile not found.");
    console.error(
      `Please run 'ccsb init' in ${args.localWorkspaceFolder} first.`,
    );
    process.exit(1);
  }

  const buildArgValues = {
    TZ: "America/New_York",
    CLAUDE_CODE_VERSION: "latest",
    GIT_DELTA_VERSION: "0.18.2",
  };

  const buildArgs = Object.entries(buildArgValues).flatMap(([key, value]) => [
    `--build-arg`,
    `${key}=${value}`,
  ]);

  await $`docker build -t ${image} ${buildArgs} -f ${dockerfilePath} ${ccsbPath}`;
}

async function init(args: { localWorkspaceFolder: string }) {
  const ccsbPath = path.join(args.localWorkspaceFolder, ".ccsb");

  if (fs.existsSync(ccsbPath)) {
    console.error("Error: .ccsb directory already exists.");
    console.error("Remove it first if you want to reinitialize.");
    process.exit(1);
  }

  const templatePath = path.join(__dirname, "template");

  await $`cp -r ${templatePath} ${ccsbPath}`;

  console.log(`Initialized .ccsb directory in ${args.localWorkspaceFolder}`);
  console.log(
    "You can now customize .ccsb/Dockerfile and .ccsb/scripts/ as needed.",
  );
}

async function run(args: { localWorkspaceFolder: string }) {
  const ccsbPath = path.join(args.localWorkspaceFolder, ".ccsb");
  const dockerfilePath = path.join(ccsbPath, "Dockerfile");

  if (!fs.existsSync(dockerfilePath)) {
    console.error("Error: .ccsb/Dockerfile not found.");
    console.error(
      `Please run 'ccsb init' in ${args.localWorkspaceFolder} first.`,
    );
    process.exit(1);
  }

  const mounts = [
    "source=claude-code-bashhistory-ccsb,target=/commandhistory,type=volume",
    "source=claude-code-config-ccsb,target=/home/node/.claude,type=volume",
  ];

  const env = {
    NODE_OPTIONS: "--max-old-space-size=4096",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
    POWERLEVEL9K_DISABLE_GITSTATUS: "true",
  };

  const workspaceName = path.basename(args.localWorkspaceFolder);

  const workspaceMount = `source=${args.localWorkspaceFolder},target=/workspace/${workspaceName},type=bind,consistency=delegated`;

  const runArgs = [
    "--cap-add=NET_ADMIN",
    "--cap-add=NET_RAW",
    ...mounts.flatMap((mount) => ["--mount", mount]),
    "--mount",
    workspaceMount,
    "--workdir",
    `/workspace/${workspaceName}`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  ];

  await $({
    stdio: "inherit",
  })`docker run --rm -it ${runArgs} ${image}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
