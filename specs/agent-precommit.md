# Agent Precommit Specification

## Overview

Agent-precommit provides AI-powered code review for git commits, ensuring code quality before changes are committed to the repository.

## User Context System

### Context Management

The `context` subcommand allows providing additional context for AI reviews:

- **Set Context**: `agent-precommit context "Implementation requirements..."`
- **Show Context**: `agent-precommit context --show`
- **Clear Context**: `agent-precommit context --clear`

### Context Features

- **Auto-Expiry**: Context expires after 10 minutes
- **Security**: Context blocked when running inside sandbox environment
- **Auto-Clear**: Context automatically cleared after successful reviews
- **Persistence**: Stored in `.agent-precommit/user-context.json`

### Context File Structure

```json
{
  "message": "User provided context string",
  "timestamp": "ISO 8601 timestamp"
}
```

Note: Expiry is calculated dynamically based on timestamp age (10 minutes), not stored in the file.

## Review Process

### Command Interface

- **Init**: `agent-precommit init` initializes `.agent-precommit` config directory, copying from `packages/agent-precommit/template`
- **Basic Review**: `agent-precommit`
- **Sandbox-Only Mode**: `agent-precommit --sandbox-only`
  - Only runs when inside agent-sandbox environment
  - Exits 0 when not in sandbox

### Review Workflow

1. **Environment Detection**: Checks for sandbox environment if `--sandbox-only`
2. **Context Loading**: Loads user context and external context files
3. **Git Status Collection**: Gathers staged changes via `git diff --cached`
4. **AI Review**: Sends to OpenAI API with system prompt and context
5. **Result Processing**: Structured output via function calling
6. **History Logging**: Saves review to audit trail
7. **Context Cleanup**: Clears user context on success

## API Configuration

### Environment Variables

- `AGENT_PRECOMMIT_OPENAI_KEY` - Required API key
- `AGENT_PRECOMMIT_OPENAI_BASE_URL` - Custom API endpoint (defaults to https://api.openai.com/v1)
- `AGENT_PRECOMMIT_MODEL` - Model selection (required, no default)
- `AGENT_PRECOMMIT_EXTRA_CONTEXT_FILE` - Path to additional context file

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
  "userContext": "User provided context message",
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

## Security Features

### Context Isolation

- User context blocked in sandbox
- Sensitive data not exposed to AI
- Context auto-expiry for security

### API Key Protection

- Environment variable based
- Never logged or stored
- Secure transmission only

## Configuration Files

### Directory Structure

```
.agent-precommit/
├── user-context.json    # User context (protected in sandbox)
├── reviews/             # Review history
│   └── review-*.json    # Individual review records
└── system-prompt.md # Customizable AI prompt
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
