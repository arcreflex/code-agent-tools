# AI Development Guardrails

Tools that prevent AI agents from bypassing development quality controls. Blocks shortcuts like `--no-verify` and protects critical workflow infrastructure.

AI agents often take shortcuts that skip code review, bypass pre-commit hooks, or modify development infrastructure. These tools enforce proper development practices by blocking problematic commands and protecting key directories.

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

Containerized development environments with built-in guardrails. See [detailed specification](specs/agent-sandbox.md).

**Branch-aware mode (dual mount):** sandboxes mount both the host repo and a shared “repo-shelf” volume. Use `--branch <name>` to work in `/repo-shelf/worktrees/<branch>`. Push back to the host with `git push host <branch>`. Default bind mode still works and can `cd` into any worktree.

### [ai-review](./packages/ai-review/)

LLM-based code review CLI for staged changes, revision ranges, and pre-receive hooks. See [detailed specification](specs/ai-review.md).
(Inspired by https://gist.github.com/huntcsg/c4fe3acf4f7d2fe1ca16e5518a27a23e via https://x.com/xlatentspace)

## Development

See [AGENTS.md](./AGENTS.md) for development commands and project structure.
