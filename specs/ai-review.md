# AI Review Specification

## Overview (structured results, secrets-aware)

AI Review provides AI-powered code review for Git commits, ensuring code quality before changes are committed or pushed.

## Review Commands

- **Init** — `ai-review init [--force]`
  - Initializes `.ai-review` from `packages/ai-review/template`
  - Adds `.ai-review/reviews`, `.ai-review/jobs` to `.gitignore`
  - With `--force`, reinitializes while preserving:
    - `.env`
    - `reviews/`
    - `jobs/`
- **Dry run** — `ai-review --dry-run`
  - Runs the full pipeline up to the network call (diff/context packing, redaction/secret scan, size estimates) and prints the would-be request summary. Exits 0.
- **Review a range** — `ai-review <old> [<new> defaults to HEAD] [--project-context <glob> ...] [--objective <message>] [--preview]
- **Review staged changes** - `ai-review staged (same options)`
- **Add objective for review** — `-m <message>` / `--objective <message>`
- **Preview mode** — `--preview` shows the exact system and user messages that would be sent; no API calls are made
- **Attach to job** - `ai-review tail <JOB_KEY>`
- **Show saved review** — `ai-review show-review [filename, default to most recent]`

## Review Workflow

1. **Context loading** — gather project context and commit messages for the range and the diff (staged or old..new).
2. **Start worker** — start a separate worker process to send the review request to the LLM, stream results back for logging, and ultimately store the review result in .ai-review/reviews
3. **Attach to worker** - attach to the worker to show progress, final result, and pass/fail exit code.

- Always print a request summary about the review request. Include a note that the review may take upwards of 3 minutes, as this is helpful context for AI coding agents using this tool.

## Project Context

`--project-context` globs resolve over **tracked** files (`git ls-files`) in the order provided. Matches are deduplicated and appended to the `CODEBASE CONTEXT` block until the global byte cap is reached (`AI_REVIEW_MAX_CONTEXT_BYTES`, default ≈200 KB). Files that would exceed the budget are replaced with placeholders and listed at the end. Can be provided multiple times, with entries processed in order. E.g.: `--project-context specs/**/*.md --project-context **/*.*` would prioritize specs, but include all tracked files if space allwed.

## API Configuration

Environment variables:

- `AI_REVIEW_OPENAI_KEY` — required API key
- `AI_REVIEW_OPENAI_BASE_URL` — optional custom endpoint (default `https://api.openai.com/v1`)
- `AI_REVIEW_MODEL` — required model id
- `AI_REVIEW_EXTRA_PARAMS` — optional JSON with extra OpenAI params
- `AI_REVIEW_MAX_CONTEXT_BYTES` — project context byte cap (default ≈200 KB)

Legacy `AGENT_PRECOMMIT_*` variables are supported for backward compatibility.

## Output Contract (tool/function, required)

The model must return its final decision by calling a tool/function named `finalize_review` with the schema below. The CLI validates the payload; if the tool is not called or validation fails, the run fails with exit code `2`.

```jsonc
{
  "type": "object",
  "properties": {
    "status": { "enum": ["pass", "block"] },
    "blockers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["rule", "title", "file", "line_start", "line_end", "why"],
        "properties": {
          "rule": { "type": "string" },
          "title": { "type": "string" },
          "file": { "type": "string" },
          "line_start": { "type": "integer" },
          "line_end": { "type": "integer" },
          "why": { "type": "string" },
          "suggested_fix": { "type": "string" }
        }
      }
    },
    "notes": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["status", "blockers", "notes"]
}
```

**Decision rule:** if any `blockers` are present → `status` must be `"block"`. The CLI exits `1` on any blocker, `0` on pass.

## Secrets Policy (pre-flight)

- Before any API call, the diff/context is scanned for secrets (for example API keys, tokens, PEM blocks, common `SECRET/TOKEN/API_KEY` env patterns).
- If any are found, the run fails with exit code `1` and a clear file/line report; no content is sent to the model.
- You may bypass intentionally with `--dangerously-allow-secrets`, which still redacts matches before sending and annotates the review as dangerous mode.

## System Prompt

The base prompt lives at `.ai-review/system-prompt.md` (falling back to `~/.ai-review/system-prompt.md`). It sets review guidelines, non-negotiables, and output format. The tool appends project context and user context (when present).

## Output and Exit Codes

- PASS prints “✓ PASSED”; FAIL prints “✗ FAILED” plus feedback
- Exit `0` on pass or preview/skip; `1` on failure; `2` on unhandled error

## Precommit usage

By default, `ai-review` is not wired to precommit. When explicitly enabled, failures and network errors are fail-closed by default (configurable).

