---
name: jev-lint-rules
description: Onboard a repository to the jev-lint hook by reading everything that says what the team values (agent instructions, skills, README/CONTRIBUTING, style guides, ADRs, linter and CI configs), then proposing a small set of Jev-checkable rules plus opinionated best practices for the repo's languages, and writing and validating the approved ones in `.jev-lint/`. Use after installing jev-lint in a repo, when its guidelines change, or when asked to generate lint rules from coding rules.
---

# Onboard a repo: propose, then write, jev-lint rules

jev-lint runs one fast Jev judgment per agent edit. Built-in packs cover TypeScript/React and
Swift/SwiftUI; this skill adds `.jev-lint/` rules for one repo. Success is **a few rules
that are rarely wrong and check what no deterministic tool can**, not coverage. A rule that
nags on correct code teaches the agent to ignore every finding.

`JEV` below means the jev-lint checkout (the directory holding `src/hook.ts`; usually
`~/Repos/jev-lint`). Run commands from the target repo's root.

## 1. Inventory everything, then read it all

```sh
bun $JEV/src/inventory.ts .
```

It lists:
- agent instructions;
- skills;
- docs (README, CONTRIBUTING, style guides, ADRs, top-level `docs/`);
- linter and type-checker configs;
- CI and hooks;
- existing `.jev-lint/` files;
- files the guidance points to;
- languages by file count.

If the README or instructions name other files as required reading, and the inventory missed
them, read those too.
**Read every listed file in full.** Skimming misses the one line that states a team
convention. If the total is over ~3,000 lines, split the groups across up to 3 read-only
subagents. Give each one its file list, tell it to read every file completely, and ask it to
return the digest below with a file:line citation for each item.

Write a **team-values digest**, one line each, with its source:
- **Conventions:** explicit rules ("use the logger in `src/log.ts`", "no default exports").
- **Architecture boundaries:** which layer may call which, where data access lives.
- **Recurring warnings:** things docs or skills repeat or put in bold ("never", "always").
- **Enforced already:** everything the linters, type checker and CI actually block.

## 2. Map deterministic coverage

Read [references/deterministic-coverage.md](references/deterministic-coverage.md). A check is
covered only if the config applies to the file, the rule is on at error level, and something
runs it:
- **CI or a hook blocks on it:** covered.
- **The repo has no CI or hooks, but its instructions tell agents to run the check** (e.g.
  "run `bun run check` before finishing"): count it as covered. In the proposal, also
  suggest adding a hook or CI job.
- **Nothing runs it:** not covered. Propose wiring it up.

Warning-level rules are not covered.
When in doubt, probe the repo's own tool with a violating snippet (the reference has the
commands). Probe in a scratch copy, never by editing the repo. Covered ideas never become Jev rules. Ideas a linter could enforce but doesn't go
in the proposal as **config changes**, not Jev rules.

## 3. Look at the code, then collect candidates

**Look at the code.** Rules are judged against real edits, so their exceptions and gates
must come from how this repo actually writes code:
1. For each candidate, grep for its pattern and read a few hits. Look for the repo's own
   helpers (a `shellQuote`, a `beforeSend`, a logger) that belong in the rule's `false`, and
   for idioms that must not be flagged.
2. Run the built-in packs over 10–20 representative files to see what they would flag today:
   ```sh
   bun $JEV/src/check.ts $(git ls-files 'src/**/*.ts' | head -20)
   ```
   If a built-in rule fires on the repo's accepted idiom (e.g. a cast after `res.json()` in
   every adapter), either:
   - disable that one rule with `.jev-lint/config.json` `"disable": ["<id>"]`, or
   - scope it with `"skipPaths": {"<id>": ["src/adapters/**"]}`.

   Put that choice in the proposal.

**Collect candidates from four sources.** The `jev-lint-write-rule` skill's
[sources.md](../jev-lint-write-rule/references/sources.md) explains each one and how much
weight it carries.

1. **The team's own guidance:** split each digest line into the smallest separate checks.
2. **Recurring review comments,** if the repo is on GitHub and `gh` works. Take the last
   ~3 months of PR review comments and cluster them by theme. Themes that recur across 3 or
   more PRs are strong candidates, and often the most valuable ones, because they are what
   reviewers keep catching by hand.
3. **Current official guidance for the frameworks in use,** researched on the web. Read the
   frameworks and versions from the manifests. For each one that matters (React, Next.js,
   Vue, SwiftUI, Django, FastAPI, Tokio, Compose…), read the official docs' pitfalls and
   "common mistakes" pages for that version. Cite the URL and the date you checked. Drop
   anything the repo's linters already enforce; propose enabling an existing lint rule
   instead of writing a Jev rule for it. If there is no network, say so and rely on source 4.
4. **Opinionated best practices for the languages present** (>~5% of files, or any file the
   team calls important):
   - TypeScript/React and Swift/SwiftUI: the built-in `hygiene` and `practices` packs
     (`$JEV/rules/*.json`) are already on. Read them so you don't duplicate them. Decide
     whether the repo wants both (`.jev-lint/config.json` `packs`).
   - Python, Go, Rust, Kotlin, Ruby, Lua/Luau: [references/best-practices/](references/best-practices/README.md).
   - Any other language: `generic.md` in that folder, adapted.
   - `generic.md` also applies to TypeScript and Swift repos, for topics the built-in packs
     don't cover (shell strings, SQL building, secrets, retries).
   - **Test validity is a default.** If the repo has tests, always propose the language's
     `*-test-cannot-fail` rule. It's already built in for TypeScript and Swift. It flags
     tests that couldn't fail if the code broke: no assertion, tautologies, asserting the
     test's own stub, or mocking the unit under test.

Keep a candidate only if **all** hold. The gates, and where rejected ideas go instead, are in the
`jev-lint-write-rule` skill:
- **Visible in the added code alone.** No other files, callers, history or runtime facts.
- **One concrete pattern, stated literally.** Jev answers the words, not the intent.
- **No counting or tracing.** No "more than N", no "every caller".
- **Not deterministically covered** (step 2).
- **It matters here:** the team says so, or it is a real bug risk in this stack.

## 4. Budget

Measured on 2026-09-27 (`eval/bench-rules.ts`, 48 held-out cases):
- **Accuracy doesn't cap the rule count.** Padding the target rules with unrelated ones up to
  100 questions per call left target F1 at 97–99% (99% with no padding), and probabilities moved 0.003 on average.
- **Speed and cost barely move.** Median latency went from 319 ms to 458 ms. Tokens grow by
  about 130 per rule, which is under $0.001 per check at 100 rules.
- **Splitting doesn't help.** Parallel requests of 10 rules each were slower and used 37% more
  tokens, because each request resends the code. Keep one request per edit.

So the budget is set by **noise and attention**, not by Jev:
- every rule adds its own false-alarm rate on clean edits;
- every extra finding competes for the agent's attention.

Propose up to **12 repo rules per language**, and give each a `when` gate so most edits
ask only a handful. Best-practice candidates count toward the budget; the built-in packs don't.

**Don't under-propose.** The budget limits noise, but it is not a target to stay far below. In
evaluations on real repos, the common failure was stopping at 4–8 rules while
well-documented conventions went unproposed. Include every candidate that:
- has A-grade evidence (a written team convention, or a recurring review theme);
- passes the gates;

up to the budget. Rank by the cost of a miss: security, data loss or money first, then
correctness, then consistency. If more candidates qualify than fit, list the rest under
**Next candidates** in the proposal, with their evidence, so the user can swap them in.
Leave out ideas that fail a gate even when the budget has room.

## 5. Propose, and wait for approval

Present the proposal using [references/proposal.md](references/proposal.md). It has:
- the digest;
- the rules to add, each with its source and why a linter can't do it;
- the best-practice rules;
- linter config changes;
- the dropped ideas and why.

**Write nothing to `.jev-lint/` until the user approves the list.** Apply edits they make to
it.

## 6. Write, label, validate

1. **Write the approved rules** to `.jev-lint/<language>.rules.json`. Use `repo-` id prefixes and a `when` gate on each; add `paths` globs when a convention only holds in some folders or file types. Add `config.json` for `packs`, `disable` or `skipPaths` if the proposal needs it. Write each one with the `jev-lint-write-rule` skill ([good-rule.md](../jev-lint-write-rule/references/good-rule.md)).
2. **Write `.jev-lint/cases.jsonl`** with a script, following [evaluate.md](../jev-lint-write-rule/references/evaluate.md). Each rule needs at least 3 positives and 2 hard negatives, plus at least 5 clean snippets in the repo's style. Labels must be complete.
3. **Validate:** `bun $JEV/src/validate.ts .jev-lint`, which exits 1 until every rule is `keep`.
   - Reword a failing rule at most twice, then drop it.
   - Never relabel a case just to make a rule pass.
   - Hold back a few cases until the wording is final, then add them and re-run.
4. **Write `.jev-lint/README.md`** with:
   - the rules and their sources;
   - the dropped ideas and why;
   - the validation table;
   - a dated changelog entry.

## 7. Hand off

- **Trigger one real finding:** make an edit that breaks a rule and confirm the hook flags it.
- **Report to the user:**
  - the rules kept per language;
  - what was dropped and why;
  - the validation table;
  - the proposed linter config changes;
  - that code from each matching edit is sent to TypeSafe.
- **Don't commit** unless asked.
- **Point to the `jev-lint-learn` skill** for tuning once the findings log has a week or two of sessions.
