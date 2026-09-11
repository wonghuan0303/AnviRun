#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

for tool in node pnpm cargo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool is not available: $tool" >&2
    exit 1
  fi
done

cd "$REPO_ROOT"
echo "Checking tool versions..."
node --version
pnpm --version
cargo --version

pnpm install --frozen-lockfile
pnpm run contracts:build
pnpm --filter @anvilrun/server run build
pnpm --filter @anvilrun/web run build
cargo build --release --locked --manifest-path agent/Cargo.toml

echo "Build completed."
