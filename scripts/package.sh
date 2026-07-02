#!/usr/bin/env bash
# Package the extension into a Chrome Web Store-ready zip.
#
# Usage:
#   scripts/package.sh            # store build: strips the dev "key" field
#   scripts/package.sh --keep-key # keep the pinned dev ID (for sideloading/testing)
#
# Output: dist/hadron-web-clipper-<version>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEEP_KEY=0
[[ "${1:-}" == "--keep-key" ]] && KEEP_KEY=1

VERSION="$(node -e "process.stdout.write(require('./manifest.json').version)")"
BUILD="$(mktemp -d)"
OUT="dist/hadron-web-clipper-${VERSION}.zip"

# Files that ship in the package (everything the runtime needs — nothing else).
FILES=(
  manifest.json
  background.js
  popup.html
  popup.css
  popup.js
  lib
  icons
)

mkdir -p dist
for f in "${FILES[@]}"; do
  cp -R "$f" "$BUILD/"
done

# For a store build, remove the "key" field so Google assigns the ID.
if [[ "$KEEP_KEY" -eq 0 ]]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    delete m.key;
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  ' "$BUILD/manifest.json"
  echo "→ store build (key stripped; store assigns the extension ID)"
else
  echo "→ dev build (key kept; ID = ccigdjebbcfljhappibfcfgkcmomiccb)"
fi

rm -f "$OUT"
( cd "$BUILD" && zip -qr -X "$ROOT/$OUT" . )
rm -rf "$BUILD"

echo "✓ wrote $OUT"
unzip -l "$OUT"
