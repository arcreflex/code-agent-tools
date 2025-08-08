# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Project Overview

This is a TypeScript monorepo containing AI development guardrails tools that prevent AI agents from bypassing development quality controls. The project uses npm workspaces to manage two main packages:

- `agent-sandbox`: Containerized environments with development guardrails
- `agent-precommit`: LLM-based pre-commit code review

## Development Commands

### Build Commands

```bash
# Build all packages
npm run build

# Build specific packages
npm run build:precommit  # Build agent-precommit only
npm run build:sandbox     # Build agent-sandbox only
```

### Code Quality

```bash
# Run linting
npm run lint

# Fix linting issues automatically
npm run lint:fix

# Run type checking
npm run typecheck

# Format code with Prettier
npm run format
```

### Publishing

```bash
# Publish individual packages
npm run publish:precommit
npm run publish:sandbox

# Publish all packages
npm run publish:all
```

## Architecture

### Package Structure

The monorepo uses npm workspaces with two main packages under `packages/`:

1. **agent-sandbox** (packages/agent-sandbox/): Docker-based containerized environments
   - Main entry: `src/index.ts` - CLI for managing sandbox containers
   - Template files in `template/` for Docker and configuration
   - Key features: container lifecycle management, readonly overlays, git wrapper hooks

2. **agent-precommit** (packages/agent-precommit/): AI-powered code review
   - Main entry: `src/index.ts` - CLI for pre-commit reviews
   - Uses OpenAI API for code review
   - Integrates with git hooks via Husky

### Key Technical Details

- **TypeScript Configuration**: Shared tsconfig.json at root, compiled with pkgroll
- **ESLint**: Modern flat config using ESLint 9+ with TypeScript support
- **Pre-commit Hooks**: Husky runs lint-staged, TypeScript checks, and agent-precommit in sandbox mode
- **Docker Integration**: agent-sandbox builds and manages Docker containers with specific security features
- **Git Wrapper**: Custom git wrapper script prevents bypass attempts like `--no-verify`
- **Preinstalled CLIs**: Containers include Claude Code and OpenAI Codex (installed globally). Their configs persist via named volumes mounted at `/home/node/.claude` and `/home/node/.codex`.

### Important Files

- `/workspace/code-agent-tools/.husky/pre-commit`: Runs lint-staged, TypeScript checks, and agent-precommit
- `/workspace/code-agent-tools/packages/agent-sandbox/template/scripts/git-wrapper.sh`: Intercepts and validates git commands
- `/workspace/code-agent-tools/packages/agent-precommit/template/system-prompt.md`: Configurable AI review prompt

## Testing

Currently, there are no automated tests configured (test scripts return exit 1). Manual testing approach:

- For agent-sandbox: Use `test-git-wrapper.sh` to verify git command filtering
- For agent-precommit: Test with actual git commits in sandbox environment

## Important Notes

- Both packages are published to npm under the `@arcreflex` scope
- The project enforces strict development practices through pre-commit hooks
- agent-sandbox protects critical directories (`.git/hooks`, `.husky`, `.agent-sandbox`) from modification
- All git operations in sandbox environments are filtered to prevent bypassing quality controls
