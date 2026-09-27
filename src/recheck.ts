#!/usr/bin/env bun
// End-of-turn re-check for the learning loop. Runs as a Stop (or SubagentStop) hook in Claude
// Code and Codex. For every file this conversation edited whose last check still had findings,
// it asks just those rules again against the file as it is now, and logs the result. That gives
// every finding an outcome (fixed or kept) even when the agent never touched the file again,
// which otherwise leaves most findings "unknown" and starves jev-lint-learn of evidence.
//
// Fails open like the main hook: it prints nothing, always exits 0, and is time-bounded.
// Env: JEV_LINT_RECHECK=off disables it; JEV_LINT_FINDINGS_LOG as for the hook.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadRecords } from "./findings";
import { appendRecords, type CheckRecord, findingsLogPath, toErrorRecords, toRecords } from "./findingsLog";
import { lintChange } from "./lint";

const MAX_FILES = 8; // two parallel batches, so a worst case stays under the hook timeout
const MAX_PARALLEL = 4;
const TIMEOUT_MS = 8000;
const MAX_FILE_CHARS = 24_000;
const LOOKBACK_MS = 24 * 60 * 60_000;

type StopEvent = { hook_event_name?: string; session_id?: string; agent_id?: string; cwd?: string };

// Files whose latest check in this conversation (or this subagent) still has findings.
export function unresolved(records: CheckRecord[], event: StopEvent, now = Date.now()) {
  const latest = new Map<string, CheckRecord>();
  for (const r of records) {
    if (r.session !== event.session_id || r.error) continue;
    if (event.agent_id && r.agent !== event.agent_id) continue; // SubagentStop: only that subagent's files
    if (now - Date.parse(r.ts) > LOOKBACK_MS) continue;
    const key = `${r.agent ?? ""}|${r.repo}|${r.file}`;
    const prev = latest.get(key);
    if (!prev || prev.ts <= r.ts) latest.set(key, r);
  }
  // A file whose latest record is already a re-check has its outcome; re-check only after new edits.
  return [...latest.values()].filter((r) => r.flagged.length > 0 && r.tool !== "recheck").slice(0, MAX_FILES);
}

async function main() {
  if (process.env.JEV_LINT_RECHECK === "off") return;
  const parsed: unknown = JSON.parse(await Bun.stdin.text());
  const event = (parsed && typeof parsed === "object" ? parsed : {}) as StopEvent;
  if (typeof event.session_id !== "string" || (event.agent_id !== undefined && typeof event.agent_id !== "string")) return;
  const log = findingsLogPath();
  if (!log || !existsSync(log)) return;
  const records = loadRecords(log, { days: 1 }); // validated records only
  const targets = unresolved(records, event);
  for (let i = 0; i < targets.length; i += MAX_PARALLEL) {
    const batch = targets.slice(i, i + MAX_PARALLEL);
    await Promise.all(
      batch.map(async (last) => {
        const path = isAbsolute(last.file) ? last.file : join(last.repo, last.file);
        if (!existsSync(path)) return; // deleted since: nothing left to judge
        const code = readFileSync(path, "utf8");
        if (!code.trim() || code.length > MAX_FILE_CHARS) return;
        const change = { filePath: path, addedCode: code, changeKind: "recheck" as const };
        const ids = { session_id: event.session_id, agent_id: last.agent, tool_name: "recheck", cwd: last.repo };
        try {
          const result = await lintChange(change, { timeoutMs: TIMEOUT_MS, cwd: last.repo, onlyRules: last.flagged.map((f) => f.rule) });
          if (result) appendRecords(toRecords([result], [change], ids));
        } catch (error) {
          appendRecords(toErrorRecords([{ change, error }], ids));
        }
      }),
    );
  }
}

if (import.meta.main) {
  main()
    .catch((err) => {
      if (process.env.JEV_LINT_DEBUG) process.stderr.write(`[jev-lint recheck] ${err}\n`);
    })
    .finally(() => process.exit(0));
}
