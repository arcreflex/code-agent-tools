# AI Review Specification

## Overview

AI Review provides AI-powered code review for Git commits, ensuring code quality before changes are committed or pushed.

## Review Commands

- **Init** — `ai-review init [--force]`
  - Initializes `.ai-review` from `packages/ai-review/template`
  - Adds `.ai-review/reviews`, `.ai-review/jobs`, and `.ai-review/user-context.json` to `.gitignore`
  - With `--force`, reinitializes while preserving:
    - `.env`
    - `user-context.json`
    - `reviews/`
- **Review staged changes** — `ai-review`
- **Review with objective** — `ai-review -m <message>` / `--objective <message>`
- **Preview mode** — `ai-review --preview`
  - Shows the exact system and user messages that would be sent; no API calls are made
- **Show saved review** — `ai-review show-review [filename]`
- **Review a range** — `ai-review review-range <old> <new> [--ref <ref>] [--project-context <glob> ...] [--objective <message>] [--preview]`
- **Pre-receive (server-side)** — `ai-review pre-receive [--project-context <glob> ...] [--objective <message>] [--default-branch <name>] [--include <glob> ...] [--exclude <glob> ...] [--include-tags] [--max-diff-bytes <n>] [--continue-on-fail] [--preview] [--async] [--attach-timeout <sec>] [--queue-exit-code <code>]`
- **Async worker** — `ai-review worker --job <jobDir | jobKey>`
- **Show job status** — `ai-review show-job <jobKey | jobDir>`
- **Sandbox-only mode** — append `--sandbox-only` to restrict invocation to the sandbox environment

## Review Workflow

1. **Context loading** — optional project context via `--project-context` globs and optional user context from `.ai-review/user-context.json`
2. **Git collection** — staged diff or `<old>..<new>` diff
3. **Preview check** — `--preview` prints messages and exits 0
4. **Request summary** — objective, model, context summary, and timing note
5. **Model call** — sends a structured request using the system prompt and diff
6. **Result** — receives structured PASS/FAIL with feedback via a function call tool
7. **History** — saves the full review artifact to `.ai-review/reviews/`

## Project Context

`--project-context` globs resolve over **tracked** files (`git ls-files`) in the order provided. Matches are deduplicated and appended to the `CODEBASE CONTEXT` block until the global byte cap is reached (`AI_REVIEW_MAX_CONTEXT_BYTES`, default ≈200 KB). Files that would exceed the budget are replaced with placeholders and listed at the end.

When `AI_REVIEW_MANIFEST_IF_TRACKED_BYTES_UNDER` is set to a positive threshold, a tracked-file manifest is prepended for small repositories. The manifest consumes at most `AI_REVIEW_MANIFEST_MAX_FRACTION` of the context budget (default 0.5).

## User Context

Use `ai-review context` to manage persistent project intent:

- `ai-review context "..."` — set
- `ai-review context --show` — display
- `ai-review context --clear` — clear

This context is injected into the system prompt as:

```

CONTEXT PROVIDED BY PROJECT OWNER (AUTHORITATIVE):
{USER_CONTEXT}

```

## API Configuration

Environment variables:

- `AI_REVIEW_OPENAI_KEY` — required API key
- `AI_REVIEW_OPENAI_BASE_URL` — optional custom endpoint (default `https://api.openai.com/v1`)
- `AI_REVIEW_MODEL` — required model id
- `AI_REVIEW_EXTRA_PARAMS` — optional JSON with extra OpenAI params
- `AI_REVIEW_MAX_CONTEXT_BYTES` — project context byte cap (default ≈200 KB)
- `AI_REVIEW_MANIFEST_IF_TRACKED_BYTES_UNDER` — manifest threshold
- `AI_REVIEW_MANIFEST_MAX_FRACTION` — max fraction of budget for the manifest
- `AI_REVIEW_MAX_DIFF_BYTES` — pre-receive diff cap (default ≈800 KB)

Legacy `AGENT_PRECOMMIT_*` variables are supported for backward compatibility.

## System Prompt

The base prompt lives at `.ai-review/system-prompt.md`. It sets review guidelines, non-negotiables, and output format. The tool appends project context and user context (when present).

## Sandbox Integration

When `--sandbox-only` is set, the tool runs only if `/.agent-sandbox` exists; otherwise it exits 0 with a skip message. `.ai-review/user-context.json` is mounted read-only in the sandbox.

## Server-Side Pre-Receive

Input follows Git’s `pre-receive` convention: lines of `<old> <new> <ref>` from stdin or as positional triples. By default it includes branches (`refs/heads/*`) and excludes tags (`refs/tags/*`). Ref deletions (new = zeros) are ignored. New branch pushes use the merge-base with the default branch as the effective base; the default branch is configurable via `--default-branch` (default `main`).

Diffs exceeding the configured byte cap are rejected. Each qualifying update is reviewed via the same engine as `review-range`. Outcomes are aggregated; the push fails if any review fails. `--continue-on-fail` processes all updates and returns a single non-zero exit if any failed.

### Asynchronous Mode

With `--async`, `pre-receive` snapshots the necessary artifacts into `.ai-review/jobs/<JOB_KEY>/` and spawns a detached worker (`ai-review worker`). A subsequent push can reattach to a running job or reuse a completed result. `--attach-timeout` controls how long the hook waits for the job to finish; on timeout it exits with `--queue-exit-code`.

Job identity is a SHA-256 over: effective base, new commit, model id, extra params JSON, canonicalized project-context globs, and the hash of the rendered system prompt (including user context). Workers update `status.json` and `progress.log`, and store a link to the final review record.

### Minimal host hook

```bash
#!/usr/bin/env bash
exec ai-review pre-receive \
  --project-context "**/*.md" \
  --project-context "package.json"
```

Make it executable: `chmod +x .git/hooks/pre-commit` or `pre-receive` depending on use.

## Output and Exit Codes

- PASS prints “✓ PASSED”; FAIL prints “✗ FAILED” plus feedback
- Exit `0` on pass or preview/skip; `1` on failure; `2` on unhandled error
