#!/usr/bin/env bash
# Hourly: dump MONGODB_DB, encrypt, upload, prove the upload reads back, keep the daily and monthly copies, prune.
set -euo pipefail
: "${MONGODB_URI:?}" "${BACKUP_PASSPHRASE:?}"
here=$(cd "$(dirname "$(command -v "$0")")" && pwd)
. "$here/common.sh"
HOURLY_KEEP="${HOURLY_KEEP:-48h}"
DAILY_KEEP="${DAILY_KEEP:-720h}"
MONTHLY_KEEP="${MONTHLY_KEEP:-8784h}"
EXPECT_COLLECTION="${EXPECT_COLLECTION:-users}"

ping() { [ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 -o /dev/null "$HEALTHCHECK_URL$1" || true; }
trap 'ping /fail' ERR

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE; }

# A URI with no database falls back to a different one and dumps nothing: say which database, and refuse an empty one
count=$(mongosh "$MONGODB_URI" --quiet --eval "db.getSiblingDB('$MONGODB_DB').getCollection('$EXPECT_COLLECTION').countDocuments({})")
echo "database $MONGODB_DB: $EXPECT_COLLECTION has $count documents"
[ "$count" -gt 0 ] || { echo "refusing to back up a database whose $EXPECT_COLLECTION is empty" >&2; exit 1; }

stamp="${BACKUP_STAMP:-$(date -u +%Y-%m-%dT%H)}"
day=${stamp%T*}
hour=${stamp#*T}
object="hourly/$stamp.archive.gz.enc"

sent=$(mktemp)
mongodump --uri="$MONGODB_URI" --db="$MONGODB_DB" --archive --gzip --quiet | encrypt | tee >(sha256sum | cut -d' ' -f1 > "$sent") | rclone rcat "$REMOTE/$object"

bytes=$(rclone size --json "$REMOTE/$object" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
[ "${bytes:-0}" -gt 1024 ] || { echo "the upload is $bytes bytes" >&2; exit 1; }
# What is stored is what was sent, and it decrypts to its last block with this passphrase
stored=$(rclone cat "$REMOTE/$object" | sha256sum | cut -d' ' -f1)
[ "$stored" = "$(cat "$sent")" ] || { echo "the stored copy differs from what was sent" >&2; exit 1; }
rclone cat "$REMOTE/$object" | decrypt > /dev/null
echo "uploaded and read back: $object, $bytes bytes"

if [ "$hour" = "00" ]; then
  rclone copyto "$REMOTE/$object" "$REMOTE/daily/$day.archive.gz.enc"
  if [ "${day##*-}" = "01" ]; then rclone copyto "$REMOTE/$object" "$REMOTE/monthly/${day%-*}.archive.gz.enc"; fi
fi

rclone delete "$REMOTE/hourly" --min-age "$HOURLY_KEEP"
rclone delete "$REMOTE/daily" --min-age "$DAILY_KEEP"
rclone delete "$REMOTE/monthly" --min-age "$MONTHLY_KEEP"
ping ""
