# jev-lint

**A fuzzy linter for coding agents.** It checks the code your agent writes against your
team's best practices while the agent is still working, not at code review.

📓 **Results and method:** [experiment notebook](https://claude.ai/artifact/BUZG9LEnaiJyaJuaP7tajs)
(source in `report/`).

### Set it up with your agent

Paste this into Claude Code or Codex, from the repo you want checked:

```text
Set up jev-lint for me: https://github.com/ckorhonen/jev-lint
Clone it to ~/Repos/jev-lint if it isn't there, then follow its jev-lint-setup skill
(.agents/skills/jev-lint-setup/SKILL.md): check my TypeSafe key, show me the dry run, install
the hook once I confirm, and run the smoke test. Then use its jev-lint-rules skill on this
repo: read all of our agent instructions, skills, docs and linter configs, and propose rules
for me to approve before writing anything.
```

The agent does the rest with two scripts: `src/install.ts` installs the hook idempotently,
with backups, and `src/inventory.ts` lists every file that says what your team values.

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
- **More rules don't make the check worse, but they do make it noisier.** Adding unrelated
  rules up to 100 per request left target-rule F1 at 97–99% (99% with no padding). Median latency went from
  319 ms to 458 ms. Splitting the rules into parallel requests was slower and used 37% more
  tokens. So the rule budget (8–12 repo rules per language) is about false alarms and the
  agent's attention, not Jev.
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

Then let the installer do the rest. It checks first and writes only with `--apply`. It backs
up each file, and replaces only the jev-lint entry, so re-running it is safe:

```sh
bun src/install.ts --skills --smoke                 # dry run: key, configs, skill links, one real check
bun src/install.ts --apply --skills --smoke         # Claude Code + Codex, user-wide
#   --claude-only | --codex-only   --project <repo> (Claude, repo-scoped)   --async (Claude, background)
```

Or by hand:

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

`--skills` links the skills into `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills`,
so they're available in every repo.

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

Run the **`jev-lint-rules`** skill inside any repo. It works in seven steps:
1. **Read everything the team wrote down.** `bun ~/Repos/jev-lint/src/inventory.ts .` lists:
   - agent instructions: `AGENTS.md`, `CLAUDE.md`, Cursor/Copilot rules;
   - skills;
   - README, CONTRIBUTING, style guides and ADRs;
   - linter and type-checker configs, and CI.

   The agent reads all of it, using subagents for big repos, and writes a short digest of
   what the team values, with sources.
2. **Map what's already enforced.** A rule counts as enforced only when the linter has it on
   and CI blocks on it. Anything enforced is left to the linter.
3. **Collect candidates** from the team's own guidance, plus opinionated best practices for
   the repo's languages:
   - TypeScript/React and Swift/SwiftUI come from the built-in packs;
   - Python, Go, Rust, Kotlin, Ruby and Lua have candidate menus;
   - anything else uses a generic menu.
4. **Stay within budget:** 8–12 repo rules per language, each with a keyword gate.
5. **Propose, then wait.** The agent shows the rules, their sources, the linter config
   changes it suggests instead, and what it dropped. It writes nothing until you approve.
6. **Write and check the rules.** It writes `.jev-lint/<language>.rules.json` and labeled
   examples in `.jev-lint/cases.jsonl`, then validates every rule against Jev:
   ```sh
   bun ~/Repos/jev-lint/src/validate.ts .jev-lint   # keep / reword-or-drop / needs-cases per rule
   ```
7. **Keep only rules that pass.** It records the dropped ideas and the reasons in
   `.jev-lint/README.md`.

The hook picks up the nearest `.jev-lint/` above each edited file. `.jev-lint/config.json`
controls which rules apply in that repo:
- `packs` chooses the packs, e.g. `["repo", "practices"]`;
- `disable` turns off single rules, e.g. `["ts-no-magic-numbers"]`;
- `skipPaths` skips a rule for some paths, as globs relative to the repo root, e.g.
  `{"ts-unvalidated-external-data": ["src/providers/**"]}`.

A repo rule can also carry `paths` globs (e.g. `["src/routes/**"]` or `["**/*.tsx"]`) so it's
only asked where its convention holds. That's useful in multi-language repos, and for
folder-specific rules.

To see what the rules would flag on existing code before enabling them, run
`bun ~/Repos/jev-lint/src/check.ts <files…>`. This
repo dogfoods it: see [`.jev-lint/`](.jev-lint/).

## Learn from what it catches

The hook keeps a local findings log: one line per checked file, with the rules that fired,
a short excerpt, latency and tokens. For each finding it records whether the agent **fixed**
it on a later edit, **kept** it (disagreed or ignored it), or never touched the file again.

```sh
bun ~/Repos/jev-lint/src/findings.ts --repo . --days 30              # per rule, plus failed checks and judge cost
bun ~/Repos/jev-lint/src/findings.ts --repo . --clusters             # rule × area × test/non-test
bun ~/Repos/jev-lint/src/findings.ts --repo . --compare <rule> --at <date>   # before/after, 95% CI
```

The **`jev-lint-learn`** skill turns this into a few changes that pay for themselves, not a
new line for every flag:
- **Act only on clusters with real evidence:** at least 5 decided outcomes across at least 3
  sessions, and for "the agent keeps ignoring it", a Wilson lower bound of 30% or more.
- **At most three changes per review.** Each is matched to its cause:
  - guidance in AGENTS.md for mistakes that keep getting made and fixed;
  - a rule exception for false positives;
  - a narrower rule when it only misfires in tests or one area;
  - a new rule, through `jev-lint-rules`.
- **Each change is recorded as a hypothesis** with a measurable prediction, then checked later
  with `--compare`.

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
| `practices` | `rules/*.practices.json` | React effect misuse (derived state, missing cleanup, fetch races, event logic), overlapping polling / debounced requests, state mutation, index keys, unvalidated external data, sequential awaits, boolean traps; SwiftUI state ownership, expensive `body`, `.onAppear { Task {} }`, retain cycles, main-thread blocking, continuation misuse, continuations without cancellation or that can be overwritten, unprotected shared state, unstable `ForEach` ids, GCD inside async; tests that can't fail (no assertion, tautologies, asserting the test's own stub, mocking the unit under test) |
| `repo` | `.jev-lint/*.rules.json` in your repo | Whatever the `jev-lint-rules` skill generated from your guidelines |

Two rules were removed because the model is weak at counting and tracing; use a deterministic linter for them:

| Removed rule | Use instead |
| --- | --- |
| `ts-no-deep-nesting` | ESLint `max-depth` (and `complexity`); SwiftLint `nesting` / `cyclomatic_complexity` for Swift |
| `ts-no-floating-promise` | typescript-eslint `@typescript-eslint/no-floating-promises` (needs type-aware linting) |

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
| `JEV_LINT_DAEMON` | `on` | `off` checks in the hook process every time. When `on`, the first check starts a small background process that keeps the API connection open and reads the key once; later checks go through it (about 100 ms faster each). It is local only (a user-only Unix socket), exits after 30 idle minutes (`JEV_LINT_DAEMON_IDLE_MS`) or when jev-lint's code changes, and the hook falls back to checking in process if it is unavailable. |
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
bun eval/bench-rules.ts                   # rules per request vs accuracy, latency, tokens; one call vs parallel
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
  - **`jev-lint-setup`** — install and verify the hook (`src/install.ts`), then hand off to rules.
  - **`jev-lint-rules`** — onboard a repo: read its guidance and linters, propose rules, write and validate the approved ones.
  - **`jev-lint-learn`** — cluster the findings log, act on the few changes with evidence, measure them.

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

