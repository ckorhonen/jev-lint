# Where rules come from, and how much to trust each source

Every proposed rule cites its evidence. Grade it; a rule needs at least one **A** or two **B**.

| Grade | Source | How to get it |
|---|---|---|
| A | The team's written conventions: AGENTS.md/CLAUDE.md, skills, CONTRIBUTING, style guides, ADRs, review checklists | `bun $JEV/src/inventory.ts .`, then read every file |
| A | Recurring review comments on the repo | `gh api "repos/OWNER/REPO/pulls/comments?per_page=100&sort=created&direction=desc" --paginate` (last ~3 months), then cluster by theme. A theme counts if it recurs across 3 or more PRs and at least 2 reviewers or bot runs |
| A | jev-lint's findings log for the repo | the `jev-lint-learn` skill: clusters with at least 5 decided outcomes across at least 3 sessions |
| B | Official docs for the exact framework and version in use | web research, below |
| B | Security references: the OWASP Cheat Sheet Series and CWE entries for the stack | web research, below |
| B | Bug-fix history: the same fix repeated in `git log` (e.g. several `fix:` commits adding cleanup to effects) | `git log --since=6.months -i --grep=fix --stat`, then read the diffs of repeat themes |
| C | Widely used style guides (Google, Airbnb, Kotlin/Swift API guidelines) and maintainers' posts | web research |
| D | Blogs, listicles, "top 10 mistakes" articles, model memory | only to find leads; confirm with A–C before proposing |

## Web research for best practices

Do this for each framework the repo actually uses. Read the frameworks and versions from the
manifests: `package.json`, `Package.swift`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
`build.gradle*`, `Gemfile` and similar.

1. **Search the official docs** for the version in use, looking for pages about pitfalls,
   common mistakes, anti-patterns, "you might not need", migration or deprecation guides,
   and security. Prefer the vendor's own domain. A documentation MCP (such as Context7) is
   fine if available; otherwise use web search and fetch.
2. **Keep only guidance that is a concrete code pattern and passes the gates** in the skill.
   Most of a framework's advice is design advice and won't pass.
3. **Check it isn't already enforced.** Many official pitfalls already have a lint rule
   (react-hooks, `@next/eslint-plugin-next`, SwiftLint, clippy, ruff). If the repo runs that
   linter with the rule on, drop the idea. If it doesn't, propose turning the linter rule on
   instead.
4. **Cite the URL and the date you checked it**, e.g.
   `https://react.dev/learn/you-might-not-need-an-effect (checked 2026-09-27)`. Advice changes
   between major versions; note the version it applies to.
5. **If there's no network,** say so and fall back to the built-in packs and the
   `jev-lint-rules` best-practice menus. Don't present model memory as research.

Useful starting points. These are official unless noted; confirm each is current before citing it:
- **React:** react.dev "Escape hatches", especially "You Might Not Need an Effect", "Synchronizing with Effects" and "Rules of React".
- **Next.js:** the docs for your router (App or Pages): data fetching, caching, "use client"/"use server" boundaries, Server Actions security.
- **Vue:** the Style Guide (priority A and B rules) and the Reactivity docs.
- **TypeScript / Node:** the TypeScript Handbook; Node.js docs on streams, errors and security best practices.
- **Swift / SwiftUI:** Swift API Design Guidelines, Swift concurrency docs (Sendable, actors, cancellation), SwiftUI data flow and state ownership docs.
- **Python:** the Django, FastAPI or SQLAlchemy docs on security and performance pitfalls; `asyncio` "Developing with asyncio".
- **Go:** Effective Go, Go Code Review Comments, and the `context` package docs.
- **Rust:** Rust API Guidelines, the async book, Tokio docs on blocking.
- **Kotlin / Android:** coroutines best practices, and the Compose performance and state docs.
- **Security, any stack:** OWASP Cheat Sheets for input validation, injection, SSRF, path traversal, logging and secrets.

## Proposing from evidence

For each candidate, record:
- the evidence (with grade, link or file:line);
- which gate it passes and why;
- what a linter already covers nearby;
- the expected noise (how often correct code looks similar).

If the only evidence is D-grade, don't propose the rule.
