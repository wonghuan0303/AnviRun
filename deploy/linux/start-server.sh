#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 <server.env>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$(realpath -- "$1")"

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
  [[ "$trimmed" == *=* ]] || { echo "Invalid environment entry in configuration file" >&2; exit 1; }
  name="${trimmed%%=*}"
  name="${name%"${name##*[![:space:]]}"}"
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid environment variable name" >&2; exit 1; }
  value="${trimmed#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ ${#value} -ge 2 && ( ( "$value" == \"*\" ) || ( "$value" == \'*\' ) ) ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf -v "$name" '%s' "$value"
  export "$name"
done < "$ENV_FILE"

[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL is required in the environment file" >&2; exit 1; }

cd "$REPO_ROOT"
pnpm --filter @anvilrun/server run db:migrate:deploy
exec pnpm --filter @anvilrun/server run start
