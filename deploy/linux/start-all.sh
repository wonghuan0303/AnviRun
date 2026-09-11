#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: start-all.sh <server.env> <build-agent.toml> [agent-executable]' \
    '' \
    'Starts Server and Agent in the foreground as one supervised deployment.' \
    'PostgreSQL must already be running and reachable through DATABASE_URL.' >&2
  exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$(realpath -- "$1")"
AGENT_CONFIG="$(realpath -- "$2")"
AGENT_EXECUTABLE="${3:-$SCRIPT_DIR/../../agent/target/release/build-agent}"

server_pid=''
agent_pid=''

cleanup() {
  trap - EXIT INT TERM
  [[ -n "$agent_pid" ]] && kill "$agent_pid" 2>/dev/null || true
  [[ -n "$server_pid" ]] && kill "$server_pid" 2>/dev/null || true
  [[ -n "$agent_pid" ]] && wait "$agent_pid" 2>/dev/null || true
  [[ -n "$server_pid" ]] && wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

bash "$SCRIPT_DIR/start-server.sh" "$ENV_FILE" &
server_pid=$!

server_port=3000
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  trimmed="${line#"${line%%[![:space:]]*}"}"
  if [[ "$trimmed" =~ ^SERVER_PORT[[:space:]]*=(.*)$ ]]; then
    value="${BASH_REMATCH[1]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 && ( ( "$value" == \"*\" ) || ( "$value" == \'*\' ) ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    [[ "$value" =~ ^[1-9][0-9]{0,4}$ && "$value" -le 65535 ]] || {
      echo "SERVER_PORT must be an integer between 1 and 65535" >&2
      exit 1
    }
    server_port="$value"
  fi
done < "$ENV_FILE"
server_url="http://127.0.0.1:$server_port"
for _ in {1..30}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  if bash "$SCRIPT_DIR/check-health.sh" "$server_url" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! bash "$SCRIPT_DIR/check-health.sh" "$server_url"; then
  echo "Server did not become ready within 30 seconds" >&2
  exit 1
fi

bash "$SCRIPT_DIR/start-agent.sh" "$AGENT_CONFIG" "$AGENT_EXECUTABLE" &
agent_pid=$!
echo "Server and Agent started. Press Ctrl+C to stop both."

while kill -0 "$server_pid" 2>/dev/null && kill -0 "$agent_pid" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$server_pid" 2>/dev/null; then
  wait "$server_pid"
else
  wait "$agent_pid"
fi
