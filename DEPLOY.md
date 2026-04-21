# Deploy Trello MCP on a VPS behind Traefik

Mono-user remote MCP server, HTTPS via Let's Encrypt, OAuth 2.1 with Google as
upstream IdP.

## Prerequisites

- VPS with Docker and a running Traefik stack exposing an external network
  named `traefik-proxy` with a resolver named `letsencrypt` (matches the
  Hostinger default stack — adjust the labels in `docker-compose.yml` if your
  names differ).
- A domain you control (DDNS providers like `*.ddns.net` are **rejected** by
  Google OAuth). Example used here: `mcp.example.com`.
- DNS `A` record `mcp.example.com` → VPS public IP.
- Google Cloud project with an OAuth 2.0 Client ID, type **Web application**,
  with authorized redirect URI
  `https://mcp.example.com/oauth/google/callback`.
- Trello API key + token (https://trello.com/app-key).

## 1. Clone the repository

```bash
ssh user@vps
cd ~
git clone git@github.com:mriffault/trello-claude-connector.git
cd trello-claude-connector
```

## 2. Create `.env`

```bash
cp .env.example .env
nano .env
```

Minimum required values (uncomment and fill in Profile B):

```
TRELLO_API_KEY=...
TRELLO_TOKEN=...
PUBLIC_HOSTNAME=mcp.example.com
PUBLIC_BASE_URL=https://mcp.example.com
ALLOWED_HOSTS=mcp.example.com,127.0.0.1
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ALLOWED_GOOGLE_EMAIL=you@gmail.com
AUTH_DB_PATH=/app/data/auth.db
TRUST_PROXY=1
```

`HOST` and `PORT` are **overridden** by `docker-compose.yml` to match the
container context — no need to set them.

## 3. Build and start

```bash
docker compose up -d --build
docker compose logs -f trello-mcp
```

Expected log lines (one JSON object per line):

```
{"level":"INFO","message":"auth_db_opened","context":{"path":"/app/data/auth.db"}}
{"level":"INFO","message":"http_server_listening","context":{"host":"0.0.0.0","port":3000,"auth":"OAuth 2.1 (Google)"}}
```

## 4. Verify

From your laptop:

```bash
# Discovery metadata (should be 200 with JSON)
curl -s https://mcp.example.com/.well-known/oauth-protected-resource | jq
curl -s https://mcp.example.com/.well-known/oauth-authorization-server | jq

# Unauthenticated /mcp returns 401 + WWW-Authenticate
curl -sI -X POST -H 'Content-Type: application/json' \
  -d '{}' https://mcp.example.com/mcp | grep -i www-authenticate
```

## 5. Connect from Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trello-prod": {
      "command": "wsl.exe",
      "args": [
        "bash",
        "-c",
        "source ~/.nvm/nvm.sh && nvm use --silent 20 && npx -y mcp-remote https://mcp.example.com/mcp"
      ]
    }
  }
}
```

(No `--allow-http` because we're on HTTPS.)

Restart Claude Desktop. The first call triggers a browser window for Google
sign-in. Once consented, tokens are cached by `mcp-remote` and the flow
becomes transparent.

## 6. Operations cheatsheet

```bash
# Tail logs
docker compose logs -f --tail=100 trello-mcp

# Restart after changing .env
docker compose up -d

# Rebuild after pulling code
git pull && docker compose up -d --build

# Inspect the auth DB
docker compose exec trello-mcp node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/app/data/auth.db', { readonly: true });
  console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all());
"

# Revoke everything (wipes the SQLite volume — users must re-login)
docker compose down
docker volume rm trello-claude-connector_trello-mcp-data
docker compose up -d
```

## Continuous deployment

A GitHub Actions workflow at [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
runs type-check + build on every push/PR, then SSH-deploys to the VPS on
pushes to `main`.

### Required GitHub repository secrets (Settings → Secrets → Actions, "prod" environment)

| Secret | Example | Notes |
|--------|---------|-------|
| `VPS_HOST` | `<your-vps-ip>` or `vps.example.com` | The host the runner SSHes into |
| `VPS_USER` | `root` or `deploy` | SSH user with access to the project dir |
| `VPS_SSH_KEY` | `-----BEGIN OPENSSH PRIVATE KEY-----...` | Private key whose public half is in `~/.ssh/authorized_keys` on the VPS |
| `VPS_SSH_PORT` | `22` (optional) | Override if SSH runs on a non-standard port |

### One-time VPS setup for CI/CD

```bash
# On the VPS, as the SSH user declared in VPS_USER
cd ~
git clone https://github.com/mriffault/trello-claude-connector.git
cd trello-claude-connector
cp .env.example .env
nano .env                              # fill in prod values
docker compose up -d --build           # first deploy is manual
```

After that, every `git push origin main` triggers the workflow, which pulls
the latest code and rebuilds the container on the VPS.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Healthcheck fails, logs show `403 Invalid Host: 127.0.0.1` | `127.0.0.1` missing from `ALLOWED_HOSTS` (note: hostnames only, no ports) |
| Let's Encrypt `acme.json` errors | DNS not propagated, or port 80 blocked by firewall |
| Google redirects with error `redirect_uri_mismatch` | The URI in Google Cloud Console doesn't exactly match `${PUBLIC_BASE_URL}/oauth/google/callback` (scheme, trailing slash, case) |
| `403 Access denied for ...@gmail.com` | Email doesn't match `ALLOWED_GOOGLE_EMAIL` (check case, typos) |
| `invalid_grant: Refresh token reuse detected` | The client replayed an already-consumed refresh token. Reconnect from Claude to re-auth. |
