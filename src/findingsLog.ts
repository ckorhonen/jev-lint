// Local log of what the hook checked and flagged, so recurring mistakes and ignored
// findings can be fed back into a repo's AGENTS.md and .jev-lint rules (see findings.ts
// and the jev-lint-learn skill).
//
// One JSON line per checked file:
//   {ts, session, agent?, repo, file, tool, changeKind, model, flagged: [{rule, p, tier}], excerpt?}
// `session` is the hook's session_id. Claude Code and Codex both give subagents the root
// conversation's session_id and add `agent_id` (Codex: the subagent's own thread id), so
// `agent` is what tells a subagent's edits apart from its parent's.
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
  agent?: string; // hook agent_id: set only when the edit was made inside a subagent
  repo: string;
  file: string;
  tool?: string;
  changeKind: ChangedFile["changeKind"];
  model: string;
  flagged: { rule: string; p: number; tier: "high" | "medium" }[];
  excerpt?: string;
  error?: string; // the check failed (timeout, API error); fail-open means the agent saw nothing
  latencyMs?: number; // time for the judge call
  inputTokens?: number; // judge input tokens (Jev bills input only)
  asked?: number; // rules sent to the judge after the gate
  gatedOut?: number; // rules skipped by their `when` patterns
};

// Findings log, daemon sockets and pre-mode denials live here. XDG_STATE_HOME lets tests
// (and non-standard setups) keep them out of the real state directory.
export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "jev-lint");
}

export function findingsLogPath(): string | undefined {
  const configured = process.env.JEV_LINT_FINDINGS_LOG;
  if (configured === "off") return undefined;
  return configured || join(stateDir(), "findings.jsonl");
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

// A file counts as part of the work when it sits under the repo that contains the session's
// cwd (or the cwd itself when there is no repo). Files elsewhere, such as scratchpads, are skipped.
export function isInsideRepo(filePath: string, cwd: string): boolean {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const root = repoRoot(join(cwd, "_"), cwd);
  const rel = relative(root, absolute);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

type HookIds = { session_id?: string; agent_id?: string; tool_name?: string; cwd?: string };

export function toRecords(results: LintResult[], changes: ChangedFile[], event: HookIds): CheckRecord[] {
  const cwd = event.cwd ?? process.cwd();
  return results.map((r) => {
    const absolute = isAbsolute(r.filePath) ? r.filePath : resolve(cwd, r.filePath);
    const repo = repoRoot(absolute, cwd);
    const flagged = r.findings.map((f) => ({ rule: f.ruleId, p: Number(f.probability.toFixed(3)), tier: f.tier }));
    const code = changes.find((c) => c.filePath === r.filePath)?.addedCode ?? "";
    return {
      ts: new Date().toISOString(),
      session: event.session_id,
      ...(event.agent_id ? { agent: event.agent_id } : {}),
      repo,
      file: relative(repo, absolute),
      tool: event.tool_name,
      changeKind: r.changeKind,
      model: r.model,
      flagged,
      latencyMs: Math.round(r.latencyMs),
      inputTokens: r.inputTokens,
      asked: r.asked,
      gatedOut: r.gatedOut,
      ...(flagged.length ? { excerpt: code.slice(0, EXCERPT_CHARS) } : {}),
    };
  });
}

// Failed checks are logged too, so a silently failing hook shows up in the log instead of
// looking like "no edits".
export function toErrorRecords(failures: { change: ChangedFile; error: unknown }[], event: HookIds): CheckRecord[] {
  const cwd = event.cwd ?? process.cwd();
  return failures.map(({ change, error }) => {
    const absolute = isAbsolute(change.filePath) ? change.filePath : resolve(cwd, change.filePath);
    const repo = repoRoot(absolute, cwd);
    return {
      ts: new Date().toISOString(),
      session: event.session_id,
      ...(event.agent_id ? { agent: event.agent_id } : {}),
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
