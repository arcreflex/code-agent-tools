import { readFileSync } from "fs";

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: {
    command?: string;
    [key: string]: unknown;
  };
}

interface DisallowedPattern {
  pattern: RegExp;
  message: string;
}

// List of disallowed patterns with explanations
const DISALLOWED_PATTERNS: DisallowedPattern[] = [
  {
    pattern: /git\s+commit.*--no-verify/,
    message:
      "Use of --no-verify is not allowed. If you are blocked on a precommit check, please escalate to the user for guidance.",
  },
  {
    pattern: /git\s+commit.*-n(?:\s|$)/,
    message:
      "Use of -n flag is not allowed. If you are blocked on a precommit check, please escalate to the user for guidance.",
  },
  {
    pattern: /git\s+push.*--force(-with-lease)?/,
    message:
      "Force pushes are not allowed. If you feel this is necessary, please escalate to the user for guidance.",
  },
];

function main(): void {
  try {
    // Read input from stdin
    const input = readFileSync(0, "utf-8");
    const hookData: HookInput = JSON.parse(input);

    // Only process Bash tool calls
    if (hookData.tool_name !== "Bash") {
      process.exit(0);
    }

    const command = hookData.tool_input.command;

    // If no command, nothing to validate
    if (!command) {
      process.exit(0);
    }

    // Check against disallowed patterns
    for (const { pattern, message } of DISALLOWED_PATTERNS) {
      if (pattern.test(command)) {
        // Exit code 2 blocks the tool call and shows stderr to Claude
        console.error(`Command blocked: ${message}`);
        console.error(`Command attempted: ${command}`);
        process.exit(2);
      }
    }

    // Command is allowed
    process.exit(0);
  } catch (error) {
    // If there's an error parsing or processing, log it but don't block
    console.error(
      `Hook error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

main();
