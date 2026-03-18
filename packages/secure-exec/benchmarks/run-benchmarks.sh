#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PACKAGE_DIR"

echo "=== Building package ===" >&2
pnpm run build >&2

RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "" >&2
echo "=== Running cold-start benchmark ===" >&2
npx tsx benchmarks/coldstart.bench.ts \
  > "$RESULTS_DIR/coldstart_${TIMESTAMP}.json" \
  2> >(tee "$RESULTS_DIR/coldstart_${TIMESTAMP}.log" >&2)

echo "" >&2
echo "=== Running memory benchmark ===" >&2
node --expose-gc --import tsx/esm benchmarks/memory.bench.ts \
  > "$RESULTS_DIR/memory_${TIMESTAMP}.json" \
  2> >(tee "$RESULTS_DIR/memory_${TIMESTAMP}.log" >&2)

echo "" >&2
echo "=== Done. Results in $RESULTS_DIR ===" >&2
