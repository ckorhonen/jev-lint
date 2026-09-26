---
name: jev-lint-rules
description: Generate repo-specific jev-lint rules from a repository's own coding guidelines (AGENTS.md, CLAUDE.md, .cursor/rules, .github/copilot-instructions.md, CONTRIBUTING, style guides, agent skills), keep only the ones a fast snippet-level judge can check, write labeled examples, and validate them against Jev before enabling them. Use right after installing the jev-lint hook in a repo, when a repo's guidelines change, or when asked to "generate lint rules from our coding rules".
---

# Generate jev-lint rules from a repo's guidelines

The jev-lint hook (`~/Repos/jev-lint`) checks the code each agent edit adds, one quick
Jev call per edit. It loads built-in packs plus any rules in the nearest `.jev-lint/`
directory. This skill writes that directory for the current repo.

The goal is a **small set of rules that are rarely wrong**, not full coverage. A rule
that nags on correct code teaches the agent to ignore the hook.

## 1. Collect the guidelines

**Read, in this order**, whichever of these exist:
- `AGENTS.md` and `CLAUDE.md`, at the root and in subdirectories;
- `.cursor/rules/*`, `.cursorrules`, `.github/copilot-instructions.md`;
- `CONTRIBUTING*`, `docs/*style*`, `docs/*conventions*`, ADRs;
- `.claude/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`, `.codex/skills/*`;
- lint configs (`.eslintrc*`, `eslint.config.*`, `biome.json`, `.swiftlint.yml`).

The lint configs are only there so you **skip** anything already enforced deterministically.

**Also note the languages and frameworks actually used**, from the file extensions and package manifests.

## 2. Turn guidelines into candidate rules

**Split each guideline into the smallest separate checks.** For each check, keep it only if **all** of these hold:
1. **It's visible in the added code alone.** No other files, callers, git history, runtime behaviour or product knowledge needed.
2. **It's one concrete pattern, stated literally.** The judge answers the words, not the intent.
3. **It needs no counting or tracing.** Skip "more than N levels" and "every caller must…".
4. **No existing linter rule already enforces it.**
5. **Breaking it matters to this team.** The guideline says so, or it's a real bug risk.

**Drop everything else,** and list what you dropped and why in `.jev-lint/README.md`. That list is valuable too: it shows which guidelines need a real linter, a test, or a human reviewer.

**Aim for 5–12 rules per language.** The built-in `practices` pack already covers React effects and state, unvalidated JSON, SwiftUI state ownership, retain cycles and continuation misuse. Don't duplicate those; set `config.json` `packs` if the repo wants only its own rules.

## 3. Write the rule files

Create `.jev-lint/<language>.rules.json`:

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
      "fix": "Move the query into a function in src/services/ and call that from the route (per CONTRIBUTING.md)."
    }
  ]
}
```

Writing rules that work:
- **Start every question with "Does `added_code` …"** and name the exact APIs, keywords or shapes.
- **Put the exceptions in `false`:** the look-alikes that are fine, and "or the code does not do X at all".
- **Make the `true` and `false` criteria say the same thing as the question.** Never phrase them as opposites of it.
- **Prefix ids with `repo-`** so they never collide with built-in rules.
- **Write `fix` as one imperative sentence** that cites the guideline source; the agent sees it.
- **Optionally add `.jev-lint/config.json`,** e.g. `{ "packs": ["repo", "practices"] }`. By default the hook uses hygiene + practices + repo.

## 4. Write labeled examples

Create `.jev-lint/cases.jsonl`. Each line is:

```json
{"id":"c01","file_path":"src/routes/users.ts","code":"<the added code>","labels":["repo-no-direct-db-in-routes"]}
```

- **Per rule:** at least 3 positives, plus at least 2 hard negatives that look similar but follow the `false` criteria.
- **Add 5 or more clean, realistic snippets** in the repo's own style. Adapt real code from the repo when you can.
- **Labels must be complete:** list every repo rule that the snippet breaks.
- **Generate the file with a script** (json.dumps / JSON.stringify), never by hand-escaping.

## 5. Validate and iterate

```sh
bun ~/Repos/jev-lint/src/validate.ts .jev-lint
```

The validator gives each rule one of three verdicts: `keep`, `reword-or-drop`, or `needs-cases`. It exits 1 until every rule is `keep`.
- **Reword:** a failing rule usually needs its pattern named more literally, or a missing exception added to `false`.
- **Two tries at most,** then drop the rule and record why in `.jev-lint/README.md`.
- **Don't edit labels to make a rule pass**, unless the label was actually wrong.
- **Hold out a few cases** until the wording is final, then add them and re-run. That checks the rule generalizes rather than fitting the examples you tuned on.

## 6. Finish

- **Commit `.jev-lint/`:** the rules, `cases.jsonl`, `README.md`, and the optional `config.json`.
- **Tell the user:**
  - how many rules were kept, per language;
  - what was dropped and why;
  - the validation table;
  - that snippets of edited code are sent to TypeSafe on every edit to matching files.
- **Hand-check the hook** by making an edit that breaks a rule. Run with `JEV_LINT_LOG=/tmp/jev.jsonl` and read the log.
