# Agent Precommit Specification

## Overview

Agent-precommit provides AI-powered code review for git commits, ensuring code quality before changes are committed to the repository.

## Review Process

### Command Interface

- **Init**: `agent-precommit init [--force]`
  - Initializes `.agent-precommit` config directory, copying from `packages/agent-precommit/template`
  - Adds `.agent-precommit/reviews` and `.agent-precommit/user-context.json` to `.gitignore`
  - If directory already exists, shows error and suggests using `--force` flag
  - With `--force` flag: Reinitializes while preserving:
    - Existing `.env` file configuration
    - Existing `user-context.json` file
    - Existing `reviews/` directory with all review history
  - Only updates template files (like `system-prompt.md`) to latest versions
- **Basic Review**: `agent-precommit`
- **Review with Objective**: `agent-precommit -m <message>` or `agent-precommit --objective <message>`
  - Provides context about the purpose of the changes being reviewed
  - The objective message is included in the review request to the model
- **Preview Mode**: `agent-precommit --preview`
  - Shows exactly what will be sent to the model provider API without making an API call
  - Displays the system message and user message that would be sent
  - Does not require API credentials or model configuration to run
  - Useful for verifying configuration and understanding the review context
  - Exits with code 0 after displaying the preview
- **Show Review**: `agent-precommit show-review [filename]`
  - Shows the last review if no filename is provided
  - Shows a specific review if a filename is provided
  - Displays the review feedback and pass/fail status
  - Shows the timestamp and objective of the review
- **Review Pushed Range**: `agent-precommit review-range <old> <new> [--ref <ref>] [--project-context <glob> ...] [--objective <message>] [--preview]`
  - Reviews the commit range `<old>..<new>` instead of staged changes
  - Intended for host-side hooks (e.g., `pre-receive`) to enforce review on push
  - Saves results under `.agent-precommit/reviews/` like normal reviews
- **Pre-Receive Hook**: `agent-precommit pre-receive [--project-context <glob> ...] [--objective <message>] [--default-branch <name>] [--include <glob> ...] [--exclude <glob> ...] [--include-tags] [--max-diff-bytes <n>] [--continue-on-fail] [--preview]`
  - Reads `old new ref` triplets from stdin (Git pre-receive semantics) or as positional triples for testing
  - Filters refs (defaults to branches only), enforces a diff byte cap, and reviews each qualifying update via the same engine as `review-range`
  - Aggregates outcomes across updates; fails the push if any review fails
- **Sandbox-Only Mode**: `agent-precommit --sandbox-only`
  - Only runs when inside agent-sandbox environment
  - Exits 0 when not in sandbox

### Review Workflow

1. **Environment Detection**: Checks for sandbox environment if `--sandbox-only`
2. **Context Loading**: Loads project context (from `--project-context` globs) and user context (from `.agent-precommit/user-context.json`)
3. **Git Status Collection**: Gathers staged changes via `git diff --cached` (or range via `git diff <old> <new>` in `review-range`)
4. **Preview Check**: If `--preview` flag is set, displays formatted prompt and exits (skips steps 5-8)
5. **Request Summary**: Displays formatted summary of review configuration (objective, model, context files, user context) with timing note
6. **AI Review**: Sends to model provider API with system prompt, context, and diff
7. **Result Processing**: Structured output via function calling
8. **History Logging**: Saves review to audit trail including raw request/response for debugging

## Project Context

The globs provided by `--project-context` are used to identify context files from the repo that should be included
in every review. These files are provided to the reviewer in the system prompt like:

```
CODEBASE CONTEXT:
{project context file, each identified by relative path with contents in a code block}
```

## User Context

The `context` subcommand allows setting contet about the current task/project to the reviewer:

- **Set User Context**: `agent-precommit context "Overall project goals and coding agent instructions..."`
- **Show User Context**: `agent-precommit context --show`
- **Clear User Context**: `agent-precommit context --clear`

The context set by this command is provided to the AI reviewer in the system prompt like:

```
CONTEXT PROVIDED BY PROJECT OWNER (AUTHORITATIVE):
{USER_CONTEXT}
```

### Purpose

The intent is to use this to provide to the the reviewer context about:

- What the coding agent was supposed to accomplish
- The overall project direction and priorities
- Any specific constraints or requirements

In practice, this may often look like copy-pasting the instructions that were given to the coding agent
whose work is being reviewed.

### File Structure

The user context is stored in a JSON file at `.agent-precommit/user-context.json`.

```json
{
  "message": "User provided project context and coding agent instructions",
  "timestamp": "ISO 8601 timestamp when context was last updated"
}
```

## API Configuration

### Environment Variables

- `AGENT_PRECOMMIT_OPENAI_KEY` - Required API key
- `AGENT_PRECOMMIT_OPENAI_BASE_URL` - Custom API endpoint (defaults to https://api.openai.com/v1)
- `AGENT_PRECOMMIT_MODEL` - Model selection (required, no default)
- `AGENT_PRECOMMIT_EXTRA_PARAMS` - JSON string for additional OpenAI parameters (optional)
- `AGENT_PRECOMMIT_MAX_CONTEXT_BYTES` - Maximum bytes for project context files (defaults to 200000)
- `AGENT_PRECOMMIT_MAX_DIFF_BYTES` - Maximum diff bytes allowed by host pre-receive hook before rejecting (default ~800000)

### Supported Providers

- **OpenAI**: Default provider
- **OpenRouter**: Via custom base URL
- **Other OpenAI-compatible APIs**: Via base URL configuration

## Review History

### Audit Trail

All reviews saved to `.agent-precommit/reviews/` directory:

- Filename format: `review_{ISO 8601 timestamp}.json`
- Complete review metadata including raw API request/response for debugging
- Structured JSON format

### Review Record Structure

```json
{
  "timestamp": "ISO 8601 timestamp",
  "objective": "Review objective",
  "userContext": "User context and coding agent instructions",
  "projectContext": "Project context file contents",
  "gitStatus": "Git status output",
  "gitDiff": "Git diff --cached output",
  "review": {
    "feedback": "Review feedback message",
    "pass": true | false
  },
  "rawRequest": "Complete API request payload sent to model provider (for debugging)",
  "rawResponse": "Complete API response received from model provider (for debugging)"
}
```

## System Prompt

Configurable prompt at `/.agent-precommit/system-prompt.md` containing:

- Review guidelines
- Code quality criteria
- AI-specific review considerations
- Output format instructions

## Sandbox Integration

### Sandbox-Only Mode

Detects sandbox via `/.agent-sandbox` marker file. When `--sandbox-only` flag is set:

- Only runs inside sandbox
- Exits with code 0 outside sandbox
- Shows skip message when not in sandbox
- Used in git hooks

### Protected Files

In sandbox, prevent access by default to:

- `.agent-precommit/user-context.json` (readonly)
- Other sensitive configuration files

## Server-Side Pre-Receive

The `pre-receive` subcommand provides first-class server-side enforcement without custom bash.

### Behavior

- Input: Consumes `old new ref` triplets from stdin (standard Git pre-receive). Also accepts positional triples for testing: `agent-precommit pre-receive <old> <new> <ref> [...]`.
- Scope defaults:
  - Includes branches: `refs/heads/*`
  - Excludes tags: `refs/tags/*` (use `--include-tags` to include)
- Ref deletions: Entries where `new` is all zeros are skipped (no content to review). File deletions within diffs are reviewed normally.
- New branch pushes: Uses the merge-base with the repository's default branch as the base for review. The default branch is configurable via `--default-branch <name>` (defaults to `main`). If the branch cannot be resolved, falls back to using the empty tree as the base. This reviews only the content introduced relative to the default branch.
- Diff size cap: Computes bytes via `git diff --patch --binary <base> <new> | wc -c` and rejects updates exceeding the cap.
  - Threshold: `AGENT_PRECOMMIT_MAX_DIFF_BYTES` (default ~800000). Override via `--max-diff-bytes`.
- Review engine: For each qualifying update, runs the same review flow as `review-range`, saving history under the repository’s `.agent-precommit/reviews/` (bare repos store this under `GIT_DIR/.agent-precommit`).
- Aggregation: Fails the push if any reviewed update fails. Stops at first failure by default; `--continue-on-fail` processes all and reports a summary.
- Errors: Network/provider and unexpected errors block the push.

### Options

- `--project-context <glob>` (repeatable): Additional repo files to include as review context.
- `--objective <text>`: Applies to all updates; if omitted, objectives may be inferred from commit subjects.
- `--default-branch <name>`: Branch used as base for new refs (default: `main`).
- `--preview`: Prints the assembled system/user messages per update and exits 0 without API calls.
- `--include <glob>` (repeatable): Additional ref patterns to include.
- `--exclude <glob>` (repeatable): Ref patterns to exclude.
- `--include-tags`: Convenience flag to include `refs/tags/*`.
- `--max-diff-bytes <n>`: Override the diff size cap (falls back to `AGENT_PRECOMMIT_MAX_DIFF_BYTES`).
- `--continue-on-fail`: Continue processing all updates, then exit 1 if any failed.

### Minimal hook (host repo)

```
#!/usr/bin/env bash
exec agent-precommit pre-receive \
  --project-context "**/*.md" \
  --project-context "package.json"
```

Make it executable: `chmod +x .git/hooks/pre-receive`.

Notes:
- Runs in the push target repository (often bare). In sandboxed local clones, `.git/hooks` may be read-only.
- Reviews are saved under `.agent-precommit/reviews/` in the target repository (bare: `GIT_DIR/.agent-precommit/reviews/`).

### Suggested sandbox pre-commit usage

Keep local hooks fast and non-blocking for agents:

```
agent-precommit --sandbox-only --preview [--project-context ...]
```

## Preview Mode

The `--preview` flag enables a dry-run mode that shows exactly what will be sent to the model provider API without making an API call. This is useful for verifying configuration is correct before running reviews, debugging issues with context loading or prompt assembly, etc.

### Design Principles

The preview mode must use the exact same code path as a real review to ensure accuracy. The preview output should display the actual system message and user message that would be sent to the model provider API, exactly as they are generated by the production code. This ensures that what users see in preview mode is precisely what the model receives, eliminating any possibility of divergence between preview and actual execution.

Preview mode respects all the same configuration and limits as a real review, including:

- `AGENT_PRECOMMIT_MAX_CONTEXT_BYTES` for project context truncation
- All file loading and error handling logic
- Context assembly and formatting

### Preview Output

When running with `--preview`, the tool displays the two messages that would be sent to the model provider API:

1. **System Message**: The complete assembled system prompt including base prompt, project context, and user context
2. **User Message**: The assembled message containing the objective (if any), git status, and diff

The output shows these messages exactly as they would be sent to the model. Any truncation or omission (e.g., due to byte limits) is clearly indicated in the output.

### Preview Mode Examples

```bash
# Preview what will be sent for current staged changes
agent-precommit --preview

# Preview with project context files included
agent-precommit --preview --project-context "*.md" --project-context "package.json"

# Preview with a specific objective
agent-precommit --preview -m "Implementing dark mode feature"

# Preview inside pre-receive (no API calls, exit 0)
git hook payload | agent-precommit pre-receive --preview
```

### Preview Mode Behavior

- No API calls are made in preview mode
- No network connections required
- Does not require API credentials (`AGENT_PRECOMMIT_OPENAI_KEY`) or model configuration to run
- No review history is saved
- Always exits with code 0 after displaying the preview (unless an unhandled error occurs, which returns code 2)
- If no staged changes exist, shows a message and exits with code 0

## Show Review Command

The `show-review` command displays saved review history from the `.agent-precommit/reviews/` directory.

### Usage

```bash
# Show the last review
agent-precommit show-review

# Show a specific review by filename
agent-precommit show-review review_2024-01-15T10-30-00.000Z.json
```

### Output Format

The command displays:

- Review timestamp
- Objective (if provided during review)
- Pass/fail status with appropriate color coding
- Review feedback message

### Error Handling

- If no reviews exist, displays an appropriate message
- If specified review file not found, shows error message
- Validates review file format before display

## Output Format

### Structured Response

AI returns structured response via function calling (`provide_review_feedback`):

```json
{
  "feedback": "Brief feedback written in first person as the developer",
  "pass": true | false
}
```

Feedback guidelines:

- **For PASS**: Minimal, no praise
- **For FAIL**: Direct actionable advice with prodding language to fix issues

### Console Output

### Request Summary

Before starting the review, displays a formatted summary including:

- Review objective (if provided)
- Model being used
- Project context files included (with count)
- User context preview (if set)
- Timing note about potential review duration (2-3 minutes)

### Review Results

- **Approved**: Green checkmark (✓) with feedback message
- **Rejected**: Red X (✗) with feedback message
- **Errors**: Clear error messages with guidance

### Exit Codes

- `0` - Review passed or skipped (sandbox-only mode)
- `1` - Review failed or error occurred
- `2` - Unhandled error

## Configuration Files

### Directory Structure

```
.agent-precommit/
├── user-context.json # Persistent project context (protected in sandbox)
├── reviews/             # Review history
│   └── review-*.json    # Individual review records
└── system-prompt.md     # Customizable AI prompt
```

### Git Integration

Integrated with git hooks via Husky:

- Runs in pre-commit hook
- After lint-staged and TypeScript checks
- Blocks commit on rejection

## Testing

### Manual Testing

- Test with actual git commits
- Verify sandbox integration
- Check API connectivity
- Validate review quality

### Test Scenarios

- Various code change types
- Different file formats
- Security vulnerability detection
- Performance issue identification
- AI code review accuracy
