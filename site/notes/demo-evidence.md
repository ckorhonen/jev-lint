# JevLint on/off flagship — private revision

28-second silent square video. Character-by-character code, one red pulse, editorial finding, a locally verified stronger assertion, a qualitative workflow animation, one verified on/off outcome, JevLint end card / https://jevlint.dev. Provider graphs removed.

## Companion caption

Your test passes. Does it prove anything? Move your team's rule feedback to the edit, before review. In our 48-run experiment, JevLint ON produced 41% fewer review comments covered by its rules than JevLint OFF. Reviews still matter for logic and design. https://jevlint.dev

The code sequence is an animated adaptation of a saved TypeSafe Jev finding, followed by an actual local synthetic assertion test. It is not fresh live inference, and the correction was not re-scored by Jev. The workflow is illustrative; it does not report measured time, tokens, or review cycles saved.

## Exact evidence and scope

Original source: `eval/results/e2e-review-packs.json`; the source report and README are in the existing authoritative jev-lint checkout. Twelve synthetic React/SwiftUI tasks × two repetitions × two conditions = 48 Claude Code runs. OFF is `none`; ON is `jev-rewake`, the asynchronous all-packs hook with 170 rules at the time of the experiment. This is a historical TypeSafe Jev hook experiment, not an OpenAI Decisions API or Cloudflare Clef comparison.

Rule-covered reviewer findings: OFF 32 across 24 runs (1.333333 per task); ON 19 across 24 runs (0.791667 per task). Relative reduction = (32−19)/32 = 40.625%, rounded to 41%. The metric counts findings attributed to a supported rule, not unique review rounds or all review comments. Total reviewer findings were 100 OFF and 94 ON, a 6% reduction.

Paired mean difference: −0.541667 rule-covered findings per task. Report's paired bootstrap, seed 0, 5,000 resamples: 95% CI −1.083333 to −0.041667. Of 24 pairs, nine improved, five worsened, ten tied. The confidence interval only narrowly excludes zero; the result is specific to this small synthetic cohort.

Review was performed by an independent blind AI reviewer and then mapped to rules by AI. Bootstrap pairs are task/repetition pairs, rather than task-clustered resampling.

Do not infer measured cycle, time, token, or overall cost savings. The notebook says the hook did not save a fix round. Agent cost rose from approximately $0.1356 OFF to $0.1800 ON, and wall time from 51.6s to 58.6s. The qualitative workflow illustrates moving this kind of feedback earlier while retaining review; it is not a quantified experiment outcome or a guarantee that review/re-review disappears.

The illustrated public case is `tsp4-dev-006`, rule `ts-test-cannot-fail`, cached score 0.97. `prorate(plan)` abbreviates the original call; “This test proves nothing” is editorial copy. Actual local Bun verification makes deliberately broken synthetic code fail after replacing self-equality with an expected value. Saved cache lacks an exact returned Jev model version and timestamp; the historical whole-pack prompt is not fully reconstructable. No clean Jev verdict on the correction is shown. See `verified-cache-evidence.json` and the local test logs.

No provider performance/cost charts remain. No new paid calls, public posts, or website changes were made. Motion uses a single smooth red pulse, no repeated flashing; the clip is captioned and readable without audio.
