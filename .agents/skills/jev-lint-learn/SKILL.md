---
name: jev-lint-learn
description: Turn the jev-lint hook's findings log into improvements for a specific repo. Add upfront guidance to AGENTS.md/CLAUDE.md for mistakes agents keep making and fixing, reword or drop .jev-lint rules that agents keep ignoring (likely false positives), and propose new rules. Use when asked what the lint hook has been catching, to "learn from lint findings", to tune a repo's jev-lint rules, or periodically (for example weekly) on an active repo.
---

# Learn from jev-lint findings

The hook appends one line per checked file to `~/.local/state/jev-lint/findings.jsonl`
(`JEV_LINT_FINDINGS_LOG` overrides; `off` disables). Each line records the repo, the file,
the rules that fired with their tier, and a short excerpt of flagged code. This skill turns
that log into small, reviewed changes for one repo.

## 1. Summarize

```sh
bun ~/Repos/jev-lint/src/findings.ts --repo <repo root> --days 30          # table
bun ~/Repos/jev-lint/src/findings.ts --repo <repo root> --days 30 --json   # with excerpts
```

**Outcome per finding** (one per session, file and rule):
- **fixed:** the next check of that file no longer flags it. The agent made the mistake and corrected it.
- **kept:** it was still flagged at the file's last check. The agent disagreed or ignored the hint.
- **unknown:** the file was never checked again.

**Suggestion column** (needs at least 3 events):
- `add-guidance` means fixes recurred across at least 2 sessions.
- `review-rule` means at least half of the decided outcomes were `kept`.
- `watch` means everything else. Don't act on it yet.

## 2. Act on each suggestion

**`add-guidance`: the agent keeps making this mistake.**
- **Write one concrete line** in the repo's `AGENTS.md` (or `CLAUDE.md` if that's what the repo uses), in the section closest to the topic. Phrase it as the positive practice and cite the pattern, e.g. "Parse API responses with the zod schemas in `src/schemas/` before use; don't cast `res.json()`." Use the excerpts to make it specific to this repo.
- **Keep the rule.** The guidance prevents the mistake; the rule still catches it.

**`review-rule`: the agent keeps ignoring it.** Read the `kept` excerpts yourself.
- **The flag is wrong** (a false positive): reword the rule.
  1. Add the look-alike pattern to the rule's `false` criteria.
  2. Add that excerpt as a hard negative in `.jev-lint/cases.jsonl`, or in the jev-lint repo's `eval/cases/` for a built-in rule.
  3. Re-validate with `bun ~/Repos/jev-lint/src/validate.ts .jev-lint`.
- **The flag is right but the agent ignores it:** make the rule's `fix` text more specific, and add guidance to AGENTS.md.
- **The repo doesn't want this rule:** drop it, or narrow the packs in `.jev-lint/config.json`.

**New rule candidates:** look for repeated fixes the agent made by hand, or recurring AI-review comments on this repo. If one is snippet-checkable, hand off to the `jev-lint-rules` skill to write and validate it.

## 3. Guardrails

- **Evidence, not one-offs.** Don't change instructions based on fewer than 3 events or a single session.
- **Built-in rules** (`rules/*.json` in jev-lint) are shared across repos. Fix them in the jev-lint repo with the `jev-lint-eval` workflow: dev-only rewording, then holdout numbers. Never edit them as a repo-specific tweak.
- **Show the user the proposed diffs** (AGENTS.md lines, rule changes, validation table) before applying them. Instruction files are shared team context.
- **Record every change** in `.jev-lint/README.md` under a dated changelog entry: what changed, the evidence (counts and outcomes), and the validation result.
- **Excerpts are code from the repo.** Keep them local; don't paste them into issues or external tools.
