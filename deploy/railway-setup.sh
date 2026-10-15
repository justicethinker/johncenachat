#!/usr/bin/env bash
#
# One-command Railway setup for this repo.
#
#   1. Links (or creates) the Railway project.
#   2. Applies .railway/railway.ts: the relay and web services.
#   3. Generates the relay's public domain.
#   4. Sets VITE_RELAY_WS on web and redeploys, so the built site points at
#      the relay (Vite bakes env vars in at build time).
#   5. Waits for the relay health check to answer.
#
# Usage:
#   deploy/railway-setup.sh
#
# Requires the Railway CLI (https://docs.railway.com/guides/cli) and a
# logged-in account: `railway login`.
#
# Nothing secret is printed. This script never logs room ids or tokens.

set -euo pipefail

cd "$(dirname "$0")/.."

RELAY_SERVICE="relay"
WEB_SERVICE="web"

if ! command -v railway >/dev/null 2>&1; then
  echo "railway CLI not found. Install it first: https://docs.railway.com/guides/cli" >&2
  exit 1
fi

echo "==> Checking Railway login"
if ! railway whoami >/dev/null 2>&1; then
  echo "Not logged in. Running 'railway login'..." >&2
  railway login
fi

echo "==> Linking the project (railway link)"
# Creates the project on first run; links to it afterwards.
railway link

echo "==> Applying .railway/railway.ts"
# --yes keeps it non-interactive. The plan is always shown first, and this
# only creates/updates services, so no destructive confirmation is needed.
railway config apply --yes

echo "==> Generating the relay public domain"
if railway domain --service "$RELAY_SERVICE" 2>/dev/null; then
  echo "    relay domain ready"
else
  echo "    could not generate the relay domain automatically." >&2
  echo "    Generate it in the dashboard (relay -> Settings -> Networking)," >&2
  echo "    then re-run this script." >&2
  exit 1
fi

# Read the generated domain back so we can bake it into the web build.
RELAY_DOMAIN="$(railway variables --service "$RELAY_SERVICE" --json 2>/dev/null \
  | tr ',' '\n' | grep -o '"RAILWAY_PUBLIC_DOMAIN":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"

if [ -z "${RELAY_DOMAIN:-}" ]; then
  echo "    could not read the relay domain from Railway." >&2
  echo "    Set VITE_RELAY_WS on the '$WEB_SERVICE' service by hand:" >&2
  echo "      railway variable set VITE_RELAY_WS=wss://<relay-domain> --service $WEB_SERVICE" >&2
  exit 1
fi

echo "==> Pointing the web build at wss://$RELAY_DOMAIN"
railway variable set "VITE_RELAY_WS=wss://$RELAY_DOMAIN" --service "$WEB_SERVICE"

echo "==> Web redeploys on its own now"
# Changing a variable triggers a fresh web deploy automatically, and the
# new build bakes VITE_RELAY_WS in. Nothing else to run.

echo "==> Waiting for the relay health check"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$RELAY_DOMAIN/healthz" >/dev/null 2>&1; then
    echo "    relay is healthy"
    break
  fi
  sleep 5
done

echo
echo "Done. Open the '$WEB_SERVICE' service domain in Railway to use the app."
echo "Try /new/4 to create a chat of four."
