# Best-practice rule candidates

The built-in packs in `rules/*.json` already cover TypeScript/React (`typescript.practices.json`) and Swift/SwiftUI (`swift.practices.json`). Don't duplicate them.

The files here are a menu of **candidates**: `python.md`, `go.md`, `rust.md`, `kotlin.md`, `ruby.md`, `lua.md`, and `generic.md` for patterns that apply in most languages.

- **Test validity is a default.** Every language menu ends with a `*-test-cannot-fail` candidate. Propose it whenever the repo has tests; it's built in for TypeScript and Swift already.
- **Propose, don't install.** Offer a candidate only if the repo uses the language and libraries it names and its `Skip if:` line doesn't apply (for example, when the repo's linter config already enforces the check).
- **Validate every one.** Copy the ones you pick into `.jev-lint/<language>.rules.json`, renaming the id prefix to `repo-`. Write labeled cases for each (3+ positives, 2+ hard negatives), run `src/validate.ts`, and keep only rules that get `keep`.
- **One version per rule.** When a language file and `generic.md` both have a version, use the language-specific one.
- **Record what you drop.** List dropped candidates and the reason in `.jev-lint/README.md`, alongside the team's own dropped guidelines.
