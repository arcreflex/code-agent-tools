#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const cliPath = path.join(rootDir, "packages/ai-review/dist/index.js");

await main();

async function main() {
  await testDryRunPass();
  await testSecretsPreflight();
  await testMissingToolCall();
}

async function testDryRunPass() {
  const repo = await createTempRepo();
  await runCli(["init"], { cwd: repo });
  const result = await runCli(["HEAD~1", "HEAD", "--dry-run"], { cwd: repo });
  assertExitCode(result.exitCode, 0, "ai-review --dry-run should succeed on clean repo");
}

async function testSecretsPreflight() {
  const repo = await createTempRepo();
  await runCli(["init"], { cwd: repo });
  const leakPath = path.join(repo, "leak.env");
  await fs.writeFile(leakPath, "OPENAI_API_KEY=sk-test-123\n", "utf8");
  await git(repo, "add", "leak.env");
  const result = await runCli(["staged", "--dry-run"], { cwd: repo });
  assertExitCode(result.exitCode, 1, "Secret preflight should block staged secrets");
}

async function testMissingToolCall() {
  const repo = await createTempRepo();
  await runCli(["init"], { cwd: repo });
  const server = await startStubServer();
  try {
    const env = {
      AI_REVIEW_OPENAI_KEY: "test-key",
      AI_REVIEW_MODEL: "gpt-test",
      AI_REVIEW_OPENAI_BASE_URL: server.baseURL,
    };
    const result = await runCli(["HEAD~1", "HEAD"], { cwd: repo, env });
    assertExitCode(result.exitCode, 2, "Missing finalize_review call should exit with code 2");
    if (server.requestCount === 0) {
      throw new Error("Stub server did not receive any requests");
    }
  } finally {
    await server.close();
  }
}

async function createTempRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-review-smoke-"));
  await git(undefined, "init", "--initial-branch=main", dir);
  await git(dir, "config", "user.email", "smoke@example.com");
  await git(dir, "config", "user.name", "Smoke Test");
  const filePath = path.join(dir, "README.md");
  await fs.writeFile(filePath, "Initial content\n", "utf8");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "initial commit");
  await fs.appendFile(filePath, "Second line\n", "utf8");
  await git(dir, "commit", "-am", "second commit");
  return dir;
}

async function git(cwd, ...args) {
  const child = spawn("git", args, {
    cwd: cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code] = await once(child, "close");
  const stdout = child.stdout ? await readStream(child.stdout) : "";
  const stderr = child.stderr ? await readStream(child.stderr) : "";
  if ((code ?? 0) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
}

async function runCli(args, { cwd, env } = {}) {
  const childEnv = { ...process.env, ...env };
  const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
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

function assertExitCode(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${expected}, got ${actual})`);
  }
}

async function startStubServer() {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      requestCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "stub",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "stub" },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("Failed to start stub server");
  }
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  return {
    baseURL,
    get requestCount() {
      return requestCount;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
