#!/usr/bin/env bash
# restore.sh list
# restore.sh <hourly|daily|monthly>/<file> <target mongodb uri (with authSource)> [target database, default restore_check]
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
existing=$(mongosh "$target" --quiet --eval "db.getSiblingDB('$into').getCollectionNames().length")
[ "$existing" = 0 ] || [ "${FORCE:-}" = "1" ] || { echo "$into already has $existing collections: restore into an empty database, or set FORCE=1 to replace them" >&2; exit 1; }

rclone cat "$REMOTE/$object" \
  | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE \
  | mongorestore --uri="$target" --archive --gzip --drop --stopOnError --nsInclude="$MONGODB_DB.*" --nsFrom="$MONGODB_DB.*" --nsTo="$into.*"

restored=$(mongosh "$target" --quiet --eval "db.getSiblingDB('$into').getCollectionNames().length")
[ "$restored" -gt 0 ] || { echo "nothing was restored into $into: is MONGODB_DB ($MONGODB_DB) the database that was backed up?" >&2; exit 1; }

# The dump reads collection after collection while the app writes: a project's counter can be behind its newest task, and every new task would then fail until it caught up
mongosh "$target" --quiet --eval "
const d = db.getSiblingDB('$into');
d.projects.find({}, { taskCounter: 1 }).forEach((p) => {
  const newest = d.tasks.find({ project: p._id }).sort({ taskNumber: -1 }).limit(1).toArray()[0];
  if (newest && newest.taskNumber > (p.taskCounter || 0)) { d.projects.updateOne({ _id: p._id }, { \$set: { taskCounter: newest.taskNumber } }); print('taskCounter of ' + p._id + ' raised to ' + newest.taskNumber); }
});"

echo "restored $object into $into; documents per collection:"
mongosh "$target" --quiet --eval "const d = db.getSiblingDB('$into'); d.getCollectionNames().sort().forEach(c => print(c + ' ' + d.getCollection(c).countDocuments({})))"
