# jev-lint

**A fuzzy linter for coding agents.** After every file edit in Claude Code or Codex, a
PostToolUse hook sends the code the edit added to [TypeSafe Jev](https://docs.typesafe.ai)
in one ~0.3 s call and asks one yes/no question per rule. Findings go back to the agent
as a hint in two tiers:

- **p ≥ 0.8** — "Likely violations — fix these"
- **0.5 ≤ p < 0.8** — "Possible violations — double-check; ignore if the code is actually fine"

It targets rules a deterministic linter can't express. Examples: "don't use `useEffect`
to derive state", "validate JSON before casting it", "don't create an object inline in
`@ObservedObject`", "resume a continuation exactly once".

📓 **Results and method:** [experiment notebook](https://claude.ai/artifact/BUZG9LEnaiJyaJuaP7tajs)
(source in `report/`).

## Results so far

Numbers are from the notebook, measured 26 Sep 2026.

| | Jev | GPT-6-Luna (low) |
| --- | --- | --- |
| Held-out F1, hygiene rules (TS / Swift) | 99% / 99% | 96% / 97% |
| Held-out F1, best-practice rules (TS / Swift) | 96% / 96% | 99% / 98% |
| Median time per check | ~0.3 s | ~1.6 s |
| Cost per 10,000 edits (both packs) | ~$1.51 | — |

**Real Claude Code runs on 12 React/SwiftUI tasks:**
- Graded rule violations per task fell from 2.12 to 1.33 with the hook.
- On React tasks, the AI reviewer's rule-covered comments fell from 1.42 to 0.25 per task.
- The hook flagged half of the rule-covered issues a later AI review raised, before that review.
- It does **not** replace review: about 75% of review findings were logic and design issues no snippet rule can see.
- Cost: +26% agent cost and about +14 s per task, from the fix-up edits.

## Install

Requires [bun](https://bun.sh) and a TypeSafe API key.

```sh
git clone https://github.com/ckorhonen/jev-lint ~/Repos/jev-lint && cd ~/Repos/jev-lint
bun install
security add-generic-password -a "$USER" -s typesafe-api-key -w   # or export TYPESAFE_API_KEY
```

**Claude Code:** add to `~/.claude/settings.json` (or a repo's `.claude/settings.json`) under `hooks.PostToolUse`:

```json
{ "matcher": "Write|Edit|MultiEdit",
  "hooks": [{ "type": "command", "command": "JEV_LINT_MODEL=jev-1.13.0 bun ~/Repos/jev-lint/src/hook.ts", "timeout": 15 }] }
```

**Codex:** add to `~/.codex/hooks.json` under `hooks.PostToolUse`. Codex `apply_patch` payloads are parsed from `tool_input.command`, and only `+` lines are judged:

```json
{ "matcher": "Edit|Write|apply_patch",
  "hooks": [{ "type": "command", "command": "JEV_LINT_MODEL=jev-1.13.0 bun ~/Repos/jev-lint/src/hook.ts", "timeout": 15 }] }
```

To make the skills available in every repo, link them into your skill directories:

```sh
for s in jev-lint-rules jev-lint-eval; do ln -s ~/Repos/jev-lint/.agents/skills/$s ~/.claude/skills/$s; done
```

The hook fails open: on a timeout, an API error or an unknown file type it exits 0 silently.
**Privacy:** the added code of every edit to a matching file is sent to TypeSafe.

## Generate rules for your repo

After installing, run the **`jev-lint-rules`** skill
(`.agents/skills/jev-lint-rules/`) inside any repo. It works in five steps:
1. It reads the repo's own guidelines: `AGENTS.md`, `CLAUDE.md`, Cursor and Copilot rules, `CONTRIBUTING`, and agent skills.
2. It keeps only the guidelines that can be judged from a snippet and that no existing linter already enforces.
3. It writes them to `.jev-lint/<language>.rules.json`, with labeled examples in `.jev-lint/cases.jsonl`.
4. It validates each rule against Jev:
   ```sh
   bun ~/Repos/jev-lint/src/validate.ts .jev-lint   # keep / reword-or-drop / needs-cases per rule
   ```
5. It keeps only rules that pass, and lists the dropped guidelines and the reasons in `.jev-lint/README.md`.

The hook picks up the nearest `.jev-lint/` above each edited file. A `.jev-lint/config.json`
such as `{ "packs": ["repo", "practices"] }` chooses which packs apply in that repo. This
repo dogfoods it: see [`.jev-lint/`](.jev-lint/).

## Rule packs

| Pack | Files | What it checks |
| --- | --- | --- |
| `hygiene` | `rules/typescript.json`, `rules/swift.json` | `any`, non-null / force-unwrap, empty catch, debug prints, restating comments, vague names, magic numbers, bare TODOs, hard-coded secrets… |
| `practices` | `rules/*.practices.json` | React effect misuse (derived state, missing cleanup, fetch races, event logic), state mutation, index keys, unvalidated external data, sequential awaits, boolean traps; SwiftUI state ownership, expensive `body`, `.onAppear { Task {} }`, retain cycles, main-thread blocking, continuation misuse, unprotected shared state, unstable `ForEach` ids, GCD inside async |
| `repo` | `.jev-lint/*.rules.json` in your repo | Whatever the `jev-lint-rules` skill generated from your guidelines |

### Options (environment variables on the hook command)

| Var | Default | Meaning |
| --- | --- | --- |
| `JEV_LINT_PACKS` | `hygiene,practices,repo` | Packs to ask (a repo's `config.json` overrides) |
| `JEV_LINT_TIERS` | `high,medium` | `high` drops the double-check tier |
| `JEV_LINT_HIGH` / `JEV_LINT_MEDIUM` | `0.8` / `0.5` | Tier thresholds |
| `JEV_LINT_MODE` | `context` | `block` sends findings as `decision: "block"` instead of `additionalContext` |
| `JEV_LINT_MODEL` | `jev-latest` | Pin `jev-1.13.0` so model updates can't shift thresholds |
| `JEV_LINT_TIMEOUT_MS` | `8000` | Per-call timeout |
| `JEV_LINT_LOG` | unset | Append every judgment to a JSONL file |
| `JEV_LINT_DEBUG` | unset | Print errors to stderr |

## Evaluation harness

All LLM judging (baseline judge, grader, reviewer, mapper) uses `gpt-6-luna` at low
reasoning. Override it with `BASELINE_MODEL`, `GRADER_MODEL` or `REVIEW_MODEL`.

```sh
bun eval/run.ts --runs 3                 # labeled edits, both packs: Jev vs Luna vs regex
bun eval/e2e/run.ts --reps 2             # E2E round 1: 12 general tasks, hook off/on
bun eval/e2e/run.ts --tasks-file eval/e2e/tasks.practices.json --tag practices --conditions none,jev --reps 2
E2E_TAG=practices bun eval/e2e/grade.ts  # rule grading of the final code
E2E_TAG=practices bun eval/e2e/review.ts # AI review, map findings to rules, replay Jev over the edits
python3 report/build.py <DepartureMono-Regular.woff2>   # rebuild the notebook
```

**Cases:**
- `eval/cases/<lang>[.practices].dev.jsonl` is the tuning split. Rule wording is only tuned here.
- `eval/cases/<lang>[.practices].holdout.jsonl` is the held-out split, written by a separate author in a different style.

**Results:**
- `eval/results/*.json` holds the latest results.
- `eval/results/snapshots/` keeps superseded evidence.
- `eval/results/cache/` is a local, gitignored judgment cache keyed by rule-text and payload hashes, so reruns are free.

**Notebook:** the report is an experiment notebook. Add a dated entry for each experiment, and label superseded numbers instead of deleting them.

## For agents working in this repo

- [`AGENTS.md`](AGENTS.md) (and `CLAUDE.md`) cover the layout, commands and rules for changes.
- Skills live in `.agents/skills/`, symlinked for Claude Code at `.claude/skills/`:
  - **`jev-lint-eval`** — the evaluation workflow: rules, labeled cases, offline eval, E2E rounds and notebook entries.
  - **`jev-lint-rules`** — generate and validate `.jev-lint/` rules from a repo's guidelines.

## Development

```sh
bun test && bunx tsc --noEmit && bunx biome check .
```
