#!/bin/sh
# Install the Doc docs-gate pre-push hook into one or more git repos.
#
# Usage:
#   ci/install-hook.sh <repo-path> [<repo-path> ...]
#
# After install, `git push` from any of those repos rebuilds the manual and blocks the push if the
# documentation quality gate fails. Point the hook at your config and thresholds with the
# DOC_DIR / DOC_CONFIG / DOC_MIN_COVERAGE / DOC_MAX_BROKEN env vars (see ci/pre-push).
# Bypass a single push with `git push --no-verify`.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK_SRC="$HERE/pre-push"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <repo-path> [<repo-path> ...]" >&2
  exit 2
fi

for repo in "$@"; do
  if [ ! -d "$repo/.git" ]; then
    echo "skip: $repo is not a git repo"
    continue
  fi
  cp "$HOOK_SRC" "$repo/.git/hooks/pre-push"
  chmod +x "$repo/.git/hooks/pre-push"
  echo "installed pre-push gate → $repo"
done

echo "Done. Test it from a repo with: git push --dry-run   (or commit + push)."
