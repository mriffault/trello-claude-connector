#!/usr/bin/env bash
set -u

source "$HOME/.nvm/nvm.sh"
nvm use --silent 20

cd "$(dirname "$0")/.."

export TRELLO_API_KEY=stub
export TRELLO_TOKEN=stub
export PORT=3399
export HOST=127.0.0.1
export PUBLIC_BASE_URL=http://127.0.0.1:3399
export GOOGLE_CLIENT_ID=stub-client-id
export GOOGLE_CLIENT_SECRET=stub-secret
export ALLOWED_GOOGLE_EMAIL=you@example.com

npm run build > /dev/null
node dist/http-server.js > /tmp/mcp-oauth.log 2>&1 &
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

echo "---- /.well-known/oauth-protected-resource ----"
curl -s http://127.0.0.1:3399/.well-known/oauth-protected-resource
echo

echo "---- /.well-known/oauth-authorization-server ----"
curl -s http://127.0.0.1:3399/.well-known/oauth-authorization-server
echo

echo "---- POST /mcp without token (expect 401 + WWW-Authenticate) ----"
curl -s -o /tmp/mcp-body.json -D /tmp/mcp-headers.txt -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
  http://127.0.0.1:3399/mcp
grep -i '^HTTP\|^www-authenticate' /tmp/mcp-headers.txt
cat /tmp/mcp-body.json
echo

echo "---- POST /register (DCR) ----"
REG_RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"client_name":"Test Client","redirect_uris":["http://localhost:9999/cb"]}' \
  http://127.0.0.1:3399/register)
echo "$REG_RES"
CLIENT_ID=$(echo "$REG_RES" | grep -o '"client_id":"[^"]*"' | cut -d'"' -f4)
echo "CLIENT_ID=$CLIENT_ID"

echo "---- GET /authorize without PKCE (expect 400) ----"
curl -s -o /dev/null -w "HTTP %{http_code}\n" "http://127.0.0.1:3399/authorize?client_id=${CLIENT_ID}&redirect_uri=http://localhost:9999/cb&response_type=code&state=abc"

echo "---- GET /authorize with PKCE (expect 302 to Google) ----"
curl -s -o /dev/null -D - -w "HTTP %{http_code}\n" \
  "http://127.0.0.1:3399/authorize?client_id=${CLIENT_ID}&redirect_uri=http://localhost:9999/cb&response_type=code&state=abc&code_challenge=fake_challenge_B64URL&code_challenge_method=S256" \
  | grep -iE '^HTTP|^location'

echo "---- POST /token with bogus code (expect 400 invalid_grant) ----"
curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=authorization_code&code=nope&redirect_uri=http://localhost:9999/cb&code_verifier=verifier&client_id=${CLIENT_ID}" \
  http://127.0.0.1:3399/token
echo

echo "---- server log ----"
cat /tmp/mcp-oauth.log
