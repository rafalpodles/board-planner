#!/usr/bin/env bash
set -euo pipefail

port="${APP_PORT:-3000}"
origin="http://localhost:${port}"
username="${DEMO_USERNAME:-trawler}"
password="${DEMO_PASSWORD:-trawler-demo-1234}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-trawler-demo}"
export BOARD_PLANNER_VERSION=trawler-ci

setup_code="$(openssl rand -hex 16)"

cat > .env <<ENV
APP_PORT=${port}
APP_ORIGIN=${origin}
PUBLIC_ORIGIN=${origin}
BOOTSTRAP_TOKEN=${setup_code}
ENCRYPTION_KEY=$(openssl rand -hex 32)
WEBHOOK_SIGNING_SECRET=$(openssl rand -hex 16)
GITHUB_SYNC_TICK_MS=0
PM_SCHEDULER_TICK_MS=86400000
DIGEST_TICK_MS=86400000
SMTP_HOST=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
ENV

docker compose up -d --build

ready=0
for _ in $(seq 1 120); do
  if curl -fsS "${origin}/api/auth/instance" > /dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "::error::Board Planner did not answer on ${origin} within 240 s"
  docker compose ps || true
  docker compose logs --no-color || true
  exit 1
fi

status="$(curl -sS -o /tmp/create-account.json -w '%{http_code}' -X POST "${origin}/api/users" \
  -H 'Content-Type: application/json' -H "Origin: ${origin}" \
  -d "{\"username\":\"${username}\",\"fullName\":\"Trawler Demo\",\"password\":\"${password}\",\"setupCode\":\"${setup_code}\"}")"
if [ "$status" != 201 ]; then
  echo "::error::Creating the demo account answered ${status}"
  cat /tmp/create-account.json || true
  docker compose logs --no-color app || true
  exit 1
fi

status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${origin}/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: ${origin}" \
  -d "{\"username\":\"${username}\",\"password\":\"${password}\"}")"
if [ "$status" != 200 ]; then
  echo "::error::Signing in as the demo account answered ${status}"
  docker compose logs --no-color app || true
  exit 1
fi

echo "Board Planner is up on ${origin}; demo account '${username}' can sign in"
