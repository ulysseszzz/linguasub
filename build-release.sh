#!/usr/bin/env bash
# Build a publishable ZIP for the Chrome Web Store.
# Output: release/linguasub-<version>.zip  (extension files at zip root)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$ROOT/linguasub"
MANIFEST="$EXT_DIR/manifest.json"

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: manifest.json not found at $MANIFEST" >&2; exit 1
fi

VERSION="$(python3 -c "import json;print(json.load(open('$MANIFEST'))['version'])")"
BUILD_DIR="$ROOT/release/build"
ZIP_PATH="$ROOT/release/linguasub-${VERSION}.zip"

echo "==> LinguaSub v${VERSION}"
echo "    build dir : $BUILD_DIR"
echo "    zip output: $ZIP_PATH"

# Clean build dir
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy publishable files (exclude test/, drafts, logs, dotfiles)
echo "==> Copying publishable files..."
rsync -a \
  --exclude='test/' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='*.mjs.bak' \
  --exclude='assets/icon-src.html' \
  "$EXT_DIR/" "$BUILD_DIR/"

# Verify critical files exist
echo "==> Verifying manifest references..."
python3 - "$BUILD_DIR" <<'PY'
import json, os, sys
root = sys.argv[1]
m = json.load(open(os.path.join(root, "manifest.json")))
errors = []

# Icons
for size, p in m.get("icons", {}).items():
    if not os.path.isfile(os.path.join(root, p)):
        errors.append(f"missing icon {size}: {p}")
# Default icon
for size, p in m.get("action", {}).get("default_icon", {}).items():
    if not os.path.isfile(os.path.join(root, p)):
        errors.append(f"missing action icon {size}: {p}")

# Background SW
sw = m.get("background", {}).get("service_worker")
if sw and not os.path.isfile(os.path.join(root, sw)):
    errors.append(f"missing service worker: {sw}")

# Content scripts
for cs in m.get("content_scripts", []):
    for js in cs.get("js", []):
        if not os.path.isfile(os.path.join(root, js)):
            errors.append(f"missing content script: {js}")

# Popup
popup = m.get("action", {}).get("default_popup")
if popup and not os.path.isfile(os.path.join(root, popup)):
    errors.append(f"missing popup: {popup}")

# Required top-level fields
for field in ["manifest_version", "name", "version", "description"]:
    if field not in m:
        errors.append(f"manifest missing field: {field}")

# Chrome Web Store: description must be <= 132 chars
desc = m.get("description", "")
if len(desc) > 132:
    errors.append(f"description too long: {len(desc)} chars (limit 132)")

# MV3 must be 3
if m.get("manifest_version") != 3:
    errors.append("manifest_version must be 3 for Chrome Web Store")

if errors:
    print("VERIFICATION FAILED:")
    for e in errors: print("  -", e)
    sys.exit(1)
print(f"  manifest OK ({len(m.get('icons',{}))} icons, {len(m.get('content_scripts',[]))} content scripts)")
print(f"  permissions: {', '.join(m.get('permissions',[]))}")
print(f"  host_permissions: {', '.join(m.get('host_permissions',[]))}")
PY

# Quick JS syntax check on all shipped JS
echo "==> Syntax-checking shipped JS..."
find "$BUILD_DIR" -name "*.js" -not -path "*/vendor/*" | while read -r f; do
  node --check "$f" || { echo "SYNTAX FAIL: $f"; exit 1; }
done
echo "  all JS passes (vendor excluded)"

# Package
echo "==> Packaging zip..."
rm -f "$ZIP_PATH"
( cd "$BUILD_DIR" && zip -qr "$ZIP_PATH" . )

SIZE="$(du -h "$ZIP_PATH" | cut -f1)"
COUNT="$(unzip -l "$ZIP_PATH" | tail -1 | awk '{print $2}')"
echo ""
echo "==> DONE"
echo "    zip     : $ZIP_PATH"
echo "    size    : $SIZE"
echo "    files   : $COUNT"
echo ""
echo "Next steps:"
echo "  1. Go to https://chrome.google.com/webstore/devconsole"
echo "  2. Create a new item (or edit existing) and upload $ZIP_PATH"
echo "  3. Fill in store listing (description, screenshots, privacy policy)"
echo "  4. Pay \$5 one-time developer registration fee (if new account)"
echo "  5. Submit for review (1-3 business days)"
