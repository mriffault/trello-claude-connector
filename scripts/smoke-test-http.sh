#!/usr/bin/env bash
set -u

source "$HOME/.nvm/nvm.sh"
nvm use --silent 20

cd "$(dirname "$0")/.."

export TRELLO_API_KEY=stub
export TRELLO_TOKEN=stub
export PORT=3399
export HOST=127.0.0.1

node dist/http-server.js > /tmp/mcp.log 2>&1 &
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

echo "---- /healthz ----"
curl -s http://127.0.0.1:3399/healthz
echo

echo "---- POST /mcp initialize ----"
curl -s -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
  http://127.0.0.1:3399/mcp
echo

echo "---- POST /mcp tools/list ----"
curl -s -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  http://127.0.0.1:3399/mcp
echo

echo "---- GET /mcp (expect 405) ----"
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3399/mcp

echo "---- server log ----"
cat /tmp/mcp.log
