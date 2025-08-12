# Agent Sandbox Specification

## Overview

Agent-sandbox provides Docker-based containerized environments with development guardrails to prevent AI agents from bypassing quality controls.

## Container Management

### Lifecycle Commands

- `init [path]` - Initialize sandbox for a workspace directory
  - Initializes .agent-sandbox and builds image
  - Sets up persistent volumes for configs and history
  - Options: `--force` to remove existing containers/directories
- `build [path]` - Build the Docker image for the sandbox
- `start [path]` - Start the sandbox container
  - Auto-started when running `shell` if not running
- `stop [path]` - Stop the running container

- `shell [path]` - Open interactive shell in container
  - Automatically starts container if not running
  - Default command when no subcommand is provided

- `show-run [path]` - Display docker run command without executing

- `volume` - Get config volume name

### Container Naming

- Uses MD5 hash of workspace path for unique container/volume names
- Enables multiple workspace isolation on same machine

### Persistent Storage

Named volumes that persist across container recreations:

- Claude Code config: `agent-sandbox-claude-code-config`
- Codex config: `agent-sandbox-codex-config`
- Bash history: `agent-sandbox-<hash>-history`

## Network Security

### Firewall System

Comprehensive iptables-based firewall (`init-firewall.sh`):

- Blocks all outbound traffic by default
- Only allows explicitly permitted domains/IPs
- Uses `ipset` for efficient domain management
- Validates firewall effectiveness at setup time

### Allowed Services

Pre-configured access to:

- **Package Registries**: npm registry
- **AI Services**: OpenRouter, OpenAI, Anthropic
- **Development Tools**: GitHub (dynamically fetched IP ranges)
- **Monitoring**: Sentry, Statsig

### Dynamic IP Management

- GitHub IP ranges fetched via API at container startup
- Domain names resolved and added to ipset
- Automatic DNS resolution for allowed domains

## Protected Directories

### Default Protected Paths

Readonly overlay prevents modification of:

- `.git/hooks` - Git hooks configuration
- `.husky` - Husky pre-commit hooks
- `.agent-sandbox` - Sandbox configuration
- `.agent-precommit/user-context.json` - Precommit context

### Configurable Protection

Additional directories can be protected via configuration file.

## Git Integration

### Git Wrapper

Custom git wrapper script (`git-wrapper.sh`) that:

- Intercepts git commands
- Blocks bypass attempts like `git commit --no-verify`, `git push --force`

### Blocked Operations

- `git commit --no-verify`
- `git commit -n`
- `git push --force`
- `git push --force-with-lease`
- Modifications to `.git/hooks/*`
- Modifications to protected directories

## Development Environment

### Pre-installed Tools

**Core Utilities**:

- `less` - File pager
- `fzf` - Fuzzy finder
- `man-db` - Manual pages
- `unzip` - Archive extraction
- `jq` - JSON processor
- `aggregate` - IP/CIDR aggregation utility
- `procps` - Process utilities

**Version Control**:

- `git` - Version control system
- `gh` - GitHub CLI
- `git-delta` - Enhanced git diffs

**Editors**:

- `nano` - Simple text editor
- `vim` - Advanced text editor

**Network/Security**:

- `sudo` - Privilege escalation
- `gnupg2` - GPG encryption
- `iptables` - Firewall management
- `ipset` - IP set management
- `iproute2` - Network configuration
- `dnsutils` - DNS utilities

### AI Development CLIs

Pre-installed globally:

- **Claude Code**: Anthropic's CLI with config at `/home/node/.claude`
- **OpenAI Codex**: With config at `/home/node/.codex`

### Custom Aliases

- `freeclaude` - Run Claude Code without permission checks

### Shell Configuration

- Optimized bash settings
- Persistent command history
- Enhanced prompt and colors

## Configuration

### Workspace Configuration

Configuration stored in `.agent-sandbox/` directory:

- Container settings
- Protected directory list
- Custom environment variables

### Environment Detection

- Marker file `/.agent-sandbox` indicates sandbox environment
- Used by other tools (like agent-precommit) for conditional behavior

## Security Features

### Process Isolation

- Runs as non-root user (`node`)
- Limited container capabilities
- No privileged operations

### Filesystem Protection

- Readonly bind mounts for sensitive directories
- Workspace mounted with write access (except protected paths)

### Network Isolation

- Default-deny outbound policy
- Explicit allowlist for required services
- No inbound by default (unless ports are published)

## Testing

### Test Scripts

- `test-git-wrapper.sh` - Validates git wrapper functionality
  - Tests blocked commands
  - Verifies allowed operations
  - Checks bypass prevention

### Integration Testing

- Manual testing in sandbox environment
- Verification of firewall rules
- CLI functionality validation
