#!/usr/bin/env bun
// Stop/SubagentStop rechecks pending warnings against the current whole file.
// Fails open like the main hook: it prints nothing, always exits 0, and is time-bounded.
// Env: JEV_LINT_RECHECK=off disables it; JEV_LINT_FINDINGS_LOG as for the hook.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadRecords } from "./findings";
import { appendRecords, type CheckRecord, findingsLogPath, toErrorRecords, toRecords } from "./findingsLog";
import { lintChange } from "./lint";
import { trackedFiles } from "./outcomes";

const MAX_FILES = 8; // two parallel batches, so a worst case stays under the hook timeout
const MAX_PARALLEL = 4;
const TIMEOUT_MS = 8000;
const MAX_FILE_CHARS = 24_000;
const LOOKBACK_MS = 24 * 60 * 60_000;

type StopEvent = { hook_event_name?: string; session_id?: string; agent_id?: string; cwd?: string };

// Pending rules survive unrelated edits in the same file and agent thread.
export function unresolved(records: CheckRecord[], event: StopEvent, now = Date.now()) {
  const recent = records.filter(
    (r) => r.session === event.session_id && (!event.agent_id || r.agent === event.agent_id) && now - Date.parse(r.ts) <= LOOKBACK_MS,
  );
  return trackedFiles(recent)
    .flatMap(({ latestEdit, warnings }) => {
      const rules = [...warnings.values()].filter((warning) => warning.pending).map((warning) => warning.hit.rule);
      return rules.length ? [{ ...latestEdit, rules }] : [];
    })
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, MAX_FILES);
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
          const result = await lintChange(change, { timeoutMs: TIMEOUT_MS, cwd: last.repo, onlyRules: last.rules });
          if (result) {
            const [record] = toRecords([result], [change], ids);
            appendRecords([{ ...record, checkedRules: Object.keys(result.probabilities), recheckOf: last.ts }]);
          }
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
