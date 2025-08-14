# Agent Precommit Specification

## Overview

Agent-precommit provides AI-powered code review for git commits, ensuring code quality before changes are committed to the repository.

## Review Process

### Command Interface

- **Init**: `agent-precommit init`
  - Initializes `.agent-precommit` config directory, copying from `packages/agent-precommit/template`
  - Adds `.agent-precommit/reviews` and `.agent-precommit/user-context.json` to `.gitignore`
- **Basic Review**: `agent-precommit`
- **Sandbox-Only Mode**: `agent-precommit --sandbox-only`
  - Only runs when inside agent-sandbox environment
  - Exits 0 when not in sandbox

### Review Workflow

1. **Environment Detection**: Checks for sandbox environment if `--sandbox-only`
2. **Context Loading**: Loads project context (from `--project-context` globs) and user context (from `.agent-precommit/user-context.json`)
3. **Git Status Collection**: Gathers staged changes via `git diff --cached`
4. **AI Review**: Sends to OpenAI API with system prompt, context, and diff
5. **Result Processing**: Structured output via function calling
6. **History Logging**: Saves review to audit trail

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

### Supported Providers

- **OpenAI**: Default provider
- **OpenRouter**: Via custom base URL
- **Other OpenAI-compatible APIs**: Via base URL configuration

## Review History

### Audit Trail

All reviews saved to `.agent-precommit/reviews/` directory:

- Filename format: `review_{ISO 8601 timestamp}.json`
- Complete review metadata
- Structured JSON format

### Review Record Structure

```json
{
  "timestamp": "ISO 8601 timestamp",
  "objective": "Review objective",
  "userContext": "User context and coding agent instructions",
  "extraContext": "External context file contents",
  "gitStatus": "Git status output",
  "gitDiff": "Git diff --cached output",
  "review": {
    "feedback": "Review feedback message",
    "pass": true | false
  }
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
- No output when skipped
- Used in git hooks

### Protected Files

In sandbox, prevent access by default to:

- `.agent-precommit/user-context.json` (readonly)
- Other sensitive configuration files

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
