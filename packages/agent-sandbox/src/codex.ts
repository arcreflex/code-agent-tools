import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { $ } from "zx";

import { getConfigVolume, loadRepoAndConfigInfo } from "./paths.ts";

$.verbose = false;

export interface CodexInitOptions {
  readonly force?: boolean;
  readonly auth?: boolean;
  readonly repoPath: string;
}

export async function initCodexConfig(options: CodexInitOptions): Promise<void> {
  const volume = getConfigVolume();

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-init-"));
  try {
    const instructionsSource = path.join(tempDir, "instructions.md");
    const instructionsContent = await loadInstructions(options.repoPath);
    if (instructionsContent) {
      await fs.writeFile(instructionsSource, instructionsContent, "utf8");
    }

    const authSource = await prepareAuthFile(options.auth === true);

    const args = [
      "run",
      "--rm",
      "--user",
      "node",
      "--env",
      `FORCE=${options.force ? "1" : "0"}`,
      "--env",
      `AUTH=${options.auth ? "1" : "0"}`,
      "--mount",
      `type=volume,src=${volume},dst=/config`,
      "--mount",
      `type=bind,src=${instructionsSource},dst=/tmp/instructions.md,ro`,
    ];

    if (authSource) {
      args.push("--mount", `type=bind,src=${authSource},dst=/tmp/auth.json,ro`);
    }

    args.push("node:24-bookworm-slim");
    args.push("bash", "-lc", buildCodexScript());

    await $({ stdio: "inherit" })`docker ${args}`;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function loadInstructions(repoPath: string): Promise<string | undefined> {
  const info = await loadRepoAndConfigInfo(repoPath);
  if (!info.agentsTemplatePath) return undefined;
  return fs.readFile(info.agentsTemplatePath, "utf8");
}

async function prepareAuthFile(requestAuth: boolean): Promise<string | undefined> {
  if (!requestAuth) {
    return undefined;
  }
  const home = process.env.HOME ?? os.homedir();
  const authPath = path.join(home, ".codex", "auth.json");
  try {
    await fs.access(authPath);
    return authPath;
  } catch {
    console.warn("Codex auth requested but ~/.codex/auth.json not found; skipping.");
    return undefined;
  }
}

function buildCodexScript(): string {
  return `
set -euo pipefail
mkdir -p /config/.codex

write_if_needed() {
  local target="$1"
  local message="$2"
  local content="$3"
  if [ "$FORCE" = "1" ] || [ ! -f "$target" ]; then
    printf '%s\n' "$content" >"$target"
    echo "$message"
  else
    echo "\${target##/config/.codex/} already present; leaving as-is."
  fi
}

write_if_needed \\
  /config/.codex/config.toml \\
  "Ensured config.toml" \\
  '[profiles.high]\nmodel = "gpt-5-codex"\nreasoning_effort = "high"\n'

AGENT_CONTENT=$(cat /tmp/instructions.md)
write_if_needed /config/.codex/AGENTS.md "Ensured AGENTS.md" "$AGENT_CONTENT"

write_if_needed /config/.codex/profile.json "Ensured profile.json" '{"defaultProfile":"high"}'

if [ "$AUTH" = "1" ]; then
  if [ -f /tmp/auth.json ]; then
    cp /tmp/auth.json /config/.codex/auth.json
    echo "Imported auth.json"
  else
    echo "Auth requested but no auth.json provided; skipping." >&2
  fi
fi
`;
}
