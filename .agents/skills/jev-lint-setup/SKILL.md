---
name: jev-lint-setup
description: Install and verify the jev-lint hook for Claude Code and/or Codex, then onboard the current repo's rules. Use when asked to set up, install, enable, update or check jev-lint.
---

# Set up jev-lint

The hook checks agent edits against best-practice rules using the selected provider.
After-write checks fail open; optional Claude Code `--pre` can block high-confidence findings.

## 1. Locate the checkout

Reuse the checkout supplied by the user or an existing known checkout. Otherwise ask
which parent folder they want to use before cloning
`https://github.com/ckorhonen/jev-lint`; do not prescribe a home-directory location.
From the chosen parent folder:

```sh
git clone https://github.com/ckorhonen/jev-lint
cd jev-lint
bun install
```

Run subsequent commands from the checkout. Bun is required; if missing, tell the
user to install it. Do not install it yourself.

## 2. Choose the provider and inspect existing credentials

Use `bun src/setup.ts` for guided setup. It offers TypeSafe Jev (default),
Cloudflare Clef (`clef` by default), and OpenAI Decisions (`gpt-6-luna` by default),
previews a local installer dry run, and asks before `--apply`. Pass installer options
such as `--claude-only`, `--codex-only`, `--project <repo>`, `--pre`, `--async`, or
`--skills` when the requested scope is already known.

Credentials must already exist; never create, read aloud, print, or persist secret
values in hook configs:

- TypeSafe: `TYPESAFE_API_KEY`, private mode-600 `~/.config/jev-lint/api-key`
  (override with `TYPESAFE_API_KEY_FILE`), or macOS Keychain service `typesafe-api-key`.
- Cloudflare: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or a private
  mode-600 `CLOUDFLARE_API_TOKEN_FILE`; set `JEV_LINT_PROVIDER=cloudflare` and
  `JEV_LINT_MODEL=clef` (or `clef-flash`).
- OpenAI: `OPENAI_API_KEY` or a private mode-600 `OPENAI_API_KEY_FILE`; set
  `JEV_LINT_PROVIDER=openai` and `JEV_LINT_MODEL=gpt-6-luna`.

If credentials are missing, report the missing variable or credential location and
ask the user to supply it themselves. Setup does not make model requests. Provider
billing and transmission approval are specific to that provider; approval for
Cloudflare does not authorize OpenAI. Do not claim Jev measurements for other providers.

## 3. Preview and apply

Manual setup remains available:

```sh
bun src/install.ts --skills
```

This local dry run reports credential presence (never the value), hook changes,
Codex's hooks feature flag, and proposed skill links. It makes no API request.
Resolve scope only when the user's request has not settled it:

- Claude Code, Codex, or both (default).
- User-wide (default), or `--project <absolute-repo-path>` for Claude Code only.
- After-write (default), or Claude Code `--pre` to block high-confidence findings.
- Synchronous (default), or Claude Code `--async` for background checks.

Show the concrete changes and obtain confirmation before applying:

```sh
bun src/install.ts --apply --skills
# Add the selected --claude-only, --codex-only, --project, --pre, or --async options.
```

The installer also adds Stop/SubagentStop rechecks (`--no-recheck` skips them).
It backs up changed files as `*.bak-jev-lint-<time>` and replaces only jev-lint
entries, preserving other hooks. `--skills` links into the supported user skill directories.
Codex requires `[features] hooks = true` in `~/.codex/config.toml`; the installer
reports but does not edit TOML. Show the needed setting and explain that the next
session asks the user to trust the hook.

If any command is denied, report the exact command and stated reason. Separately
propose the local setup work that remains possible within allowed permissions.
Never bypass a denial, expand a broad Bash allowlist, or bypass hook trust.

## 4. Optional network verification

`bun src/install.ts --smoke` is opt-in REAL NETWORK verification. It sends synthetic
fixture code and rule questions to the selected provider and may incur charges.
Ask for explicit provider-specific transmission and billing approval unless already
granted. Respect execution approval failures. An empty `catch` must be flagged;
report errors and failed checks accurately. A successful local install is not proof
of a successful model check. Do not run evals as part of setup.

## 5. Updates, rollback, and handoff

For an authorized upgrade, run `bun src/install.ts --upgrade` from the existing
checkout. It pulls, installs dependencies, and reapplies the existing mode; report
the printed commit range. Do not add `--smoke` without network approval.

Report changed files, backup paths, selected provider/model and scope, and whether
network verification was skipped, passed, or failed. Installed hooks send added
edit code, whole files for Writes, and current file content for end-of-turn rechecks,
plus file context and rule questions, to the selected provider. Findings are logged
locally at `~/.local/state/jev-lint/findings.jsonl`; `JEV_LINT_FINDINGS_LOG=off` disables it.
To turn hooks off, remove jev-lint entries or restore the corresponding backups,
keeping other hooks intact.

Then use **jev-lint-rules** in the target repo to read instructions, skills, docs
and linter configs and propose rules before writing approved changes. After a week
or two, **jev-lint-learn** can use findings to propose evidence-backed improvements.
See [README](../../../../README.md) for all installer and provider options.
