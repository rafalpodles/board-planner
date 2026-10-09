#!/usr/bin/env bash
# Runs the whole path on this machine: a Mongo with authentication and seeded data, an S3 stand-in (adobe/s3mock), the image, a scratch Mongo.
set -euo pipefail
cd "$(dirname "$0")"
net=bp965-test
cleanup() { docker rm -fv bp965-mongo bp965-scratch bp965-s3 bp965-ping >/dev/null 2>&1 || true; docker network rm $net >/dev/null 2>&1 || true; }
[ -n "${KEEP:-}" ] || trap cleanup EXIT
cleanup
docker network create $net >/dev/null
docker build -q -t bp965-backup . >/dev/null
auth=(-e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=rootpw)
docker run -d --name bp965-mongo --network $net "${auth[@]}" mongo:4.4 >/dev/null
docker run -d --name bp965-scratch --network $net "${auth[@]}" mongo:4.4 >/dev/null
docker run -d --name bp965-s3 --network $net -e initialBuckets=bp965 adobe/s3mock >/dev/null
docker run -d --name bp965-ping --network $net alpine sh -c 'while true; do printf "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n" | nc -l -p 8080 >> /tmp/pings; done' >/dev/null
sh_mongo() { docker exec "$1" mongo -u root -p rootpw --authenticationDatabase admin --quiet "${@:2}"; }
for host in bp965-mongo bp965-scratch; do
  for _ in $(seq 1 60); do sh_mongo $host --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done
done

uri="mongodb://root:rootpw@bp965-mongo:27017/?authSource=admin"
scratch="mongodb://root:rootpw@bp965-scratch:27017/?authSource=admin"
env_args=(-e MONGODB_URI="$uri" -e R2_ENDPOINT=http://bp965-s3:9090 -e R2_ACCESS_KEY_ID=key -e R2_SECRET_ACCESS_KEY=secret12345 -e R2_BUCKET=bp965 -e BACKUP_PASSPHRASE=correct-horse -e ALLOW_NO_HEALTHCHECK=1)
run() { docker run --rm --network $net "${env_args[@]}" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
expect_failure() { local why=$1; shift; local out; if out=$("$@" 2>&1); then fail "it succeeded, and should have failed: $why"; fi; echo "$out" | grep -q -- "$why" || fail "it failed, but not for '$why': $out"; }
sh() { run bp965-backup bash -c ". /usr/local/bin/common.sh; $1"; }
list() { run bp965-backup restore.sh list; }
for _ in $(seq 1 30); do sh 'RCLONE_CONFIG_R2_NO_CHECK_BUCKET=false rclone mkdir "$REMOTE"' >/dev/null 2>&1 && break; sleep 1; done

echo "== a URI without authSource, no healthcheck, and an empty database are all refused, each for its reason"
expect_failure "authSource" docker run --rm --network $net "${env_args[@]}" -e MONGODB_URI=mongodb://root:rootpw@bp965-mongo:27017 bp965-backup backup.sh
expect_failure "HEALTHCHECK_URL" docker run --rm --network $net "${env_args[@]}" -e ALLOW_NO_HEALTHCHECK= bp965-backup backup.sh
sh_mongo bp965-mongo test --eval 'db.other.insertMany(Array.from({length: 3000}, (_, i) => ({n: i, filler: "x".repeat(40)})))' >/dev/null
expect_failure "refusing to back up" run -e ALLOW_NO_HEALTHCHECK= -e HEALTHCHECK_URL=http://bp965-ping:8080/hc bp965-backup backup.sh
pings() { docker exec bp965-ping cat /tmp/pings 2>/dev/null || true; }
pings | grep -q 'GET /hc/fail' || fail "a refusal did not ping /fail"

sh_mongo bp965-mongo test --eval '
  db.users.insertMany(Array.from({length: 250}, (_, i) => ({n: i, name: "user" + i})));
  db.tasks.insertMany(Array.from({length: 1000}, (_, i) => ({n: i, project: i % 2 ? "p1" : "p2", taskNumber: i})));
  db.projects.insertMany([{_id: "p1", taskCounter: 3}, {_id: "p2", taskCounter: 5000}])' >/dev/null

echo "== a backup uploads, reads back, and lands under hourly/, leaving nothing in incoming/, and says it succeeded"
run -e ALLOW_NO_HEALTHCHECK= -e HEALTHCHECK_URL=http://bp965-ping:8080/hc bp965-backup backup.sh
pings | grep -q 'GET /hc ' || fail "a success did not ping"
[ "$(list | grep -c '^hourly/')" = 1 ] || fail "no hourly object"
[ -z "$(sh 'rclone lsf "$REMOTE/incoming"')" ] || fail "incoming/ is not empty"

echo "== a dump that dies midway never takes the place of a copy"
shim=$(mktemp -d)
printf '#!/bin/sh\nhead -c 500 /dev/urandom\nexit 1\n' > "$shim/mongodump"; chmod +x "$shim/mongodump"
shimmed() { docker run --rm --network $net "${env_args[@]}" -v "$shim:/shim" -e PATH="/shim:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "$@"; }
if shimmed -e BACKUP_STAMP=2027-01-01T01 bp965-backup backup.sh >/dev/null 2>&1; then fail "a dead dump passed"; fi
list | grep -q '^hourly/2027-01-01T01' && fail "a dead dump became an hourly copy"

echo "== an upload that does not read back as it was sent is a failed backup, whether cut short or changed in the middle"
rm -f "$shim/mongodump"
for fault in 'head -c 200' '{ head -c 100; printf X; tail -c +102; }'; do
  printf '#!/bin/sh\nif [ "$1" = cat ]; then /usr/bin/rclone "$@" | (%s); else exec /usr/bin/rclone "$@"; fi\n' "$fault" > "$shim/rclone"; chmod +x "$shim/rclone"
  out=$(shimmed -e BACKUP_STAMP=2026-12-15T05 bp965-backup backup.sh 2>&1) && fail "a changed read-back passed: $fault"
  echo "$out" | grep -q "differs" || fail "a changed read-back failed for another reason: $out"
done
rm -rf "$shim"
list | grep -q '^hourly/2026-12-15T05' && fail "a bad upload became an hourly copy"

echo "== the first good dump of a day and of a month is kept, whatever the hour, and is not replaced"
run -e BACKUP_STAMP=2026-11-01T00 bp965-backup backup.sh >/dev/null
first=$(sh 'rclone cat "$REMOTE/daily/2026-11-01.archive.gz.enc" | sha256sum')
run -e BACKUP_STAMP=2026-11-01T09 bp965-backup backup.sh >/dev/null
[ "$first" = "$(sh 'rclone cat "$REMOTE/daily/2026-11-01.archive.gz.enc" | sha256sum')" ] || fail "the daily copy was replaced"
run -e BACKUP_STAMP=2026-12-02T05 bp965-backup backup.sh >/dev/null
all=$(list)
echo "$all" | grep -q '^monthly/2026-11' || fail "no monthly copy for November"
echo "$all" | grep -q '^daily/2026-12-02' || fail "no daily copy for a run at five"
echo "$all" | grep -q '^monthly/2026-12' || fail "no monthly copy for a month first dumped on the second"

echo "== it restores into a scratch database with the same documents, and raises a counter the dump left behind"
out=$(run bp965-backup restore.sh hourly/$(list | grep '^hourly/' | head -1 | cut -d/ -f2) "$scratch")
echo "$out"
echo "$out" | grep -q '^users 250$' || fail "users not restored"
echo "$out" | grep -q '^tasks 1000$' || fail "tasks not restored"
echo "$out" | grep -q 'taskCounter of p1 raised to 999' || fail "the counter behind its newest task was not raised"
echo "$out" | grep -q 'taskCounter of p2' && fail "a counter ahead of its tasks was lowered or touched"

echo "== it will not restore into a database that has data, over the source, or with the wrong database name; FORCE replaces"
expect_failure "already has" run bp965-backup restore.sh monthly/2026-11.archive.gz.enc "$scratch"
expect_failure "refusing to restore over" run bp965-backup restore.sh monthly/2026-11.archive.gz.enc "$scratch" test
sh_mongo bp965-scratch restore_check --eval 'db.users.insertOne({stray: true})' >/dev/null
run -e FORCE=1 bp965-backup restore.sh monthly/2026-11.archive.gz.enc "$scratch" | grep -q '^users 250$' || fail "FORCE did not replace what was there"
expect_failure "nothing was restored" run -e MONGODB_DB=other bp965-backup restore.sh monthly/2026-11.archive.gz.enc "$scratch" fresh

echo "== a wrong passphrase restores nothing"
expect_failure "" run -e BACKUP_PASSPHRASE=wrong bp965-backup restore.sh monthly/2026-11.archive.gz.enc "$scratch" wrongkey
[ "$(sh_mongo bp965-scratch wrongkey --eval 'db.getCollectionNames().length')" = 0 ] || fail "wrongkey has collections"

echo "== old copies are pruned, current ones are not"
sh 'echo old | rclone rcat "$REMOTE/hourly/old.txt"'
sleep 12
run -e HOURLY_KEEP=10s bp965-backup backup.sh >/dev/null
all=$(list)
echo "$all" | grep -q 'old.txt' && fail "old.txt survived"
echo "$all" | grep -q "^hourly/$(date -u +%Y-%m-%dT%H)" || fail "the fresh hourly copy was pruned"
echo "$all" | grep -q '^daily/2026-11-01' || fail "the daily copy was pruned"

echo "ALL GOOD"
