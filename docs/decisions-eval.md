# Decisions integration and pending comparison

Contract checked October 6, 2026 against the official [guide](https://developers.openai.com/api/docs/guides/decisions)
and [create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).
This continues archived task `01a0fcb0-52db-75b8-8289-41ce92251013` and
[PR #2](https://github.com/ckorhonen/jev-lint/pull/2) (now merged), which added
optional Clef/Clef-flash. The pending Decisions implementation commitment is
fulfilled; live comparison remains pending explicit approval. Chris's
production preference for Clef is preserved. The separate jevlint-app production
checkout is outside scope.

## Fixed comparison plan (not executed)

Question: how does Decisions compare with Jev and Clef on the same existing
snippet-level rule labels?

- Judges: `jev` (`jev-1.13.0`), `clef`, `clef-flash`, `decisions` (`gpt-6-luna`,
  POST /v1/decisions predicates). No undocumented reasoning setting is sent to
  Decisions. Each named judge forces its own provider/model.
- Packs/languages: all existing packs and languages supported by the harness.
- Split: existing holdout; three runs, no rule or label changes.
- Thresholds: 0.8 fix / 0.5 double-check, unchanged.
- Report precision, recall, F1, clean false alarms, latency, input tokens and
  errors by pack/language; record returned model IDs from judgment caches.
- Separate Decisions cache variant includes model, endpoint/adapter version,
  rule-text hash and payload hash. A refusal is an error, never a clean score.
- Gating is off in the harness; masked gated metrics do not measure production
  hook latency. Existing synthetic labels and service model aliases limit claims.

After explicit approval for OpenAI paid requests/code transmission and each
provider's existing credentials are available:

```sh
JEV_LINT_MODEL=jev-1.13.0 bun eval/run.ts --systems jev,clef,clef-flash,decisions \
  --splits holdout --runs 3 --out decisions-comparison-2026-10-06.json
```

Use a fresh output name if that file exists. Do not overwrite prior evidence.
No notebook numbers or recommendations change until results exist and are reviewed.
At the local implementation checkpoint, no live paid calls, credential
creation/grants, terms acceptance, deployment or private source transmission
had been performed. Prior
Cloudflare synthetic-eval approval is consumed and does not authorize OpenAI.

## Local validation receipt

- `bun test`: 142 passed, 0 failed, including 30 Decisions tests. Loopback
  mock-server tests ran outside the filesystem/network sandbox; no hosted calls.
- `bunx tsc --noEmit`: passed. E2E scaffold dependencies were prepared locally.
- `bunx biome check .`: passed with 12 existing warnings.
- Focused independent Sol 6.1 review found and resolved foreign-model inheritance
  in Jev comparisons, missing Decisions metric policies, and incomplete full-file
  recheck disclosure. 30 focused tests independently passed.
- Mocked Decisions harness smoke: 66 existing TypeScript hygiene holdout cases,
  zero errors; verified 0.8/0.5 policies, gated views, nine sweep points and bands.
  Fixed synthetic probabilities validate plumbing only, not model accuracy.

Original checkout/user untracked files and jevlint-app were not modified.
At the local implementation checkpoint, publication and live OpenAI verification
remained approval-gated. Subsequent owner approval and verification are below.

## Live smoke and publication receipt

The owner authorized pushing the reviewed branch, a draft PR, reuse of an
existing local OpenAI credential for a minimal synthetic smoke, and merge after
checks pass. Published as [PR #3](https://github.com/ckorhonen/jev-lint/pull/3).

A single no-retry live adapter request on October 6, 2026 evaluated the synthetic
sentence "The package arrived with a broken screen." with one predicate asking
whether the customer reports a damaged item. No repository code was sent.

- Passed: returned model `gpt-6-luna`, probability 0.99.
- Usage: 164 input tokens, zero output tokens.
- Observed client round-trip: 1,267 ms; this is one smoke, not a latency benchmark.
- Estimated base charge: $0.0000164 at the documented $0.10 per million input
  tokens ([Decisions pricing](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability)).
  This is not an invoice; regional/long-context modifiers may apply.
- Existing environment credential reused in memory; no credential creation,
  persistence, grants, payment setup or terms acceptance.

GitHub reported no CI checks or Actions runs for the implementation commit and
no branch protection on main; local validation passed (142 tests, types and lint
with 12 existing warnings). No live comparison, production deployment or X post
was performed by this task.

## Adversarial review follow-up

Review of merged PR #3 identified a relative `OPENAI_API_KEY_FILE` defect in
manual daemon configurations: the caller read the project-relative file, while
the daemon inherited the relative filename and resolved it from the home
directory. The same filename in different projects could share a daemon identity.
The follow-up resolves one absolute path consistently for identity and child
environment, without changing the caller environment or provider defaults.
Absolute paths are preserved verbatim and relative paths receive a caller-directory
prefix without collapsing `..`, preserving symlink traversal and credential choice.
Installer-generated plain absolute paths and environment keys were unaffected.
Regression tests use only temporary dummy keys and local child processes.

Follow-up validation: 147 tests passed; types passed; lint passed with the same
12 existing warnings. Independent Sol 6.1 adversarial re-review passed 35 focused
tests, including relative and absolute symlink/`..` child-process checks, with no
material findings remaining. No additional live API requests were made.

The review also reproduced an inherited evaluation-harness limitation: errored
judgments are excluded from scoring, so an all-error slice can display perfect
precision/recall/F1 with zero evaluated cases. Error totals cover only the first
run. This is outside the narrow credential-path fix; future comparisons must
report evaluated coverage and errors per slice/run before making performance
claims. No comparative Decisions performance claims are made here.
