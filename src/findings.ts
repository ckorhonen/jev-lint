#!/usr/bin/env bun
// Summarize the hook's findings log so it can be fed back into a repo's instructions.
//   bun ~/Repos/jev-lint/src/findings.ts [--repo <path>] [--days 30] [--json]
//
// For every finding (session, file, rule) the outcome is:
//   fixed   — a later check of the same file in the same session no longer flags the rule
//   kept    — the file was checked again and the rule was still flagged at the last check
//   unknown — the file was never checked again in that session
// "fixed" means the agent made the mistake and corrected it: worth upfront guidance in
// AGENTS.md so it stops happening. "kept" means the agent disagreed or ignored the hint:
// a likely false positive, or a rule that needs rewording.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type CheckRecord, findingsLogPath } from "./findingsLog";

export type RuleSummary = {
  rule: string;
  flags: number;
  high: number;
  medium: number;
  sessions: number;
  files: number;
  fixed: number;
  kept: number;
  unknown: number;
  suggestion: "add-guidance" | "review-rule" | "watch";
  excerpts: { file: string; outcome: "fixed" | "kept" | "unknown"; p: number; excerpt: string }[];
};

// Thresholds for a suggestion: enough evidence across sessions, not one noisy afternoon.
const MIN_EVENTS = 3;
const MIN_SESSIONS = 2;
const MS_PER_DAY = 86_400_000;

function isCheckRecord(value: unknown): value is CheckRecord {
  const r = value as CheckRecord;
  return Boolean(r && typeof r.ts === "string" && typeof r.repo === "string" && typeof r.file === "string" && Array.isArray(r.flagged));
}

export function summarize(records: CheckRecord[]): RuleSummary[] {
  const byThread = new Map<string, CheckRecord[]>();
  for (const r of records) {
    const key = `${r.session ?? "?"}|${r.repo}|${r.file}`;
    byThread.set(key, [...(byThread.get(key) ?? []), r]);
  }

  const rules = new Map<string, RuleSummary & { _sessions: Set<string>; _files: Set<string> }>();
  const get = (rule: string) => {
    let s = rules.get(rule);
    if (!s) {
      s = {
        rule,
        flags: 0,
        high: 0,
        medium: 0,
        sessions: 0,
        files: 0,
        fixed: 0,
        kept: 0,
        unknown: 0,
        suggestion: "watch",
        excerpts: [],
        _sessions: new Set(),
        _files: new Set(),
      };
      rules.set(rule, s);
    }
    return s;
  };

  for (const [key, checks] of byThread) {
    checks.sort((a, b) => a.ts.localeCompare(b.ts));
    const [session] = key.split("|");
    // One outcome per (thread, rule): judged from the first flag onward.
    const firstFlag = new Map<string, number>();
    checks.forEach((c, i) => {
      for (const f of c.flagged) {
        const s = get(f.rule);
        s.flags++;
        s[f.tier]++;
        if (!firstFlag.has(f.rule)) firstFlag.set(f.rule, i);
      }
    });
    for (const [rule, index] of firstFlag) {
      const s = get(rule);
      s._sessions.add(session);
      s._files.add(`${checks[index].repo}|${checks[index].file}`);
      const last = checks[checks.length - 1];
      const outcome = index === checks.length - 1 ? "unknown" : last.flagged.some((f) => f.rule === rule) ? "kept" : "fixed";
      s[outcome]++;
      const hit = checks[index].flagged.find((f) => f.rule === rule);
      s.excerpts.push({ file: checks[index].file, outcome, p: hit?.p ?? 0, excerpt: checks[index].excerpt ?? "" });
    }
  }

  return [...rules.values()]
    .map(({ _sessions, _files, ...s }) => {
      const sessions = _sessions.size;
      const decided = s.fixed + s.kept;
      let suggestion: RuleSummary["suggestion"] = "watch";
      if (s.kept >= MIN_EVENTS && s.kept / Math.max(decided, 1) >= 0.5) suggestion = "review-rule";
      else if (s.fixed >= MIN_EVENTS && sessions >= MIN_SESSIONS) suggestion = "add-guidance";
      return { ...s, sessions, files: _files.size, suggestion, excerpts: s.excerpts.slice(-5) };
    })
    .sort((a, b) => b.flags - a.flags);
}

export function loadRecords(path: string, filter: { repo?: string; days?: number }): CheckRecord[] {
  if (!existsSync(path)) return [];
  const since = filter.days ? Date.now() - filter.days * MS_PER_DAY : 0;
  const repo = filter.repo ? resolve(filter.repo) : undefined;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isCheckRecord(parsed) ? [parsed] : [];
      } catch {
        return []; // a truncated or corrupt line is skipped, not fatal
      }
    })
    .filter((r) => (!repo || r.repo === repo) && Date.parse(r.ts) >= since);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      days: { type: "string", default: "30" },
      json: { type: "boolean", default: false },
      log: { type: "string" },
    },
  });
  const path = values.log ?? findingsLogPath();
  if (!path) throw new Error("findings log is disabled (JEV_LINT_FINDINGS_LOG=off)");
  const records = loadRecords(path, { repo: values.repo, days: Number(values.days) });
  const summary = summarize(records);
  if (values.json) {
    console.log(JSON.stringify({ log: path, checks: records.length, rules: summary }, null, 2));
  } else {
    console.log(`${records.length} checks in ${path}${values.repo ? ` for ${resolve(values.repo)}` : ""} (last ${values.days} days)`);
    console.log("rule                                    flags  high  med  sessions  fixed  kept  unknown  suggestion");
    for (const s of summary) {
      console.log(
        `${s.rule.padEnd(40)}${String(s.flags).padStart(5)}${String(s.high).padStart(6)}${String(s.medium).padStart(5)}${String(s.sessions).padStart(10)}${String(s.fixed).padStart(7)}${String(s.kept).padStart(6)}${String(s.unknown).padStart(9)}  ${s.suggestion}`,
      );
    }
  }
}
