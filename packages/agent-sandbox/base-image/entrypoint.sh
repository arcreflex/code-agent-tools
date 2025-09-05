#!/bin/bash
set -euo pipefail

echo "Setting up sandbox environment..."

if [ "${SKIP_FIREWAL:-}" = "1" ]; then
  echo "Skipping firewall setup as SKIP_FIREWALL is set."
else
  # Run firewall initialization
  sudo /usr/local/bin/init-firewall.sh
fi

echo "Firewall setup complete."

# Add a safety guard for Git repo-shelf ownership checks (best effort & idempotent)
# This complements provisioning chown and avoids surprise failures if
# ownership drifts or volumes are pre-populated. Runs as the current user.
if command -v git >/dev/null 2>&1; then
  if ! git config --global --get-regexp '^safe\.directory\s*/repo-shelf/repo$' >/dev/null 2>&1; then
    git config --global --add safe.directory /repo-shelf/repo || true
  fi
fi

# If running interactively, start shell
if [ -t 0 ]; then
  echo "Starting interactive shell..."
  exec bash
else
  echo "Running in detached mode..."
  exec tail -f /dev/null
fi
