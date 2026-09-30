#!/bin/bash
# Builds the process reaper (src/reap.ts) into dist/bin/cp-reap, universal unless CP_ARCHS says
# otherwise, so a release carries it rather than needing a compiler on the operator's machine.
#
#   ./build-reaper.sh            after `npm run build`
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ARCHS="${CP_ARCHS:-arm64 x86_64}"

if [ ! -f "$ROOT/dist/reap.js" ]; then
  echo "error: no worker build at $ROOT/dist — run 'npm run build' in worker/ first." >&2
  exit 1
fi

ARCH_FLAGS=()
for arch in $ARCHS; do ARCH_FLAGS+=(-arch "$arch"); done

# A file rather than stdin: clang reads the input once per architecture
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SOURCE="$WORK/reap.c"
node --input-type=module -e 'process.stdout.write((await import(process.argv[1])).REAPER_SOURCE)' "$ROOT/dist/reap.js" > "$SOURCE"

mkdir -p "$ROOT/dist/bin"
xcrun clang -O2 -Wall -Werror -mmacosx-version-min=14.0 "${ARCH_FLAGS[@]}" "$SOURCE" -o "$ROOT/dist/bin/cp-reap"
chmod 755 "$ROOT/dist/bin/cp-reap"
lipo -info "$ROOT/dist/bin/cp-reap"
