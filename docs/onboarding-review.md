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
The parent subsequently confirmed its direct visual inspection satisfies screenshot
review: the image showed assistant guidance, no actual host denial or reaper reference.

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

Initial static review also noted a preexisting check/unlink race when two starters
recover the same stale lock. The first published revision documented it as unmodified;
the lifecycle follow-up below addresses it.
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

## Lifecycle follow-up

The old recovery sequence allowed starter A and starter B to read the same dead PID.
A could unlink that stale lock and create its own; B would then unlink A's fresh lock
based on its earlier observation. Both could believe they owned the daemon socket.
Rechecking the inode before unlink would still leave a check-to-unlink window.

`src/daemonLock.ts` now uses an exclusive, short-lived `<socket>.lock.guard` directory
for every ownership transaction. Stale-owner inspection, removal, fresh lock creation,
and stale socket cleanup share the guard. Shutdown uses the same guard and checks both
lock inode and PID before removing its socket, stamp, or lock. A contender that cannot
acquire the guard changes no ownership files. Liveness probes send only signal 0;
permission errors never establish that an owner is dead. No process is terminated.

This favors safety over automatic cleanup: a crash while holding the guard may leave
it abandoned. It is never automatically deleted. The optional daemon then cannot start
for that configuration until an operator verifies ownership and performs explicit
cleanup; hooks continue in process. A lock PID reused by an unrelated live process also
causes conservative refusal to start, rather than signalling that process.

Focused regressions cover deterministic competing recovery, startup/shutdown exclusion,
successor preservation, abandoned guards, permission errors, exception cleanup, and
six real concurrent subprocesses recovering one stale lock (exactly one owner).
The updated full suite passed: 184 tests, 1,091 assertions, 18 files. Type checking and
Biome passed; the same 12 preexisting warnings remain. No live provider calls occurred.
Independent read-only review found no blockers and passed all seven new ownership
tests (32 assertions), including the six-process election. A local Unix-socket probe
also confirmed that `server.stop(true)` leaves its socket for guarded removal on the
installed Bun runtime. No merge or deployment was performed.
