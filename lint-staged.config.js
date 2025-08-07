export default {
  "*.{ts,tsx,js,jsx}": ["prettier --write", "eslint --fix"],
  "packages/agent-sandbox/template/**/*": () => [
    "./scripts/compare-sandbox-dirs.sh",
  ],
  ".agent-sandbox/**/*": () => ["./scripts/compare-sandbox-dirs.sh"],
};
