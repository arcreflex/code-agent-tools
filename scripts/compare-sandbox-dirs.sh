#!/bin/bash

# Verify template files exist unchanged in sandbox

set -euo pipefail

TEMPLATE_DIR="packages/agent-sandbox/template"
SANDBOX_DIR=".agent-sandbox"

# Validate directories
[ ! -d "$TEMPLATE_DIR" ] && { echo "Error: Template directory '$TEMPLATE_DIR' not found" >&2; exit 1; }
[ ! -r "$TEMPLATE_DIR" ] && { echo "Error: Template directory '$TEMPLATE_DIR' not readable" >&2; exit 1; }
[ ! -d "$SANDBOX_DIR" ] && { echo "Error: Sandbox directory '$SANDBOX_DIR' not found" >&2; exit 1; }
[ ! -r "$SANDBOX_DIR" ] && { echo "Error: Sandbox directory '$SANDBOX_DIR' not readable" >&2; exit 1; }

echo "Verifying sandbox integrity..."

# Check each template file
while IFS= read -r -d '' file; do
  rel="${file#$TEMPLATE_DIR/}"
  target="$SANDBOX_DIR/$rel"
  
  if [ ! -f "$target" ]; then
    echo "Error: Missing file: $rel" >&2
    echo "To fix: cp '$file' '$target'" >&2
    exit 1
  fi
  
  # Compare checksums
  template_sum=$(sha256sum "$file" | cut -d' ' -f1)
  sandbox_sum=$(sha256sum "$target" | cut -d' ' -f1)
  
  if [ "$template_sum" != "$sandbox_sum" ]; then
    echo "Error: File modified: $rel" >&2
    echo "Differences:" >&2
    diff -u "$file" "$target" | head -20 >&2 || true
    echo "To fix: cp '$file' '$target'" >&2
    exit 1
  fi
done < <(find "$TEMPLATE_DIR" -type f \
  ! -path "*/.git/*" \
  ! -path "*/node_modules/*" \
  ! -name ".DS_Store" \
  ! -name "*.swp" \
  ! -name "*.tmp" \
  -print0)

echo "✓ Sandbox integrity verified"
exit 0
