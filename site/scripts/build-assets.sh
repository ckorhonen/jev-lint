#!/usr/bin/env bash
# Regenerate the OG image (headless Chrome, house font) and the favicon set.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PYTHON="${PYTHON:-python3}" # Choose an existing interpreter with Pillow installed.
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 \
  --virtual-time-budget=3000 --allow-file-access-from-files --screenshot="$PWD/public/og.png" "file://$PWD/src/og.html"
"$PYTHON" -c "from PIL import Image; im=Image.open('public/og.png').convert('RGB'); im.quantize(colors=64, method=Image.Quantize.MEDIANCUT).save('public/og.png', optimize=True)"
"$PYTHON" scripts/icons.py
