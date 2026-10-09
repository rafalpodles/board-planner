#!/usr/bin/env bash
# restore.sh list
# restore.sh <hourly|daily|monthly>/<file> <target mongodb uri> [target database, default restore_check]
set -euo pipefail
here=$(cd "$(dirname "$(command -v "$0")")" && pwd)
. "$here/common.sh"

if [ "${1:-}" = "list" ]; then
  for kind in monthly daily hourly; do rclone lsf "$REMOTE/$kind" | sed "s|^|$kind/|"; done
  exit 0
fi

: "${BACKUP_PASSPHRASE:?}"
object="${1:?object, as printed by list}"
target="${2:?target uri}"
into="${3:-restore_check}"
[ "$into" != "$MONGODB_DB" ] || [ "${FORCE:-}" = "1" ] || { echo "refusing to restore over $MONGODB_DB: pick a scratch database, or set FORCE=1" >&2; exit 1; }

rclone cat "$REMOTE/$object" \
  | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE \
  | mongorestore --uri="$target" --archive --gzip --nsFrom="$MONGODB_DB.*" --nsTo="$into.*" --quiet

echo "restored $object into $into; documents per collection:"
mongosh "$target" --quiet --eval "const d = db.getSiblingDB('$into'); d.getCollectionNames().sort().forEach(c => print(c + ' ' + d.getCollection(c).countDocuments({})))"
