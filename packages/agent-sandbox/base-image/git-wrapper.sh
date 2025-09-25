#!/bin/bash

# Git wrapper to prevent certain dangerous operations
# This wrapper is installed in the container's PATH before the real git

# Check for disallowed patterns
if [[ "$*" =~ commit.*(--no-verify|-n([[:space:]]|$)) ]]; then
    echo "Error: Use of --no-verify/-n is not allowed. If you are blocked on a precommit check, please escalate to the user for guidance." >&2
    exit 1
fi

# Also check for HUSKY=0
if [[ "$HUSKY" == "0" ]]; then
    echo "Error: HUSKY=0 is not allowed. If you are blocked on a precommit check, please escalate to the user for guidance." >&2
    exit 1
fi

if [[ "$*" =~ push.*(--force|--force-with-lease) ]]; then
    echo "Error: Force pushes are not allowed. If you feel this is necessary, please escalate to the user for guidance." >&2
    exit 1
fi

# Guard against global config edits
if [[ "$1" == "config" && ( " $* " == *" --global "* ) ]]; then
    echo "Error: Mutating global git config is disallowed inside the sandbox. Set repo-local config instead." >&2
    exit 1
fi

# Guard against destructive ref edits (opt-out with env if truly necessary)
if [[ "$1" == "update-ref" && "${AGENT_SANDBOX_ALLOW_UPDATE_REF:-}" != "1" ]]; then
    echo "Error: 'git update-ref' is blocked by default in the sandbox. Set AGENT_SANDBOX_ALLOW_UPDATE_REF=1 if you are absolutely sure." >&2
    exit 1
fi

# Execute the real git command
exec /usr/bin/git "$@"