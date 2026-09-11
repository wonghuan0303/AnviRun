#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 <build-agent.toml> [agent-executable]" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$(realpath -- "$1")"
AGENT_EXECUTABLE="${2:-$SCRIPT_DIR/../../agent/target/release/build-agent}"
AGENT_EXECUTABLE="$(realpath -- "$AGENT_EXECUTABLE")"

[[ -f "$AGENT_EXECUTABLE" && -x "$AGENT_EXECUTABLE" ]] || {
  echo "Agent executable is missing or not executable: $AGENT_EXECUTABLE" >&2
  exit 1
}

cd "$(dirname -- "$AGENT_EXECUTABLE")"
exec "$AGENT_EXECUTABLE" --config "$CONFIG_PATH"
