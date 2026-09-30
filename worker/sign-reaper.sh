#!/bin/bash
# Signs dist/bin/cp-reap with a Developer ID for the tarball, and notarises it when an App Store
# Connect key is given. Without this the tarball carries the linker's ad-hoc signature, and a
# downloaded, quarantined copy hangs its first run behind Gatekeeper (BP-796).
#
#   CP_SIGN_IDENTITY=… [CP_NOTARY_KEY_PATH=… CP_NOTARY_KEY_ID=… CP_NOTARY_ISSUER=…] ./sign-reaper.sh
#
# A bare Mach-O cannot be stapled: Gatekeeper fetches its ticket online on first run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HELPER="$ROOT/dist/bin/cp-reap"
IDENTITY="${CP_SIGN_IDENTITY:?CP_SIGN_IDENTITY is required}"

[ -x "$HELPER" ] || { echo "error: no process reaper at $HELPER — run build-reaper.sh first." >&2; exit 1; }

codesign --force --options runtime --timestamp --sign "$IDENTITY" "$HELPER"
codesign --verify --strict --verbose=2 "$HELPER"

[ -n "${CP_NOTARY_KEY_PATH:-}" ] || { echo "note: $HELPER signed but NOT notarised." >&2; exit 0; }
NOTARY_AUTH=(--key "$CP_NOTARY_KEY_PATH" --key-id "${CP_NOTARY_KEY_ID:?}" --issuer "${CP_NOTARY_ISSUER:?}")

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ditto -c -k --keepParent "$HELPER" "$WORK/cp-reap.zip"

NOTARY_TIMEOUT="${CP_NOTARY_TIMEOUT:-90m}"
SUBMISSION="$(xcrun notarytool submit "$WORK/cp-reap.zip" "${NOTARY_AUTH[@]}" --output-format json)"
SUBMISSION_ID="$(/usr/bin/plutil -extract id raw -o - - <<<"$SUBMISSION")"
echo "reaper notarisation submission id: $SUBMISSION_ID"
xcrun notarytool wait "$SUBMISSION_ID" "${NOTARY_AUTH[@]}" --timeout "$NOTARY_TIMEOUT" || true
SUBMISSION_STATUS="$(xcrun notarytool info "$SUBMISSION_ID" "${NOTARY_AUTH[@]}" --output-format json \
  | /usr/bin/plutil -extract status raw -o - - 2>/dev/null || true)"
if [ "$SUBMISSION_STATUS" != "Accepted" ]; then
  echo "error: notarisation of the reaper ($SUBMISSION_ID) ended '${SUBMISSION_STATUS:-without a verdict}'." >&2
  xcrun notarytool log "$SUBMISSION_ID" "${NOTARY_AUTH[@]}" >&2 || true
  exit 1
fi
