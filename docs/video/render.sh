#!/usr/bin/env bash
# Re-render both cuts end to end: synthesise audio, render with Remotion, loudness-normalise, mux, poster.
# Deps were installed with npm (bun add failed integrity checks under safe-chain on this machine).
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
python3 audio/generate.py
opts=(--codec=h264 --crf=23 --x264-preset=slow --pixel-format=yuv420p --color-space=bt709 --audio-codec=aac --audio-bitrate=320k)
npx remotion render src/index.ts JevLint out/raw-169.mp4 "${opts[@]}"
npx remotion render src/index.ts JevLintSquare out/raw-sq.mp4 "${opts[@]}"

# Two-pass EBU R128 loudnorm to -16 LUFS integrated, -1.5 dBTP; AAC 192 kbps stereo; video copied.
master() {
  local in=$1 out=$2
  local m
  m=$(ffmpeg -hide_banner -i "$in" -vn -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
  local mi mtp mlra mth off
  mi=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["input_i"])' "$m")
  mtp=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["input_tp"])' "$m")
  mlra=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["input_lra"])' "$m")
  mth=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["input_thresh"])' "$m")
  off=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["target_offset"])' "$m")
  ffmpeg -v error -y -i "$in" -c:v copy \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$mi:measured_TP=$mtp:measured_LRA=$mlra:measured_thresh=$mth:offset=$off:linear=true,aresample=48000" \
    -c:a aac -b:a 192k -ac 2 -movflags +faststart "$out"
}
master out/raw-169.mp4 out/jev-lint-demo-1920x1080.mp4
master out/raw-sq.mp4 out/jev-lint-demo-1080x1080.mp4

# Poster = frame 0 = the end card, fully composed.
npx remotion still src/index.ts JevLint out/jev-lint-demo-poster.png --frame=0
