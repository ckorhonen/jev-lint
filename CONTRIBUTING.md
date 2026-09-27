# Contributing to jev-lint

Thanks for helping. Contributions from people and from coding agents are both welcome. The
rules below apply to both; agents should also read [AGENTS.md](AGENTS.md).

## Quick start

```sh
git clone https://github.com/ckorhonen/jev-lint && cd jev-lint
bun install
bun test && bunx tsc --noEmit && bunx biome check .   # must pass before every PR
```

Evaluation runs that call Jev need a TypeSafe key (`TYPESAFE_API_KEY`, the macOS Keychain
item `typesafe-api-key`, or `~/.config/jev-lint/api-key`). Runs that use Luna as a judge need
`OPENAI_API_KEY`. Never commit either.

## What we look for

- **Small, focused PRs.** One change per PR, with the reason in the description.
- **The hook stays safe.** It must fail open: on any error it exits 0 and prints nothing but
  its JSON. It must stay fast; say what your change does to per-check latency.
- **Rules earn their place with evidence.** Use the
  [`jev-lint-write-rule`](.agents/skills/jev-lint-write-rule/SKILL.md) skill. A new built-in rule
  needs graded evidence (`rules/sources/`), labeled dev and holdout cases written independently,
  wording tuned on dev only, and held-out numbers that pass the bar in `src/validate.ts`. Add it
  as `"status": "candidate"`; it ships when `eval/pack-status.ts` says it passes.
- **Nothing a linter already does.** If ESLint, Biome, SwiftLint, ruff, clippy or similar can
  check it literally, it doesn't belong here.
- **Evidence is append-only.** Snapshot result files before regenerating them, and label
  replaced numbers "superseded" in the notebook instead of deleting them.
- **Docs move with behaviour.** Update the README, `docs/`, and the skills when behaviour
  changes. Regenerate the pack docs with `bun scripts/pack-docs.ts`.

## For coding agents

- Read [AGENTS.md](AGENTS.md) first. It has the layout, commands and hard rules.
- Use the repo's skills in `.agents/skills/`: `jev-lint-eval` for rules and evaluation,
  `jev-lint-write-rule` for a single rule.
- Don't invent results. If you didn't run it, say so in the PR.
- Keep private code out: no excerpts from other repos in cases, results or PR text.
- Use `bun`, and let Biome format (`bunx biome check --write <files>`).
- Fill in the PR template, including "How it was validated".

## Reporting issues

Open an issue with what you expected, what happened, and how to reproduce it. For a noisy or
wrong finding, include the rule id, a minimal snippet, and whether it was the `fix` or
`double-check` tier.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
