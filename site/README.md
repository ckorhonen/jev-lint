# jevlint.dev

Static launch site for jev-lint: plain HTML/CSS/JS in `public/`, served by a Cloudflare Worker with
static assets (`worker.js` only redirects `www.jevlint.dev` to the apex).

```sh
python3 -m http.server 8787 -d public     # preview locally
./scripts/build-assets.sh                  # regenerate og.png (from src/og.html) and the favicon set
./scripts/sync-media.sh && wrangler deploy  # copy the demo video in, then deploy to jevlint.dev (account ea76e5b24c115e61c4ca83acb28b7e4d)
```

- Every number on the page comes from the repo README, the experiment notebook or the benchmark
  results; update the page when those change.
- The demo video in `public/media/` is a gitignored copy of `docs/media/jev-lint-demo-1920x1080.mp4` (`scripts/sync-media.sh` refreshes it); the WebP poster is committed.
- Departure Mono is self-hosted under the SIL OFL 1.1 (`public/fonts/DepartureMono-OFL.txt`).
