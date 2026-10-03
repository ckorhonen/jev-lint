# E2E round "tests": do the Entry 10 test rules change what agents write? (2026-10-03)

Date source: system clock, 2026-10-03 (local time -0400). Uncommitted. The numbers below come from these files:

- `eval/results/e2e-runs-tests.json`: 32 runs.
- `eval/results/e2e-graded-tests.json`: `grade.ts` output.
- `eval/results/e2e-tests-analysis-2026-10-03.json`: per-run rows and stats for the primary and focused grading, the test reruns and the hook findings by rule.

## Setup

- **Tasks:** `eval/e2e/tasks.tests.json` has 8 write-the-tests tasks. Each task asks for tests of existing code. The prompts are natural and never mention the rules.
  - 4 TypeScript tasks on scaffold `ts-tests` (Vitest 2.1.9): `OrderService` with internal collaborators, an HTML invoice renderer, the ShipFast HTTP client and the pricing quote module.
  - 4 Python tasks on scaffold `py-tests` (pytest): `OrderService`, the RateBridge FX client (httpx), `CustomerRepository` over a `Database` wrapper (sqlite3), and the pricing quote module.
- **Run:**
  - Command: `bun eval/e2e/run.ts --tasks-file eval/e2e/tasks.tests.json --tag tests --conditions none,jev --reps 2`.
  - Agent: Claude Code headless, model `sonnet`, concurrency 4.
  - Work dirs: `$TMPDIR/jev-lint-e2e`.
  - Results: 32 of 32 runs finished. All exited 0 with no `is_error`, and all passed the build check (16/16 per condition).
  - Mean wall time was 42.7 s with the hook off and 42.4 s with it on. Agent cost was $2.17 with the hook off and $2.20 with it on.
- **Rule state:**
  - `reimplements-logic` (ts and py) shipped in commit `20eaae6` at 18:25:50. The rule files were last modified at 18:24:29, before this run started at about 18:26. So the hook and the grader both treated `reimplements-logic` as a live rule for the whole round, and it is counted as an Entry 10 rule below.
  - The only candidate left in the tests packs is `ts-test-unordered-assertion`.
  - The rule-file hashes were the same at the start of the run and the start of grading.
- **Grading:** blind, `gpt-6-luna` at reasoning effort low, counted on the test files the agent wrote. The scaffold's own `money` tests are excluded. Two gradings were run:
  - **Primary:** `E2E_TAG=tests bun eval/e2e/grade.ts`, which uses all packs, so each file is judged against about 60 rules in one prompt. The per-test-file counts come from its cache.
  - **Focused:** the same test files regraded with the tests pack only (`JEV_LINT_PACKS=tests JEV_LINT_CANDIDATES=on`, 14 to 15 rules per prompt).
- **Paired statistics:** the difference is hook on minus hook off, per (task, rep), so a negative value means fewer violations with the hook. The 95% CI is a percentile bootstrap over the pairs (10,000 resamples, seed 1). "Better" means fewer violations with the hook.
- **Test pass rate:** `vitest run` or `pytest -q` was rerun on each final work dir. The harness itself only records a compile and collect check.

## Results

### Entry 10 rules (asserts-internal-calls, mocks-own-module, snapshot-lock-in [ts only], untyped-fake-response, reimplements-logic)

| grading | slice | pairs | hook off total | hook on total | mean diff | 95% CI | better / worse / tie |
|---|---|---|---|---|---|---|---|
| primary | all | 16 | 1 | 1 | 0.0000 | [-0.1875, 0.1875] | 1 / 1 / 14 |
| primary | TypeScript | 8 | 1 | 1 | 0.0000 | [-0.375, 0.375] | 1 / 1 / 6 |
| primary | Python | 8 | 0 | 0 | 0.0000 | [0, 0] | 0 / 0 / 8 |
| focused | all | 16 | 12 | 12 | 0.0000 | [-1.25, 1.1875] | 4 / 3 / 9 |
| focused | TypeScript | 8 | 12 | 7 | -0.625 | [-2.75, 1.75] | 4 / 1 / 3 |
| focused | Python | 8 | 0 | 5 | +0.625 | [0.0, 1.5] | 0 / 2 / 6 |

The four rules that were already live in Entry 10 (without reimplements-logic):

| grading | slice | off | on | mean diff | 95% CI | better / worse / tie |
|---|---|---|---|---|---|---|
| primary | all | 0 | 1 | +0.0625 | [0.0, 0.1875] | 0 / 1 / 15 |
| primary | TypeScript | 0 | 1 | +0.125 | [0.0, 0.375] | 0 / 1 / 7 |
| focused | all | 5 | 12 | +0.4375 | [-0.375, 1.4375] | 2 / 3 / 11 |
| focused | TypeScript | 5 | 7 | +0.25 | [-1.125, 2.125] | 2 / 1 / 5 |
| focused | Python | 0 | 5 | +0.625 | [0.0, 1.5] | 0 / 2 / 6 |

### All test-pack rules

The live rules alone and the live rules plus the `ts-test-unordered-assertion` candidate give identical numbers, because no other test rule was flagged in any run. Those totals equal the Entry 10 table in both gradings. In the primary grading: 1 vs 1, mean diff 0.0000, CI [-0.1875, 0.1875]. In the focused grading: 12 vs 12, mean diff 0.0000, CI [-1.25, 1.1875].

For context, the primary grading's total for all rules over all collected files is below. For TypeScript this includes the unchanged scaffold sources, which are cached and therefore constant. Most of the difference comes from `ts-no-vague-names` in test files.

| slice | off | on | mean diff | 95% CI | better / worse / tie |
|---|---|---|---|---|---|
| all | 160 | 138 | -1.375 | [-4.5, 0.625] | 5 / 2 / 9 |
| TypeScript | 160 | 138 | -2.75 | [-8.75, 1.375] | 5 / 2 / 1 |
| Python | 0 | 0 | 0 | [0, 0] | 0 / 0 / 8 |

**Every CI includes zero.** No grading or slice shows the hook changing what the agent writes.
- Two lower bounds sit exactly at 0: the primary 4-rule set and the focused Python slice. Both point toward more violations with the hook, from 1 and 5 violations respectively. Neither is evidence of an effect.

### Violations by rule (summed over runs)

| rule | primary off / on | focused off / on |
|---|---|---|
| ts-test-untyped-fake-response | 0 / 1 | 5 / 7 |
| ts-test-reimplements-logic | 1 / 0 | 7 / 0 |
| py-test-untyped-fake-response | 0 / 0 | 0 / 5 |
| asserts-internal-calls, mocks-own-module, snapshot-lock-in (both languages) | 0 / 0 | 0 / 0 |

### Per task

Each cell shows Entry 10 violations as primary/focused, then the number of tests that passed. Every run had 0 failing tests. The pass counts include the scaffold's 3 TypeScript or 2 Python money tests. Hook findings shown during the run are in brackets.

| task | off r1 | off r2 | on r1 | on r2 |
|---|---|---|---|---|
| ts-tests-order-service | 0/0, 14 | 0/2, 17 | 1/6, 12 | 0/1, 19 |
| ts-tests-invoice-report | 0/0, 17 | 0/0, 22 | 0/0, 15 | 0/0, 22 |
| ts-tests-carrier-client | 0/3, 25 | 0/0, 22 | 0/0, 21 [1] | 0/0, 25 [1] |
| ts-tests-pricing-quote | 0/6, 48 | 1/1, 47 | 0/0, 49 | 0/0, 46 |
| py-tests-order-service | 0/0, 18 | 0/0, 21 | 0/0, 21 | 0/0, 21 |
| py-tests-fx-client | 0/0, 25 | 0/0, 25 | 0/2, 24 | 0/3, 26 |
| py-tests-customer-repository | 0/0, 40 | 0/0, 40 | 0/0, 37 | 0/0, 37 |
| py-tests-pricing-quote | 0/0, 45 | 0/0, 49 | 0/0, 47 [1] | 0/0, 48 |

### Test pass rate

All 32 test suites ran green: 8/8 per condition and language. No test files were written outside the paths the harness collects.

### Hook findings during the runs (jev condition)

- **Volume:** 19 hook calls, 0 errors, mean latency 241 ms. The hook showed 3 findings in total.
- **`ts-test-untyped-fake-response`:** high tier, 2 findings (p 0.89 and 0.87), in carrier-client r1 and r2. The agent kept both, with no edit after the finding. Both files already typed their fake bodies (`: ApiRatesResponse`, `satisfies ApiError`), and both gradings scored both final files at 0. Likely false alarms.
- **`py-test-reimplements-logic`:** medium tier, 1 finding (p 0.66), in pricing-quote r1. The agent fixed it. Its next edit replaced `expected = (D("95.00") * {rates}...)` with literal expected taxes in the parametrize table (`"6.89"  # 6.8875 rounds up`, ...). This is the one case in the round where the hook visibly changed the code.
- **The other Entry 10 rules:** never fired. That is consistent with the grader, and with a grep of all 32 runs' test files:
  - zero `vi.mock`, `vi.spyOn`, `toMatchSnapshot`/`toMatchInlineSnapshot`, `patch(`, `monkeypatch.setattr`, `mocker.`, `MagicMock`/`Mock(` or `assert_called`/`call_count`;
  - every `toHaveBeenCalled*` is on an injected boundary: fetchImpl ×31, sleep ×21, and the payments and mailer fakes ×17.

## Interpretation and caveats

- **Floor effect: the round cannot answer the question.** With these scaffolds, Sonnet almost never took the lazy path even with the hook off: it wrote no snapshots, no own-module mocks and no assertions on internal calls. Mean Entry 10 violations per run with the hook off were 1/16 (primary) and 12/16 (focused), against 1/16 and 12/16 with it on.
  - **Probable cause:** the scaffolds hand the agent good seams. Clients take `fetchImpl` or an `httpx.Client`, `OrderService` takes its boundaries in the constructor, and the API wire types are exported. These seams make the clean path the easy path.
  - **Next round:** a sharper round would use scaffolds without seams. Collaborators would be imported at module level and called directly, with global `fetch` or `requests`, and there would be no exported response types. It would also use a UI component for snapshots and more reps.
- **Grader disagreement:** the two gradings agree on direction (none) but not on level: 2 violations in the primary grading against 24 in the focused one, on the same files.
  - The all-packs prompt (about 60 rules) at low effort misses obvious cases, for example the untyped inline ShipFast bodies in carrier-client hook-off r1.
  - The focused counts are the more plausible level, but neither grading was hand-validated beyond the spot checks above.
- **Sample size:** n = 8 pairs per language and 2 reps per task. Even a real effect of about 1 violation per run would be hard to separate from noise here.

## Not done / issues

- `review.ts` was skipped. It needs `REVIEW_STACK` and legacy handling, and it would add little given the floor effect.
- Biome: the `ts-tests` scaffold sources fall under `eval/**/*.ts` and fail `bunx biome check .`.
  - 6 files have format-only diffs.
  - `src/orders/service.ts` also has an organize-imports fix and `noImplicitAnyLet` on `let charge;`.
  - `src/reports/invoice.ts` has `noShadowRestrictedNames` on `escape`.
  - I left them as run so the round is reproducible. Run `bunx biome check --write eval/e2e/scaffold/ts-tests/src` and fix the two lint items, or exclude the scaffolds in `biome.json`, before committing.
- The analysis scripts are outside the repo, in the session scratchpad (`analyze.ts`, `stats.py`). Their output is saved in `eval/results/e2e-tests-analysis-2026-10-03.json`.
