#!/usr/bin/env bash
#
# Rebase the fork's main branch onto the latest upstream/main and update origin.
#
# Usage:
#   scripts/sync-upstream.sh             # sync local main and push the fork
#   scripts/sync-upstream.sh --no-push   # sync local main only
#
set -euo pipefail

UPSTREAM_URL="https://github.com/pingdotgg/t3code.git"
DO_PUSH=1

for arg in "$@"; do
  case "$arg" in
    --no-push) DO_PUSH=0 ;;
    -h|--help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Run this script from inside the rCode repository." >&2
  exit 1
}
cd "$REPO_ROOT"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Switch to main before syncing upstream (current branch: ${CURRENT_BRANCH:-detached HEAD})." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash your changes before syncing upstream." >&2
  exit 1
fi

if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "The origin remote is missing; add your fork as origin before syncing." >&2
  exit 1
fi

echo "Fetching upstream..."
git fetch upstream --prune --tags

echo "Rebasing main onto upstream/main..."
git rebase upstream/main

if [[ "$DO_PUSH" == "1" ]]; then
  echo "Updating origin/main..."
  git push --force-with-lease origin main
fi

echo "main is synchronized with upstream/main."