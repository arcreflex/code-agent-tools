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

errors=()

# Check each template file
while IFS= read -r -d '' file; do
  rel="${file#$TEMPLATE_DIR/}"
  target="$SANDBOX_DIR/$rel"

  if [ ! -f "$target" ]; then
    errors+=("Missing file: $rel"$'\n'"  To fix: cp '$file' '$target'")
    continue
  fi

  # Compare checksums
  template_sum=$(sha256sum "$file" | cut -d' ' -f1)
  sandbox_sum=$(sha256sum "$target" | cut -d' ' -f1)

  if [ "$template_sum" != "$sandbox_sum" ]; then
    diff_snippet=$(diff -u "$file" "$target" | head -20 || true)
    errors+=("File modified: $rel"$'\n'"  Differences (first 20 lines):"$'\n'"$(printf '%s' "$diff_snippet")"$'\n'"  To fix: cp '$file' '$target'")
  fi
done < <(find "$TEMPLATE_DIR" -type f \
  ! -path "*/.git/*" \
  ! -path "*/node_modules/*" \
  ! -name ".DS_Store" \
  ! -name "*.swp" \
  ! -name "*.tmp" \
  -print0)

# Detect extras in SANDBOX_DIR that are not part of the template
while IFS= read -r -d '' sandbox_file; do
  rel="${sandbox_file#$SANDBOX_DIR/}"
  # Skip marker.txt
  if [ "$rel" = "marker.txt" ]; then
    continue
  fi

  tpl_path="$TEMPLATE_DIR/$rel"
  if [ ! -f "$tpl_path" ]; then
    errors+=("Unexpected extra file in sandbox: $rel"$'\n'"  Consider removing it or adding to the template if intended.")
  fi
done < <(find "$SANDBOX_DIR" -type f \
  ! -path "*/.git/*" \
  ! -path "*/node_modules/*" \
  ! -name ".DS_Store" \
  ! -name "*.swp" \
  ! -name "*.tmp" \
  -print0)

if [ "${#errors[@]}" -gt 0 ]; then
  echo "✗ Sandbox integrity check failed:" >&2
  printf ' - %s\n\n' "${errors[@]}" >&2
  exit 1
fi

echo "✓ Sandbox integrity verified"
exit 0
