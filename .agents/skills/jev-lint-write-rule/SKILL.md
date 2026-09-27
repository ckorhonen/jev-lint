---
name: jev-lint-write-rule
description: Write, improve or evaluate a single jev-lint rule. Covers what makes a rule Jev can judge well, where the evidence for a rule comes from (team docs, review comments, the findings log, official framework docs researched on the web), writing labeled cases, and validating before enabling. Use when drafting a new rule, rewording a noisy or missed one, turning a guideline or best practice into a rule, or deciding whether an idea should be a rule at all. The jev-lint-rules and jev-lint-learn skills hand off here.
---

# Write and evaluate one jev-lint rule

A jev-lint rule is one yes/no question that Jev answers about the code an agent just added,
in about 0.3 s. The hook shows findings to the agent as it works. A good rule is **right
almost every time it fires**, catches something that matters, and needs Jev: a linter can't
express it. A rule that nags on correct code teaches agents to ignore every finding.

`JEV` is the jev-lint checkout (the directory holding `src/hook.ts`, usually `~/Repos/jev-lint`).

## 1. Is it worth a rule? (Decide before writing anything)

The idea needs evidence that it matters: a written convention, recurring review comments,
repeated findings, or authoritative guidance for the stack. Find and grade that evidence
with [references/sources.md](references/sources.md). Then it must pass every gate:

| Gate | Fails when | Send it to |
|---|---|---|
| Visible in the added code alone | needs other files, callers, history, runtime or config | a test, a type, a reviewer |
| One concrete pattern | "write clean code", "follow SOLID" | drop it, or split it into concrete patterns |
| No counting or tracing | "more than N", "every caller", nesting depth | a linter (`max-depth`, `complexity`) |
| Not deterministic | a regex or AST rule could do it exactly | the repo's linter config |
| Not already enforced | the repo's linter or type checker blocks it | nothing; it's covered |
| Rarely ambiguous | reasonable engineers would disagree on many snippets | guidance in AGENTS.md instead |

If an idea fails a gate, say where it should go instead. That is a useful result too.

## 2. Write it

Follow [references/good-rule.md](references/good-rule.md) for the file shape and wording:
- **The question** starts "Does `added_code` …" and names the exact APIs or shapes to look for.
- **`false`** lists the look-alikes that are fine.
- **`fix`** is one imperative sentence that cites the source.
- **`when`** is a recall-safe gate.
- **`paths`** is optional, for conventions that only hold in some folders or file types.

## 3. Evaluate it

Follow [references/evaluate.md](references/evaluate.md):
1. **Write cases.** At least 3 positives and 2 hard negatives, taken from the rule's own `false` criteria, plus clean snippets in the codebase's style. Keep some aside as held-out cases.
2. **Validate** with `bun $JEV/src/validate.ts .jev-lint`. Reword at most twice, then drop the rule. Never relabel a case just to make the rule pass.
3. **Check the held-out cases** once the wording is final.
4. **Dry-run on real code** with `bun $JEV/src/check.ts <20 representative files>`. Every flag should be a real violation. One false alarm on accepted code means narrowing `false` or adding `paths`.
5. **After enabling,** measure with `bun $JEV/src/findings.ts --compare <rule> --at <date>` (see the jev-lint-learn skill).

Built-in rules (`$JEV/rules/*.json`) are shared across every repo. They need the fuller
`jev-lint-eval` workflow: dev and holdout splits from separate authors, and reporting holdout
numbers.

## 4. Record it

For a repo rule, add it to `.jev-lint/README.md` with:
- the source and its evidence grade;
- the validation table;
- the dry-run result;
- the date.

For a rejected idea, record where it went instead.
