# jev-lint — agent instructions

A PostToolUse hook that sends the code an agent just added to TypeSafe Jev (one call,
one Noul per rule) and feeds findings back in two tiers, plus the harness that
evaluates it. Results live in an experiment notebook:
https://claude.ai/artifact/BUZG9LEnaiJyaJuaP7tajs (source: `report/`).

For evaluation work (new rules, new judges or models, new E2E rounds, notebook
entries) use the `jev-lint-eval` skill in `.agents/skills/jev-lint-eval/`. To generate
`.jev-lint/` rules for any repo from its guidelines, use `jev-lint-rules`; to feed the
findings log back into a repo's instructions, use `jev-lint-learn`. To install the hook, use `jev-lint-setup`; to write or
reword a single rule, use `jev-lint-write-rule`. All five skills are symlinked into `.claude/skills/`.

## Layout

- `src/hook.ts` — hook entry (Claude Code `Write|Edit|MultiEdit`, Codex `apply_patch`). Must fail open: never throw, never block, always exit 0.
- `src/recheck.ts` — end-of-turn re-check (Stop/SubagentStop hook): re-asks still-flagged rules about the current file so findings get fixed/kept outcomes; fail-open, prints nothing.
- `src/checks.ts` — runs the checks for one event (file cap, parallelism); used in process and by the daemon.
- `src/daemon.ts` / `src/daemonClient.ts` — optional warm daemon: one API connection and one Keychain read shared across hook calls, over a user-only Unix socket. The hook must keep working when it is absent, stale or slow (it falls back to in-process checks; a timeout counts as a failed check, not a retry).
- `src/extract.ts` — hook payload → code the edit added (Codex: `+` lines only).
- `src/lint.ts` — rule packs, tiers (0.8 fix / 0.5 double-check), feedback text.
- `src/repoRules.ts` — loads repo packs and `config.json` (`packs`, `disable`, `skipPaths`) from the nearest `.jev-lint/`; `src/validate.ts` validates them against labeled cases.
- `src/findingsLog.ts` / `src/findings.ts` — per-check findings log (default `~/.local/state/jev-lint/findings.jsonl`), its fixed/kept/unknown summary, `--clusters` (rule × area × test) and `--compare` (before/after with a session bootstrap CI); used by the `jev-lint-learn` skill.
- `src/install.ts` — idempotent hook installer for Claude Code/Codex (dry run unless `--apply`; backs up; `--skills`, `--smoke`); used by the `jev-lint-setup` skill.
- `src/repoEval.ts` — proves an instruction/skill change in a target repo: runs `.jev-lint/evals/*.json` tasks with a headless agent (hook off) on the base commit and on the working tree, scores the new code with Jev, reports the paired difference with a bootstrap CI. See `docs/feedback-loop.md`.
- `src/check.ts` — runs the rules over existing files (as whole-file writes) to preview what would fire in a repo.
- `src/inventory.ts` — lists a repo's instructions, skills, docs, linter/CI configs and languages; step 1 of the `jev-lint-rules` skill.
- `local/` — local-model experiments (Laya server, encoder benchmark, Core ML attempt); venvs and models are gitignored.
- `src/jev.ts` — minimal TypeSafe client (any `/v1/systemone` server via `TYPESAFE_BASE_URL`); key from `TYPESAFE_API_KEY` or Keychain service `typesafe-api-key`.
- `rules/<lang>.json` — hygiene pack; `rules/<lang>.<pack>.json` — practices, tests, performance (and security) packs, loaded by file name; `rules/sources/` — each rule's graded evidence. New rules carry `"status": "candidate"` (the hook skips them) until `bun eval/pack-status.ts <holdout summary> --apply` ships the ones that pass. `.jev-lint/` — this repo's own dogfooded repo pack (run `bun src/validate.ts .jev-lint` after changing it).
- `docs/packs/` — generated pack docs (`bun scripts/pack-docs.ts`; rerun after changing rules or cases).
- `eval/cases/` — labeled hook payloads: `<lang>[.<pack>][.vN].<dev|holdout>.jsonl` (later batches `vN` carry their own `scope`).
- `eval/run.ts`, `eval/systems.ts` — offline eval (Jev vs LLM judge vs regex).
- `eval/skill/run.ts` — skill eval: runs `jev-lint-rules` headless (dry run) on pinned real repos and scores the proposal against gold annotations. Fixtures, gold and results are private and live outside the repo (`~/.local/share/jev-lint/skill-evals`, or `JEV_LINT_SKILL_EVALS`); never commit them or name the repos in public results.
- `eval/e2e/` — headless Claude Code runs with/without the hook, grading, AI review mapping.
- `eval/results/` — committed result files; `snapshots/` keeps superseded evidence; `cache/` is local only.
- `docs/media/` — demo video (both cuts) and poster; `docs/video/` — its Remotion source, audio generator and `render.sh`.
- `report/notebook.html` + `report/build.py` → `report/index.html` (the published notebook).

## Commands

```sh
bun install
bun test && bunx tsc --noEmit && bunx biome check .   # required before committing
bun eval/run.ts --runs 3                               # offline eval (cached)
bun eval/bench-rules.ts                                # rule count vs accuracy/latency/tokens (not cached)
python3 report/build.py <DepartureMono-Regular.woff2>  # rebuild notebook
```

## Rules for changes

- **Hook safety:** keep the hook fail-open and fast (default timeout 8 s). Never print anything except the final JSON on stdout.
- **Rule wording:** rules must be judgeable from the added code alone. Every rule needs:
  - labeled positives and hard negatives in both the dev and holdout sets;
  - wording tuned on dev only;
  - reported holdout numbers.
- **Evidence is append-only:** don't overwrite or delete earlier results.
  - Copy `eval/results/summary.json` (and any E2E file you will regenerate) into `eval/results/snapshots/` with a dated, descriptive name first.
  - Add a new dated notebook entry; label replaced numbers "superseded" instead of removing them.
- **LLM judging** (baseline judge, grader, reviewer, mapper) uses `gpt-6-luna` at `reasoning_effort: low` unless the user says otherwise.
- **Thresholds:** don't retune them on holdout data. Show alternatives with the sweep instead.
- **Secrets:** never commit `.env` or print keys. Test fixtures with fake secrets live only in `eval/cases/`.
- **Package manager:** use bun. JSON and TS are formatted by biome.
