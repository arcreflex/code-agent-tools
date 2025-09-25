# AI Development Guardrails

Tools that prevent AI agents from bypassing development quality controls. Blocks shortcuts like `--no-verify` and protects critical workflow infrastructure. **Default stance: fail-closed.**

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

**Firewall / networking (summary)**

- **Fail-closed**: if guardrails cannot be applied/verified, sandbox exits non-zero
- **Egress**: DNS (UDP+TCP 53 to Docker DNS), SSH only to GitHub, HTTPS only to allowlisted domains (OpenAI, Anthropic, OpenRouter, npm plus repo-specific extras)
- **Inbound**: closed by default; only ports listed in `.agent-sandbox/config.json#ports` are opened
- No NAT manipulation; only filter-table rules. Requires `--cap-add=NET_ADMIN,NET_RAW`.

**Base image**

- Based on Node 24 (bookworm-slim) with core CLIs preinstalled. Global tool installs are tolerant (warn if missing on the current arch).

### [ai-review](./packages/ai-review/)

LLM-based code review CLI for staged changes, revision ranges, and pre-receive hooks. See the [detailed specification](specs/ai-review.md).

**Behavioral guarantees**

- Returns a deterministic pass/block via a required structured tool/function call
- Hard-fails pre-flight if likely secrets are detected (no API call); can be overridden with `--dangerously-allow-secrets` (content still redacted)
- `--dry-run` (size/scan preview, no network) and `--preview` (show exact request payload/messages)
- Not wired to precommit by default; when enabled, failures are fail-closed by default.

## Development

See [AGENTS.md](./AGENTS.md) for development commands and project structure.
