#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import * as path from "path";

interface ClaudeCodeSettings {
  // See https://docs.anthropic.com/en/docs/claude-code/hooks
  hooks?: {
    [key: string]: Array<{
      matcher?: string;
      hooks: Array<{
        type: string;
        command: string;
        timeout?: number;
      }>;
    }>;
  };
  [key: string]: unknown;
}

const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
const SETTINGS_PATH = path.join(CLAUDE_CONFIG_DIR, "settings.json");

function loadSettings(): ClaudeCodeSettings {
  if (!existsSync(SETTINGS_PATH)) {
    mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
    return {};
  }

  const content = readFileSync(SETTINGS_PATH, "utf-8");
  return JSON.parse(content);
}

function setupHooks(): void {
  console.log("🔧 Setting up Claude Code hooks...\n");

  const settings = loadSettings();

  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.PreToolUse) {
    settings.hooks.PreToolUse = [];
  }

  let matcher = settings.hooks.PreToolUse.find(
    (hook) => hook.matcher === "Bash",
  );
  if (!matcher) {
    matcher = {
      matcher: "Bash",
      hooks: [],
    };
    settings.hooks.PreToolUse.push(matcher);
  }

  matcher.hooks.push({
    type: "command" as const,
    command: "/usr/local/bin/validate-bash-tool.ts",
    timeout: 5,
  });

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log("✅ Claude Code hooks configured successfully!");
  console.log(`📁 Settings saved to: ${SETTINGS_PATH}\n`);
}

setupHooks();
