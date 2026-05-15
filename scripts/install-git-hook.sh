#!/usr/bin/env bash
# Install pre-deploy-check.sh as a git pre-push hook so it runs
# automatically every time you `git push`. One-time setup — run once
# per fresh clone of the repo.
#
# What this does:
#   • symlinks .git/hooks/pre-push → scripts/pre-deploy-check.sh
#   • marks both files executable
#
# After this, `git push` runs the checks first. If anything's broken
# (duplicate IDs, syntax errors, etc.) the push is blocked. Override
# with `git push --no-verify` only when you know what you're doing.
#
# Usage:
#   ./scripts/install-git-hook.sh

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOOK="$ROOT/.git/hooks/pre-push"
SCRIPT="$ROOT/scripts/pre-deploy-check.sh"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "Not a git repo (no .git dir at $ROOT). Bail."
  exit 1
fi

mkdir -p "$ROOT/.git/hooks"
chmod +x "$SCRIPT"

# Symlink (or replace existing hook). Relative path so the symlink
# survives if the repo is moved.
rm -f "$HOOK"
ln -s ../../scripts/pre-deploy-check.sh "$HOOK"
chmod +x "$HOOK"

echo "✓ Installed: .git/hooks/pre-push → scripts/pre-deploy-check.sh"
echo ""
echo "Every \`git push\` now runs the pre-deploy checks first."
echo "Bypass once with \`git push --no-verify\`."
