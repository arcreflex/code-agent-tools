### Package Structure

The monorepo uses npm workspaces with two packages under `packages/`:

1. **agent-sandbox** (`packages/agent-sandbox/`): Docker-based containerized environments with guardrails
   - Entry point: `src/index.ts` (CLI)
   - Template files in `template/` for Docker and configuration
   - Features: container lifecycle management, readonly overlays, git wrapper hooks, network firewall
   - See the [Agent Sandbox spec](agent-sandbox.md).

2. **ai-review** (`packages/ai-review/`): AI-powered code review
   - Entry point: `src/index.ts` (CLI for pre-commit reviews and server-side Git hooks)
   - Uses OpenAI-compatible APIs for review
   - Returns **structured** results via a required tool/function call; the CLI validates and sets pass/fail status deterministically
   - Supports asynchronous pre-receive processing via a detached worker and a job queue under `.ai-review/jobs`
   - See the [AI Review spec](ai-review.md).

### Key Technical Details

- **TypeScript**: shared `tsconfig.json` at the repo root; compiled with `pkgroll`; strict mode with `no-explicit-any` as an error
- **ESLint**: flat config (ESLint 9+) with TypeScript support; separate lint-staged config
- **Pre-commit**: Husky runs lint-staged, TypeScript checks, and `ai-review` (often in sandbox-only preview)
- **Docker**: agent-sandbox builds and manages images:
  - Base image `agent-sandbox-base:<tag>` contains shared tooling, guardrails, and `ENTRYPOINT`
  - Per-repo image derives from the base; workspace code is bind-mounted at runtime
- **Git wrapper**: blocks `--no-verify` and force pushes
- **Preinstalled CLIs**: Claude Code, OpenAI Codex, and ast-grep; configs persist via named volumes
- **Firewall**: fail-closed egress using filter table only; SSH restricted to GitHub; HTTPS restricted to allowlisted domains; inbound closed unless declared
- **Node base**: Node 24 (bookworm-slim)

### Template Integrity

`scripts/compare-sandbox-dirs.sh` verifies that `.agent-sandbox` matches the template via SHA-256 checksums during lint-staged.
