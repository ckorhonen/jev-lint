## What changed and why

<!-- One or two sentences. Link the issue or notebook entry if there is one. -->

## Type

- [ ] Hook / runtime (`src/`)
- [ ] Rules or rule packs (`rules/`, `.jev-lint/`)
- [ ] Eval harness or results (`eval/`)
- [ ] Skills or docs (`.agents/skills/`, `docs/`, README)
- [ ] Site (`site/`)

## Checklist

- [ ] `bun test && bunx tsc --noEmit && bunx biome check .` pass
- [ ] The hook still fails open: no new way for it to throw, block, print to stdout (other than its JSON), or exit non-zero
- [ ] **Rule changes:** reworded on the dev split only; held-out numbers reported; new built-in rules added as `"status": "candidate"` and shipped with `bun eval/pack-status.ts <holdout summary> --apply`
- [ ] **New or changed labeled cases:** generated with a script; dev and holdout written independently
- [ ] **Results:** earlier result files snapshotted to `eval/results/snapshots/` before being regenerated; replaced numbers labelled "superseded" in the notebook, not deleted
- [ ] **Docs:** README, `docs/packs/` (`bun scripts/pack-docs.ts`) and skills updated if behaviour changed
- [ ] No secrets, keys, or code from private repos in the diff (the pre-commit gitleaks hook passes)

## How it was validated

<!-- Commands run and their results. For rule or eval changes: the numbers, and on which split. -->

## Written by an agent?

<!-- If a coding agent made this change, say which one and paste the prompt or summary. It helps review. -->
