FROM node:24-bookworm-slim

# Build arguments for tool versions
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG GIT_DELTA_VERSION=0.18.2
ARG AST_GREP_VERSION=latest

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  ca-certificates \
  procps \
  sudo \
  fzf \
  man-db \
  unzip \
  gnupg2 \
  curl \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  wget \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R ${USERNAME} /commandhistory

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude /home/node/.codex && \
  chown -R node:node /workspace /home/node/.claude /home/node/.codex

WORKDIR /workspace

# Install git-delta for better diffs
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# NPM global package installation directory
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Shell setup
ENV SHELL=/bin/bash
ENV EDITOR=vim
ENV VISUAL=vim
ENV TERM=xterm-256color
ENV COLORTERM=truecolor
ENV HISTFILE=/commandhistory/.bash_history
ENV PROMPT_COMMAND="history -a"

# Copy and set up security scripts
COPY ./init-firewall.sh ./git-wrapper.sh ./entrypoint.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  chmod +x /usr/local/bin/entrypoint.sh && \
  chmod +x /usr/local/bin/git-wrapper.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall && \
  # Install git wrapper by creating a symlink in /usr/local/bin (which comes before /usr/bin in PATH)
  ln -sf /usr/local/bin/git-wrapper.sh /usr/local/bin/git && \
  # Ensure login shells keep npm global bin on PATH
  printf '%s\n' 'export PATH="/usr/local/share/npm-global/bin:$PATH"' > /etc/profile.d/npm-global.sh && \
  chmod 0644 /etc/profile.d/npm-global.sh
USER node

# Tools for AI agents
RUN npm install -g @playwright/mcp@latest || echo "warning: failed to install @playwright/mcp@latest"
RUN npm install -g @ast-grep/cli@${AST_GREP_VERSION} || echo "warning: failed to install @ast-grep/cli@${AST_GREP_VERSION}"

# Install AI CLIs globally
RUN npm install -g opencode-ai@latest || echo "warning: failed to install opencode-ai@latest"

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} || echo "warning: failed to install @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
RUN echo "alias freeclaude='claude --dangerously-skip-permissions'" >> /home/node/.bashrc

RUN npm install -g @openai/codex@${CODEX_VERSION} || echo "warning: failed to install @openai/codex@${CODEX_VERSION}"
RUN echo "alias freecodex='codex --sandbox=danger-full-access'" >> /home/node/.bashrc

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
