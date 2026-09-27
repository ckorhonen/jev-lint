---
name: jev-lint-setup
description: Install and verify the jev-lint hook (fast Jev best-practice checks on every agent edit) for Claude Code and/or Codex, then onboard the current repo's rules. Use when asked to set up, install, enable, update or check jev-lint, or when pointed at the jev-lint repository with a request to get it working.
---

# Set up jev-lint

The hook runs after each Write/Edit/MultiEdit (Claude Code) or apply_patch (Codex) and asks
TypeSafe's Jev a yes/no question per rule about the added code, in about 0.3 s. Findings go
back to the agent as context. It fails open: errors never block an edit.

## 1. Locate and prepare the checkout

`JEV` is the jev-lint checkout: this repo if you were pointed at it; otherwise
`~/Repos/jev-lint`. If neither exists, ask before cloning
`https://github.com/ckorhonen/jev-lint` there. Then run:

```sh
cd "$JEV" && bun install
```

You need [bun](https://bun.sh). If it's missing, tell the user to install it; don't install it yourself.

## 2. Check before changing anything

```sh
bun "$JEV/src/install.ts" --skills --smoke
```

This dry run writes nothing. It reports:
- **The TypeSafe key:** present or MISSING. It never prints the key.
- **Each hook config:** whether it would be `added`, `updated` or `unchanged`.
- **Codex's hooks feature flag.**
- **The skill links** it would create.
- **A real smoke check:** a file with an empty `catch` must come back flagged.

**If the key is missing,** ask the user to add it themselves. Don't handle the value.
- **macOS:** `security add-generic-password -a "$USER" -s typesafe-api-key -w`, which prompts for it.
- **Linux, or a Mac reached only over SSH** (where the Keychain is locked): a user-only file at `~/.config/jev-lint/api-key` (mode 600; override with `TYPESAFE_API_KEY_FILE`). The hook ignores a key file that others can read.
- **Or** `TYPESAFE_API_KEY` in the environment the agent runs in.

Then re-run the check.

## 3. Choose the scope with the user, then apply

Ask these only if the request didn't already settle them:
- **Agents:** Claude Code, Codex, or both (the default).
- **Where:** user-wide, which is the default and writes `~/.claude/settings.json` and `~/.codex/hooks.json`. Or this repo only, with `--project <repo>`, which is Claude Code only and writes `<repo>/.claude/settings.json` to share with the team.
- **Sync or async:** sync is the default; the agent waits about 0.3 s per edit. Async (`--async`) is Claude Code only: the check runs in the background and wakes the agent when it finds something. Use async for slow local judges or long edit bursts.

Then run:

```sh
bun "$JEV/src/install.ts" --apply [--claude-only|--codex-only] [--project <repo>] [--async] --skills --smoke
```

Besides the main hook, the installer adds the end-of-turn **re-check** on `Stop` and
`SubagentStop`, which gives the learning loop an outcome for every finding (`--no-recheck` skips
it). `--apply` backs up each file it changes (`*.bak-jev-lint-<time>`) and only replaces the
jev-lint entry, never other hooks. Running it again changes nothing.

**Codex:**
- `[features] hooks = true` must be in `~/.codex/config.toml`. The installer reports it but doesn't edit TOML; show the user the line to add.
- The next Codex session asks the user to trust the new hook. Say so.

## 4. Onboard the repo's rules

The built-in packs (TypeScript/React and Swift/SwiftUI hygiene and best practices) now work
everywhere. For team-specific rules, and packs for other languages, run the
**jev-lint-rules** skill in the target repo. It reads the repo's instructions, skills, docs
and linter configs, and proposes rules for approval before writing anything.

## 5. Tell the user

- **What changed:** the files and whether each was added or updated, where the backups are, and the smoke result.
- **Privacy:** the added code of each edit to a matching file is sent to TypeSafe. Findings are logged locally to `~/.local/state/jev-lint/findings.jsonl`; set `JEV_LINT_FINDINGS_LOG=off` to stop.
- **How to turn it off:** remove the jev-lint entry, or restore a backup.
- **After a week or two of use:** the **jev-lint-learn** skill turns the log into evidence-backed changes.
- **Options:** `$JEV/README.md` lists them all (packs, tiers, gating, modes, model).
