#!/usr/bin/env bash
# Copy the demo video from docs/media (the single source) into public/media under the site's name.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/media
cp ../docs/media/jev-lint-demo-1920x1080.mp4 public/media/jev-lint-demo.mp4
