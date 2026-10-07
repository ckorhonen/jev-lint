# Onboarding review — October 7, 2026

This follows the optional-provider work in [PR #2](https://github.com/ckorhonen/jev-lint/pull/2),
the Decisions integration in [PR #3](https://github.com/ckorhonen/jev-lint/pull/3), and its
credential-path follow-up in [PR #4](https://github.com/ckorhonen/jev-lint/pull/4).
Original archived integration task: `01a0fcb0-52db-75b8-8289-41ce92251013`.

## Setup changes

- Clone instructions use the user's chosen location or an existing checkout.
- `bun src/setup.ts` offers TypeSafe, Cloudflare Clef, and OpenAI Decisions;
  TypeSafe remains the default for a new install. Existing matching models are retained.
- Preview and apply run locally. No credential creation or model request occurs.
  `--smoke` remains a separate, explicitly authorized network operation.
- Guidance explains provider-specific credentials, later code transmission, normal
  permissions and hook trust, and backup/rollback paths. Expected setup errors are concise.
- Hook commands quote executable and checkout paths. Credential and project paths retain
  filesystem symlink/`..` semantics. Settings-file symlinks are refused during preview.
- Disabling rechecks removes owned Stop/SubagentStop commands while preserving other hooks.

The supplied Claude Code screenshot was described by the parent thread as assistant
guidance mixing local installation, network smoke, and permission expansion. This does
not establish a Claude host permission-dialog defect. This executor attempted current
Library materialization twice; both authorized downloads returned HTTP 403, so it did
not independently view the pixels. No permission bypass is proposed.

## Lifecycle investigation

There is no task-deletion subsystem in this repository. Its owned background process is
the optional daemon, which already uses private sockets, exclusive lock creation,
idle exit, bounded draining, source-change shutdown, and ownership checks during shutdown.
No arbitrary user tasks were deleted and no general reaper was introduced.

Previously, a check timeout followed by an unavailable health endpoint could SIGKILL the
PID in a lock file, remove ownership files, and respawn. A stale lock with a reused PID
could target an unrelated process. That recovery is removed: timeout checks fail open
without signals, file deletion, or forced spawning. A wedged daemon can persist until
its own shutdown or an explicitly verified owner restart. `JEV_LINT_DAEMON=off` remains
available to use in-process checks.

Static review also noted a preexisting check/unlink race when two starters recover the
same stale lock in `src/daemon.ts`. It was not reproduced and is outside this narrow
change; fresh concurrent-start behavior remains covered by the existing daemon suite.
Clarify which tasks the original "reaper" request meant before adding task cleanup.

## Validation

The full suite passed: 177 tests, 1,059 assertions, across 17 files. Type checking passed;
Biome passed with the same 12 preexisting warnings. Tests ran with real credentials
removed; requests were mocked or used local loopback servers. No live paid request,
new credential, external contact, deployment, or private-code model transmission occurred.

New regressions cover all providers, default selection and explicit confirmation,
preview failure, inherited model isolation, literal shell characters, unusual checkout
names, relative and symlink paths, backups/idempotence, unrelated-hook preservation,
recheck removal, and daemon ownership preservation. A separate read-only reviewer
verified the fixes and passed 30 focused tests with 113 assertions.
