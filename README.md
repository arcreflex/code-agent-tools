# AI Development Guardrails

Tools that prevent AI agents from bypassing development quality controls. Blocks shortcuts like `--no-verify` and protects critical workflow infrastructure.

AI agents sometimes skip code review, bypass pre-commit hooks, or modify development infrastructure. These tools enforce proper development practices by blocking problematic commands and protecting key directories.

## Installation

```bash
# Install globally via npm
npm install -g @arcreflex/agent-sandbox
npm install -g @arcreflex/ai-review

# Or install from source
git clone https://github.com/arcreflex/code-agent-tools.git
cd code-agent-tools
npm install
npm run build
```

## Packages

### [agent-sandbox](./packages/agent-sandbox/)

Containerized development environments with built-in guardrails. See the [detailed specification](specs/agent-sandbox.md).

Each workspace runs a single container that mounts the host checkout at `/workspace/<repo>` and a shared **repo-shelf** volume. `--branch <name>` (default: the current host branch) provisions `/repo-shelf/worktrees/<branchSan>`. `agent-sandbox shell` launches directly in that path via `docker exec -w`. Sandbox branches track `host/<branch>` so `git push` works without extra flags.

### [ai-review](./packages/ai-review/)

LLM-based code review CLI for staged changes, revision ranges, and pre-receive hooks. See the [detailed specification](specs/ai-review.md).

## Development

See [AGENTS.md](./AGENTS.md) for development commands and project structure.
