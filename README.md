# jev-lint

**A fuzzy linter for coding agents.** Your agent writes a file; 0.3 seconds later it hears
which of your team's rules it just broke, and fixes them before anyone reviews the code.

[![jev-lint in 40 seconds: an agent writes a useEffect fetch, the hook flags a race in 0.3 s, the agent fixes it before review](docs/media/jev-lint-demo-poster.png)](docs/media/jev-lint-demo-1920x1080.mp4)

▶ **[Watch the 40-second demo](docs/media/jev-lint-demo-1920x1080.mp4)** (with sound; [square cut](docs/media/jev-lint-demo-1080x1080.mp4)). The editor scene is an illustrative session; the numbers are from the notebook.

🌐 **Website:** [jevlint.dev](https://jevlint.dev) · 📓 **Results and method:** [experiment notebook](https://claude.ai/artifact/BUZG9LEnaiJyaJuaP7tajs)
(source in `report/`).

## Contents

- [Why use it](#why-use-it)
- [Set it up with your agent](#set-it-up-with-your-agent)
- [How it works](#how-it-works)
- [What's in the box](#whats-in-the-box)
- [Results](#results)
- [Reference](#reference)
  - [Install](#install)
  - [Generate rules for your repo](#generate-rules-for-your-repo)
  - [Learn from what it catches](#learn-from-what-it-catches)
  - [Rule packs](#rule-packs)
    - [Options (environment variables on the hook command)](#options-environment-variables-on-the-hook-command)
  - [Cloudflare Clef (optional)](#cloudflare-clef-optional)
  - [OpenAI Decisions (optional)](#openai-decisions-optional)
  - [Local models](#local-models)
  - [Evaluation harness](#evaluation-harness)
  - [For agents working in this repo](#for-agents-working-in-this-repo)
  - [Development](#development)
  - [Contributing](#contributing)
  - [License and credits](#license-and-credits)

Also: [pack docs](docs/packs/) · [feedback loop](docs/feedback-loop.md) · [experiment notebook](https://claude.ai/artifact/BUZG9LEnaiJyaJuaP7tajs)

## Why use it

- **Catches what linters can't.** "Don't derive state in `useEffect`", "a test must be able
  to fail", "never trust a client-sent `userId`": rules that need judgment, not a regex.
  Normally they surface at code review. jev-lint flags them the moment the file is written.
- **Agents ship fewer violations.** In real runs with the hook on, rule violations per task
  fell from 2.38 to 1.21 in Claude Code (96 runs) and from 1.67 to 0.92 in Codex (48 runs).
- **Fixing at the edit is cheaper than fixing after review.** The agent fixes the problem
  while the file is still open: about +$0.04 and a few seconds per task. Found in review
  instead, the same problem costs a review → fix → re-review round, about $0.18 and 70 s on
  our agent runs, on top of the review itself. With the hook on, review comments covered by
  our rules fell 41%.
- **Costs almost nothing to run.** About $1.51 per 10,000 edits for the checks. It never
  blocks the agent: if anything fails, the edit goes through unchanged.
- **Starts with opinionated defaults.** Tested rule packs for TypeScript and React, Swift and
  SwiftUI, Kotlin, Rust, Python, Ruby and Bazel, plus cross-language packs for security,
  test hygiene (tests that can't fail, flaky tests, tests that lock in the implementation)
  and performance (177 rules). Every
  rule passed an evaluation on held-out examples before it was switched on. See
  [the pack docs](docs/packs/) for a good and bad example of each.
- **Your rules, not just ours.** The packs are only defaults: turn any pack or rule off, scope
  it to some folders, or add your own rules for your team and codebase in `.jev-lint/`. One
  skill reads your agent instructions, docs, skills and linter configs, researches current
  best practices for your frameworks, and proposes rules for you to approve (nothing a linter
  already checks). Another writes and tests a single rule when you think of one.
- **Gets better over time** ([how](docs/feedback-loop.md)). Every check is logged. The learning skill finds the mistakes agents
  keep making, proposes a few targeted fixes to your instructions or rules, and measures
  whether they worked.
- **Works where your agents work.** Claude Code and Codex, installed with one command or one
  pasted prompt. Rules live in your repo (`.jev-lint/`), so the whole team shares them.

It complements linters, type checkers and code review; it doesn't replace them.

## Set it up with your agent

Paste this into Claude Code or Codex, from the repo you want checked:

```text
Set up jev-lint for me: https://github.com/ckorhonen/jev-lint
Reuse an existing checkout, or ask me where to clone it. Follow its jev-lint-setup
skill (.agents/skills/jev-lint-setup/SKILL.md): choose TypeSafe Jev, Cloudflare Clef,
or OpenAI Decisions, check existing credentials without printing them, show me the
local dry run, and install the hook once I confirm. Do not create credentials or
make model requests during setup. Then use its jev-lint-rules skill on this repo:
read our agent instructions, skills, docs and linter configs, and propose rules
for me to approve before writing anything.
```

For guided setup, run `bun src/setup.ts` from the checkout. It offers TypeSafe
Jev (default), Cloudflare Clef (`clef`), and OpenAI Decisions (`gpt-6-luna`), checks
existing credentials, previews the local installer dry run, and asks before
`--apply`. Pass installer options such as `--claude-only`, `--codex-only`,
`--project <repo>`, `--pre`, `--async`, or `--skills` to choose the scope.
`src/install.ts` remains available for manual setup; `src/inventory.ts` lists
files that describe your team's conventions.

## How it works

Every team has best practices and patterns, some common across the industry and some
specific to the team. For example, a team may have a particular way it wants people to
use React hooks like `useEffect`. Rules like that can't be checked deterministically:
there is no regex for "this effect only derives state". So they usually aren't caught
until code review, by a human or an agent.

Catching them at review is expensive. The code goes back to the agent, the agent fixes
it, and the fix has to be reviewed again.

jev-lint moves that check to the moment the file is written. In plain terms:

1. A **hook** — a small script that Claude Code or Codex runs automatically right after
   a file edit — sends the code the agent just added to [TypeSafe Jev](https://docs.typesafe.ai),
   a fast judgment model built for exactly this. [Cloudflare Clef](#cloudflare-clef-optional) is an optional alternative.
2. Jev answers yes or no for each rule, in about 0.3 seconds.
3. If a rule looks broken, the agent hears about it right away and fixes it while the
   file is still open, with no review round trip.
4. Every check is logged, so the team can see where agents keep tripping up and adjust
   rules or instructions later — see [What's in the box](#whats-in-the-box).

For the tiers, the pattern gate, and the rest of the mechanics, see
[Rule packs](#rule-packs) in the reference section below.

## What's in the box

jev-lint is four pieces:

- **Rule packs, as defaults, plus your own rules.** Tested packs for TypeScript/React,
  Swift/SwiftUI, Kotlin, Rust, Python, Ruby and Bazel, plus cross-language security,
  test-hygiene and performance packs (177 rules in total). Turn any pack or rule off, or
  add your own team rules in `.jev-lint/`. See [Rule packs](#rule-packs) for the full pack
  table and how to configure them.
- **An onboarding skill.** `jev-lint-rules` reads your agent instructions, docs, skills and
  linter configs, and proposes rules for you to approve — nothing a linter already checks.
  See [Generate rules for your repo](#generate-rules-for-your-repo).
- **A feedback loop.** Every check is logged. The `jev-lint-learn` skill finds the mistakes
  agents keep making, proposes a few targeted fixes to your instructions or rules, and
  measures whether they worked. See [Learn from what it catches](#learn-from-what-it-catches)
  and [docs/feedback-loop.md](docs/feedback-loop.md).
- **Claude Code and Codex support.** Install with one command or one pasted prompt (see
  [Set it up with your agent](#set-it-up-with-your-agent)); rules live in your repo
  (`.jev-lint/`), so the whole team shares them.

## Results

Measured 26–27 Sep 2026. The notebook has the details and every caveat; here the same
findings are grouped as the questions we were trying to answer.

**Is the check itself accurate and fast enough to trust?**
- **The check itself is accurate and fast.** On held-out edits it scored 94–100% F1 (the
  balance of catching real violations and avoiding false flags). It took about 0.3 s, and
  the pattern gate means only about a third of the rules are asked for each edit.
- **The 170 shipped rules hold up on examples they were never tuned on.** Across the packs,
  held-out precision is 91–100%, and 0–4% of clean edits get any flag. 110 of 117 new
  candidate rules and 12 of 12 new security rules passed; the rest stay switched off.
- **More rules don't make the check worse, but they do make it noisier.** Adding unrelated
  rules up to 100 per request left target-rule F1 at 97–99% (99% with no padding). Median
  latency went from 319 ms to 458 ms. Splitting the rules into parallel requests was slower
  and used 37% more tokens. So the rule budget (8–12 repo rules per language) is about false
  alarms and the agent's attention, not Jev. On 86 real files, the new packs doubled the rules
  that apply to a file (23 → 48), but the gate asks only about 12, and the median check went
  from 299 ms to 307 ms.

**Does immediate feedback beat a review round trip?**
**Agents act on the feedback (hypothesis 1: supported).** In 96 real Claude Code runs,
violations per task fell from 2.38 to 1.21 with the hook running in the background. In
48 Codex runs they fell from 1.67 to 0.92. Both drops are statistically significant.
With all 170 rules, a new round of 48 Claude Code runs showed the same drop: 2.71 → 1.54
per task (−1.17, 95% CI −2.12 to −0.29). The starting point is higher only because there
are more rules to check.

**Does checking before the write do better than after?** Slightly, but not significantly.
Same 12 tasks, 24 runs per condition (the before-the-write runs came a few hours after the
others): violations per task were 2.42 with the hook off, 1.62 checking after the write (async),
and 1.25 checking before it. That's −33% and −48%, both significant against no hook. The
difference between the two modes (−0.38, 95% CI −1.25 to +0.42) is not significant. Both cost
about +$0.04 per task. The before-the-write mode blocked an edit in 17 of 24 runs (0.7 blocks per
task), never deadlocked, and every run still built. The bad patch has already been generated
either way, so checking earlier doesn't save those tokens. What does is feedback before the agent
plans, which is what the [feedback loop](docs/feedback-loop.md) is for.

**Is it cheap enough to run on every edit?**
**Cost per check is negligible (hypothesis 2: supported).** Each check costs roughly
$0.00015, about $1.51 per 10,000 edits (measured before the new packs, which add about 30%
more input; roughly $2 per 10,000 now). The real cost is the agent's own fix-up work, about +$0.03–0.04 and +10 s per task.

**Does it pay for itself, once review and rework are counted?**
**It cuts what reviewers have to flag, at a fraction of the cost of fixing it later
(hypothesis 3: supported for review findings; the total saving depends on your review setup).**
- With all 170 rules, review comments that one of our rules covers fell from 1.33 to 0.79
  per task (−41%, 48 Claude Code runs, 95% CI −1.08 to −0.04). Each one is a comment the
  agent never has to read, work out how to fix, fix, and send back for another review.
- Catching it at the edit costs about +$0.04 and a few seconds per task. A review → fix →
  re-review round costs about $0.18 and 70 s on our runs, and you pay for the review itself
  either way: per AI review, or in a person's time.
- With human reviewers the saving is direct: they never see these problems at all.
- Reviews still find logic and design issues that no rule covers (about 3.6 comments per
  task in our tests), so the review doesn't go away. It gets smaller and cleaner.

**Does logging every check create a useful feedback loop?**
**The feedback loop works (hypothesis 4).** The findings log already showed real noise
(debug scripts, domain constants), which led to a fix the same day.

**Could it run locally, for free?**
**Yes, as a fallback. Cloud Jev is still more accurate and faster.**
- A Kev-4B fine-tuned on our own labels scores 95.2% F1 on 2,089 held-out edits and flags
  2.0% of clean edits. Jev scores 98.1% and flags 0.8% on the same edits.
- A three-model local chain on an M3 Max checks an edit in about 460 ms (median) at 94.5% F1.
  Jev takes about 343 ms. More tuning didn't close that gap; matching Jev's speed would need
  a faster model architecture.
- The Neural Engine couldn't be used: the model's core layer has no Core ML equivalent yet.
- Running locally costs nothing per edit and works offline, but needs roughly 20 GB of
  memory (an estimate) for the three local model servers.

See the [experiment notebook](https://claude.ai/artifact/BUZG9LEnaiJyaJuaP7tajs) for the
full method and every caveat.

## Reference

Everything below is the technical detail behind the sections above: installing by hand,
generating and tuning rules, the full pack table and its options, local models, the
evaluation harness, and how the repo itself is developed.

### Install

Most people should use [Set it up with your agent](#set-it-up-with-your-agent) above. This
section is the manual reference.

Requires [bun](https://bun.sh) and existing credentials for your selected provider.
Reuse an existing checkout. Otherwise, choose a parent folder and run:

```sh
git clone https://github.com/ckorhonen/jev-lint
cd jev-lint
bun install
bun src/setup.ts
```

TypeSafe uses `TYPESAFE_API_KEY`, a private mode-600 file at
`~/.config/jev-lint/api-key` (override with `TYPESAFE_API_KEY_FILE`), or the macOS
Keychain service `typesafe-api-key`. Cloudflare needs `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` or a mode-600 `CLOUDFLARE_API_TOKEN_FILE`. OpenAI uses
`OPENAI_API_KEY` or a mode-600 `OPENAI_API_KEY_FILE`. Setup checks for existing
credentials without printing them; it does not create credentials or call a model.

For a noninteractive local preview, use `bun src/setup.ts --provider typesafe`
(or `clef` / `decisions`). Add `--apply` to authorize the reviewed local changes.
The guide accepts the scope and mode flags shown below; network smoke tests stay separate.

All shell examples below run from the jev-lint checkout. Use absolute target-repo
paths where an example asks for a repo or files. The manual installer checks first
and writes only with `--apply`, after you approve its preview:

```sh
bun src/install.ts --skills                 # local dry run; no model request
bun src/install.ts --apply --skills         # Claude Code + Codex, user-wide
#   --claude-only | --codex-only   --project <repo> (Claude, repo-scoped)   --async (Claude, background)
```

**Optional network verification:** `bun src/install.ts --smoke` makes a REAL NETWORK
request, sending synthetic fixture code and rule questions to the selected provider;
it may incur charges. Run it only with explicit approval for that provider and
transmission. It must flag an empty `catch`; report failures instead of treating
installation as verified. Honor permission denials; never add a broad Bash allowlist
or bypass approval or hook trust to make it pass.

`--apply` backs up changed files as `*.bak-jev-lint-<time>` and replaces only
jev-lint entries. To turn it off, remove those entries or restore the corresponding
backups; keep other hooks intact.
The installer reports each actual backup path. Settings files that are symlinks are
refused during preview: review their target and configure that location explicitly.

**Upgrading.** One command pulls this checkout, installs dependencies and re-applies the hooks
in whatever mode they're in (`--pre`, `--async`, re-check on or off are read back from your
config), for both Claude Code and Codex:

```sh
bun src/install.ts --upgrade
```

The warm daemon notices the code change and restarts itself on the next check. Running
agents pick up the new hook on their next edit; nothing needs restarting.

Or by hand:

**Claude Code:** add to `~/.claude/settings.json` (or a repo's `.claude/settings.json`) under `hooks.PostToolUse`:

```json
{ "matcher": "Write|Edit|MultiEdit",
  "hooks": [{ "type": "command", "command": "JEV_LINT_MODEL=jev-1.13.0 bun \"/absolute/path/to/jev-lint/src/hook.ts\"", "timeout": 15 }] }
```

**Codex:** add to `~/.codex/hooks.json` under `hooks.PostToolUse`. Codex `apply_patch` payloads are parsed from `tool_input.command`, and only `+` lines are judged:

```json
{ "matcher": "Edit|Write|apply_patch",
  "hooks": [{ "type": "command", "command": "JEV_LINT_MODEL=jev-1.13.0 bun \"/absolute/path/to/jev-lint/src/hook.ts\"", "timeout": 15 }] }
```

`--skills` links the skills into `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills`,
so they're available in every repo.

**Before the write (Claude Code): `--pre`.** By default the hook checks each edit right after
it's written, and the agent fixes problems on its next edit. With `--pre`, it checks each edit
*before* it's applied instead. A high-confidence finding blocks the edit, and the agent rewrites
it; double-check findings pass through as hints.

```sh
bun src/install.ts --apply --pre     # switch Claude Code to before-the-write
bun src/install.ts --apply           # switch back to after-the-write
```

In our benchmark it did as well as or slightly better than checking after the write (violations
per task 1.25 vs 1.62; the difference isn't statistically significant), at the same extra cost.
Neither mode saves the tokens spent generating the bad patch; that has already happened.

When to turn it on:
- **Bad code must never land, even briefly:** secrets, security patterns, or generated files that
  other people or systems read.
- **Something watches the working tree:** a dev server, file watcher or test runner would pick up
  the bad version before the agent's fix.
- **You'd rather the agent get it right in one edit** than write, then patch. It made slightly
  fewer edits in our runs.

When to leave it off (the default):
- **You want the agent never to wait on the check.** Before-the-write adds about 0.3 s before
  every write, while the async after-the-write mode doesn't block at all.
- **Your rules are noisy.** A false alarm blocks a good edit instead of just adding a hint. The
  same rule can block the same file at most twice per conversation, so a false alarm can't
  deadlock the agent, but it still costs a rewrite. Tune noisy rules first (`thresholds`,
  `skipPaths`).

Codex keeps checking after the write for now: `--pre` applies to Claude Code only.

Codex **cloud** tasks don't run command hooks (OpenAI's hooks docs: command hooks are
unsupported under cloud orchestration), so jev-lint can't check edits made there. Cloud agents
are the main reason a review-time check on the pull request is on the roadmap.

**Async (Claude Code only):** to keep the agent from waiting on the check (useful with a slower
local judge), run it in the background and let findings wake the agent:

```json
{ "type": "command", "command": "JEV_LINT_MODE=rewake JEV_LINT_MODEL=jev-1.13.0 bun \"/absolute/path/to/jev-lint/src/hook.ts\"", "timeout": 180, "asyncRewake": true }
```

Codex supports `async` hooks but not rewake, so keep Codex synchronous. Codex needs
`[features] hooks = true` in `config.toml` and, the first time, trusting the hook through the normal approval flow.

The hook fails open: on a timeout, an API error or an unknown file type it exits 0 silently.
**Privacy:** installed hooks send added edit code, whole files for Writes, and current file content for end-of-turn rechecks to the selected provider: TypeSafe, Cloudflare Clef, OpenAI Decisions, or your configured local server. Replace the manual JSON examples' quoted absolute path with your checkout path.

### Generate rules for your repo

Run the **`jev-lint-rules`** skill inside any repo. It works in seven steps:
1. **Read everything the team wrote down.** `bun src/inventory.ts /absolute/path/to/target-repo` lists:
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
   bun src/validate.ts /absolute/path/to/target-repo/.jev-lint   # keep / reword-or-drop / needs-cases per rule
   ```
7. **Keep only rules that pass.** It records the dropped ideas and the reasons in
   `.jev-lint/README.md`.

The hook picks up the nearest `.jev-lint/` above each edited file. `.jev-lint/config.json`
controls which rules apply in that repo:
- `packs` chooses the packs, e.g. `["repo", "practices"]`;
- `disable` turns off single rules, e.g. `["ts-no-magic-numbers"]`;
- `skipPaths` skips a rule for some paths, as globs relative to the repo root, e.g.
  `{"ts-unvalidated-external-data": ["src/providers/**"]}`.
- `thresholds` sets a rule's own confidence cutoffs, e.g. `{"ts-no-magic-numbers": {"medium": null}}`
  to show only its high-confidence findings.

A repo rule can also carry `paths` globs (e.g. `["src/routes/**"]` or `["**/*.tsx"]`) so it's
only asked where its convention holds. That's useful in multi-language repos, and for
folder-specific rules.

To see what the rules would flag on existing code before enabling them, run
`bun src/check.ts <files…>`. This
repo dogfoods it: see [`.jev-lint/`](.jev-lint/).

### Learn from what it catches

The hook keeps a local findings log: one line per checked file, with the rules that fired,
the lines around each flag, latency and tokens. For each finding it records whether the agent **fixed**
it on a later edit, **kept** it (disagreed or ignored it), or never touched the file again.
At the end of each turn, a re-check hook (`src/recheck.ts`, installed on `Stop` and
`SubagentStop` by `install.ts`) looks again at files that still had findings, so almost every
finding gets a fixed-or-kept outcome. Subagents are tracked separately.

```sh
bun src/findings.ts --repo /absolute/path/to/target-repo --days 30              # per rule, plus failed checks and judge cost
bun src/findings.ts --repo /absolute/path/to/target-repo --clusters             # rule × area × test/non-test
bun src/findings.ts --repo /absolute/path/to/target-repo --compare <rule> --at <date>   # before/after, 95% CI
bun src/valueAudit.ts --repo /absolute/path/to/target-repo --days 30            # LLM-graded: were the fixed/kept findings worth it?
```

The **value audit** asks `gpt-6-luna` whether a reviewer would have asked for each fixed or
kept change (bug, security, review comment) or whether it was style or noise; see
[Is it worth fixing?](docs/feedback-loop.md#is-it-worth-fixing-the-value-audit).

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

**Set it up as a loop.** [docs/feedback-loop.md](docs/feedback-loop.md) explains it for humans, and
gives agents the steps to schedule a weekly review. Each proposed change gets proven before
it's kept:
- a rule change against the labeled examples in `.jev-lint/cases.jsonl`;
- an instruction or skill change with `src/repoEval.ts`, which has an agent do small tasks from
  `.jev-lint/evals/` twice, with the old and the new instructions, and compares how often it
  makes the mistake.

### Rule packs

After every file edit, a PostToolUse hook sends the added code to Jev in one call. Rules
whose trigger patterns don't appear in the code are skipped (the pattern **gate**). Findings
go back to the agent in two tiers:

- **p ≥ 0.8** — "Likely violations — fix these"
- **0.5 ≤ p < 0.8** — "Possible violations — double-check; ignore if the code is actually fine"

The rules target what a deterministic linter can't express. Examples: "don't use
`useEffect` to derive state", "validate JSON before casting it", "don't create an object
inline in `@ObservedObject`", "resume a continuation exactly once". Teams can generate their
own rules from their guidelines with the `jev-lint-rules` skill.

These packs are defaults. Turn a pack or a rule off, or scope it to some folders, in your
repo's `.jev-lint/config.json` (`packs`, `disable`, `skipPaths`), and add your own rules next
to them. Each pack has a page with a good and a bad example of every rule, and its holdout
numbers.

| Pack | Rules | Languages | What it checks |
| --- | --- | --- | --- |
| [`hygiene`](docs/packs/hygiene.md) | 24 | swift, typescript | `any`, non-null / force-unwrap, empty catch, debug prints, restating comments, vague names, magic numbers, bare TODOs, hard-coded secrets |
| [`practices`](docs/packs/practices.md) | 65 | bazel, kotlin, python, ruby, rust, swift, typescript | React effects and rendering, SwiftUI and Swift concurrency, Kotlin coroutines/Flow/Compose, Rust async and `unsafe`, Python async and ORMs, Rails, Bazel |
| [`security`](docs/packs/security.md) | 33 | python, ruby, rust, typescript | Secrets in client bundles or logs, unverified JWTs, SQL/shell built from input, SSRF, path traversal, mass assignment, unscoped record lookups, Server Actions without auth, unsafe deserialization, weak password hashing |
| [`tests`](docs/packs/tests.md) | 42 | bazel, kotlin, python, ruby, rust, swift, typescript | Tests that can't fail; flaky tests (real clock, unseeded randomness, real network, fixed sleeps, order-dependent assertions, shared state); tests bent to pass; tests that lock in the implementation (assert internal calls, mock the codebase's own modules, whole-output snapshots, hand-typed fake API responses) |
| [`performance`](docs/packs/performance.md) | 13 | kotlin, python, ruby, rust, swift, typescript | N+1 queries and per-item writes, sync I/O on request paths, unbounded queries, independent calls awaited one by one, unbounded fan-out |
| `repo` | yours | any | Your team's rules in `.jev-lint/*.rules.json`, written with the `jev-lint-rules` and `jev-lint-write-rule` skills |

**New in October 2026: test rules for implementation lock-in.** The "unit tests are bloat"
debate is really about tests that pin the implementation instead of the behaviour. Seven new
rules in the `tests` pack (TypeScript and Python) catch the concrete patterns: tests whose
only assertions are which internal functions were called (`*-test-asserts-internal-calls`),
tests that mock the codebase's own modules instead of an external boundary
(`*-test-mocks-own-module`), tests whose only assertion is a whole-output snapshot
(`ts-test-snapshot-lock-in`), and tests that fake an external API or database response with a
hand-typed literal that schema drift will never break (`*-test-untyped-fake-response`). All
seven passed the held-out bar at 100% precision. The fake-response rule
(`*-test-untyped-fake-response`) is back to candidate for now: in an end-to-end round the same
day it fired twice on agent-written tests whose fakes were already typed, which its own
exceptions allow, so it needs narrower wording and fresh cases. Two more, "test re-implements the logic"
(`*-test-reimplements-logic`), were first held back after a real-code false alarm on a
differential test, then shipped the same day after their `false` criteria named differential
tests and a fresh pair of labeled batches passed. Details and the real-code dry run are in
[notebook Entry 10](https://claude.ai/artifact/BUZG9LEnaiJyaJuaP7tajs); examples in
[docs/packs/tests.md](docs/packs/tests.md). If one argues with your team's habits, disable it
in `.jev-lint/config.json` rather than lowering its threshold.

Three style rules, `ts-no-magic-numbers`, `ts-no-vague-names` and `ts-unvalidated-external-data`
(plus `swift-no-magic-numbers`), are skipped in test files (`*.test.*`, `__tests__/`, `test/`,
`tests/`, `e2e/`), where bare numbers, short names and unchecked fixtures are normal. A week of
real use showed those flags were mostly kept there, not fixed.

Rules still being evaluated are marked `"status": "candidate"` and are not asked by the hook.
A rule ships only after it passes on held-out examples written by a separate author
(precision ≥ 90% on "fix" findings, ≥ 75% overall, recall ≥ 80%) and a dry run on real code.

Two rules were removed because the model is weak at counting and tracing; use a deterministic linter for them:

| Removed rule | Use instead |
| --- | --- |
| `ts-no-deep-nesting` | ESLint `max-depth` (and `complexity`); SwiftLint `nesting` / `cyclomatic_complexity` for Swift |
| `ts-no-floating-promise` | typescript-eslint `@typescript-eslint/no-floating-promises` (needs type-aware linting) |

#### Options (environment variables on the hook command)

| Var | Default | Meaning |
| --- | --- | --- |
| `JEV_LINT_PACKS` | `hygiene,practices,tests,performance,repo` | Packs to ask (a repo's `config.json` overrides) |
| `JEV_LINT_TIERS` | `high,medium` | `high` drops the double-check tier |
| `JEV_LINT_GATE` | on | `off` asks every rule. By default a rule is only asked when its `when` patterns match the added code (about a third of rules per edit) |
| `JEV_LINT_HIGH` / `JEV_LINT_MEDIUM` | `0.8` / `0.5` | Tier thresholds |
| `JEV_LINT_MODE` | `context` | `block` sends findings as `decision: "block"`; `rewake` is for Claude Code async hooks (see below) |
| `JEV_LINT_PROVIDER` | `typesafe` | `cloudflare` opts into Workers AI Clef; `openai` opts into OpenAI Decisions; see setup below |
| `JEV_LINT_MODEL` | `jev-latest` (TypeSafe), `clef` (Cloudflare), `gpt-6-luna` (OpenAI) | Pin `jev-1.13.0` for TypeSafe; Cloudflare accepts `clef` or `clef-flash`; Decisions accepts `gpt-6-luna` |
| `CLOUDFLARE_ACCOUNT_ID` | unset | Required in Cloudflare mode: your 32-character account ID |
| `CLOUDFLARE_API_TOKEN` | unset | Workers AI token, read only in Cloudflare mode; never written to hook configs |
| `CLOUDFLARE_API_TOKEN_FILE` | unset | Alternative token file; must have no group/other permissions (use mode 600). Environment token takes priority |
| `OPENAI_API_KEY` | unset | OpenAI key, read by the Decisions provider; never written to hook configs |
| `OPENAI_API_KEY_FILE` | unset | Alternative Decisions key file with no group/other permissions (mode 600); environment key takes priority |
| `JEV_LINT_TIMEOUT_MS` | `8000` | Per-call timeout |
| `JEV_LINT_LOG` | unset | Debug: append every raw judgment to a JSONL file |
| `JEV_LINT_FINDINGS_LOG` | `~/.local/state/jev-lint/findings.jsonl` | Findings log used by `jev-lint-learn`; `off` disables it |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Any `/v1/systemone` server, e.g. a local Kev or Laya (no key needed) |
| `JEV_LINT_RECHECK` | `on` | `off` disables the end-of-turn re-check (`src/recheck.ts`) that gives each finding a fixed/kept outcome |
| `JEV_LINT_SCOPE` | `repo` | Only files inside the repo around the session's cwd are checked; `all` also checks scratch files elsewhere (such as `/tmp` debug scripts, where printing is usually intended) |
| `JEV_LINT_DAEMON` | `on` | `off` checks in the hook process every time. When `on`, the first check starts a small background process that keeps the API connection open and reads the key once; later checks go through it (about 100 ms faster each). It is local only (a user-only Unix socket), exits after 30 idle minutes (`JEV_LINT_DAEMON_IDLE_MS`) or when jev-lint's code changes, and the hook falls back to checking in process if it is unavailable. |
| `JEV_LINT_DEBUG` | unset | Print errors to stderr, including why each failed check failed (e.g. `Cloudflare 401`) |

### Cloudflare Clef (optional)

[Clef](https://developers.cloudflare.com/workers-ai/models/clef/) and
[Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) are
Cloudflare decision models served by Workers AI. Opt in with
`JEV_LINT_PROVIDER=cloudflare`; TypeSafe Jev remains the default. This is an
experimental alternative: the Jev accuracy, latency and cost results above do
**not** establish Clef's performance on these rules. The adapter is tested against
responses that match Cloudflare's published Clef schema, not yet against the live
API, so treat the first real run as a smoke test (`bun src/install.ts --smoke` in
Cloudflare mode must flag an empty `catch`). See the
[comparison plan and current status](docs/cloudflare-eval.md).

Use existing `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or set
`CLOUDFLARE_API_TOKEN_FILE` to an existing private mode-600 token file. Setup does
not create tokens. From the checkout:

```sh
export JEV_LINT_PROVIDER=cloudflare
export CLOUDFLARE_ACCOUNT_ID=your_32_character_account_id
export JEV_LINT_MODEL=clef             # or clef-flash
bun src/install.ts --skills           # local preview; no API request
bun src/install.ts --apply --skills   # after approving the preview
```

The installer records the provider, model, account ID and optional absolute token
file path in both the edit hook and the end-of-turn recheck. It never writes the
token into hook configs. An environment token must also be present in the running
agent's environment; exporting it only for installation does not persist it.
No TypeSafe key is required in this mode. Existing `--pre`, `--async`, pack,
threshold and rule options work as before. `check.ts` and `validate.ts` also honor
the selected provider.

The hook posts to
`https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/@cf/cloudflare/<model>`.
It sends the same added code and Noul questions as Jev, unwraps the Workers AI
response, and keeps the existing 0.8 / 0.5 tiers. More than 64 questions are split
into batches under one timeout, with token usage summed. Missing credentials,
timeouts, API failures and malformed answers fail open; errors appear in the
findings log (or on stderr with `JEV_LINT_DEBUG=1`). Provider/account/model/token
changes get separate daemon sockets. There is no automatic fallback to TypeSafe.
`TYPESAFE_BASE_URL` configures only the TypeSafe/local path, not Workers AI.

**Privacy and billing:** Cloudflare receives the added code and rule questions.
Workers AI usage is billed to your account at its current model rates; the Jev
cost estimates on this page do not apply. Findings record the returned model and
input tokens, and the summary excludes other models from its Jev cost estimate.
Cloudflare's `clef` and `clef-flash` names are service model IDs, not immutable
version pins; record the date and returned model when comparing runs.

To switch installed hooks back to Jev:

```sh
JEV_LINT_PROVIDER=typesafe JEV_LINT_MODEL=jev-1.13.0 bun src/install.ts --apply
```

To compare the hosted models on the same existing holdout cases, configure **both**
providers' credentials, then run (use a fresh output filename for each experiment):

```sh
JEV_LINT_MODEL=jev-1.13.0 bun eval/run.ts --systems jev,clef,clef-flash \
  --splits holdout --runs 3 --out cloudflare-comparison-2026-10-02.json
```

The named eval judges select their own provider; `JEV_LINT_MODEL` pins the Jev
baseline, while `clef` and `clef-flash` select their respective Cloudflare models.
Compare precision, recall, F1, clean-edit false alarms, latency, tokens and errors
per pack/language. Each provider has separate caches keyed by model, rule text and
payload. The harness asks every rule and derives gated scores by masking: those
latencies are **ungated**, not production-hook timings. Existing results are not
overwritten. See [docs/cloudflare-eval.md](docs/cloudflare-eval.md) for limitations.

### OpenAI Decisions (optional)

Set `JEV_LINT_PROVIDER=openai` to use the public beta
[Decisions API](https://developers.openai.com/api/docs/guides/decisions).
TypeSafe remains the default; Clef remains available independently. This mode uses
`POST https://api.openai.com/v1/decisions` with `gpt-6-luna`, not Chat Completions
or System One. Contract checked against the
[create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
on October 6, 2026.

After approving OpenAI billing and transmission of your code, make an existing
`OPENAI_API_KEY` available to the agent, or set `OPENAI_API_KEY_FILE` to a private
mode-600 file. Credentials are never persisted in hook configs. Select:

```sh
export JEV_LINT_PROVIDER=openai
export JEV_LINT_MODEL=gpt-6-luna
bun src/install.ts                         # dry run, no API request
# After approving hook installation:
bun src/install.ts --apply
```

The installer persists the provider/model and optional key-file path for both
edit and recheck hooks. Relative `OPENAI_API_KEY_FILE` paths resolve against the
invoking directory; the daemon retains that absolute path when it starts from
the home directory. Changing provider or credentials isolates the daemon.
`TYPESAFE_BASE_URL` has no effect in OpenAI mode; explicit local endpoints still
use the System One protocol. There is no automatic fallback between providers.

OpenAI receives the added code for edits, the whole file for Writes and
end-of-turn rechecks (including pre-existing content), file path/language context
and built-in or repository rule questions. Rule
questions become predicates; true/false criteria are included in instructions,
and the documented ordered `answers` array becomes internal rule probabilities.
Names are optional in the API: the adapter sends rule IDs and accepts null answer
names by position, while rejecting mismatched names. A refusal, malformed answer,
missing usage, timeout or HTTP failure fails the whole file check; the hook stays
silent and exits successfully. Refusals never become zero-probability clean-code
judgments. Retries are off for hooks and share one deadline when requested.

An October 6, 2026 synthetic live smoke request passed (`gpt-6-luna`, predicate
probability 0.99, 164 input tokens, zero output tokens); see the
[verification receipt](docs/decisions-eval.md#live-smoke-and-publication-receipt).
No live Decisions accuracy, latency or cost comparison has been measured. Jev's
measurements do not apply to this mode. OpenAI bills usage to your account under
the current Decisions rates; findings record returned model IDs and input tokens,
and existing Jev-only cost estimates exclude them.

For a comparison after approval, see [the fixed plan](docs/decisions-eval.md).
Switch back using the existing Cloudflare or TypeSafe installer commands and the
appropriate model. No credentials or provider defaults are changed automatically.

### Local models

Kev and Laya serve the same `/v1/systemone` protocol, so `TYPESAFE_BASE_URL=http://127.0.0.1:8009`
points the hook at a local server. As of 27 Sep 2026 they are not accurate or fast enough on
these rules. The best, Kev-4B with the rule gate, scored 70–75% held-out F1 at about 1.4 s per edit on an
M3 Max (notebook Entries 4–5). JevLike trained on our labels didn't learn the task (Entry 6), and a
fine-tuned Kev-4B is in progress. `local/laya_server.py` and `local/bench_encoder.py` reproduce the Laya runs.

### Evaluation harness

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

**Rule-pack languages (E2E):** `eval/e2e/tasks.packs.json` has 15 tasks for Python (FastAPI),
Ruby (ActiveRecord, no full Rails), Kotlin, Rust (Tokio), Bazel (rules_python) and one
TypeScript security task, on scaffolds in `eval/e2e/scaffold/<lang>/`. Only files the agent
added or changed are graded, each with every non-candidate pack for its language. The build
check is compile-only and is skipped (`build.ok: null`) when the toolchain is missing
(Kotlin needs gradle and a JDK, Bazel needs bazel or bazelisk):

```sh
bun eval/e2e/run.ts --tasks-file eval/e2e/tasks.packs.json --tag langs --conditions none,jev --reps 2
E2E_TAG=langs bun eval/e2e/grade.ts && E2E_TAG=langs bun eval/e2e/review.ts
```

**Cases:**
- `eval/cases/<lang>[.practices].dev.jsonl` is the tuning split. Rule wording is only tuned here.
- `eval/cases/<lang>[.practices].holdout.jsonl` is the held-out split, written by a separate author in a different style.

**Results:**
- `eval/results/*.json` holds the latest results.
- `eval/results/snapshots/` keeps superseded evidence.
- `eval/results/cache/` is a local, gitignored judgment cache keyed by rule-text and payload hashes, so reruns are free.

**Notebook:** the report is an experiment notebook. Add a dated entry for each experiment, and label superseded numbers instead of deleting them.

### For agents working in this repo

- [`AGENTS.md`](AGENTS.md) (and `CLAUDE.md`) cover the layout, commands and rules for changes.
- Skills live in `.agents/skills/`, symlinked for Claude Code at `.claude/skills/`:
  - **`jev-lint-eval`** — the evaluation workflow: rules, labeled cases, offline eval, E2E rounds and notebook entries.
  - **`jev-lint-write-rule`** — write, reword or evaluate one rule: the gates, evidence sources (incl. web research on official docs), cases and validation.
  - **`jev-lint-setup`** — install and verify the hook (`src/install.ts`), then hand off to rules.
  - **`jev-lint-rules`** — onboard a repo: read its guidance and linters, propose rules, write and validate the approved ones.
  - **`jev-lint-learn`** — cluster the findings log, act on the few changes with evidence, measure them.

### Development

```sh
bun test && bunx tsc --noEmit && bunx biome check .
```

### Contributing

Contributions from people and coding agents are welcome. The short version:
- keep PRs small;
- the hook must fail open and stay fast;
- new rules need evidence plus independent dev and holdout cases, and ship only after passing
  held-out evaluation;
- nothing a linter can already check;
- make `bun test && bunx tsc --noEmit && bunx biome check .` pass.

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [pull request template](.github/pull_request_template.md).
Agents: read [AGENTS.md](AGENTS.md) first.

### License and credits

jev-lint is released under the [MIT License](LICENSE).

- The demo video's source is in [`docs/video/`](docs/video/) (Remotion; `./render.sh`
  re-renders both cuts, music and sound effects are synthesised by `audio/generate.py`).
- The experiment notebook (`report/`) embeds the **Departure Mono** typeface by Helena Zhang
  ([departuremono.com](https://departuremono.com)), licensed under the
  [SIL Open Font License 1.1](https://openfontlicense.org). The font remains under its own license.
- The evaluation compares against and links to other projects without vendoring them:
  [TypeSafe Jev](https://docs.typesafe.ai) (hosted API), [Kev](https://github.com/jaredpalmer/kev),
  [Laya](https://github.com/NandhaKishorM/laya) and [JevLike](https://github.com/vinnylarouge/jevlike).
