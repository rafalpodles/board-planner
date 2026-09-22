#!/bin/bash
# Packs a built worker into a tarball that runs with `node` alone: no clone, no npm install.
#
#   ./pack.sh 1.2.3 <out-dir>     writes <out-dir>/board-planner-worker-1.2.3.tar.gz
set -euo pipefail

VERSION="${1:?usage: pack.sh <x.y.z> <out-dir>}"
OUT="${2:?usage: pack.sh <x.y.z> <out-dir>}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be x.y.z, got '$VERSION'" >&2
  exit 1
fi
if [ ! -f "$ROOT/dist/main.js" ]; then
  echo "error: no worker build at $ROOT/dist — run 'npm ci && npm run build' in worker/ first." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# The top directory is worker/ so the launchd instructions read the same as in a clone
mkdir -p "$STAGE/worker"
cp -R "$ROOT/dist" "$ROOT/launchd" "$ROOT/README.md" "$STAGE/worker/"
cp "$ROOT/../LICENSE" "$STAGE/worker/"
rm -rf "$STAGE/worker/dist/__fixtures__"

node -e '
  const [source, target, version] = process.argv.slice(1);
  const pkg = JSON.parse(require("fs").readFileSync(source, "utf8"));
  const shipped = {
    name: pkg.name,
    version,
    private: true,
    license: pkg.license,
    type: pkg.type,
    main: pkg.main,
    scripts: { start: pkg.scripts.start },
  };
  require("fs").writeFileSync(target, JSON.stringify(shipped, null, 2) + "\n");
' "$ROOT/package.json" "$STAGE/worker/package.json" "$VERSION"

mkdir -p "$OUT"
TARBALL="$(cd "$OUT" && pwd)/board-planner-worker-$VERSION.tar.gz"
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --uid 0 --gid 0 --uname root --gname wheel -czf "$TARBALL" -C "$STAGE" worker
echo "$TARBALL"
