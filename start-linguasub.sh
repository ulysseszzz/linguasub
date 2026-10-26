#!/usr/bin/env bash
# Launch Chrome for Testing with the LinguaSub extension loaded.
# System Google Chrome is enterprise-managed (ExtensionInstallBlocklist="*")
# and silently refuses unpacked extensions, so we use Chrome for Testing.
#
# Usage:
#   ./start-linguasub.sh            # normal window
#   ./start-linguasub.sh --headless # headless (for testing)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$ROOT/linguasub"
PROFILE_DIR="$ROOT/linguasub-profile"

CFT_BASE="/tmp/linguasub-browser/chrome"
CFT_APP=""
if [ -d "$CFT_BASE" ]; then
  for ver in "$CFT_BASE"/*/; do
    [ -d "$ver" ] || continue
    for mac in "$ver"*/; do
      [ -d "$mac" ] || continue
      cand="$mac/Google Chrome for Testing.app"
      if [ -d "$cand" ]; then CFT_APP="$cand"; break 2; fi
    done
  done
fi

if [ -z "$CFT_APP" ]; then
  echo "ERROR: Chrome for Testing not found under $CFT_BASE" >&2
  echo "Install it with: npx @puppeteer/browsers install chrome@stable --path /tmp/linguasub-browser" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

ARGS=(
  --user-data-dir="$PROFILE_DIR"
  --load-extension="$EXT_DIR"
  --disable-extensions-except="$EXT_DIR"
  --no-first-run
  --no-default-browser-check
)
if [ "${1:-}" = "--headless" ]; then
  ARGS+=(--headless=new --disable-gpu)
fi

echo "Launching: $CFT_APP"
echo "Extension : $EXT_DIR"
echo "Profile   : $PROFILE_DIR"
exec open -na "$CFT_APP" --args "${ARGS[@]}"
