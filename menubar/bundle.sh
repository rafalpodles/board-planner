#!/bin/bash
# Wraps the SwiftPM executable in a .app bundle.
#
# Not optional packaging: UNUserNotificationCenter throws `bundleProxyForCurrentProcess is nil` for
# a bare binary, so the app cannot start at all outside a bundle. LSUIElement keeps it out of the
# Dock, which is what a menubar app wants.
set -euo pipefail

CONFIG="${1:-debug}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$(swift build --package-path "$ROOT" -c "$CONFIG" --show-bin-path)/CPMenubar"

swift build --package-path "$ROOT" -c "$CONFIG"

APP="$ROOT/.build/CPMenubar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/CPMenubar"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>CPMenubar</string>
  <key>CFBundleIdentifier</key><string>com.claudeplanner.menubar</string>
  <key>CFBundleName</key><string>ClaudePlanner Worker</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- Menu bar only: no Dock icon, no window on launch -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signing is enough for UserNotifications to accept the bundle locally; without any
# signature the notification centre refuses to register it.
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "codesign failed; notifications may not register"

echo "$APP"
