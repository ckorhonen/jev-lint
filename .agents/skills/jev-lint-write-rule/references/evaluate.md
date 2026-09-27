# Evaluating a rule

## Cases (`.jev-lint/cases.jsonl`)

Each line is `{"id","file_path","code","labels"}`, where `file_path` is repo-relative so any
`paths` globs apply.
- **Positives:** at least 3. Cover every pattern the question names, not just the easiest one.
- **Hard negatives:** at least 2, taken from the rule's `false` list. They should look like
  violations but aren't: a real assertion that resembles a tautology, a helper the repo uses
  correctly, the pattern inside the one folder where it's allowed.
- **Clean snippets:** at least 5 in the repo's style, preferably adapted from real repo code.
- **Complete labels:** each line lists every repo rule the snippet breaks.
- **Generate the file with a script** (`json.dumps` / `JSON.stringify`); never hand-escape.
- **Hold 1–2 positives and 1 negative out** until the wording is final.

## Validate

```sh
bun $JEV/src/validate.ts .jev-lint
```

A rule is `keep` only if all of these hold:
- precision is at least 90% at p ≥ 0.8;
- precision is at least 75% and recall at least 80% at p ≥ 0.5;
- its `when` gate and `paths` don't exclude any labeled positive;
- it has enough cases.

Otherwise the verdict is `reword-or-drop` or `needs-cases`.

**Rewording that works:**
- **It misses positives:** name the pattern more literally, and list the variants (`useEffect` *and* `useLayoutEffect`).
- **It fires on negatives:** add the look-alike to `false`, and name it exactly.
- **It overlaps another rule:** say in each rule which pattern belongs to the other.
- **It can't be fixed in two tries:** drop it and record why. Some ideas are just too
  ambiguous for a snippet judgment.

## Dry-run on real code

```sh
bun $JEV/src/check.ts $(git ls-files '<glob for the rule>' | head -20)
```

Read every flag. Accepted repo code that gets flagged is a false alarm the synthetic cases
missed. Fix it with `false`, `paths` or `.jev-lint/config.json` `skipPaths`, then add that
snippet as a hard negative.

## After enabling

The hook logs every finding. After 1–2 weeks, the `jev-lint-learn` skill tells you whether
agents fix the flags (the rule teaches) or keep them (likely noise). `findings.ts --compare`
shows whether a rule or guidance change moved the rate.

## Built-in rules

Rules in `$JEV/rules/*.json` affect every repo, so they use the `jev-lint-eval` workflow:
- labeled dev and holdout sets from separate authors, in `eval/cases/`;
- rewording on dev only;
- reporting holdout numbers, run-to-run consistency, and a comparison with the Luna baseline.
