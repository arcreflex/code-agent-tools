#!/bin/bash
set -euo pipefail

echo "Setting up sandbox environment..."

# Run firewall initialization
sudo /usr/local/bin/init-firewall.sh

echo "Firewall setup complete. Starting interactive shell..."

# Start zsh as the node user
exec zsh