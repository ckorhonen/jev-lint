// Local log of what the hook checked and flagged, so recurring mistakes and ignored
// findings can be fed back into a repo's AGENTS.md and .jev-lint rules (see findings.ts
// and the jev-lint-learn skill).
//
// One JSON line per checked file:
//   {ts, session, repo, file, tool, changeKind, model, flagged: [{rule, p, tier}], excerpt?}
// `excerpt` (first 400 chars of the checked code) is kept only when something was flagged.
// Default path: ~/.local/state/jev-lint/findings.jsonl. JEV_LINT_FINDINGS_LOG=off disables it.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { ChangedFile } from "./extract";
import type { LintResult } from "./lint";

const EXCERPT_CHARS = 400;

export type CheckRecord = {
  ts: string;
  session?: string;
  repo: string;
  file: string;
  tool?: string;
  changeKind: ChangedFile["changeKind"];
  model: string;
  flagged: { rule: string; p: number; tier: "high" | "medium" }[];
  excerpt?: string;
  error?: string; // the check failed (timeout, API error); fail-open means the agent saw nothing
};

export function findingsLogPath(): string | undefined {
  const configured = process.env.JEV_LINT_FINDINGS_LOG;
  if (configured === "off") return undefined;
  return configured || join(homedir(), ".local/state/jev-lint/findings.jsonl");
}

// Nearest directory above the file that has .git or .jev-lint; otherwise the event cwd.
export function repoRoot(absoluteFile: string, fallback: string): string {
  let dir = dirname(absoluteFile);
  const { root } = parse(dir);
  for (;;) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".jev-lint"))) return dir;
    if (dir === root) return fallback;
    dir = dirname(dir);
  }
}

export function toRecords(
  results: LintResult[],
  changes: ChangedFile[],
  event: { session_id?: string; tool_name?: string; cwd?: string },
): CheckRecord[] {
  const cwd = event.cwd ?? process.cwd();
  return results.map((r) => {
    const absolute = isAbsolute(r.filePath) ? r.filePath : resolve(cwd, r.filePath);
    const repo = repoRoot(absolute, cwd);
    const flagged = r.findings.map((f) => ({ rule: f.ruleId, p: Number(f.probability.toFixed(3)), tier: f.tier }));
    const code = changes.find((c) => c.filePath === r.filePath)?.addedCode ?? "";
    return {
      ts: new Date().toISOString(),
      session: event.session_id,
      repo,
      file: relative(repo, absolute),
      tool: event.tool_name,
      changeKind: r.changeKind,
      model: r.model,
      flagged,
      ...(flagged.length ? { excerpt: code.slice(0, EXCERPT_CHARS) } : {}),
    };
  });
}

// Failed checks are logged too, so a silently failing hook shows up in the log instead of
// looking like "no edits".
export function toErrorRecords(
  failures: { change: ChangedFile; error: unknown }[],
  event: { session_id?: string; tool_name?: string; cwd?: string },
): CheckRecord[] {
  const cwd = event.cwd ?? process.cwd();
  return failures.map(({ change, error }) => {
    const absolute = isAbsolute(change.filePath) ? change.filePath : resolve(cwd, change.filePath);
    const repo = repoRoot(absolute, cwd);
    return {
      ts: new Date().toISOString(),
      session: event.session_id,
      repo,
      file: relative(repo, absolute),
      tool: event.tool_name,
      changeKind: change.changeKind,
      model: "error",
      flagged: [],
      error: String(error).slice(0, 300),
    };
  });
}

export function appendRecords(records: CheckRecord[], path = findingsLogPath()) {
  if (!path || !records.length) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}
