---
name: jev-lint-learn
description: Analyze the jev-lint hook's findings log for one repo and make a few evidence-backed changes. Clusters findings by rule, repo area and test/non-test code, ranks the clusters by recurrence and cost, proposes targeted fixes (AGENTS.md guidance, rule rewording or exceptions, dropping a rule, a new rule), records each as a hypothesis, and later measures whether it worked. Use when asked what the lint hook has been catching, to learn from or tune jev-lint findings, or for a periodic (e.g. every two weeks) review of an active repo.
---

# Learn from jev-lint findings, with evidence

The hook appends one line per checked file to `~/.local/state/jev-lint/findings.jsonl`
(`JEV_LINT_FINDINGS_LOG` overrides it). Each line holds the repo, file, session, the rules
flagged with their tier, an excerpt, and the latency and tokens.

**The goal is a few changes that remove a recurring cost.** Don't add a line of guidance
for every flag. Each instruction you add dilutes the others, and each rule change risks new
noise. `JEV` is the jev-lint checkout (usually `~/Repos/jev-lint`).

## 1. Check there is enough data

```sh
bun $JEV/src/findings.ts --repo . --days 30
```

**Stop if the window has fewer than 5 sessions or 100 checks.** Report "not enough data yet"
and give the date to look again. Failed checks (timeouts, API errors) are listed separately.
If more than 5% failed, fix that first, because a failed check silently shows the agent
nothing.

What an outcome means, for each first flag of a rule in a (session, file) thread:

| Outcome | What happened | Cost |
|---|---|---|
| fixed | the file's next check no longer flags it | a rework loop that upfront guidance could prevent |
| kept | still flagged at the file's last check | noise, or a real issue the agent ignored |
| unknown | the file was never checked again | nothing learned |

## 2. Cluster

```sh
bun $JEV/src/findings.ts --repo . --days 30 --clusters
```

Clusters are rule × area (first two directories) × test/non-test. Columns:
- `sessions`: recurrence. This is what matters most; ten flags in one session is one bad afternoon.
- `per100`: findings per 100 checks of that area.
- `fixed` / `kept` / `unk`.
- `keptLB`: the Wilson 95% lower bound of kept / (fixed + kept).
- `action`: the script's suggestion.

A rule often splits into clusters that each need a different fix, so read them side by side.
For example, magic numbers kept in tests but fixed in source means the rule needs a test
exception, plus guidance only for source code.

## 3. Pick at most three clusters to act on

**A cluster qualifies only if it is `add-guidance` or `review-rule`.** That takes at least 5
decided outcomes across at least 3 sessions. `review-rule` also needs `keptLB ≥ 0.3`, so 4 of 5
kept is enough but 3 of 5 is not. `watch` means do nothing, even if the pattern looks
interesting.

**Rank the qualifying clusters by expected impact:**
- sessions affected × (fixed + kept) for the recurring cost;
- then how costly a miss is in this repo (security or data loss beats style).

**Read the excerpts** (`--json` includes them) of every cluster you act on. Read at least 5,
covering both fixed and kept. The numbers alone don't tell you *why* the agent kept a flag.

## 4. Choose the change that fits the cause

| Evidence | Likely cause | Change |
|---|---|---|
| Mostly `fixed`, many sessions | agent doesn't know the convention | one line in AGENTS.md/CLAUDE.md, in the closest section, stated as the positive practice with a repo-specific pointer ("Parse API responses with the zod schemas in `src/schemas/`") |
| Mostly `kept`, and the excerpts are correct code | false positive | add the look-alike to the rule's `false`, add the excerpt as a hard negative case, re-validate |
| Mostly `kept`, only in one area or only tests | rule doesn't fit that context | `.jev-lint/config.json` `"skipPaths": {"<rule>": ["<glob for that area>"]}` (or `paths` on a repo rule), or narrow the rule's `false` |
| Mostly `kept`, and the excerpts are real issues | agent ignores the hint | make `fix` more specific; if it still matters, add guidance |
| Repeated fixes the hook doesn't cover, or review comments | missing rule | hand off to the `jev-lint-rules` skill (proposal → validation) |

Built-in rules (`$JEV/rules/*.json`) are shared across repos. Change them only in the
jev-lint repo with the `jev-lint-eval` workflow: reword on the dev split, then check the
holdout. For a repo-specific exception, use `.jev-lint/config.json` (`disable` for one rule,
`skipPaths` for one area) or add a repo rule; never fork a built-in.

## 5. Propose, then apply what's approved

For each change show the user four things:
- the cluster row;
- 2–3 excerpts;
- the exact diff;
- a **hypothesis with a measurable prediction**, e.g. "`ts-no-magic-numbers` findings in `apps/tools` source drop from 5.0 to under 2 per 100 checks over the next 10 sessions".

Instruction files are shared team context, so apply only the approved changes. For rule
changes, re-run `bun $JEV/src/validate.ts .jev-lint` and require `keep`.

**Record it** in `.jev-lint/README.md` under a dated `## Changelog` entry:
- the change;
- the evidence (the cluster numbers);
- the hypothesis;
- the validation result.

## 6. Measure earlier changes

For each changelog hypothesis older than about 10 sessions:

```sh
bun $JEV/src/findings.ts --repo . --compare <rule> --at <ISO date of the change>
```

This reports findings per 100 checks before and after, with a session-bootstrap 95% CI.
- **The CI is below zero:** the change worked. Record it.
- **The CI crosses zero:** say so and keep watching. Don't claim success.
- **Still no effect after two windows:** revert or rethink the change. Guidance that doesn't
  change behavior is just more context to read.

## Guardrails

- **Don't count excerpts as evidence on their own.** They show why a cluster happened, but numbers decide what qualifies.
- **Keep excerpts local.** They are repo code, so don't paste them into issues or external tools.
- **Watch for confounders.** A new task type, a model change, or a rule wording change inside the window can move rates. Note the ones you know of next to each comparison.
