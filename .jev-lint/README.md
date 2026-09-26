# Repo rules for jev-lint

Generated from this repo's `AGENTS.md` with the `jev-lint-rules` skill. They're validated with
`bun src/validate.ts .jev-lint` (all rules must report `keep`).

| Rule | Source |
| --- | --- |
| `repo-hook-stdout-noise` | AGENTS.md: hook stdout must stay clean JSON |
| `repo-hook-must-fail-open` | AGENTS.md: hook safety, fail open |
| `repo-judge-model-luna` | AGENTS.md: LLM judging uses gpt-6-luna |
| `repo-judge-effort-low` | AGENTS.md: LLM judging uses reasoning_effort low (split from the model rule after validation: the combined "or" wording missed 1 of 3) |

Guidelines not turned into rules (a linter, test, or reviewer is the better check):

| Guideline | Why not |
| --- | --- |
| Evidence is append-only (snapshot before regenerating) | It's about a workflow across files, so the snippet can't show it. |
| Tune wording on dev only; report holdout | It's a process rule, not a code pattern. |
| Use bun, not npm | This is in shell commands and docs, not TS code; the review catches it. |
| Never commit `.env` | `.gitignore` and gitleaks already enforce it. |
