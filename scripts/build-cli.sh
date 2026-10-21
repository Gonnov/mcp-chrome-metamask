#!/bin/sh
# Bundle the CLI into dist/cli.mjs. Written to a temp name and renamed, so a
# concurrent ./bin/rig never runs a half-written bundle.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DIR/dist"
TMP="$DIR/dist/cli.$$.mjs"
"$DIR/node_modules/.bin/esbuild" "$DIR/src/cli.ts" --bundle --platform=node --format=esm --target=node20 \
  --packages=external --log-level=warning --outfile="$TMP"
mv -f "$TMP" "$DIR/dist/cli.mjs"
