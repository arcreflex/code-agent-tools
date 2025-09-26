import type { SecretMatch } from "./types.ts";

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}["']?/i, label: "Generic API key" },
  { pattern: /secret\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/i, label: "Secret assignment" },
  { pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/, label: "PEM private key" },
  { pattern: /ghp_[A-Za-z0-9]{20,}/, label: "GitHub token" },
  { pattern: /sk-[A-Za-z0-9]{20,}/, label: "OpenAI secret key" },
];

export interface SecretScanResult {
  readonly matches: SecretMatch[];
  readonly redactedText: string;
}

export function scanForSecrets(input: string): SecretScanResult {
  const matches: SecretMatch[] = [];
  let redactedText = input;
  for (const { pattern, label } of SECRET_PATTERNS) {
    let match: RegExpExecArray | null;
    const re = new RegExp(pattern, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    while ((match = re.exec(input)) !== null) {
      const line = input.slice(0, match.index).split("\n").length;
      const excerpt = input.slice(match.index, match.index + 80).replace(/\s+/g, " ");
      matches.push({ pattern: label, excerpt, line });
      redactedText = redactedText.replace(match[0], "[REDACTED]");
    }
  }
  return { matches, redactedText };
}
