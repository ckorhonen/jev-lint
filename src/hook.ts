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

import { appendFileSync } from "node:fs";
import { extractChanges } from "./extract";
import { appendRecords, toRecords } from "./findingsLog";
import { formatFeedback, type LintResult, lintChange } from "./lint";

const MAX_FILES = 8;
// 0 unless rewake mode has findings to deliver. Errors never change it: the hook fails open.
let exitCode = 0;
const MAX_PARALLEL = 4;

async function main() {
  const raw = await Bun.stdin.text();
  const event = JSON.parse(raw);
  if (event.hook_event_name && event.hook_event_name !== "PostToolUse") return;

  const tiers = new Set((process.env.JEV_LINT_TIERS ?? "high,medium").split(","));
  const timeoutMs = Number(process.env.JEV_LINT_TIMEOUT_MS ?? 8000);

  // A large multi-file patch must not fan out into dozens of API calls from one edit:
  // lint at most MAX_FILES files, MAX_PARALLEL at a time.
  const changes = extractChanges(event).slice(0, MAX_FILES);
  const settled: PromiseSettledResult<LintResult | undefined>[] = [];
  for (let i = 0; i < changes.length; i += MAX_PARALLEL) {
    const batch = changes.slice(i, i + MAX_PARALLEL);
    settled.push(...(await Promise.allSettled(batch.map((c) => lintChange(c, { timeoutMs, cwd: event.cwd })))));
  }
  const results = settled
    .flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []))
    .map((r): LintResult => ({ ...r, findings: r.findings.filter((f) => tiers.has(f.tier)) }));

  if (process.env.JEV_LINT_LOG) {
    const errors = settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason)] : []));
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
    appendRecords(toRecords(results, changes, event));
  } catch (err) {
    if (process.env.JEV_LINT_DEBUG) process.stderr.write(`[jev-lint] findings log: ${err}\n`);
  }
}

main()
  .catch((err) => {
    if (process.env.JEV_LINT_DEBUG) process.stderr.write(`[jev-lint] ${err}\n`);
  })
  .finally(() => process.exit(exitCode));
