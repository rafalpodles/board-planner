#!/bin/bash
# Builds the .app, and — when given a Developer ID — signs it with the hardened runtime, notarises
# it and staples the ticket, which is what lets it open on a Mac other than this one.
#
# Ad-hoc by default, so a normal build needs no account and no secrets. The two paths differ only
# in the identity: everything else, hardened runtime included, is the same either way, so a problem
# shows up on the build machine rather than after a submission.
#
#   ./bundle.sh                                   ad-hoc, hardened runtime, runs here only
#   CP_SIGN_IDENTITY="Developer ID Application: …" ./bundle.sh release
#   CP_SIGN_IDENTITY=… CP_NOTARY_PROFILE=… ./bundle.sh release   also notarises and staples
set -euo pipefail

CONFIG="${1:-debug}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
IDENTITY="${CP_SIGN_IDENTITY:--}"
NOTARY_PROFILE="${CP_NOTARY_PROFILE:-}"

swift build --package-path "$ROOT" -c "$CONFIG"
BIN="$(swift build --package-path "$ROOT" -c "$CONFIG" --show-bin-path)/CPMenubar"

APP="$ROOT/.build/CPMenubar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/CPMenubar"

# The worker ships inside the app. A distributed app cannot read one out of the operator's
# checkout — that checkout is their project, and only a Board Planner clone has worker/ in it.
# Zero runtime dependencies, so this is about 200 KB of JavaScript and no node.
WORKER_DIST="$ROOT/../worker/dist"
if [ -d "$WORKER_DIST" ]; then
  mkdir -p "$APP/Contents/Resources/worker"
  cp -R "$WORKER_DIST"/* "$APP/Contents/Resources/worker/"
else
  echo "warning: no worker build at $WORKER_DIST — run npm run build in worker/ first" >&2
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>CPMenubar</string>
  <key>CFBundleIdentifier</key><string>com.boardplanner.menubar</string>
  <key>CFBundleName</key><string>Board Planner Worker</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- Menu bar only: no Dock icon, no window on launch -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# --options runtime on both paths on purpose. Ad-hoc plus hardened runtime is how the spawning and
# login-item behaviour get exercised here, instead of being discovered after a notarisation round.
codesign --force --options runtime \
  --entitlements "$ROOT/Resources/CPMenubar.entitlements" \
  --sign "$IDENTITY" "$APP"

codesign --verify --strict --verbose=2 "$APP" 2>&1 | sed 's/^/  /'

if [ "$IDENTITY" = "-" ]; then
  echo "$APP"
  echo "note: ad-hoc signed — this opens on this Mac only. Set CP_SIGN_IDENTITY to distribute." >&2
  exit 0
fi

# Notarisation takes a zip, and the ticket is stapled to the .app afterwards
ZIP="$ROOT/.build/CPMenubar.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

if [ -z "$NOTARY_PROFILE" ]; then
  echo "$APP"
  echo "note: signed but NOT notarised. Set CP_NOTARY_PROFILE to a stored notarytool profile." >&2
  exit 0
fi

xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
# The stapled ticket lives in the .app, so the zip has to be rebuilt from it
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

# What a first launch on someone else's Mac will actually decide
spctl --assess --type execute --verbose=4 "$APP" 2>&1 | sed 's/^/  /'
echo "$ZIP"
