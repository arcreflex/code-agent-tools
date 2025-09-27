#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const cliPath = path.join(rootDir, "packages/agent-sandbox/dist/index.js");
const templateDir = path.join(rootDir, "packages/agent-sandbox/template");
const branch = "sbx-smoke";
const sanitizedBranch = branch.replace(/[\s/\\]+/g, "-");

await main();

async function main() {
  const repo = await createRepoWithTemplate();
  await testExecHappyPath(repo);
  await testPrintCommand(repo);
  await testFirewallVisibility(repo);
}

async function testExecHappyPath(repo) {
  const result = await runCli(["exec", "--branch", branch, "--", "echo", "OK"], { cwd: repo });
  assertExitCode(result.exitCode, 0, "exec should return the command exit code");
  if (!result.stdout.includes("OK")) {
    throw new Error("Expected command output to include OK");
  }
  await assertSuccess(
    runCli(["exec", "--branch", branch, "--", "test", "-d", "/repo-shelf/repo/.git"], { cwd: repo }),
    "repo shelf should be provisioned",
  );
  await assertSuccess(
    runCli(["exec", "--branch", branch, "--", "test", "-d", `/repo-shelf/worktrees/${sanitizedBranch}/.git`], {
      cwd: repo,
    }),
    "worktree should be provisioned",
  );
}

async function testPrintCommand(repo) {
  const result = await runCli(["exec", "--branch", branch, "--print-cmd", "--", "true"], { cwd: repo });
  assertExitCode(result.exitCode, 0, "exec --print-cmd should return command exit code");
  const expectedWorkdir = `/repo-shelf/worktrees/${sanitizedBranch}`;
  if (!result.stdout.includes(expectedWorkdir)) {
    throw new Error(`Expected docker exec output to include workdir ${expectedWorkdir}`);
  }
}

async function testFirewallVisibility(repo) {
  const configPath = path.join(repo, ".agent-sandbox", "config.json");
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  config.ports = [3456];
  config.egress_allow_domains = ["example.org"];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const countResult = await runCli(
    ["exec", "--branch", branch, "--", "jq", "-r", ".ports|length", "/.agent-sandbox/config.json"],
    { cwd: repo },
  );
  assertExitCode(countResult.exitCode, 0, "jq should read updated config");
  if (!countResult.stdout.trim().startsWith("1")) {
    throw new Error(`Expected port count to be 1, got ${countResult.stdout}`);
  }

  const curlResult = await runCli(
    ["exec", "--branch", branch, "--", "sh", "-c", "curl -fsS https://example.com && exit 1 || exit 0"],
    { cwd: repo },
  );
  assertExitCode(curlResult.exitCode, 0, "curl probe should confirm deny-by-default egress");
}

async function createRepoWithTemplate() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sandbox-smoke-"));
  await git(undefined, "init", "--initial-branch=main", dir);
  await git(dir, "config", "user.email", "smoke@example.com");
  await git(dir, "config", "user.name", "Sandbox Smoke");
  await fs.mkdir(path.join(dir, ".agent-sandbox"), { recursive: true });
  await fs.cp(templateDir, path.join(dir, ".agent-sandbox"), { recursive: true });
  const filePath = path.join(dir, "README.md");
  await fs.writeFile(filePath, "Sandbox smoke test\n", "utf8");
  await git(dir, "add", "README.md", ".agent-sandbox");
  await git(dir, "commit", "-m", "initial commit");
  return dir;
}

async function git(cwd, ...args) {
  const child = spawn("git", args, {
    cwd: cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "close");
  const stderr = child.stderr ? await readStream(child.stderr) : "";
  if ((code ?? 0) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function runCli(args, { cwd, env } = {}) {
  const childEnv = { ...process.env, ...env };
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "close");
  const stdout = child.stdout ? await readStream(child.stdout) : "";
  const stderr = child.stderr ? await readStream(child.stderr) : "";
  return { exitCode: code ?? 0, stdout, stderr };
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function assertSuccess(promise, message) {
  const result = await promise;
  assertExitCode(result.exitCode, 0, message);
}

function assertExitCode(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${expected}, got ${actual})`);
  }
}
