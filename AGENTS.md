# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Specification

Detailed specifications for each domain live in the `specs/` directory.

| Topic           | Description                                      | Link                                        |
| --------------- | ------------------------------------------------ | ------------------------------------------- |
| Architecture    | Overall system architecture and design decisions | [Architecture](specs/architecture.md)       |
| Agent Sandbox   | Docker container sandbox implementation details  | [Agent Sandbox](specs/agent-sandbox.md)     |
| AI Review       | AI-powered code review system specification      | [AI Review](specs/ai-review.md)             |

## Development Commands

### Build Commands

```bash
# Build all packages
npm run build

# Build specific packages
npm run build:ai-review  # Build ai-review only
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
npm run publish:ai-review
npm run publish:sandbox

# Publish all packages
npm run publish:all
```

### Releasing a new version

```bash
# Bump package versions
npm --workspaces version patch
git commit -am "Bump package versions"
npm version patch
git push
```
