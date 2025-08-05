# AI coding tools

## Packages

### [agent-sandbox](./packages/agent-sandbox/)

CLI tool for containerized Claude Code development environments. Provides Docker-based development containers with customizable configurations.

**Usage:**

```bash
# Run agent-sandbox in current directory
node packages/agent-sandbox/cli.mjs

# Initialize .agent-sandbox configuration
node packages/agent-sandbox/cli.mjs init

# Build container image
node packages/agent-sandbox/cli.mjs build

# Print config volume name
node packages/agent-sandbox/cli.mjs volume
```

### [agent-precommit](./packages/agent-precommit/)

git pre-commit hook that gets an LLM to review code changes before they are committed.

**Usage:**

```bash
# Run AI code review on staged changes
node packages/agent-precommit/index.ts
```

## Development

### Root Commands

```bash
# Install all dependencies
npm install

# Lint all packages
npm run lint

# Type check all packages
npm run typecheck

# Format all packages
npm run format
```

### Package Structure

- `packages/agent-sandbox/` - Core agent-sandbox CLI functionality
- `packages/agent-precommit/` - AI-powered pre-commit hooks
- Shared configuration at root level (ESLint, TypeScript, etc.)
