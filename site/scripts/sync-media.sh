#!/usr/bin/env bash
# Copy the reviewed demo from docs/media into the Worker static assets.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/media
cp ../docs/media/jev-lint-on-off-flagship.mp4 public/media/jev-lint-on-off-flagship.mp4
