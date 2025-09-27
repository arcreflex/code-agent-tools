import { $ } from "zx";

import { execInContainer } from "./docker.ts";
import { loadRepoAndConfigInfo, getWorktreePath, sanitizeBranchName } from "./paths.ts";
import type { RepoInfo } from "./types.ts";

$.verbose = false;

export async function ensureRepoProvisioned(repoPath: string, branch?: string): Promise<string> {
  const info = await loadRepoAndConfigInfo(repoPath);
  const checkout = branch ?? (await detectDefaultBranch(info));
  await provisionRepo(info, checkout);
  return checkout;
}

async function detectDefaultBranch(info: RepoInfo): Promise<string> {
  const result = await $`git -C ${info.repoPath} symbolic-ref --short HEAD`;
  const branch = result.stdout.trim() || "main";
  return branch;
}

async function provisionRepo(info: RepoInfo, branch: string): Promise<void> {
  const sanitized = sanitizeBranchName(branch);
  const script = `
set -euo pipefail
REPO_SHELF=/repo-shelf
HOST_REPO=/workspace/${info.name}
SHELF_REPO="$REPO_SHELF/repo"
WORKTREE_PATH="${getWorktreePath(branch)}"

if [ ! -d "$SHELF_REPO/.git" ]; then
  echo "Initializing repo shelf at $SHELF_REPO"
  git clone "$HOST_REPO" "$SHELF_REPO"
fi

git -C "$SHELF_REPO" remote get-url host >/dev/null 2>&1 || git -C "$SHELF_REPO" remote add host "file://$HOST_REPO"
git -C "$SHELF_REPO" remote set-url host "file://$HOST_REPO"
git -C "$SHELF_REPO" fetch host --prune

if ! git -C "$SHELF_REPO" show-ref --verify --quiet "refs/heads/${branch}"; then
  DEFAULT_BRANCH=$(git -C "$SHELF_REPO" symbolic-ref --short HEAD || echo main)
  git -C "$SHELF_REPO" checkout -B "${branch}" "host/${branch}" || git -C "$SHELF_REPO" checkout -B "${branch}" "$DEFAULT_BRANCH"
fi

mkdir -p "$(dirname "$WORKTREE_PATH")"
if [ ! -d "$WORKTREE_PATH/.git" ]; then
  git -C "$SHELF_REPO" worktree add "$WORKTREE_PATH" "${branch}"
fi

git -C "$WORKTREE_PATH" remote get-url host >/dev/null 2>&1 || git -C "$WORKTREE_PATH" remote add host "file://$HOST_REPO"
git -C "$WORKTREE_PATH" remote set-url host "file://$HOST_REPO"
git -C "$WORKTREE_PATH" config branch.${branch}.remote host
git -C "$WORKTREE_PATH" config branch.${branch}.merge refs/heads/${branch}
`; // end script
  await execInContainer(info, script);
  console.log(`Provisioned worktree ${sanitized} in repo shelf.`);
}
