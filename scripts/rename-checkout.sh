#!/usr/bin/env bash

set -euo pipefail

OLD_DIR="$HOME/Documents/Projects/ClaudePlanner"
NEW_DIR="$HOME/Documents/Projects/BoardPlanner"
OLD_MEM="$HOME/.claude/projects/-Users-$USER-Documents-Projects-ClaudePlanner"
NEW_MEM="$HOME/.claude/projects/-Users-$USER-Documents-Projects-BoardPlanner"
OLD_STATE="$HOME/.claudeplanner"
NEW_STATE="$HOME/.boardplanner"
CONFIGS=("$HOME/.claude/settings.json" "$HOME/.claude/mcp.json")

APPLY=${1:-}
say() { printf '  %s\n' "$1"; }

echo "checkout"
if [ -d "$OLD_DIR" ]; then say "$OLD_DIR → $NEW_DIR"; else say "already moved"; fi

echo "project memory and session history"
if [ -d "$OLD_MEM" ]; then
  say "$OLD_MEM → $NEW_MEM"
  say "$(find "$OLD_MEM/memory" -name '*.md' 2>/dev/null | wc -l | tr -d ' ') memory notes travel with it"
else say "already moved"; fi

echo "worker state directory"
if [ -d "$OLD_STATE" ]; then say "$OLD_STATE → $NEW_STATE"; else say "already moved"; fi

echo "absolute paths in Claude Code config"
for f in "${CONFIGS[@]}"; do
  [ -f "$f" ] || continue
  n=$(grep -c "Projects/ClaudePlanner" "$f" || true)
  [ "$n" -gt 0 ] && say "$f — $n reference(s)"
done

if [ "$APPLY" != "--apply" ]; then
  echo
  echo "Nothing moved. Re-run with --apply."
  exit 0
fi

echo
[ -d "$NEW_DIR" ] && { echo "$NEW_DIR already exists — refusing to merge two checkouts."; exit 1; }
[ -d "$OLD_DIR" ] && mv "$OLD_DIR" "$NEW_DIR" && say "checkout moved"
[ -d "$OLD_MEM" ] && [ ! -d "$NEW_MEM" ] && mv "$OLD_MEM" "$NEW_MEM" && say "memory moved"
[ -d "$OLD_STATE" ] && [ ! -d "$NEW_STATE" ] && mv "$OLD_STATE" "$NEW_STATE" && say "worker state moved"

for f in "${CONFIGS[@]}"; do
  [ -f "$f" ] || continue
  cp "$f" "$f.before-rename"
  sed -i '' 's#Projects/ClaudePlanner#Projects/BoardPlanner#g' "$f"
  say "$(basename "$f") repointed (backup: $f.before-rename)"
done

echo
echo "Done. Open the new path — the old one is gone:"
echo "  cd $NEW_DIR"
