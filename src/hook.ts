#!/usr/bin/env bun
// PostToolUse hook entry for Claude Code and Codex. Reads the hook event on stdin and
// feeds rule findings back to the agent. Fails open: any error exits 0 silently.
//
// Env: JEV_LINT_MODE=context (default, additionalContext) | block (decision: "block")
//      | rewake: for Claude Code hooks with "asyncRewake": true — the hook runs in the
//        background; findings go to stderr with exit code 2, which wakes the agent with them.
//      JEV_LINT_TIERS=high,medium (default) | high
//      JEV_LINT_LOG=/path/to/log.jsonl to record every judgment (debug)
//      JEV_LINT_FINDINGS_LOG=path|off  findings log for feedback (default ~/.local/state/jev-lint/findings.jsonl)
//      JEV_LINT_DAEMON=off  always check in process instead of via the warm daemon (daemon.ts)

import { appendFileSync } from "node:fs";
import { MAX_FILES, runChecks, type Settled } from "./checks";
import { checkViaDaemon, daemonEnabled, startDaemon } from "./daemonClient";
import { extractChanges } from "./extract";
import { appendRecords, isInsideRepo, toErrorRecords, toRecords } from "./findingsLog";
import { formatFeedback, type LintResult } from "./lint";

// Below this, a fallback check can't finish anyway; record failures instead.
const MIN_FALLBACK_MS = 1000;
// 0 unless rewake mode has findings to deliver. Errors never change it: the hook fails open.
let exitCode = 0;

async function main() {
  const raw = await Bun.stdin.text();
  const event = JSON.parse(raw);
  if (event.hook_event_name && event.hook_event_name !== "PostToolUse") return;

  const tiers = new Set((process.env.JEV_LINT_TIERS ?? "high,medium").split(","));
  const timeoutMs = Number(process.env.JEV_LINT_TIMEOUT_MS ?? 8000);

  // Skip files outside the working repo (scratchpad and /tmp debug scripts): printing and
  // throwaway code are the point there, and real-world logs showed them as pure noise.
  const cwd = event.cwd ?? process.cwd();
  const changes = extractChanges(event)
    .filter((c) => isInsideRepo(c.filePath, cwd))
    .slice(0, MAX_FILES);
  if (!changes.length) return;

  // Prefer the warm daemon; if it isn't there, start one for next time and check in process.
  // One deadline covers both, so falling back after a failed daemon call can't double the wait.
  const deadline = Date.now() + timeoutMs;
  let settled: Settled[] | undefined = daemonEnabled() ? await checkViaDaemon(changes, { timeoutMs, cwd }) : undefined;
  if (!settled) {
    if (daemonEnabled()) startDaemon();
    const remaining = deadline - Date.now();
    settled =
      remaining >= MIN_FALLBACK_MS
        ? await runChecks(changes, { timeoutMs: remaining, cwd })
        : changes.map(() => ({ ok: false as const, error: "no time left after daemon failure" }));
  }
  const results = settled
    .flatMap((s) => (s.ok && s.value ? [s.value] : []))
    .map((r): LintResult => ({ ...r, findings: r.findings.filter((f) => tiers.has(f.tier)) }));

  if (process.env.JEV_LINT_LOG) {
    const errors = settled.flatMap((s) => (s.ok ? [] : [s.error]));
    appendFileSync(
      process.env.JEV_LINT_LOG,
      `${JSON.stringify({ ts: new Date().toISOString(), tool: event.tool_name, session: event.session_id, results, errors })}\n`,
    );
  }

  const feedback = formatFeedback(results);
  if (feedback && process.env.JEV_LINT_MODE === "rewake") {
    process.stderr.write(feedback);
    exitCode = 2;
  } else if (feedback) {
    const output =
      process.env.JEV_LINT_MODE === "block"
        ? { decision: "block", reason: feedback }
        : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: feedback } };
    process.stdout.write(JSON.stringify(output));
  }

  // Clean checks are logged too: a later clean check of the same file is how a finding
  // counts as fixed. Logging must never affect the agent, so errors are swallowed.
  try {
    const failures = settled.flatMap((s, i) => (s.ok ? [] : [{ change: changes[i], error: s.error }]));
    appendRecords([...toRecords(results, changes, event), ...toErrorRecords(failures, event)]);
  } catch (err) {
    if (process.env.JEV_LINT_DEBUG) process.stderr.write(`[jev-lint] findings log: ${err}\n`);
  }
}

main()
  .catch((err) => {
    if (process.env.JEV_LINT_DEBUG) process.stderr.write(`[jev-lint] ${err}\n`);
  })
  .finally(() => process.exit(exitCode));
