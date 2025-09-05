### Package Structure

The monorepo uses npm workspaces with two main packages under `packages/`:

1. **agent-sandbox** (packages/agent-sandbox/): Docker-based containerized environments
   - Main entry: `src/index.ts` - CLI for managing sandbox containers
   - Template files in `template/` for Docker and configuration
   - Key features: container lifecycle management, readonly overlays, git wrapper hooks, network firewall
   - [Detailed Specification](agent-sandbox.md)

2. **agent-precommit** (packages/agent-precommit/): AI-powered code review
   - Main entry: `src/index.ts` - CLI for pre-commit reviews
   - Uses OpenAI API for code review
   - Integrates with git hooks via Husky
   - [Detailed Specification](agent-precommit.md)

### Key Technical Details

- **TypeScript Configuration**: Shared tsconfig.json at root, compiled with pkgroll, strict mode with `no-explicit-any` as error
- **ESLint**: Modern flat config using ESLint 9+ with TypeScript support, separate lint-staged config file
- **Pre-commit Hooks**: Multi-step chain - Husky runs lint-staged, TypeScript checks, and agent-precommit in sandbox mode
- **Docker Integration**: agent-sandbox builds and manages Docker containers with specific security features
  - Uses a two-layer image model: a shared base image (`agent-sandbox-base:<tag>`) containing common tooling, security scripts, and ENTRYPOINT; and a thin, per-repo image that derives from the base.
  - Base image built with `agent-sandbox build-base` command from `packages/agent-sandbox/base-image/Dockerfile`
  - Per-repo Dockerfiles should be minimal: `FROM agent-sandbox-base:${BASE_IMAGE_TAG}` plus only repo-specific additions. Workspace code is bind-mounted at runtime.
- **Git Wrapper**: Custom git wrapper script prevents bypass attempts like `--no-verify`
- **Preinstalled CLIs**: Containers include Claude Code, OpenAI Codex, and ast-grep (installed globally). Their configs persist via named volumes mounted at `/home/node/.claude` and `/home/node/.codex`
- **Codex config management**: `agent-sandbox codex-init-config [--auth]` initializes the shared Codex config volume (adds a `config.toml` profile `high` for `gpt-5` with high reasoning effort, and an `AGENTS.md` note about the sandbox). With `--auth`, also imports host Codex credentials.
- **Template Integrity**: Automated SHA256 checksum verification of sandbox templates during lint-staged

### Important Files

- `/workspace/code-agent-tools/.husky/pre-commit`: Runs lint-staged, TypeScript checks, and agent-precommit
- `/workspace/code-agent-tools/packages/agent-sandbox/template/scripts/git-wrapper.sh`: Intercepts and validates git commands
- `/workspace/code-agent-tools/packages/agent-sandbox/template/scripts/init-firewall.sh`: Network firewall setup with domain allowlisting
- `/workspace/code-agent-tools/packages/agent-precommit/template/system-prompt.md`: Configurable AI review prompt
- `/workspace/code-agent-tools/scripts/compare-sandbox-dirs.sh`: Template integrity verification script
