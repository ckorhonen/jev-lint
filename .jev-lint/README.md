# Repo rules for jev-lint

Generated from this repo's `AGENTS.md` with the `jev-lint-rules` skill. They're validated with
`bun src/validate.ts .jev-lint` (all rules must report `keep`).

| Rule | Source |
| --- | --- |
| `repo-hook-stdout-noise` | AGENTS.md: hook stdout must stay clean JSON |
| `repo-hook-must-fail-open` | AGENTS.md: hook safety, fail open |
| `repo-judge-model-luna` | AGENTS.md: LLM judging uses gpt-6-luna |
| `repo-judge-effort-low` | AGENTS.md: LLM judging uses reasoning_effort low (split from the model rule after validation: the combined "or" wording missed 1 of 3) |

## `config.json`

- `ts-no-empty-catch` is skipped under `src/`: the hook, daemon and key lookups swallow errors
  on purpose (fail open, AGENTS.md). In a week of use that rule was kept 9 times and fixed once
  here, all in `src/`.

Guidelines not turned into rules (a linter, test, or reviewer is the better check):

| Guideline | Why not |
| --- | --- |
| Evidence is append-only (snapshot before regenerating) | It's about a workflow across files, so the snippet can't show it. |
| Tune wording on dev only; report holdout | It's a process rule, not a code pattern. |
| Use bun, not npm | This is in shell commands and docs, not TS code; the review catches it. |
| Never commit `.env` | `.gitignore` and gitleaks already enforce it. |

## Changelog

- 2026-09-26: `repo-hook-stdout-noise` narrowed to the hook's runtime files. It flagged `console.log` in the `src/findings.ts` CLI at p=0.93, which the agent (correctly) kept, so it was a false positive. Added two CLI hard negatives and re-validated.
