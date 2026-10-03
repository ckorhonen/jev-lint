# Cloudflare Clef comparison — 2 October 2026

## Question and setup (fixed before running)

Can Cloudflare Clef or Clef-flash replace TypeSafe Jev for these snippet-level lint
rules without increasing false alarms or unacceptable latency?

- Judges: TypeSafe `jev-1.13.0`, Workers AI `@cf/cloudflare/clef` and
  `@cf/cloudflare/clef-flash`. These Cloudflare IDs are not immutable version pins.
- Cases: the existing 2,089 holdout edits across all seven languages and five built-in
  packs. Candidate rules are included by the existing eval harness; no rule wording changed.
- Policies: fixed thresholds 0.8 (fix) and 0.5 (fix + double-check); no holdout tuning.
- Repeats: three per hosted judge, same cases and rule text. Each judge has a separate
  cache keyed by model, rules and payload. Clear the relevant gitignored cache directories
  before a fresh service-latency experiment; otherwise timings reflect earlier cached calls.
- Metrics: precision, recall, F1, clean-edit false alarms, p50/p90 latency, tokens,
  errors, per pack/language, and repeated-run F1. Inspect errors before interpreting accuracy:
  the existing scorer skips failed calls, so incomplete runs cannot establish parity.
- Gate: each hosted judge receives every rule in the case's pack; gated accuracy is
  computed by masking those scores. This does not measure gated hook latency.

## Status

**Live comparison blocked, not measured.** The comparison command was attempted on
2 October 2026 and stopped before inference because the environment has no configured
Cloudflare account/token. No TypeSafe key is configured either. No hosted results
were produced or substituted with mocks, and earlier evidence was preserved.

The client was checked against Cloudflare's published
[Clef request/response schema](https://developers.cloudflare.com/workers-ai/models/clef/).
Regression tests cover both models, the REST envelope, malformed/missing answers,
64-question batching, usage aggregation, retries/deadlines, token files,
installer/recheck configuration, and provider/account/token daemon isolation.
These are protocol tests, not model accuracy measurements, and they use mocked
responses: as of 3 October 2026 the adapter has not been run against the live
Workers AI endpoint (a Workers AI API token is needed; wrangler's OAuth session is
rejected with 401).

The credential-free regex holdout baseline ran successfully with zero API errors:

| Language (hygiene pack) | Edits scored | Precision | Recall | F1 | Clean-edit false alarms |
| --- | ---: | ---: | ---: | ---: | ---: |
| swift | 66 | 96.4% | 50.0% | 65.9% | 4.2% |
| typescript | 66 | 96.2% | 53.2% | 68.5% | 3.4% |

Source: [`regex-cloudflare-integration-2026-10-02.json`](../eval/results/snapshots/regex-cloudflare-integration-2026-10-02.json).
The runner loaded 2,089 holdout cases; regex supports only hygiene, so the table
covers that subset. It does not compare Clef and Jev.

## Reproduce the hosted comparison

Configure both providers' credentials as described in the
[README](../README.md#cloudflare-clef-optional), then:

```sh
JEV_LINT_MODEL=jev-1.13.0 bun eval/run.ts --systems jev,clef,clef-flash \
  --splits holdout --runs 3 --out cloudflare-comparison-2026-10-02.json
```

Use a new output name for each experiment. All three judges use the same payloads,
questions and scoring. No OpenAI key is needed for this comparison. The selected
systems pin their providers explicitly, even when the hook environment selects Clef.
Do not set `TYPESAFE_BASE_URL` to a local server for a hosted Jev comparison.

Report hosted results per pack/language and check coverage before recommending a
provider. Follow with a separate gate-on hook latency run if the accuracy is acceptable;
then an E2E agent run before claiming fewer violations or review savings. Synthetic
labels and a small number of repeats limit generalization. Compare billed usage at
current provider rates; do not apply Jev's price to Clef tokens.

**Recommendation:** keep TypeSafe as the default. Clef is available as an optional,
experimental mode until the same-case hosted evaluation can establish its tradeoffs.
