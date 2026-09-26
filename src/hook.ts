#!/usr/bin/env bun
// PostToolUse hook entry for Claude Code and Codex. Reads the hook event on stdin and
// feeds rule findings back to the agent. Fails open: any error exits 0 silently.
//
// Env: JEV_LINT_MODE=context (default, additionalContext) | block (decision: "block")
//      JEV_LINT_TIERS=high,medium (default) | high
//      JEV_LINT_LOG=/path/to/log.jsonl to record every judgment

import { appendFileSync } from "node:fs";
import { extractChanges } from "./extract";
import { formatFeedback, type LintResult, lintChange } from "./lint";

const MAX_FILES = 8;
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
  if (!feedback) return;

  const output =
    process.env.JEV_LINT_MODE === "block"
      ? { decision: "block", reason: feedback }
      : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: feedback } };
  process.stdout.write(JSON.stringify(output));
}

main()
  .catch((err) => {
    if (process.env.JEV_LINT_DEBUG) process.stderr.write(`[jev-lint] ${err}\n`);
  })
  .finally(() => process.exit(0));
