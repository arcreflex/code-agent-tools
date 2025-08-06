# AI Development Guardrails

Tools that prevent AI agents from bypassing development quality controls. Blocks shortcuts like `--no-verify` and protects critical workflow infrastructure.

AI agents often take shortcuts that skip code review, bypass pre-commit hooks, or modify development infrastructure. These tools enforce proper development practices by blocking problematic commands and protecting key directories.

## Packages

### [agent-sandbox](./packages/agent-sandbox/)

Containerized development environments with built-in guardrails. Sandboxing allows for giving agents more autonomy without having to worry about them messing with the rest of the system or bypassing various other guardrails.

**Features:**

- **Claude Code hook**: Blocks `--no-verify`, force pushes, and other bypass attempts
- **Readonly Overlay**: Protects `.git/hooks`, `.husky`, `.agent-sandbox` directories from modification

**Usage:**

```bash
# Run agent-sandbox in current directory
agent-sandbox

# Initialize .agent-sandbox configuration
agent-sandbox init

# Build container image
agent-sandbox build

# Print config volume name
agent-sandbox volume

# Set up Claude Code hooks
agent-sandbox setup-hooks
```

### [agent-precommit](./packages/agent-precommit/)

LLM-based pre-commit hook for code review. Reviews staged changes before allowing commits.
(Inspired by https://gist.github.com/huntcsg/c4fe3acf4f7d2fe1ca16e5518a27a23e via https://x.com/xlatentspace)

**Usage:**

```bash
# Run AI code review on staged changes
agent-precommit
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

- `packages/agent-sandbox/` - Containerized environments with development guardrails
- `packages/agent-precommit/` - LLM-based pre-commit code review
- Shared configuration at root level (ESLint, TypeScript, etc.)
