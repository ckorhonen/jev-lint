---
name: jev-lint-eval
description: Evaluate a fast judgment model (TypeSafe Jev, a local model, or an LLM) as a post-edit "fuzzy linter" hook for coding agents — write snippet-level rules, build labeled dev/holdout hook payloads, compare judges, run hook-on/off agent runs, measure what it catches before AI code review, and log results in the experiment notebook. Use when adding or rewording lint rules, adding a new judge or model to the jev-lint harness, running a new E2E round, or updating the jev-lint notebook.
---

# jev-lint evaluation workflow

The repo root's `AGENTS.md` has layout and commands. This skill is the method: the
order of steps, what to measure, and the traps that already cost time once.

## 0. Frame the experiment

Write down, before running anything:
- **the question** (one sentence);
- **the judge(s) and exact model ids and settings;**
- **the rule pack(s);**
- **the splits;**
- **the thresholds.** These are fixed a priori: 0.8 "fix", 0.5 "double-check".

That becomes the notebook entry's "Question" and "Setup". LLM judging roles
(baseline judge, grader, reviewer, mapper) default to `gpt-6-luna` at
`reasoning_effort: low`.

## 1. Rules (`rules/*.json`)

The `jev-lint-write-rule` skill covers what makes a good rule and where evidence comes from; this section adds what built-in rules need on top.

A rule is one yes/no question about `added_code` plus `true`/`false` criteria and a
`fix` line shown to the agent.
- **Judgeable from the snippet alone.** No other files, no multi-step reasoning, no counting (depth, occurrences) and no tracing across functions. Jev is weak at all of these; send them to ESLint/SwiftLint instead.
- **Literal.** Jev answers the words, not the intent, so name the exact pattern and list the exceptions in `false`, e.g. "WebSockets are not HTTP requests". If two rules overlap, say in each one which pattern belongs to the other.
- **Opinionated but low-noise.** If a rule would flag idiomatic code (`data` from a network call, named default parameters), narrow it.

## 2. Labeled cases (`eval/cases/<lang>[.<pack>].<split>.jsonl`)

Each line is `{id, lang, split, payload, labels, notes}`. The payload is a real hook event: Claude `Write`/`Edit`/`MultiEdit`, or Codex `apply_patch` with only the `+` lines judged.
- **Delegate authoring** to subagents, with the dev set and the holdout set written by different authors in different styles. The holdout author must not read the dev files.
- **Per rule:** at least 5 positives and at least 3 hard negatives drawn from the `false` criteria.
- **Also include:** about 20 clean realistic edits, multi-violation cases, and traps where the violation sits only in `old_string` or `-`/context lines.
- **Labels must be complete across every rule in the pack.** Have the authors generate the cases with a script (`json.dumps`) and validate: every line parses, ids are unique, labels are valid.

## 3. Offline eval (`bun eval/run.ts --runs 3`)

- **What it reports:** precision, recall, F1 and clean-edit false-alarm rate per pack, language, split and policy, plus the threshold sweep, band precision (how real the 0.5–0.8 tier is) and run-to-run consistency.
- **Tuning discipline:** reword rules using **dev only**, then report holdout. Snapshot the before-numbers first, because the v1 → v2 comparison is evidence.
- **Cache keys include the pack's rule-text hash and the case's payload hash.** If you touch the case-key logic, keep both — a stale cache keyed only by id once produced fake regressions.
- **Adding a judge:** add a `judgeX(c: Case): Promise<Judgment>` to `eval/systems.ts`. It returns per-rule scores in [0, 1] plus latency and tokens. Register it in `JUDGES` in `eval/run.ts` and give it a cache variant name.

## 4. End-to-end runs (`eval/e2e/`)

- **Run:** `bun eval/e2e/run.ts --tasks-file … --tag … --conditions none,jev --reps 2`.
  - Runs are headless Claude Code with `--setting-sources project` (no user hooks or plugins), interleaved across conditions.
  - Work dirs live outside the repo (`E2E_ROOT`).
- **Grade:** `E2E_TAG=… bun eval/e2e/grade.ts` gives blind rule grading of the final files.
- **Review:** `E2E_TAG=… bun eval/e2e/review.ts` runs an AI reviewer that isn't told the rules, then:
  - maps each finding to a rule or "none";
  - replays Jev over the transcript's edits ("caught before review");
  - grader-checks Jev-only flags on the final files only.
- **Don't change rules while grading or review is running.** Mixed rule versions invalidate the round. Regrade after any rule change (the caches make it cheap).
- **Report paired differences** per task and rep, with a bootstrap 95% CI and better/worse/tie counts. With about 24 runs per condition, say plainly when the CI crosses zero.
- **Break results down by language/stack.** An overall improvement can hide one stack getting nothing.
- **Rule-pack languages:** `eval/e2e/tasks.packs.json` has 15 tasks: 5 Python, 3 Ruby, 2 each for Kotlin, Rust and Bazel, and 1 TypeScript security task. Run it with `--tasks-file eval/e2e/tasks.packs.json --tag langs` (`packs` is already used by a rerun of the practices tasks).
  - Per-language settings live in `eval/e2e/languages.ts`: source globs, a compile-only build check, and the reviewer persona. TypeScript and Swift keep their original code paths.
  - Only files that differ from the scaffold are recorded. Each file is graded with its own language's rules, so Bazel runs grade BUILD/.bzl files with the Bazel rules and .py files with the Python rules.
  - A missing toolchain gives `build: {ok: null, skipped}`. On this machine that is Kotlin (no gradle or JDK) and Bazel. Report build pass rates only for languages that were actually checked.
  - `remediate.ts` still handles TypeScript and Swift only.

## 5. Notebook (`report/`)

- **Before regenerating any result file,** copy the current one into `eval/results/snapshots/` with a dated name.
- **Add a new dated entry at the top** of `report/notebook.html`: question, setup, charts, what we learned.
- **Update "Current answer", "Recommendation" and the changelog.** Label replaced numbers `superseded`; never delete them.
- **Rebuild and check:**
  - Run `python3 report/build.py <font.woff2>`. It fails on any unfilled `{{PLACEHOLDER}}`.
  - Screenshot the result once and check the charts.
  - Headless Chrome won't go narrower than 500 px, so probe overflow with a script rather than trusting a 400 px crop.
- **Publish** to the same artifact URL (see `AGENTS.md`).
- **Fact-check every number in the prose** against the build output before publishing.

## 6. Closeout

Run `bun test && bunx tsc --noEmit && bunx biome check .`. Then report:
- files touched;
- what was measured, on which split;
- what was not verified: synthetic labels, the same model acting as grader and competitor, small E2E samples.
