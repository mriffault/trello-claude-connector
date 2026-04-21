#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Missing $PROJECT_DIR/.env (expected TRELLO_API_KEY, TRELLO_TOKEN)." >&2
  exit 1
fi

source "$HOME/.nvm/nvm.sh"
nvm use --silent 20

set -a
source .env
set +a

export PORT="${PORT:-3000}"
export HOST="${HOST:-127.0.0.1}"

npm run build
exec node dist/http-server.js
