# Writing jev-lint rules that work

## File shape

`.jev-lint/<language>.rules.json`:

```json
{
  "language": "typescript",
  "extensions": [".ts", ".tsx"],
  "rules": [
    {
      "id": "repo-no-direct-db-in-routes",
      "question": "Does `added_code` call the database client (`db.query`, `prisma.*`, `knex(...)`) directly inside an Express/Next route handler instead of going through a function from `src/services/`?",
      "true": "A route handler body calls the database client directly.",
      "false": "Route handlers only call service functions, or the code is not a route handler, or the database call is inside `src/services/` code itself.",
      "fix": "Move the query into a function in src/services/ and call that from the route (CONTRIBUTING.md, 'Layers').",
      "when": ["db\\.|prisma|knex"]
    }
  ]
}
```

Optional `.jev-lint/config.json`:

```json
{
  "packs": ["hygiene", "practices", "repo"],
  "disable": ["ts-no-magic-numbers"],
  "skipPaths": { "ts-unvalidated-external-data": ["src/providers/**"], "repo-no-shell-string": ["**/*.test.ts"] }
}
```

- **`packs`:** the default is hygiene + practices + repo. `JEV_LINT_PACKS` on the hook command overrides it.
- **`disable`:** turns off single rules, built-in or repo.
- **`skipPaths`:** a list of globs per rule id, matched against the path relative to the
  repo root (the directory holding `.jev-lint/`). The rule isn't asked for matching files.
  Use it to exempt an area from a rule, including a built-in one, such as tests.

## Scoping a rule to files: `paths`

A rule may list `paths` globs, relative to the repo root. It is then asked only for files
that match one of them, on top of its rule set's `extensions`:

```json
{ "id": "repo-routes-use-services", "paths": ["src/routes/**", "app/api/**/route.ts"], "...": "..." }
{ "id": "repo-client-components-no-server-imports", "paths": ["**/*.tsx"], "...": "..." }
```

Use `paths` when a convention only holds in one place, such as layer rules, a package with
its own conventions, or `.tsx`-only React rules in a `.ts`/`.tsx` rule set. It keeps the rule
out of edits where it can only produce false alarms, and makes it cheaper. Leave `paths` off
for repo-wide rules. In `cases.jsonl`, give `file_path` as the repo-relative path. The
validator fails a rule whose `paths` exclude one of its labeled positives.

## Wording

- **Open with "Does `added_code` …"** and name the exact APIs, keywords or shapes.
- **List the exceptions in `false`.** Name the look-alikes that are fine, and add "or the code does not do X at all".
- **Make `true` and `false` restate the question.** Neither should read as the opposite of it.
- **Handle overlaps explicitly.** When two rules overlap, say in each one which pattern belongs to the other.
- **Name idioms that aren't violations.** For example, `data` from a network call is not a vague name, and a named default parameter is not a boolean trap.
- **Write `fix` as one imperative sentence** that cites the source. The agent reads it mid-task.

## `when` gates

`when` is a list of case-insensitive regexes. The rule is asked only if one of them matches
the added code, and in practice about a third of rules get asked per edit.
- **Gate on what must appear** for the rule to apply: the API names, keywords or syntax.
- **Never trade recall for a narrower gate.** If you're unsure, widen it or leave it out.
- **Test every gate against every positive case.** The validator reports gated-out positives.

## What Jev is bad at (send these elsewhere)

- **Counting:** nesting depth, number of parameters, file length.
- **Tracing:** "every caller", data flow across functions, whether something is awaited somewhere else.
- **Needing other files:** whether an import exists, whether a type is exported, what a config says.
- **Pure syntax:** a regex or AST rule is cheaper and exact.

## Labeled cases (`.jev-lint/cases.jsonl`)

One JSON object per line: `{"id","file_path","code","labels"}`.
- **Per rule:** at least 3 positives and at least 2 hard negatives taken from the `false` criteria.
- **Clean snippets:** at least 5, in the repo's style. Adapting real repo code is best.
- **Complete labels:** each line lists every repo rule the snippet breaks.
- **Generate the file with a script** (`json.dumps` / `JSON.stringify`), not by hand-escaping.

## Validation verdicts

`bun $JEV/src/validate.ts .jev-lint`:
- `keep`: done.
- `reword-or-drop`: it misses positives or fires on negatives. Name the pattern more literally or add the missing exception. After two tries, drop it and record why.
- `needs-cases`: not enough positives or negatives to judge.

## Copying a best-practice candidate

Candidates in `best-practices/*.md` use language prefixes (`py-`, `go-`…). When adopting one:
- rename it to `repo-…`;
- adjust its `false` for the repo's idioms (its logger, its error type);
- check its `Skip if:` line against the coverage map;
- write cases for it like any other rule.
