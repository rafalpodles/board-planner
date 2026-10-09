#!/usr/bin/env bash
# Hourly: dump MONGODB_DB, encrypt, upload to incoming/, prove it, move it to hourly/, keep one daily and monthly copy, prune.
set -euo pipefail

ping() { [ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 -o /dev/null "$HEALTHCHECK_URL$1" || true; }
trap 'rc=$?; trap - EXIT; [ $rc -eq 0 ] || ping /fail; exit $rc' EXIT
trap 'exit 143' TERM

# A run that hangs would stop every later one
if [ -z "${BACKUP_INNER:-}" ]; then BACKUP_INNER=1 exec timeout "${BACKUP_TIMEOUT:-45m}" "$0" "$@"; fi

: "${MONGODB_URI:?}" "${BACKUP_PASSPHRASE:?}"
[ -n "${HEALTHCHECK_URL:-}" ] || [ "${ALLOW_NO_HEALTHCHECK:-}" = "1" ] || { echo "set HEALTHCHECK_URL: a backup that fails must tell somebody" >&2; exit 1; }
case "$MONGODB_URI" in *authSource=*) ;; *) echo "MONGODB_URI needs authSource=admin: the tools would otherwise log in against the dumped database" >&2; exit 1 ;; esac
here=$(cd "$(dirname "$(command -v "$0")")" && pwd)
. "$here/common.sh"
HOURLY_KEEP="${HOURLY_KEEP:-48h}"
DAILY_KEEP="${DAILY_KEEP:-720h}"
MONTHLY_KEEP="${MONTHLY_KEEP:-8784h}"
EXPECT_COLLECTION="${EXPECT_COLLECTION:-users}"

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE; }

# A URI with no database falls back to a different one and dumps nothing: say which database, and refuse an empty one
count=$(mongosh "$MONGODB_URI" --quiet --eval "db.getSiblingDB('$MONGODB_DB').getCollection('$EXPECT_COLLECTION').countDocuments({})")
echo "database $MONGODB_DB: $EXPECT_COLLECTION has $count documents"
[ "$count" -gt 0 ] || { echo "refusing to back up a database whose $EXPECT_COLLECTION is empty" >&2; exit 1; }

stamp="${BACKUP_STAMP:-$(date -u +%Y-%m-%dT%H)}"
day=${stamp%T*}
month=${day%-*}
object="hourly/$stamp.archive.gz.enc"
incoming="incoming/$stamp-$$.archive.gz.enc"

# Into incoming/ first: a dump that dies midway still uploads, and must not take the place of a good copy
sent=$(mktemp)
mongodump --uri="$MONGODB_URI" --db="$MONGODB_DB" --archive --gzip --quiet | encrypt | tee >(sha256sum | cut -d' ' -f1 > "$sent") | rclone rcat "$REMOTE/$incoming"

bytes=$(rclone size --json "$REMOTE/$incoming" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
[ "${bytes:-0}" -gt 1024 ] || { echo "the upload is $bytes bytes" >&2; exit 1; }
# What is stored is what was sent
stored=$(rclone cat "$REMOTE/$incoming" | sha256sum | cut -d' ' -f1)
[ "$stored" = "$(cat "$sent")" ] || { echo "the stored copy differs from what was sent" >&2; exit 1; }
rclone moveto "$REMOTE/$incoming" "$REMOTE/$object"
echo "uploaded and read back: $object, $bytes bytes"

# The first good dump of a day and of a month is kept, whichever hour it is: a failed midnight run loses nothing
[ -n "$(rclone lsf "$REMOTE/daily/$day.archive.gz.enc")" ] || rclone copyto "$REMOTE/$object" "$REMOTE/daily/$day.archive.gz.enc"
[ -n "$(rclone lsf "$REMOTE/monthly/$month.archive.gz.enc")" ] || rclone copyto "$REMOTE/$object" "$REMOTE/monthly/$month.archive.gz.enc"

rclone delete "$REMOTE/incoming" --min-age 24h
rclone delete "$REMOTE/hourly" --min-age "$HOURLY_KEEP"
rclone delete "$REMOTE/daily" --min-age "$DAILY_KEEP"
rclone delete "$REMOTE/monthly" --min-age "$MONTHLY_KEEP"
ping ""
