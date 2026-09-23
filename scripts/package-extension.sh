#!/usr/bin/env bash
# One-off packaging script for Chrome Web Store upload. Not part of the
# extension itself -- zips exactly the runtime files Chrome needs (manifest,
# sidepanel, src/, icons/), leaving out dev-only files (tests, docs, the SDD
# workspace, package.json, README/PRIVACY markdown).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(grep -m1 '"version"' manifest.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
OUT="mail-cleaner-v${VERSION}.zip"

rm -f "$OUT"
zip -r "$OUT" \
  manifest.json \
  sidepanel.html \
  src/*.js \
  icons/*.png \
  -x '*.DS_Store'

echo "Wrote $ROOT/$OUT"
unzip -l "$OUT"
