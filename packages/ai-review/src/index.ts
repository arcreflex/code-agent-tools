#!/usr/bin/env node

// Inspired by https://gist.github.com/huntcsg/c4fe3acf4f7d2fe1ca16e5518a27a23e
// via https://x.com/xlatentspace

import * as fs from "fs";
import * as path from "path";
import { $, chalk, spinner } from "zx";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { parseArgs, type ParseArgsOptionsConfig } from "util";
import { loadEnvFile } from "process";
import { glob } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ReviewResult {
  feedback: string;
  pass: boolean;
}

interface ReviewData {
  timestamp: string;
  objective: string | undefined;
  userContext: string | undefined;
  projectContext: string | undefined;
  gitStatus: string;
  gitDiff: string;
  review: ReviewResult;
  rawRequest?: unknown;
  rawResponse?: unknown;
}

interface UserContext {
  message: string;
  timestamp: string;
}

interface Messages {
  system: string;
  user: string;
}

const CONTEXT_FILE = "user-context.json";

type OptionSpec = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  default?: string | boolean | string[] | boolean[];
  desc: string;
};

type CommandSpec<V> = {
  summary: string;
  usage?: string[];
  run: (ctx: { args: { positionals: string[]; values: V } }) => Promise<void> | void;
};

const envFallbackNotified = new Set<string>();
const getEnv = (primary: string, legacy?: string): string | undefined => {
  const primaryValue = process.env[primary];
  if (primaryValue !== undefined) return primaryValue;
  if (legacy) {
    const legacyValue = process.env[legacy];
    if (legacyValue !== undefined && !envFallbackNotified.has(legacy)) {
      console.warn(chalk.yellow(`Using deprecated ${legacy} environment variable; rename to ${primary}.`));
      envFallbackNotified.add(legacy);
    }
    return legacyValue;
  }
  return undefined;
};

type PrecommitValues = {
  objective?: string;
  ref?: string;
  force: boolean;
  "sandbox-only": boolean;
  clear: boolean;
  show: boolean;
  "project-context"?: string[];
  preview: boolean;
  "default-branch"?: string;
  include?: string[];
  exclude?: string[];
  "include-tags"?: boolean;
  "max-diff-bytes"?: string;
  "continue-on-fail"?: boolean;
  help: boolean;
};

const CLI_OPTIONS: Record<string, OptionSpec> = {
  objective: {
    type: "string",
    short: "m",
    desc: "Objective hint to guide the review",
  },
  ref: { type: "string", desc: "Git ref to compare against (review-range)" },
  force: { type: "boolean", default: false, desc: "Force init; preserve .env and reviews" },
  "sandbox-only": { type: "boolean", default: false, desc: "Run only inside agent-sandbox" },
  clear: { type: "boolean", default: false, desc: "Clear saved user context" },
  show: { type: "boolean", default: false, desc: "Show saved user context" },
  "project-context": { type: "string", multiple: true, desc: "Extra project files to include" },
  preview: { type: "boolean", default: false, desc: "Preview system+user messages then exit" },
  "default-branch": { type: "string", desc: "Default branch name used as base for new refs (pre-receive)" },
  include: { type: "string", multiple: true, desc: "Include ref pattern (glob), default refs/heads/* (pre-receive)" },
  exclude: { type: "string", multiple: true, desc: "Exclude ref pattern (glob), default refs/tags/* (pre-receive)" },
  "include-tags": { type: "boolean", default: false, desc: "Include tag updates (pre-receive)" },
  "max-diff-bytes": { type: "string", desc: "Override diff byte cap (pre-receive)" },
  "continue-on-fail": {
    type: "boolean",
    default: false,
    desc: "Process all updates then fail if any failed (pre-receive)",
  },
  help: { type: "boolean", short: "h", default: false, desc: "Show help" },
};

const COMMANDS: Record<string, CommandSpec<PrecommitValues>> = {
  review: {
    summary: "Review staged changes (default)",
    usage: ["ai-review [--objective <text>] [--project-context <glob>...] [--preview]"],
    run: async ({ args }) => {
      const result = await review(args.values);
      if (result.kind === "skipped" || result.kind === "no-changes" || result.kind === "preview-shown") {
        process.exit(0);
      } else if (result.kind === "review-done" && !result.pass) {
        process.exit(1);
      }
    },
  },
  init: {
    summary: "Initialize .ai-review in repo",
    usage: ["ai-review init [--force]"],
    run: async ({ args }) => {
      await init({ force: args.values.force });
    },
  },
  context: {
    summary: "Manage user context for reviews",
    usage: ["ai-review context --show", "ai-review context --clear", "ai-review context <message>"],
    run: async ({ args }) => {
      await handleContext(args.positionals.slice(1), args.values);
    },
  },
  "show-review": {
    summary: "Show a saved review by timestamp",
    usage: ["ai-review show-review <timestamp>"],
    run: async ({ args }) => {
      try {
        await showReview(args.positionals[1]);
        process.exit(0);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(errorMessage));
        process.exit(1);
      }
    },
  },
  "review-range": {
    summary: "Review changes between two refs",
    usage: [
      "ai-review review-range <old> <new> [--ref <ref>] [--objective <text>] [--project-context <glob>...] [--preview]",
    ],
    run: async ({ args }) => {
      try {
        const [, ...rest] = args.positionals;
        const oldRef = rest[0];
        const newRef = rest[1];
        const ref = args.values.ref as string | undefined;

        if (!oldRef || !newRef) {
          console.error(chalk.red("Usage: ai-review review-range <old> <new> [--ref <ref>]"));
          process.exit(2);
        }

        const result = await reviewRange({
          old: oldRef,
          new: newRef,
          ref,
          objective: args.values.objective,
          "project-context": args.values["project-context"],
          preview: args.values.preview,
        });

        if (result.kind === "preview-shown" || result.kind === "no-changes") {
          process.exit(0);
        }
        if (result.kind === "review-done" && !result.pass) {
          process.exit(1);
        }
        process.exit(0);
      } catch (error) {
        console.error(chalk.red("Unhandled error in review-range"));
        console.error(error);
        process.exit(2);
      }
    },
  },
  "pre-receive": {
    summary: "Server-side hook. Review pushed updates from stdin",
    usage: [
      "ai-review pre-receive [--project-context <glob> ...] [--objective <text>] [--default-branch <name>] [--include <glob> ...] [--exclude <glob> ...] [--include-tags] [--max-diff-bytes <n>] [--continue-on-fail] [--preview]",
      "cat updates.txt | ai-review pre-receive",
      "ai-review pre-receive <old> <new> <ref> [<old> <new> <ref> ...]",
    ],
    run: async ({ args }) => {
      try {
        const opts = args.values;

        const includePatterns: string[] = ["refs/heads/*", ...(opts.include ?? [])];
        const excludeDefaults = opts["include-tags"] ? [] : ["refs/tags/*"];
        const excludePatterns: string[] = [...excludeDefaults, ...(opts.exclude ?? [])];
        const defaultBranch = opts["default-branch"] ?? "main";
        const continueOnFail = Boolean(opts["continue-on-fail"]);

        const maxEnv = getEnv("AI_REVIEW_MAX_DIFF_BYTES", "AGENT_PRECOMMIT_MAX_DIFF_BYTES");
        const maxOverride = opts["max-diff-bytes"];
        const maxBytes = (() => {
          const v = maxOverride ?? maxEnv ?? "800000";
          const n = parseInt(v, 10);
          return Number.isFinite(n) && n > 0 ? n : 800000;
        })();

        // Gather updates: either from positionals (triples) or stdin
        const positionals = args.positionals.slice(1);
        let updates: Array<{ old: string; newRef: string; ref: string }> = [];

        if (positionals.length >= 3 && positionals.length % 3 === 0) {
          for (let i = 0; i < positionals.length; i += 3) {
            updates.push({ old: positionals[i], newRef: positionals[i + 1], ref: positionals[i + 2] });
          }
        } else {
          // Read stdin
          updates = await readPreReceiveUpdatesFromStdin();
        }

        if (updates.length === 0) {
          console.log(chalk.gray("ai-review: no updates provided to pre-receive"));
          process.exit(0);
        }

        // Filter by include/exclude
        updates = updates.filter((u) => matchesAny(u.ref, includePatterns) && !matchesAny(u.ref, excludePatterns));

        if (updates.length === 0) {
          console.log(chalk.gray("ai-review: no updates matched filters"));
          process.exit(0);
        }

        const ZERO = "0000000000000000000000000000000000000000";
        let anyFailed = false;

        for (const u of updates) {
          // Skip ref deletions
          if (u.newRef === ZERO) continue;

          const shortOld = u.old === ZERO ? "∅" : (await $`git rev-parse --short ${u.old}`).stdout.trim();
          const shortNew = (await $`git rev-parse --short ${u.newRef}`).stdout.trim();
          console.log(`ai-review: reviewing ${u.ref} ${shortOld}..${shortNew}`);

          // Determine effective base for diff size and review-range
          const effectiveOld = u.old !== ZERO ? u.old : await determineNewRefBase(u.newRef, defaultBranch);

          // Enforce byte cap before invoking model
          const bytesOut =
            await $`git diff --no-ext-diff --no-color --patch --binary ${effectiveOld} ${u.newRef} | wc -c | awk '{print $1}'`;
          const bytes = parseInt(bytesOut.stdout.trim(), 10) || 0;
          if (bytes > maxBytes) {
            console.error(
              chalk.red(
                `ai-review: diff for ${u.ref} is ${bytes} bytes (max ${maxBytes}). Split this push into smaller chunks.`,
              ),
            );
            anyFailed = true;
            if (!continueOnFail) break;
            continue;
          }

          // Delegate to review-range with effective base
          const result = await reviewRange({
            old: effectiveOld,
            new: u.newRef,
            ref: u.ref,
            objective: opts.objective,
            "project-context": opts["project-context"],
            preview: opts.preview,
          });

          if (result.kind === "review-done" && !result.pass) {
            anyFailed = true;
            if (!continueOnFail) break;
          }
        }

        process.exit(anyFailed ? 1 : 0);
      } catch (error) {
        console.error(chalk.red("Unhandled error in pre-receive"));
        console.error(error);
        process.exit(2);
      }
    },
  },
};

function toParseArgsOptions(options: Record<string, OptionSpec>): ParseArgsOptionsConfig {
  type ArgOpt = {
    type: "string" | "boolean";
    short?: string;
    multiple?: boolean;
    default?: string | boolean | string[] | boolean[];
  };
  const out: Partial<ParseArgsOptionsConfig> = {};
  for (const [k, v] of Object.entries(options)) {
    const conf: ArgOpt = { type: v.type };
    if (v.short !== undefined) conf.short = v.short;
    if (v.multiple !== undefined) conf.multiple = v.multiple;
    if (v.default !== undefined) conf.default = v.default;
    out[k] = conf as unknown as ParseArgsOptionsConfig[string];
  }
  return out as ParseArgsOptionsConfig;
}

function printHelp(command?: string) {
  const header = "ai-review";
  if (!command) {
    console.log(`${header} - AI-powered precommit review`);
    console.log("");
    console.log("Usage: ai-review [command] [options]");
    console.log("");
    console.log("Commands:");
    const entries = Object.entries(COMMANDS);
    const namePad = Math.max(...entries.map(([n]) => n.length));
    for (const [name, c] of entries) {
      console.log(`  ${name.padEnd(namePad)}  ${c.summary}`);
    }
    console.log("  help            Show help (also -h, --help)");
    console.log("");
    console.log("Options:");
    for (const [name, spec] of Object.entries(CLI_OPTIONS)) {
      const flags = [spec.short ? `-${spec.short}` : null, `--${name}`].filter(Boolean).join(", ");
      console.log(`  ${flags.padEnd(18)} ${spec.desc}`);
    }
    console.log("");
    console.log("Default command: review");
  } else {
    const c = COMMANDS[command];
    if (!c) {
      console.error(chalk.red(`Unknown command: ${command}`));
      console.log("Use --help to see available commands.");
      process.exit(2);
    }
    console.log(`${header} ${command} - ${c.summary}`);
    console.log("");
    if (c.usage && c.usage.length) {
      console.log("Usage:");
      for (const u of c.usage) console.log(`  ${u}`);
      console.log("");
    }
    console.log("Options:");
    for (const [name, spec] of Object.entries(CLI_OPTIONS)) {
      const flags = [spec.short ? `-${spec.short}` : null, `--${name}`].filter(Boolean).join(", ");
      console.log(`  ${flags.padEnd(18)} ${spec.desc}`);
    }
  }
}

async function main() {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: toParseArgsOptions(CLI_OPTIONS),
  });
  const args: { positionals: string[]; values: PrecommitValues } = parsed as unknown as {
    positionals: string[];
    values: PrecommitValues;
  };

  for (const env of [path.join(await getDataDir(), ".env"), ".env"]) {
    if (fs.existsSync(env)) {
      loadEnvFile(env);
    }
  }

  const positional = args.positionals[0];
  const wantsHelp = args.values.help || positional === "help";
  const helpFor = wantsHelp ? args.positionals[1] : undefined;

  if (wantsHelp) {
    printHelp(helpFor);
    process.exit(0);
  }

  const cmdName = positional && COMMANDS[positional] ? positional : "review";
  await COMMANDS[cmdName].run({ args });
}

async function init(args: { force: boolean }) {
  const dataDir = await getDataDir();
  let existingEnv: string | null = null;
  let existingUserContext: string | null = null;
  let hadExistingDir = false;

  if (fs.existsSync(dataDir)) {
    hadExistingDir = true;

    // Preserve existing .env file content if it exists
    const envPath = path.join(dataDir, ".env");
    if (fs.existsSync(envPath)) {
      existingEnv = fs.readFileSync(envPath, "utf8");
    }

    // Preserve existing user-context.json if it exists
    const userContextPath = path.join(dataDir, "user-context.json");
    if (fs.existsSync(userContextPath)) {
      existingUserContext = fs.readFileSync(userContextPath, "utf8");
    }

    if (args.force) {
      console.log(chalk.yellow("Force reinitializing .ai-review directory"));
      console.log(chalk.gray("Preserving: .env, user-context.json, and reviews/"));

      // Create temp directory to store preserved files
      const tempDir = `${dataDir}.tmp`;
      if (fs.existsSync(tempDir)) {
        await $`rm -rf ${tempDir}`;
      }
      fs.mkdirSync(tempDir);

      // Preserve reviews directory if it exists
      const reviewsDir = path.join(dataDir, "reviews");
      if (fs.existsSync(reviewsDir)) {
        await $`cp -r ${reviewsDir} ${tempDir}/reviews`;
      }

      // Remove the old directory
      await $`rm -r ${dataDir}`;

      // Create fresh directory
      fs.mkdirSync(dataDir, { recursive: true });

      // Restore reviews if they existed
      if (fs.existsSync(path.join(tempDir, "reviews"))) {
        await $`mv ${tempDir}/reviews ${dataDir}/reviews`;
      }

      // Clean up temp directory
      await $`rm -rf ${tempDir}`;
    } else {
      console.error(`Error: ${dataDir} directory already exists.`);
      console.error("Use --force to reinitialize while preserving .env, user-context.json, and reviews.");
      process.exit(1);
    }
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Copy template files including dotfiles
  const templateDir = path.join(__dirname, "..", "template");
  await $`cp -RL ${templateDir}/. ${dataDir}/`;

  // Handle .env file
  const envPath = path.join(dataDir, ".env");
  const examplePath = path.join(dataDir, ".env.example");

  if (existingEnv) {
    // Restore the preserved .env content
    fs.writeFileSync(envPath, existingEnv);
    console.log(chalk.green("✓ Preserved existing .env configuration"));

    // Remove .env.example since we have a real .env
    if (fs.existsSync(examplePath)) {
      fs.unlinkSync(examplePath);
    }
  } else {
    // Rename .env.example to .env for new installations
    if (fs.existsSync(examplePath)) {
      await $`mv ${examplePath} ${envPath}`;
    } else {
      console.error(chalk.red("Warning: No .env.example file found in template. Please configure .env manually."));
    }
  }

  // Handle user-context.json
  if (existingUserContext) {
    const userContextPath = path.join(dataDir, "user-context.json");
    fs.writeFileSync(userContextPath, existingUserContext);
    console.log(chalk.green("✓ Preserved existing user context"));
  }

  let repoRoot;
  try {
    repoRoot = await $`git rev-parse --show-toplevel`;
  } catch {
    console.error(chalk.yellow("ERROR: not in a git repository"));
    process.exitCode = 1;
    return;
  }

  const gitignorePath = path.join(repoRoot.stdout.trim(), ".gitignore");
  const gitignoreEntries = [".ai-review/reviews", ".ai-review/user-context.json"];

  let gitignoreContent = "";
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
  }

  const entriesToAdd = gitignoreEntries.filter((entry) => !gitignoreContent.includes(entry));

  if (entriesToAdd.length > 0) {
    const hasAgentPrecommitSection = gitignoreContent.includes("# Agent Precommit");
    const newContent =
      gitignoreContent +
      (gitignoreContent && !gitignoreContent.endsWith("\n") ? "\n" : "") +
      (hasAgentPrecommitSection ? "" : "\n# Agent Precommit\n") +
      entriesToAdd.join("\n") +
      "\n";
    fs.writeFileSync(gitignorePath, newContent);
    console.log(chalk.yellow(`Added ${entriesToAdd.length} entries to .gitignore`));
  }

  if (hadExistingDir && args.force) {
    console.log(chalk.green(`✓ Reinitialized ai-review in ${dataDir}`));
  } else {
    console.log(chalk.green(`✓ Initialized ai-review in ${dataDir}`));
  }

  const initIndex = process.argv.indexOf("init");
  const command = initIndex > 0 ? process.argv.slice(0, initIndex).join(" ") : "ai-review";

  if (!existingEnv) {
    console.log(chalk.yellow(`Set environment variables in ${dataDir}/.env and add:`));
    console.log(chalk.white(command));
    console.log(chalk.yellow(`to your precommit hook`));
  } else {
    console.log(chalk.gray(`Your existing .env configuration has been preserved.`));
    console.log(chalk.gray(`Ensure ${command} is in your precommit hook.`));
  }
}

async function review(args: {
  objective?: string;
  "sandbox-only": boolean;
  "project-context"?: string[];
  preview?: boolean;
}): Promise<
  { kind: "skipped" } | { kind: "no-changes" } | { kind: "preview-shown" } | { kind: "review-done"; pass: boolean }
> {
  if (args["sandbox-only"] && !fs.existsSync(`/.agent-sandbox`)) {
    console.log(chalk.yellow(`Skipping ai-review review because /.agent-sandbox doesn't exist`));
    return { kind: "skipped" };
  }

  const [gitStatus, diff] = await getGitContextFromIndex();

  if (!diff.trim()) {
    console.log("No changes to review");
    return { kind: "no-changes" };
  }

  const projectContext = await getProjectContext(args["project-context"]);

  const messages = await buildMessages(args.objective, gitStatus, diff, projectContext.formattedContents);

  // Handle preview mode
  if (args.preview) {
    await showPreview(messages);
    return { kind: "preview-shown" };
  }

  // Print request summary
  await printRequestSummary("Requesting review of staged changes", args.objective, projectContext);

  const reviewResponse = await spinner(() => requestReview(messages));

  // Get user context for saving in review data
  const userContext = await getUserContext();
  const reviewData: ReviewData = {
    timestamp: new Date().toISOString(),
    objective: args.objective,
    userContext: userContext?.message,
    projectContext: projectContext.formattedContents,
    gitStatus,
    gitDiff: diff,
    review: reviewResponse.result,
    rawRequest: reviewResponse.rawRequest,
    rawResponse: reviewResponse.rawResponse,
  };
  await saveReview(reviewData);
  renderReview(reviewData);

  return { kind: "review-done", pass: reviewResponse.result.pass };
}

/**
 * Build the messages that will be sent to the model provider API
 */
async function buildMessages(
  objective: string | undefined,
  gitStatus: string,
  diff: string,
  projectContext: string,
  ref?: string,
): Promise<Messages> {
  const systemPrompt = await getSystemPrompt(projectContext);

  const userMessage = `${objective ? `OBJECTIVE:\n${objective}\n\n` : ""}${ref ? `REF:\n${ref}\n\n` : ""}GIT STATUS:
${gitStatus}

DIFF TO REVIEW:
${diff}

Review this diff, and be uncompromising about quality standards.`;

  return { system: systemPrompt, user: userMessage };
}

/**
 * Print a summary of the request configuration before starting the review
 */
async function printRequestSummary(
  header: string,
  objective: string | undefined,
  projectContext: { contextFiles: string[]; formattedContents: string },
): Promise<void> {
  const userContext = await getUserContext();
  const model = getEnv("AI_REVIEW_MODEL", "AGENT_PRECOMMIT_MODEL");

  console.log(chalk.cyan("\n\n" + header));

  if (objective) {
    console.log(chalk.cyan(`Objective: `) + objective);
  }

  if (model) {
    console.log(chalk.cyan(`Model: `) + model);
  }

  if (projectContext.contextFiles.length > 0) {
    console.log(
      [chalk.cyan(`Context files included along with diff:`), ...projectContext.contextFiles].join(`\n    - `),
    );
  }

  if (userContext) {
    console.log(chalk.cyan(`User context:`));
    console.log(userContext.message);
  }

  console.log(chalk.yellow("\n⏳ Note: Depending on the model, reviews can take 3+ minutes\n\n"));
}

/**
 * Display a preview of what would be sent to the model provider API
 */
async function showPreview(messages: Messages): Promise<void> {
  console.log(chalk.blue("=== PREVIEW MODE ==="));
  console.log(chalk.gray("The following messages would be sent to the model provider API:\n"));

  console.log(chalk.cyan("=== SYSTEM MESSAGE ==="));
  console.log(messages.system);

  console.log(chalk.cyan("\n=== USER MESSAGE ==="));
  console.log(messages.user);

  console.log(chalk.gray("\n=== END PREVIEW ==="));
  console.log(chalk.gray("No API call was made. Exit code: 0"));
}

/**
 * Run a review over a pushed range <old>..<new>.
 */
async function reviewRange(args: {
  old: string;
  new: string;
  ref?: string;
  objective?: string;
  "project-context"?: string[];
  preview?: boolean;
}): Promise<{ kind: "preview-shown" } | { kind: "no-changes" } | { kind: "review-done"; pass: boolean }> {
  const { old, new: nu, ref } = args;

  // Build an inferred objective if not provided, including full commit messages
  let objective = args.objective;
  if (!objective) {
    try {
      const ZERO = "0000000000000000000000000000000000000000";
      if (old === ZERO) {
        objective = "New branch push";
      } else {
        // Use NUL (\x00) as a robust separator between fields to capture full messages safely
        // Sequence is repeated per commit: <hash>\0<full message>\0
        const log = await $`git log --no-color --max-count=50 --pretty=format:%h%x00%B%x00 ${old}..${nu}`;
        const parts = log.stdout.split("\u0000").filter(Boolean);
        // Chunk into [hash, message] pairs and cap at 50 commits
        const commits: Array<{ hash: string; message: string }> = [];
        for (let i = 0; i + 1 < parts.length && commits.length < 50; i += 2) {
          const hash = parts[i].trim();
          const message = (parts[i + 1] ?? "").replace(/\r\n?/g, "\n").trimEnd();
          if (hash) commits.push({ hash, message });
        }

        // Limits to prevent oversized prompts
        const MAX_COMMITS = 50;
        const MAX_SUBJECT_CHARS = 120;
        const MAX_BODY_LINES = 8;
        const MAX_BODY_BYTES = 1000; // per-commit body cap
        const MAX_TOTAL_BYTES = 12000; // overall inferred objective cap

        const sanitize = (s: string) =>
          Array.from(s)
            .filter((ch) => {
              const code = ch.charCodeAt(0);
              // allow tab (9) and newline (10); strip other C0 controls and DEL (127)
              if (code === 9 || code === 10) return true;
              if (code < 32 || code === 127) return false;
              return true;
            })
            .join("");
        const clampSubject = (s: string) =>
          s.length > MAX_SUBJECT_CHARS ? s.slice(0, MAX_SUBJECT_CHARS - 1) + "…" : s;
        const truncateByBytes = (s: string, max: number) => {
          const bytes = Buffer.byteLength(s);
          if (bytes <= max) return { text: s, truncated: false } as const;
          // naive but safe: grow until limit
          let acc = "";
          let truncated = false;
          for (const ch of s) {
            const next = acc + ch;
            if (Buffer.byteLength(next) > max) {
              truncated = true;
              break;
            }
            acc = next;
          }
          return { text: acc, truncated } as const;
        };

        const bullets: string[] = [];
        const objectiveHeader = "Inferred from pushed commits:\n";
        const firstSep = "- ";
        const nextSep = "\n- ";
        let totalBytes = Buffer.byteLength(objectiveHeader);
        for (const { hash, message } of commits.slice(0, MAX_COMMITS)) {
          const lines = sanitize(message).split("\n");
          const rawSubject = (lines[0] ?? "").trim();
          const subject = clampSubject(rawSubject.length > 0 ? rawSubject : "<no subject>");
          // Lines already passed through sanitize(message) above; avoid re-sanitizing here.
          let bodyLines = lines.slice(1).map((l) => l.replace(/\s+$/g, ""));

          // collapse multiple blank lines to single
          const collapsed: string[] = [];
          for (const ln of bodyLines) {
            if (ln.trim() === "" && collapsed[collapsed.length - 1]?.trim() === "") continue;
            collapsed.push(ln);
          }
          bodyLines = collapsed;

          // limit lines and bytes
          let limited: string[] = [];
          let bytes = 0;
          let truncated = false;
          for (const ln of bodyLines) {
            if (limited.length >= MAX_BODY_LINES) {
              truncated = true;
              break;
            }
            const { text } = truncateByBytes(ln, Math.max(0, MAX_BODY_BYTES - bytes));
            bytes += Buffer.byteLength(text);
            limited.push(text);
            if (bytes >= MAX_BODY_BYTES) {
              truncated = true;
              break;
            }
          }
          if (truncated) {
            limited.push("… [truncated]");
          }

          const indentedBody = limited.length > 0 ? "\n  " + limited.join("\n  ") : "";
          const bullet = `${hash} ${subject}${indentedBody}`;

          // Check total limit before adding (linear accounting)
          const sepBytes = Buffer.byteLength(bullets.length === 0 ? firstSep : nextSep);
          const candBytes = totalBytes + sepBytes + Buffer.byteLength(bullet);
          if (candBytes > MAX_TOTAL_BYTES) {
            break;
          }
          bullets.push(bullet);
          totalBytes = candBytes;
        }

        if (bullets.length > 0) {
          // If we omitted any remaining commits, hint at omission
          const omitted = commits.length > bullets.length;
          let rendered = bullets.join("\n- ");
          if (omitted) {
            const more = "… [more commits omitted]";
            // Try to add the omission note within limits
            // We already have at least one bullet here; use nextSep for clarity
            const sepBytes = Buffer.byteLength(nextSep);
            const moreBytes = sepBytes + Buffer.byteLength(more);
            if (totalBytes + moreBytes <= MAX_TOTAL_BYTES) {
              rendered = `${rendered}\n- ${more}`;
              totalBytes += moreBytes;
            }
          }
          objective = `${objectiveHeader}${bullets.length ? firstSep : ""}${rendered}`;
        } else if (commits.length > 0) {
          objective = "Pushed commits (details omitted due to size)";
        }
      }
    } catch (err) {
      console.error(
        chalk.yellow(
          `Warning: failed to infer objective from git log for range ${old}..${nu}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
  }

  const [gitStatus, diff] = await getGitContextFromRange(old, nu);
  if (!diff.trim()) {
    console.log("No changes to review");
    return { kind: "no-changes" };
  }

  const ZERO = "0000000000000000000000000000000000000000";
  const shortOld = old === ZERO ? "∅" : (await $`git rev-parse --short ${old}`).stdout.trim();
  const shortNew = (await $`git rev-parse --short ${nu}`).stdout.trim();
  const header = `Requesting review of pushed range ${shortOld}..${shortNew}${ref ? ` on ${ref}` : ""}`;

  const projectContext = await getProjectContext(args["project-context"]);
  const messages = await buildMessages(objective, gitStatus, diff, projectContext.formattedContents, ref);

  if (args.preview) {
    console.log("");
    await printRequestSummary(header, objective, projectContext);
    await showPreview(messages);
    return { kind: "preview-shown" };
  }

  await printRequestSummary(header, objective, projectContext);
  const reviewResponse = await spinner(() => requestReview(messages));

  const userContext = await getUserContext();
  const reviewData: ReviewData = {
    timestamp: new Date().toISOString(),
    objective,
    userContext: userContext?.message,
    projectContext: projectContext.formattedContents,
    gitStatus,
    gitDiff: diff,
    review: reviewResponse.result,
    rawRequest: reviewResponse.rawRequest,
    rawResponse: reviewResponse.rawResponse,
  };
  await saveReview(reviewData);
  renderReview(reviewData);

  return { kind: "review-done", pass: reviewResponse.result.pass };
}

/**
 * Get the current git status and staged diff.
 */
async function getGitContextFromIndex(): Promise<[string, string]> {
  const gitStatus = await $`git status --porcelain`;
  const stagedDiff = await $`git diff --staged`;
  return [gitStatus.stdout, stagedDiff.stdout];
}

/**
 * Get git status and diff for a specific range old..new.
 */
async function getGitContextFromRange(oldRef: string, newRef: string): Promise<[string, string]> {
  const ZERO = "0000000000000000000000000000000000000000";
  const base = oldRef === ZERO ? (await $`git hash-object -t tree -w /dev/null`).stdout.trim() : oldRef;

  const status = await $`git diff --no-ext-diff --no-color --name-status ${base} ${newRef}`;
  const diff = await $`git diff --no-ext-diff --no-color --patch --binary ${base} ${newRef}`;
  return [status.stdout, diff.stdout];
}

/**
 * Determine the effective base for a new ref push.
 * Prefer merge-base with the declared default branch; fall back to empty tree.
 */
async function determineNewRefBase(newRef: string, defaultBranch: string): Promise<string> {
  try {
    const base = await $`git merge-base ${defaultBranch} ${newRef}`;
    const commit = base.stdout.trim();
    if (commit) return commit;
  } catch {
    // ignore
  }
  const emptyTree = await $`git hash-object -t tree -w /dev/null`;
  return emptyTree.stdout.trim();
}

/**
 * Read updates from stdin for pre-receive: lines of "<old> <new> <ref>".
 */
async function readPreReceiveUpdatesFromStdin(): Promise<Array<{ old: string; newRef: string; ref: string }>> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    process.stdin.on("end", () => resolve());
    process.stdin.resume();
  });
  const text = Buffer.concat(chunks).toString("utf8");
  const updates: Array<{ old: string; newRef: string; ref: string }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      updates.push({ old: parts[0], newRef: parts[1], ref: parts.slice(2).join(" ") });
    }
  }
  return updates;
}

/**
 * Simple glob matcher supporting * and ? for refname patterns.
 */
function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => globLike(text, p));
}

function globLike(text: string, pattern: string): boolean {
  // Escape regex special chars, then replace \* and \? tokens
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp("^" + esc.replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$");
  return rx.test(text);
}

async function getDataDir(): Promise<string> {
  try {
    const isBare = (await $`git rev-parse --is-bare-repository`).stdout.trim() === "true";
    if (isBare) {
      const gitDir = (await $`git rev-parse --git-dir`).stdout.trim();
      return path.join(gitDir, ".ai-review");
    }

    // In non-bare repos, hooks triggered during push execute in $GIT_DIR (inside .git),
    // where --show-toplevel may fail. Prefer show-toplevel, but derive from --git-dir if needed.
    try {
      const repoRoot = (await $`git rev-parse --show-toplevel`).stdout.trim();
      if (repoRoot) return path.join(repoRoot, ".ai-review");
    } catch {
      // fall through to derive from git-dir
    }

    const gitDirOut = await $`git rev-parse --git-dir`;
    const gitDir = gitDirOut.stdout.trim();
    const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(process.cwd(), gitDir);
    const repoRoot = path.dirname(absGitDir);
    return path.join(repoRoot, ".ai-review");
  } catch (err) {
    // Deterministic fallback: place data dir under current working directory
    console.warn(
      chalk.yellow(
        `Warning: git rev-parse failed (${err instanceof Error ? err.message : String(err)}). Falling back to ${path.join(
          process.cwd(),
          ".ai-review",
        )}`,
      ),
    );
    return path.join(process.cwd(), ".ai-review");
  }
}

async function getProjectContext(globs?: string[]): Promise<{
  contextFiles: string[];
  formattedContents: string;
}> {
  if (!globs || globs.length === 0) {
    return {
      contextFiles: [],
      formattedContents: "",
    };
  }

  const repoRoot = await $`git rev-parse --show-toplevel`;
  const rootPath = repoRoot.stdout.trim();

  const contextFiles: string[] = [];

  for (const pattern of globs) {
    try {
      for await (const entry of glob(pattern, { cwd: rootPath })) {
        contextFiles.push(entry);
      }
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Failed to process glob pattern "${pattern}": ${error}`));
    }
  }

  if (contextFiles.length === 0) {
    return {
      contextFiles: [],
      formattedContents: "",
    };
  }

  const maxContextEnv = getEnv("AI_REVIEW_MAX_CONTEXT_BYTES", "AGENT_PRECOMMIT_MAX_CONTEXT_BYTES");
  const MAX_CONTEXT_BYTES = maxContextEnv ? parseInt(maxContextEnv, 10) : 200000; // ~200KB limit to avoid overlong prompts

  let totalBytes = 0;
  const contextSections: string[] = [];
  const omittedFiles: string[] = [];

  for (const filePath of contextFiles) {
    try {
      const fullPath = path.join(rootPath, filePath);
      const content = await fs.promises.readFile(fullPath, "utf8");
      const section = `## ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
      const sectionBytes = Buffer.byteLength(section, "utf8");

      if (totalBytes + sectionBytes > MAX_CONTEXT_BYTES) {
        // Skip this file and add a placeholder
        const placeholder = `## ${filePath}\n\n\`\`\`\n[OMITTED: Including this file would exceed the context byte limit]\n\`\`\``;
        const placeholderBytes = Buffer.byteLength(placeholder, "utf8");

        // Only add placeholder if it fits
        if (totalBytes + placeholderBytes <= MAX_CONTEXT_BYTES) {
          contextSections.push(placeholder);
          totalBytes += placeholderBytes;
        }
        omittedFiles.push(filePath);
        // Continue to try other files that might fit
        continue;
      }

      contextSections.push(section);
      totalBytes += sectionBytes;
    } catch (error: unknown) {
      if (
        !(typeof error === "object" && error && "code" in error) ||
        (error.code !== "ENOENT" && error.code !== "EISDIR")
      ) {
        console.warn(chalk.yellow(`Warning: Failed to read context file "${filePath}": ${error}`));
      }
    }
  }

  if (contextSections.length === 0) {
    return {
      contextFiles: [],
      formattedContents: "",
    };
  }

  let formattedContents = `CODEBASE CONTEXT:\n\n${contextSections.join("\n\n")}`;

  if (omittedFiles.length > 0) {
    formattedContents += `\n\n[NOTE: The following files were omitted because including them would exceed the ${MAX_CONTEXT_BYTES} byte context limit: ${omittedFiles.join(", ")}]`;
  }

  formattedContents += "\n\n";

  return {
    contextFiles,
    formattedContents,
  };
}

async function handleContext(args: string[], options: { clear?: boolean; show?: boolean }): Promise<void> {
  if (options.clear) {
    await clearUserContext();
    console.log(chalk.green("✓ User context cleared"));
    return;
  }

  if (options.show) {
    const context = await getUserContext();
    if (context) {
      console.log(chalk.blue("Current user context:"));
      console.log(context.message);
      const age = Math.floor((Date.now() - new Date(context.timestamp).getTime()) / 1000 / 60);
      console.log(chalk.gray(`(set ${age} minutes ago)`));
    } else {
      console.log(chalk.yellow("No active user context"));
    }
    return;
  }

  // Join all positional args to handle both quoted and unquoted input:
  // - Quoted: ai-review context "multi word message" -> ["multi word message"]
  // - Unquoted: ai-review context multi word message -> ["multi", "word", "message"]
  const message = args.join(" ").trim();
  if (!message) {
    console.error(chalk.red("Error: Please provide a context message"));
    console.log("Usage: ai-review context <message>");
    console.log("       ai-review context --show");
    console.log("       ai-review context --clear");
    process.exit(1);
  }

  // Block setting context when running inside agent-sandbox
  if (fs.existsSync("/.agent-sandbox")) {
    console.error(chalk.red("Cannot set user context from within agent-sandbox."));
    console.log("Please ask the human user to set context.");
    process.exit(1);
  }

  await setUserContext(message);
  console.log(chalk.green("✓ User context set:"));
  console.log(message);
}

async function setUserContext(message: string): Promise<void> {
  const dataDir = await getDataDir();
  const contextPath = path.join(dataDir, CONTEXT_FILE);

  const context: UserContext = {
    message,
    timestamp: new Date().toISOString(),
  };

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2));
}

async function getUserContext(): Promise<UserContext | null> {
  const dataDir = await getDataDir();
  const contextPath = path.join(dataDir, CONTEXT_FILE);

  if (!fs.existsSync(contextPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(contextPath, "utf8");
    const context: UserContext = JSON.parse(content);
    return context;
  } catch {
    console.error(chalk.yellow("Warning: Failed to read user context"));
    return null;
  }
}

async function clearUserContext(): Promise<void> {
  const dataDir = await getDataDir();
  const contextPath = path.join(dataDir, CONTEXT_FILE);

  if (fs.existsSync(contextPath)) {
    fs.unlinkSync(contextPath);
  }
}

async function getSystemPrompt(projectContext: string): Promise<string> {
  const filepath = path.join(await getDataDir(), "system-prompt.md");
  let prompt = fs.readFileSync(filepath, "utf8");

  if (projectContext.trim()) {
    prompt += `\n\n${projectContext}`;
  }

  const userContext = await getUserContext();
  if (userContext) {
    prompt += `\n\nCONTEXT PROVIDED BY PROJECT OWNER (AUTHORITATIVE):\n${userContext.message}\n\n`;
  }

  return prompt;
}

async function requestReview(
  messages: Messages,
): Promise<{ result: ReviewResult; rawRequest: unknown; rawResponse: unknown }> {
  const apiKey = getEnv("AI_REVIEW_OPENAI_KEY", "AGENT_PRECOMMIT_OPENAI_KEY");
  if (!apiKey) {
    throw new Error("Error: AI_REVIEW_OPENAI_KEY (or legacy AGENT_PRECOMMIT_OPENAI_KEY) environment variable not set");
  }

  const baseURL = getEnv("AI_REVIEW_OPENAI_BASE_URL", "AGENT_PRECOMMIT_OPENAI_BASE_URL") || "https://api.openai.com/v1";

  const openai = new OpenAI({
    apiKey,
    baseURL,
  });

  const tools: OpenAI.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "provide_review_feedback",
        description: "Provide structured review feedback with pass/fail determination",
        parameters: {
          type: "object",
          properties: {
            feedback: {
              type: "string",
              description:
                "Brief feedback written in first person as the developer user. For PASS: minimal, no praise. For FAIL: direct actionable advice with prodding language to fix issues.",
            },
            pass: {
              type: "boolean",
              description: "Whether the code changes meet quality standards",
            },
          },
          required: ["feedback", "pass"],
        },
      },
    },
  ];

  const model = getEnv("AI_REVIEW_MODEL", "AGENT_PRECOMMIT_MODEL");
  if (!model) {
    throw new Error("Error: AI_REVIEW_MODEL (or legacy AGENT_PRECOMMIT_MODEL) environment variable not set");
  }

  const extraParamsRaw = getEnv("AI_REVIEW_EXTRA_PARAMS", "AGENT_PRECOMMIT_EXTRA_PARAMS");
  const extraParams = extraParamsRaw ? JSON.parse(extraParamsRaw) : {};

  const requestPayload = {
    model,
    messages: [
      { role: "developer", content: messages.system },
      { role: "user", content: messages.user },
    ],
    temperature: 1,
    tools,
    tool_choice: {
      type: "function",
      function: { name: "provide_review_feedback" },
    },
    max_completion_tokens: 50000,
    ...extraParams,
  };

  const response = await openai.chat.completions.create(requestPayload);

  const choice = response.choices[0];
  if (!choice) {
    throw new Error("Error: No choices returned from OpenAI");
  }

  const toolCall = choice.message?.tool_calls?.[0];
  if (toolCall?.type !== "function" || !toolCall.function.arguments) {
    console.error(JSON.stringify(response));
    throw new Error("Error: OpenAI did not return expected function call response");
  }

  const parsed = JSON.parse(toolCall.function.arguments);
  // The API already enforces the structure of the response, so we can safely assume
  // the parsed result matches the expected type.
  return {
    result: parsed,
    rawRequest: requestPayload,
    rawResponse: response,
  };
}

async function saveReview(reviewData: ReviewData): Promise<void> {
  const reviewsDir = path.join(await getDataDir(), "reviews");
  if (!fs.existsSync(reviewsDir)) {
    fs.mkdirSync(reviewsDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const filename = `review_${timestamp}.json`;
  const reviewFile = path.join(reviewsDir, filename);
  fs.writeFileSync(reviewFile, JSON.stringify(reviewData, null, 2));
}

function isValidReviewData(data: unknown): data is ReviewData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;

  // Check required fields
  if (typeof d.timestamp !== "string") return false;
  // Validate strict ISO 8601 timestamp format
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
  if (!iso8601Regex.test(d.timestamp) || new Date(d.timestamp).toString() === "Invalid Date") return false;
  if (typeof d.gitStatus !== "string") return false;
  if (typeof d.gitDiff !== "string") return false;

  // Check optional fields
  if (d.objective !== undefined && typeof d.objective !== "string") return false;
  if (d.userContext !== undefined && typeof d.userContext !== "string") return false;
  if (d.projectContext !== undefined && typeof d.projectContext !== "string") return false;

  // Check review object
  if (!d.review || typeof d.review !== "object") return false;
  const review = d.review as Record<string, unknown>;
  if (typeof review.pass !== "boolean") return false;
  if (typeof review.feedback !== "string") return false;

  return true;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.promises
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function resolveLatestReviewFile(reviewsDir: string): Promise<string> {
  const dirEntries = await fs.promises.readdir(reviewsDir, { withFileTypes: true });
  const reviewFiles = dirEntries
    .filter((entry) => entry.isFile() && entry.name.match(/^review_.*\.json$/))
    .map((entry) => entry.name);

  if (reviewFiles.length === 0) {
    throw new Error("No reviews found.");
  }

  // Read and validate all review files, collecting valid ones with their timestamps
  const validReviews: Array<{ filename: string; timestamp: Date }> = [];

  for (const file of reviewFiles) {
    try {
      const filePath = path.join(reviewsDir, file);
      const content = await fs.promises.readFile(filePath, "utf8");
      const data = JSON.parse(content);

      if (isValidReviewData(data)) {
        validReviews.push({
          filename: file,
          timestamp: new Date(data.timestamp),
        });
      } else {
        console.warn(chalk.yellow(`Warning: Skipping invalid review file: ${file}`));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(chalk.yellow(`Warning: Skipping unreadable review file ${file}: ${errorMessage}`));
    }
  }

  if (validReviews.length === 0) {
    throw new Error("No valid reviews found.");
  }

  // Sort by timestamp and get the latest
  validReviews.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return path.join(reviewsDir, validReviews[validReviews.length - 1].filename);
}

async function readAndValidateReview(reviewFile: string): Promise<ReviewData> {
  const content = await fs.promises.readFile(reviewFile, "utf8");
  const rawData = JSON.parse(content);

  if (!isValidReviewData(rawData)) {
    throw new Error("Invalid review file format. The file may be corrupted or from an incompatible version.");
  }

  return rawData;
}

function renderReview(reviewData: ReviewData): void {
  const feedback = reviewData.review.feedback || "";
  if (reviewData.review.pass) {
    console.log(chalk.green(`✓ PASSED`));
  } else {
    console.log(chalk.red("✗ FAILED"));
  }

  if (feedback.trim()) {
    console.log(chalk.blue(`=== FEEDBACK ===`));
    console.log(feedback);
  }

  console.log(
    `\nPlease address any valid points in the feedback above.

If you feel the reviewer might be missing important context, you can ask the human user
to provide additional context with "ai-review context <message>" and then resubmit
your changes.`,
  );
}

async function showReview(filename?: string): Promise<void> {
  const reviewsDir = path.join(await getDataDir(), "reviews");

  if (!(await pathExists(reviewsDir))) {
    console.log(chalk.yellow("No reviews found. The reviews directory does not exist."));
    return;
  }

  let reviewFile: string;
  let reviewFilename: string;

  if (filename) {
    if (path.basename(filename) !== filename) {
      reviewFile = path.resolve(filename);
      if (!reviewFile.startsWith(reviewsDir)) {
        throw new Error("Invalid filename. Path traversal not allowed.");
      }
    } else {
      reviewFile = path.join(reviewsDir, filename);
    }

    reviewFilename = path.basename(reviewFile);

    if (!(await pathExists(reviewFile))) {
      throw new Error(`Review file "${filename}" not found.`);
    }
  } else {
    // Show the last review
    reviewFile = await resolveLatestReviewFile(reviewsDir);
    reviewFilename = path.basename(reviewFile);
  }

  const reviewData = await readAndValidateReview(reviewFile);
  console.error(chalk.gray(`File: ${reviewFilename}`));
  console.error(chalk.gray(`Timestamp: ${reviewData.timestamp}`));
  renderReview(reviewData);
}

main().catch((error) => {
  console.error(`Unhandled error`);
  console.error(error);
  process.exit(2);
});
