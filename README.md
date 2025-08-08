# AI Development Guardrails

Tools that prevent AI agents from bypassing development quality controls. Blocks shortcuts like `--no-verify` and protects critical workflow infrastructure.

AI agents often take shortcuts that skip code review, bypass pre-commit hooks, or modify development infrastructure. These tools enforce proper development practices by blocking problematic commands and protecting key directories.

## Installation

```bash
# Install globally via npm
npm install -g @arcreflex/agent-sandbox
npm install -g @arcreflex/agent-precommit

# Or install from source
git clone https://github.com/arcreflex/code-agent-tools.git
cd code-agent-tools
npm install
npm run build
```

## Packages

### [agent-sandbox](./packages/agent-sandbox/)

Containerized development environments with built-in guardrails. Sandboxing allows for giving agents more autonomy without having to worry about them messing with the rest of the system or bypassing various other guardrails.

**Features:**

- **Universal Git Wrapper**: Works with any coding agent CLI (Claude Code, Cursor, Aider, etc.) - blocks `--no-verify`, force pushes, and other bypass attempts
- **Readonly Overlay**: Protects critical directories from modification (configurable)
- **Container Persistence**: Dedicated containers with preserved bash history across sessions
- **Port Forwarding**: Expose container ports for web development
- **Workspace Isolation**: Each project gets its own container and volumes

**Usage:**

```bash
# Run agent-sandbox in current directory (interactive mode)
agent-sandbox

# Initialize .agent-sandbox configuration
agent-sandbox init

# Persistent container workflow
agent-sandbox start  # Start container in background
agent-sandbox shell  # Connect to running container (auto-starts if needed)
agent-sandbox stop   # Stop and remove container

# Build container image
agent-sandbox build

# Print config volume name
agent-sandbox volume

# Set up validation hooks (optional, for Claude Code)
agent-sandbox setup-hooks
```

**Configuration (.agent-sandbox/config.json):**

```json
{
  "ports": [3000, 8080],  // Ports to expose from container
  "readonly": [".git/hooks", ".husky", ".agent-sandbox"]  // Protected directories
}
```

**Development Features:**
- Claude Code and OpenAI Codex CLIs preinstalled (`claude`, `codex`)
- `freeclaude` alias available inside containers for testing Claude Code
- Persistent config volumes for `~/.claude` and `~/.codex`
- Persistent bash history across container sessions
- Workspace-specific volumes prevent cross-project interference

### [agent-precommit](./packages/agent-precommit/)

LLM-based pre-commit hook for code review. Reviews staged changes before allowing commits.
(Inspired by https://gist.github.com/huntcsg/c4fe3acf4f7d2fe1ca16e5518a27a23e via https://x.com/xlatentspace)

**Usage:**

```bash
# Run AI code review on staged changes
agent-precommit

# Provide user context for the review (authoritative intent)
agent-precommit context "Refactoring auth flow to support OAuth2"
agent-precommit context --show    # Display current context
agent-precommit context --clear   # Clear context manually

# Context auto-clears after successful review or 10 minutes
```

**User Context Feature:**

The context command allows human developers to provide authoritative intent when necessary. This is particularly useful when:
- Working with AI coding agents that may not fully explain the purpose of changes
- Making complex refactors where the intent isn't obvious from the diff
- Ensuring the reviewer understands business/architectural decisions

Context is marked as "USER PROVIDED CONTEXT (AUTHORITATIVE)" in the review prompt and is respected as the developer's intent.

## Development

### Build System

This monorepo uses [pkgroll](https://github.com/privatenumber/pkgroll) for TypeScript bundling and npm workspaces for package management.

### Root Commands

```bash
# Install all dependencies
npm install

# Build all packages
npm run build

# Build specific packages
npm run build:sandbox    # Build agent-sandbox only
npm run build:precommit  # Build agent-precommit only

# Code quality
npm run lint        # Lint all packages
npm run lint:fix    # Fix linting issues automatically
npm run typecheck   # Type check all packages
npm run format      # Format with Prettier

# Publishing (maintainers)
npm run publish:sandbox    # Publish agent-sandbox
npm run publish:precommit  # Publish agent-precommit
npm run publish:all        # Publish all packages
```

### CI/CD

- **GitHub Actions**: Automated npm publishing on git tag pushes
- **Pre-commit Hooks**: Husky runs lint-staged, TypeScript checks, and agent-precommit in sandbox mode
- **Template Synchronization**: Lint-staged verifies `.agent-sandbox` stays synchronized with source templates

### Package Structure

- `packages/agent-sandbox/` - Containerized environments with development guardrails
  - `src/` - TypeScript source code
  - `template/` - Docker and configuration templates
  - `dist/` - Built output (generated)
- `packages/agent-precommit/` - LLM-based pre-commit code review
  - `src/` - TypeScript source code
  - `template/` - Configurable AI review prompts
  - `dist/` - Built output (generated)
- Shared configuration at root level (ESLint, TypeScript, Prettier)

### Documentation

- **[AGENTS.md](./AGENTS.md)** - Comprehensive technical reference for AI coding assistants
- **CLAUDE.md** - Project-specific instructions (references AGENTS.md)
- Individual package READMEs for package-specific details
