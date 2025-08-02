import path from "node:path";
import { parseArgs } from "util";
import { $ } from "zx";

const __dirname = new URL(".", import.meta.url).pathname;
const image = "claude-code-sandbox";

async function main() {
  const args = parseArgs({
    allowPositionals: true,
  });

  if (args.positionals[0] === "build") {
    await build();
  } else {
    const localWorkspaceFolder = args.positionals[0] || process.cwd();

    await run({ localWorkspaceFolder });
  }
}

async function build() {
  const args = {
    TZ: "America/New_York",
    CLAUDE_CODE_VERSION: "latest",
    GIT_DELTA_VERSION: "0.18.2",
    ZSH_IN_DOCKER_VERSION: "1.2.0",
  };

  const buildArgs = Object.entries(args).flatMap(([key, value]) => [
    `--build-arg`,
    `${key}=${value}`,
  ]);

  await $`docker build -t ${image} ${buildArgs} ${__dirname}`;
}

async function run(args: { localWorkspaceFolder: string }) {
  const mounts = [
    "source=claude-code-bashhistory-ccsb,target=/commandhistory,type=volume",
    "source=claude-code-config-ccsb,target=/home/node/.claude,type=volume",
  ];

  const env = {
    NODE_OPTIONS: "--max-old-space-size=4096",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
    POWERLEVEL9K_DISABLE_GITSTATUS: "true",
  };

  // get the current directory name (just the last part of the path)
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
