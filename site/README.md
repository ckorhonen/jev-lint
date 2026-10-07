# jevlint.dev

Static launch site for jev-lint: plain HTML/CSS/JS in `public/`, served by a Cloudflare Worker with
static assets (`worker.js` only redirects `www.jevlint.dev` to the apex).

```sh
python3 -m http.server 8787 -d public     # preview locally
./scripts/build-assets.sh                  # regenerate og.png (from src/og.html) and the favicon set
./scripts/sync-media.sh && wrangler deploy  # copy the demo video in, then deploy to jevlint.dev (account ea76e5b24c115e61c4ca83acb28b7e4d)
```

Asset generation needs an existing Python interpreter with Pillow. Override it with `PYTHON=/usr/bin/python3 ./scripts/build-assets.sh` on this Mac if the default `python3` has no Pillow.

- Every number on the page comes from the repo README, the experiment notebook or the benchmark
  results; update the page when those change.
- The 28-second silent demo in `public/media/` is a gitignored copy of `docs/media/jev-lint-on-off-flagship.mp4` (`scripts/sync-media.sh` refreshes it); the WebP poster is committed. Playback is user-initiated, with native controls and inline mobile playback.
- Departure Mono is self-hosted under the SIL OFL 1.1 (`public/fonts/DepartureMono-OFL.txt`).

The hero leads with team standards and setup. Provider support remains visible below the pitch: TypeSafe Jev is the default; OpenAI Decisions API (public beta) and Cloudflare Clef are optional. Keep provider setup and privacy copy aligned with the root README. Published accuracy, latency and cost figures apply to Jev only; the synthetic Decisions smoke is not a comparative benchmark. Setup prompts and promotional end cards use https://jevlint.dev, with GitHub links retained for source and documentation.

`public/methodology.html` contains the accessible video transcript, saved-case/local-test provenance, and exact 41% rule-covered review-comment outcome. The workflow animation is illustrative, not measured time/token/cycle savings. Preserve these disclosures whenever reusing the creative. Hosted reviews are marked in development; no signup, telemetry or hosted service is introduced by this page.
