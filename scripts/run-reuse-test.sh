#!/usr/bin/env bash
set -u

source "$HOME/.nvm/nvm.sh"
nvm use --silent 20

cd "$(dirname "$0")/.."

# Fresh DB for this test
rm -f ./data/auth-smoke.db ./data/auth-smoke.db-shm ./data/auth-smoke.db-wal

export TRELLO_API_KEY=stub
export TRELLO_TOKEN=stub
export PORT=3399
export HOST=127.0.0.1
export PUBLIC_BASE_URL=http://127.0.0.1:3399
export GOOGLE_CLIENT_ID=stub-client-id
export GOOGLE_CLIENT_SECRET=stub-secret
export ALLOWED_GOOGLE_EMAIL=allowed@example.com
export AUTH_DB_PATH=./data/auth-smoke.db

npm run build > /dev/null
node dist/http-server.js > /tmp/mcp-reuse.log 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf http://127.0.0.1:3399/healthz > /dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

AUTH_DB_PATH=./data/auth-smoke.db BASE_URL=http://127.0.0.1:3399 \
  node scripts/smoke-test-reuse.mjs
EXIT=$?

echo
echo "---- server log ----"
cat /tmp/mcp-reuse.log

exit $EXIT
