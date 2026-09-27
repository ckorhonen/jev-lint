# Proposal template

Present this to the user before writing anything. Keep each line short and cite the source
(`file:line`) so the user can check it quickly.

```markdown
## jev-lint proposal for <repo>

**Read:** <N> files, <M> lines (instructions <a>, skills <b>, docs <c>, linter configs <d>, CI <e>).
**Languages:** <language> <files>, …   **Built-in packs:** hygiene + practices (TS/React, Swift) | none apply

### What the team values
- <convention>. Source: <file:line>
- …

### Already enforced (so not proposed)
- <idea> is covered by <tool rule>, which CI blocks on (<workflow:line>)
- …

### Rules to add (<k> of budget 8–12 per language)
| id | checks | evidence (grade) | why not a linter | when gate | paths |
|---|---|---|---|---|---|
| repo-… | <one line> | AGENTS.md:42 (A); 4 PRs of review comments (A) | needs intent: … | `useEffect` | `src/components/**` or all |

### Best practices for <frameworks/languages>
| id | checks | evidence (URL + date checked, or menu) | why here | skip-if checked |
|---|---|---|---|---|
| repo-… | <one line> | https://react.dev/learn/you-might-not-need-an-effect (checked <date>, React <version>) | … | react-hooks plugin has no rule for it |

Research: <frameworks and versions researched, or "no network: used built-in menus only">

### Next candidates (qualified, over budget)
- repo-… (<one line>). Evidence: <file:line (A)>. Why it ranked lower: <reason>.

### Linter config changes instead (not Jev)
- Enable <rule> in <config>. Reason: <guideline> is literal and syntactic.

### Dropped
- "<guideline>". Reason: needs other files / counting / already covered / too vague to judge.

### Privacy
The added code of every edit to <extensions> files is sent to TypeSafe for judging.

Approve, edit or remove rows, and I'll write the rules, labeled cases, and validation.
```
