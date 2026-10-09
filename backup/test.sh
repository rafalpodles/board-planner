#!/usr/bin/env bash
# Runs the whole path on this machine: a Mongo with seeded data, an S3 stand-in (adobe/s3mock), the image, a scratch Mongo.
set -euo pipefail
cd "$(dirname "$0")"
net=bp965-test
cleanup() { docker rm -fv bp965-mongo bp965-scratch bp965-minio >/dev/null 2>&1 || true; docker network rm $net >/dev/null 2>&1 || true; }
[ -n "${KEEP:-}" ] || trap cleanup EXIT
cleanup
docker network create $net >/dev/null
docker build -q -t bp965-backup . >/dev/null
docker run -d --name bp965-mongo --network $net mongo:4.4 >/dev/null
docker run -d --name bp965-scratch --network $net mongo:4.4 >/dev/null
docker run -d --name bp965-minio --network $net -e initialBuckets=bp965 adobe/s3mock >/dev/null
for _ in $(seq 1 30); do docker exec bp965-mongo mongo --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done
for _ in $(seq 1 30); do docker exec bp965-scratch mongo --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done

env_args=(-e MONGODB_URI=mongodb://bp965-mongo:27017 -e R2_ENDPOINT=http://bp965-minio:9090 -e R2_ACCESS_KEY_ID=minio -e R2_SECRET_ACCESS_KEY=minio12345 -e R2_BUCKET=bp965 -e BACKUP_PASSPHRASE=correct-horse)
run() { docker run --rm --network $net "${env_args[@]}" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
for _ in $(seq 1 30); do run bp965-backup bash -c '. /usr/local/bin/common.sh; RCLONE_CONFIG_R2_NO_CHECK_BUCKET=false rclone mkdir "$REMOTE"' 2>/dev/null && break; sleep 1; done

echo "== an empty database is refused, not backed up"
docker exec bp965-mongo mongo --quiet test --eval 'db.other.insertMany(Array.from({length: 3000}, (_, i) => ({n: i, filler: "x".repeat(40)})))' >/dev/null
run bp965-backup backup.sh >/dev/null 2>&1 && fail "backed up a database with no users"

docker exec bp965-mongo mongo --quiet test --eval 'db.users.insertMany(Array.from({length: 250}, (_, i) => ({n: i, name: "user" + i}))); db.tasks.insertMany(Array.from({length: 1000}, (_, i) => ({n: i})))' >/dev/null

echo "== a backup uploads, reads back, and lands under hourly/"
run bp965-backup backup.sh
[ "$(run bp965-backup restore.sh list | grep -c '^hourly/')" = 1 ] || fail "no hourly object"

echo "== an upload that does not read back as it was sent is a failed backup, whether cut short or changed in the middle"
shim=$(mktemp -d)
for fault in 'head -c 200' '{ head -c 100; printf X; tail -c +102; }'; do
  printf '#!/bin/sh\nif [ "$1" = cat ]; then /usr/bin/rclone "$@" | (%s); else exec /usr/bin/rclone "$@"; fi\n' "$fault" > "$shim/rclone"
  chmod +x "$shim/rclone"
  docker run --rm --network $net "${env_args[@]}" -v "$shim:/shim" -e PATH="/shim:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" -e BACKUP_STAMP=2026-12-15T05 bp965-backup backup.sh >/dev/null 2>&1 && fail "a changed read-back passed: $fault"
done
rm -rf "$shim"

echo "== at midnight it keeps a daily copy, and on the first of the month a monthly one"
run -e BACKUP_STAMP=2026-11-01T00 bp965-backup backup.sh >/dev/null
list=$(run bp965-backup restore.sh list)
echo "$list" | grep -q '^daily/2026-11-01' || fail "no daily copy"
echo "$list" | grep -q '^monthly/2026-11' || fail "no monthly copy"
run -e BACKUP_STAMP=2026-12-02T00 bp965-backup backup.sh >/dev/null
list=$(run bp965-backup restore.sh list)
echo "$list" | grep -q '^daily/2026-12-02' || fail "no daily copy on the second"
echo "$list" | grep -q '^monthly/2026-12' && fail "a monthly copy on the second"

echo "== it restores into a scratch database with the same documents, and refuses to restore over the source"
out=$(run bp965-backup restore.sh hourly/$(run bp965-backup restore.sh list | grep '^hourly/' | head -1 | cut -d/ -f2) mongodb://bp965-scratch:27017)
echo "$out"
echo "$out" | grep -q '^users 250$' || fail "users not restored"
echo "$out" | grep -q '^tasks 1000$' || fail "tasks not restored"
run bp965-backup restore.sh monthly/2026-11.archive.gz.enc mongodb://bp965-scratch:27017 test >/dev/null 2>&1 && fail "restored over the source database"

echo "== a wrong passphrase restores nothing"
docker run --rm --network $net "${env_args[@]}" -e BACKUP_PASSPHRASE=wrong bp965-backup restore.sh monthly/2026-11.archive.gz.enc mongodb://bp965-scratch:27017 wrongkey >/dev/null 2>&1 && fail "a wrong passphrase restored"
[ "$(docker exec bp965-scratch mongo --quiet wrongkey --eval 'db.getCollectionNames().length')" = 0 ] || fail "wrongkey has collections"

echo "== old copies are pruned, current ones are not"
run bp965-backup bash -c '. /usr/local/bin/common.sh; echo old | rclone rcat "$REMOTE/hourly/old.txt"'
sleep 3
run -e HOURLY_KEEP=2s bp965-backup backup.sh >/dev/null
list=$(run bp965-backup restore.sh list)
echo "$list" | grep -q 'old.txt' && fail "old.txt survived"
echo "$list" | grep -q '^daily/2026-11-01' || fail "the daily copy was pruned"

echo "ALL GOOD"
