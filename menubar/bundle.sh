#!/bin/bash
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

WORKER_DIST="$ROOT/../worker/dist"
if [ ! -f "$WORKER_DIST/main.js" ]; then
  echo "error: no worker build at $WORKER_DIST — run 'npm run build' in worker/ first," >&2
  echo "       or use 'make app', which does it for you. The app is not usable without it." >&2
  exit 1
fi
mkdir -p "$APP/Contents/Resources/worker"
cp -R "$WORKER_DIST"/* "$APP/Contents/Resources/worker/"

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

codesign --force --options runtime \
  --entitlements "$ROOT/Resources/CPMenubar.entitlements" \
  --sign "$IDENTITY" "$APP"

codesign --verify --strict --verbose=2 "$APP" 2>&1 | sed 's/^/  /'

if [ "$IDENTITY" = "-" ]; then
  echo "$APP"
  echo "note: ad-hoc signed — this opens on this Mac only. Set CP_SIGN_IDENTITY to distribute." >&2
  exit 0
fi

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
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

spctl --assess --type execute --verbose=4 "$APP" 2>&1 | sed 's/^/  /'
echo "$ZIP"
