# jev-lint

**A fuzzy linter for coding agents.** It checks the code your agent writes against your
team's best practices while the agent is still working, not at code review.

📓 **Results and method:** [experiment notebook](https://claude.ai/artifact/BUZG9LEnaiJyaJuaP7tajs)
(source in `report/`).

## What is this for?

Every team has best practices and patterns, some common across the industry and some
specific to the team. For example, a team may have a particular way it wants people to
use React hooks like `useEffect`. Rules like that can't be checked deterministically:
there is no regex for "this effect only derives state". So they usually aren't caught
until code review, by a human or an agent.

Catching them at review is expensive. The code goes back to the agent, the agent fixes
it, and the fix has to be reviewed again.

jev-lint moves that check to the moment the file is written. A hook in Claude Code or
Codex sends the code the agent just added to a fast "System 1" judgment model
([TypeSafe Jev](https://docs.typesafe.ai)), asking one yes/no question per rule. If a rule
looks broken, the agent hears about it right away and fixes it while it still has the
context, with no review round trip.

## Our hypothesis

1. **Immediate feedback beats a review round trip.** An agent that's told about a
   problem while it's writing the file can fix it in the next edit, instead of waiting
   for review and a remediation pass.
2. **It's cheap enough to run on every edit.** Jev takes about 0.3 s and roughly
   $0.00015 per check, so checking a whole session costs very little.
3. **It pays for itself.** It may raise the cost per task a little, because the agent
   now fixes issues as it goes. That should be cancelled out by less review and rework.
4. **It creates a feedback loop.** Every check is logged, so it's easy to see where
   agents keep failing, then adjust rules, skills, or the rest of the harness to help
   them (see the `jev-lint-learn` skill).
5. **It could run locally, for free.** As an exploration, we're testing Jev-like models
   hosted on the machine itself, using its GPU or Neural Engine, for lower latency and no
   cost per check.

## What we've found so far

Measured 26–27 Sep 2026. The notebook has the details and the caveats.

- **The check itself is accurate and fast.** On held-out edits it scored 94–100% F1 (the
  balance of catching real violations and avoiding false flags). It took about 0.3 s, and
  the pattern gate means only about a third of the rules are asked for each edit.
- **Agents act on the feedback (hypothesis 1: supported).** In 96 real Claude Code runs,
  violations per task fell from 2.38 to 1.21 with the hook running in the background. In
  48 Codex runs they fell from 1.67 to 0.92. Both drops are statistically significant.
- **Cost per check is negligible (hypothesis 2: supported).** It's about $1.51 per 10,000
  edits. The real cost is the agent's own fix-up work, about +$0.03–0.04 and +10 s per task.
- **Review and rework don't cancel out yet when an AI reviewer checks every change
  (hypothesis 3: not yet shown).**
  - Every task still got review comments, 3.6 per task and mostly about logic and design
    that no rule covers, so a fix round still happened.
  - The hook ended with about 35% fewer rule violations after review (1.08 vs 1.67 per
    task, not yet significant), for about +17% agent cost.
  - The case is strongest with human reviewers, or when no AI reviewer runs on every
    change.
- **The feedback loop works (hypothesis 4).** The findings log already showed real noise
  (debug scripts, domain constants), which led to a fix the same day.
- **Local models aren't there yet (hypothesis 5: open).**
  - The best zero-shot local model, Kev-4B, scored 70–75% F1 and took about 1.4 s per edit
    on an M3 Max.
  - The Neural Engine couldn't be used through the current model exports.
  - A Kev-4B fine-tuned on our own labels is being tested now.

## How it works

After every file edit, a PostToolUse hook sends the added code to Jev in one call. Rules
whose trigger patterns don't appear in the code are skipped. Findings go back to the agent
in two tiers:

- **p ≥ 0.8** — "Likely violations — fix these"
- **0.5 ≤ p < 0.8** — "Possible violations — double-check; ignore if the code is actually fine"

The rules target what a deterministic linter can't express. Examples: "don't use
`useEffect` to derive state", "validate JSON before casting it", "don't create an object
inline in `@ObservedObject`", "resume a continuation exactly once". Teams can generate their
own rules from their guidelines with the `jev-lint-rules` skill.

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

**Async (Claude Code only):** to keep the agent from waiting on the check (useful with a slower
local judge), run it in the background and let findings wake the agent:

```json
{ "type": "command", "command": "JEV_LINT_MODE=rewake JEV_LINT_MODEL=jev-1.13.0 bun ~/Repos/jev-lint/src/hook.ts", "timeout": 180, "asyncRewake": true }
```

Codex supports `async` hooks but not rewake, so keep Codex synchronous. Codex needs
`[features] hooks = true` in `config.toml` and, the first time, trusting the hook (or `--dangerously-bypass-hook-trust` in automation).

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

## Learn from what it catches

The hook keeps a local findings log: one line per checked file, with the rules that fired
and a short excerpt. `src/findings.ts` classifies each finding:
- **fixed:** the agent corrected it on a later edit of the same file;
- **kept:** it was still flagged at the file's last check, so the agent disagreed or ignored it;
- **unknown:** the file wasn't checked again.

```sh
bun ~/Repos/jev-lint/src/findings.ts --repo . --days 30   # per-rule counts and a suggestion
```

The **`jev-lint-learn`** skill turns this into reviewed changes for one repo:
- AGENTS.md guidance for mistakes that keep getting made and fixed;
- rewording or dropping rules that agents keep ignoring (usually false positives), re-validated with `src/validate.ts`;
- new rule candidates, handed to `jev-lint-rules`.

## Local models

Kev and Laya serve the same `/v1/systemone` protocol, so `TYPESAFE_BASE_URL=http://127.0.0.1:8009`
points the hook at a local server. As of 27 Sep 2026 they are not accurate or fast enough on
these rules. The best, Kev-4B with the rule gate, scored 70–75% held-out F1 at about 1.4 s per edit on an
M3 Max (notebook Entries 4–5). JevLike trained on our labels didn't learn the task (Entry 6), and a
fine-tuned Kev-4B is in progress. `local/laya_server.py` and `local/bench_encoder.py` reproduce the Laya runs.

## Rule packs

| Pack | Files | What it checks |
| --- | --- | --- |
| `hygiene` | `rules/typescript.json`, `rules/swift.json` | `any`, non-null / force-unwrap, empty catch, debug prints, restating comments, vague names, magic numbers, bare TODOs, hard-coded secrets… |

Two rules were removed because the model is weak at counting and tracing; use a deterministic linter for them:

| Removed rule | Use instead |
| --- | --- |
| `ts-no-deep-nesting` | ESLint `max-depth` (and `complexity`); SwiftLint `nesting` / `cyclomatic_complexity` for Swift |
| `ts-no-floating-promise` | typescript-eslint `@typescript-eslint/no-floating-promises` (needs type-aware linting) |
| `practices` | `rules/*.practices.json` | React effect misuse (derived state, missing cleanup, fetch races, event logic), overlapping polling / debounced requests, state mutation, index keys, unvalidated external data, sequential awaits, boolean traps; SwiftUI state ownership, expensive `body`, `.onAppear { Task {} }`, retain cycles, main-thread blocking, continuation misuse, continuations without cancellation or that can be overwritten, unprotected shared state, unstable `ForEach` ids, GCD inside async |
| `repo` | `.jev-lint/*.rules.json` in your repo | Whatever the `jev-lint-rules` skill generated from your guidelines |

### Options (environment variables on the hook command)

| Var | Default | Meaning |
| --- | --- | --- |
| `JEV_LINT_PACKS` | `hygiene,practices,repo` | Packs to ask (a repo's `config.json` overrides) |
| `JEV_LINT_TIERS` | `high,medium` | `high` drops the double-check tier |
| `JEV_LINT_GATE` | on | `off` asks every rule. By default a rule is only asked when its `when` patterns match the added code (about a third of rules per edit) |
| `JEV_LINT_HIGH` / `JEV_LINT_MEDIUM` | `0.8` / `0.5` | Tier thresholds |
| `JEV_LINT_MODE` | `context` | `block` sends findings as `decision: "block"`; `rewake` is for Claude Code async hooks (see below) |
| `JEV_LINT_MODEL` | `jev-latest` | Pin `jev-1.13.0` so model updates can't shift thresholds |
| `JEV_LINT_TIMEOUT_MS` | `8000` | Per-call timeout |
| `JEV_LINT_LOG` | unset | Debug: append every raw judgment to a JSONL file |
| `JEV_LINT_FINDINGS_LOG` | `~/.local/state/jev-lint/findings.jsonl` | Findings log used by `jev-lint-learn`; `off` disables it |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Any `/v1/systemone` server, e.g. a local Kev or Laya (no key needed) |
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
  - **`jev-lint-learn`** — feed the findings log back into a repo's AGENTS.md and `.jev-lint/` rules.

## Development

```sh
bun test && bunx tsc --noEmit && bunx biome check .
```

## License and credits

jev-lint is released under the [MIT License](LICENSE).

- The experiment notebook (`report/`) embeds the **Departure Mono** typeface by Helena Zhang
  ([departuremono.com](https://departuremono.com)), licensed under the
  [SIL Open Font License 1.1](https://openfontlicense.org). The font remains under its own license.
- The evaluation compares against and links to other projects without vendoring them:
  [TypeSafe Jev](https://docs.typesafe.ai) (hosted API), [Kev](https://github.com/jaredpalmer/kev),
  [Laya](https://github.com/NandhaKishorM/laya) and [JevLike](https://github.com/vinnylarouge/jevlike).

