# Decisions integration and pending comparison

Contract checked October 6, 2026 against the official [guide](https://developers.openai.com/api/docs/guides/decisions)
and [create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).
This continues archived task `01a0fcb0-52db-75b8-8289-41ce92251013` and
[PR #2](https://github.com/ckorhonen/jev-lint/pull/2) (now merged), which added
optional Clef/Clef-flash. The pending Decisions implementation commitment is
fulfilled locally; live comparison remains pending explicit approval. Chris's
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
No live paid calls, credential creation/grants, terms acceptance, deployment or
private source transmission were performed for this implementation. Prior
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
Publication remains pending verified authorization; GitHub push/admin access alone
is not publication consent. Live OpenAI smoke/comparison remains approval-gated.
