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

# Add a safety guard for Git repo-shelf ownership checks (best-effort)
# This complements provisioning chown and avoids surprise failures if
# ownership drifts or volumes are pre-populated.
git config --global --add safe.directory /repo-shelf/repo >/dev/null 2>&1 || true

# If running interactively, start shell
if [ -t 0 ]; then
  echo "Starting interactive shell..."
  exec bash
else
  echo "Running in detached mode..."
  exec tail -f /dev/null
fi
