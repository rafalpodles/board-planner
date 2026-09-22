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
#
# CI notarises with an App Store Connect API key instead of a stored profile:
#   CP_NOTARY_KEY_PATH=AuthKey.p8 CP_NOTARY_KEY_ID=… CP_NOTARY_ISSUER=…
# CP_VERSION (x.y.z) and CP_BUILD_NUMBER stamp Info.plist; CP_ARCHS="arm64 x86_64" builds universal.
set -euo pipefail

CONFIG="${1:-debug}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
IDENTITY="${CP_SIGN_IDENTITY:--}"
NOTARY_PROFILE="${CP_NOTARY_PROFILE:-}"
NOTARY_KEY_PATH="${CP_NOTARY_KEY_PATH:-}"
VERSION="${CP_VERSION:-1.0.0}"
BUILD_NUMBER="${CP_BUILD_NUMBER:-1}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: CP_VERSION must be x.y.z, got '$VERSION'" >&2
  exit 1
fi
if ! [[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "error: CP_BUILD_NUMBER must be a whole number, got '$BUILD_NUMBER'" >&2
  exit 1
fi

ARCH_FLAGS=()
for arch in ${CP_ARCHS:-}; do ARCH_FLAGS+=(--arch "$arch"); done

swift build --package-path "$ROOT" -c "$CONFIG" ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}
BIN="$(swift build --package-path "$ROOT" -c "$CONFIG" ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --show-bin-path)/CPMenubar"

APP="$ROOT/.build/CPMenubar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/CPMenubar"

# The worker ships inside the app. A distributed app cannot read one out of the operator's
# checkout — that checkout is their project, and only a Board Planner clone has worker/ in it.
# Zero runtime dependencies, so this is about 200 KB of JavaScript and no node.
WORKER_DIST="$ROOT/../worker/dist"
# Refused rather than warned. A warning on stderr scrolls past, and what it leaves behind is an app
# that installs, onboards, reaches "Connect" and only then says it has nothing to run — by which
# point the build that produced it is long out of sight.
if [ ! -f "$WORKER_DIST/main.js" ]; then
  echo "error: no worker build at $WORKER_DIST — run 'npm run build' in worker/ first," >&2
  echo "       or use 'make app', which does it for you. The app is not usable without it." >&2
  exit 1
fi
mkdir -p "$APP/Contents/Resources/worker"
cp -R "$WORKER_DIST"/* "$APP/Contents/Resources/worker/"
rm -rf "$APP/Contents/Resources/worker/__fixtures__"
# Without it node decides ESM vs CommonJS by sniffing, which older releases do not do. The version
# is what the running worker reports to the server.
printf '{ "type": "module", "version": "%s" }\n' "$VERSION" > "$APP/Contents/Resources/worker/package.json"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>CPMenubar</string>
  <key>CFBundleIdentifier</key><string>com.boardplanner.menubar</string>
  <key>CFBundleName</key><string>Board Planner Worker</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- Menu bar only: no Dock icon, no window on launch -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# --options runtime on both paths on purpose. Ad-hoc plus hardened runtime is how the spawning and
# login-item behaviour get exercised here, instead of being discovered after a notarisation round.
TIMESTAMP=()
[ "$IDENTITY" = "-" ] || TIMESTAMP=(--timestamp)
codesign --force --options runtime ${TIMESTAMP[@]+"${TIMESTAMP[@]}"} \
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

if [ -n "$NOTARY_KEY_PATH" ]; then
  NOTARY_AUTH=(--key "$NOTARY_KEY_PATH" --key-id "${CP_NOTARY_KEY_ID:?CP_NOTARY_KEY_ID is required with CP_NOTARY_KEY_PATH}" \
    --issuer "${CP_NOTARY_ISSUER:?CP_NOTARY_ISSUER is required with CP_NOTARY_KEY_PATH}")
elif [ -n "$NOTARY_PROFILE" ]; then
  NOTARY_AUTH=(--keychain-profile "$NOTARY_PROFILE")
else
  echo "$APP"
  echo "note: signed but NOT notarised. Set CP_NOTARY_PROFILE, or CP_NOTARY_KEY_PATH with its id and issuer." >&2
  exit 0
fi

NOTARY_TIMEOUT="${CP_NOTARY_TIMEOUT:-90m}"
SUBMISSION="$(xcrun notarytool submit "$ZIP" "${NOTARY_AUTH[@]}" --output-format json)"
SUBMISSION_ID="$(/usr/bin/plutil -extract id raw -o - - <<<"$SUBMISSION")"
echo "notarisation submission id: $SUBMISSION_ID"
xcrun notarytool wait "$SUBMISSION_ID" "${NOTARY_AUTH[@]}" --timeout "$NOTARY_TIMEOUT" || true
SUBMISSION_STATUS="$(xcrun notarytool info "$SUBMISSION_ID" "${NOTARY_AUTH[@]}" --output-format json \
  | /usr/bin/plutil -extract status raw -o - - 2>/dev/null || true)"
case "$SUBMISSION_STATUS" in
  Accepted) ;;
  "In Progress"|"")
    echo "error: notarisation of $SUBMISSION_ID had no verdict within $NOTARY_TIMEOUT. Finish it by hand:" >&2
    echo "       xcrun notarytool wait $SUBMISSION_ID <auth>, then xcrun stapler staple CPMenubar.app" >&2
    exit 1
    ;;
  *)
    echo "error: notarisation of $SUBMISSION_ID ended '$SUBMISSION_STATUS'. Apple's log follows." >&2
    xcrun notarytool log "$SUBMISSION_ID" "${NOTARY_AUTH[@]}" >&2 || true
    exit 1
    ;;
esac

for attempt in 1 2 3; do
  if xcrun stapler staple "$APP"; then break; fi
  if [ "$attempt" = 3 ]; then
    echo "error: stapling failed three times; notarisation $SUBMISSION_ID was accepted, so retry 'xcrun stapler staple'." >&2
    exit 1
  fi
  sleep 30
done
# The stapled ticket lives in the .app, so the zip has to be rebuilt from it
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

# What a first launch on someone else's Mac will actually decide
spctl --assess --type execute --verbose=4 "$APP" 2>&1 | sed 's/^/  /'
echo "$ZIP"
