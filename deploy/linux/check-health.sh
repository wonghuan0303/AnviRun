#!/usr/bin/env bash
set -Eeuo pipefail

SERVER_URL="${1:-http://127.0.0.1:3000}"
SERVER_URL="${SERVER_URL%/}"

command -v curl >/dev/null 2>&1 || { echo "Required tool is not available: curl" >&2; exit 1; }

for endpoint in live ready; do
  payload="$(curl --fail --silent --show-error --max-time 10 "$SERVER_URL/health/$endpoint")"
  if [[ "$payload" != *'"status":"ok"'* && "$payload" != *'"status": "ok"'* ]]; then
    echo "$endpoint: failed" >&2
    exit 1
  fi
  echo "$endpoint: ok"
done
