#!/usr/bin/env bash
# Restore rehearsal for the Board Planner backups (BP-965): asks for the R2 details, starts a throwaway Mongo in Docker,
# restores a chosen backup into it and prints the number of documents per collection. Nothing is written to production.
# Run: bash backup/rehearse.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
BASE_IMAGE="public.ecr.aws/docker/library/mongo:7.0"
NET="bp-rehearsal-$$"
SCRATCH="bp-rehearsal-mongo-$$"
WORK=$(mktemp -d)
chmod 700 "$WORK"

cleanup() {
  rm -rf "$WORK"
  [ "${KEEP_SCRATCH:-}" = "1" ] || { docker rm -fv "$SCRATCH" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
ask() { local v; read -r -p "$1" v; printf '%s' "$v"; }
ask_hidden() { local v; read -r -s -p "$1" v; printf '\n' >&2; printf '%s' "$v"; }

docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop and run this again." >&2; exit 1; }

say "R2 details (the same as the variables of the 'backup' service on Railway)"
endpoint=$(ask "R2_ENDPOINT (https://<id>.r2.cloudflarestorage.com): ")
key_id=$(ask_hidden "R2_ACCESS_KEY_ID (hidden): ")
secret=$(ask_hidden "R2_SECRET_ACCESS_KEY (hidden): ")
bucket=$(ask "R2_BUCKET [board-planner-backups]: ")
bucket="${bucket:-board-planner-backups}"
passphrase=$(ask_hidden "BACKUP_PASSPHRASE (hidden): ")
db=$(ask "Database the backup was made from [test]: ")
db="${db:-test}"
[ -n "$endpoint" ] && [ -n "$key_id" ] && [ -n "$secret" ] && [ -n "$passphrase" ] || { echo "Every value is required." >&2; exit 1; }

umask 077
{
  printf 'R2_ENDPOINT=%s\n' "$endpoint"
  printf 'R2_ACCESS_KEY_ID=%s\n' "$key_id"
  printf 'R2_SECRET_ACCESS_KEY=%s\n' "$secret"
  printf 'R2_BUCKET=%s\n' "$bucket"
  printf 'BACKUP_PASSPHRASE=%s\n' "$passphrase"
  printf 'MONGODB_DB=%s\n' "$db"
} > "$WORK/env"
unset key_id secret passphrase

say "Building the backup image from $HERE"
cp -R "$HERE" "$WORK/backup"
# Docker Hub rate-limits anonymous pulls; the same official image comes from AWS's mirror
sed -i.bak "s#^FROM .*#FROM $BASE_IMAGE#" "$WORK/backup/Dockerfile"
docker build -q -t bp-backup-rehearsal "$WORK/backup" >/dev/null

say "Starting a throwaway Mongo"
docker network create "$NET" >/dev/null
docker run -d --name "$SCRATCH" --network "$NET" "$BASE_IMAGE" >/dev/null
for _ in $(seq 1 30); do docker exec "$SCRATCH" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break; sleep 1; done

run() { docker run --rm --network "$NET" --env-file "$WORK/env" bp-backup-rehearsal "$@"; }

say "Backups in the bucket (newest hourly last)"
copies=$(run restore.sh list) || { echo "Could not list the bucket: check the endpoint, the bucket name and the token's permissions." >&2; exit 1; }
[ -n "$copies" ] || { echo "The bucket is empty." >&2; exit 1; }
echo "$copies" | grep -E '^(monthly|daily)/' | tail -3
echo "..."
echo "$copies" | grep '^hourly/' | tail -5
newest=$(echo "$copies" | grep '^hourly/' | tail -1)
choice=$(ask "Which one to restore [$newest]: ")
choice="${choice:-$newest}"

say "Restoring $choice into the scratch database (this downloads and decrypts it)"
run restore.sh "$choice" "mongodb://$SCRATCH:27017/?directConnection=true" 2>&1 | grep -v -E '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'

say "Done. Compare these numbers with what the backup log said ('users has N documents') and with the app."
keep=$(ask "Keep the scratch Mongo to look around in? [y/N]: ")
if [ "$keep" = "y" ] || [ "$keep" = "Y" ]; then
  KEEP_SCRATCH=1
  echo "Look: docker exec -it $SCRATCH mongosh restore_check"
  echo "Remove when done: docker rm -fv $SCRATCH && docker network rm $NET"
fi
