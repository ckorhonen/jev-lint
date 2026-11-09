# Rust rule expansion, 8 November 2026

## Question and fixed setup

Can seven snippet-visible Rust failure modes add useful coverage without exceeding the existing false-alarm budget?

- Base: `a89a6d9`, core CLI repository `ckorhonen/jev-lint`.
- Judge: existing TypeSafe System One endpoint, `jev-1.13.0` (the installed hook model), no LLM baseline. Only synthetic fixtures and rule text are sent.
- New rules: four practices rules (HTTP error status, broadcast lag, detached timed-out tasks, cancelled channel sends) and three security rules (shell interpolation, ZIP entry traversal, string-prefix path authorization).
- Independent native authors produce development and holdout splits. The holdout author must not read development cases. Wording is tuned on development only, frozen before holdout scoring.
- Three runs per split. Existing thresholds stay fixed: high at 0.8, medium at 0.5. Existing promotion bar: high precision at least 90%, medium precision at least 75%, medium recall at least 80%, at least three holdout positives.
- New rules begin as candidates. Promote only through `eval/pack-status.ts` after holdout; leave failures disabled. No changes to pack opt-ins or hook trust/configuration.
- Results are append-only named artifacts. Snapshot existing pack status before updating it.

## Scope and limitations

These synthetic snippet labels test agreement with the intended rules, not production bug prevention. The change does not add an end-to-end coding-agent experiment or claim a production quality improvement. The default configuration already includes practices and security; any explicit existing pack selections are preserved.

## Results

Live scoring completed on 9 November after explicit approval to send these synthetic fixtures and rules to the existing TypeSafe endpoint. The earlier denied attempt had no completed judgments or result artifact and its process was confirmed gone before retrying.

All seven rules passed the predeclared promotion bar and were enabled with `bun eval/pack-status.ts eval/results/rust-v9-holdout-2026-11-09.json --apply`. Rust now has 17 live rules, up from 10. All packs together have 184 live rules.

The first dev run produced one medium-confidence false positive on a function returning a raw `reqwest::Response`. The HTTP question/true wording was clarified using development evidence only. Original wording and measurements are preserved. No other rule was reworded. Final development scoring has 100% precision and recall at 0.5 on all three runs.

Independent holdout, 53 cases, three runs:
- Run 1: all seven rules have 100% precision and recall at 0.5; 100% precision at 0.8. Practices high-tier recall is 80%; security is 100%.
- Across all three runs: 108 true-positive rule decisions, two false positives, zero false negatives at 0.5: **98.2% precision / 100% recall**. These are repeated decisions on the same 53 cases, not 159 independent examples.
- The path-prefix rule produced one medium-tier false positive in each of runs 2 and 3. Its per-run medium precision is 100%, 83.3%, 83.3%; all remain above the fixed 75% bar. No threshold or wording was tuned using holdout.
- At 0.8: 94 true positives, zero false positives, 14 false negatives across the repetitions. High-tier recall is 87.0%; precision is 100%.
- Zero API errors in every final dev/holdout repeat. Returned model is `jev-1.13.0`. Primary run-1 holdout p50 judge latency: practices 175 ms, security 106 ms; these are synthetic pack calls, not end-to-end hook timings.

Artifacts:
- `rust-v9-dev-2026-11-09.json`: first dev wording, superseded by tuned results.
- `rust-v9-dev-tuned-2026-11-09.json`: final development metrics.
- `rust-v9-holdout-2026-11-09.json`: primary holdout and run consistency.
- `rust-v9-repeats-2026-11-09.json`: per-rule gated counts for each repeat.
- `snapshots/rust-practices-2026-11-09-v9-before-dev-tuning.json`: original candidate wording.
- `snapshots/pack-status-2026-11-09-before-rust-v9.json`: status evidence before promotion.

Pre-holdout rule-file SHA-256 (candidate status still present):
- practices: `0199b92f88d6b58789f09db23c640404026b23f63207a6aaa33e4caad6e88459`
- security: `1304a9c19e9cb307bd6e850b5a92a8e3b7526d244463e75dd1cbe6070dd0eb46`

Independent final review verified all 115 decoded Rust additions parse with rustfmt and found no remaining material rule or label defects. Rule content was frozen before opening holdout.

Offline checks:
- 62 development cases: 34 practices / 28 security, 23 clean cases, 43 positive labels.
- 53 independent holdout cases: 30 practices / 23 security, 21 clean cases. At least five positives and three focused hard negatives per new rule per split.
- Native independent review found and fixed one malformed Rust string in a development negative. All 62 decoded development additions then parsed with rustfmt. Holdout content remained sealed during this initial review; the final review checked all 115 additions after scoring.
- Bun 1.4.4: 200 tests passed, 0 failed (2022 assertions), including local daemon integration. TypeScript passed. Biome passed with 12 pre-existing warnings.
- Environment notes: installed Bun 1.2.3 hangs on upstream timeout tests; a temporary npm-packaged Bun 1.4.4 passed them unchanged. The test suite needs local Unix-socket access outside the sandbox. An existing installer test assumes the checkout basename is `jev-lint`; the isolated worktree was renamed accordingly. No global runtime, hook, trust, or provider settings were changed.
- Dev and holdout fixture contract tests check unique IDs, complete scopes, positive gate recall, per-rule coverage, multi-violation cases, and clean cases.

Notebook verification: `report/build.py` rebuilt the notebook with the existing embedded font. The new entry/chart was rendered and visually inspected; no unfilled placeholders and no horizontal overflow at a 400 px viewport (client/scroll widths both 400).
