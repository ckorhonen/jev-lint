#!/usr/bin/env bun
// Summarize the hook's findings log so it can be fed back into a repo's instructions.
//   bun ~/Repos/jev-lint/src/findings.ts [--repo <path>] [--days 30] [--json]
//   bun ~/Repos/jev-lint/src/findings.ts --repo <path> --clusters          # rule × area × test/non-test
//   bun ~/Repos/jev-lint/src/findings.ts --repo <path> --compare <rule> --at <ISO date>
//
// For every finding (session, file, rule) the outcome is:
//   fixed   — a later check of the same file in the same session no longer flags the rule
//   kept    — the file was checked again and the rule was still flagged at the last check
//   unknown — the file was never checked again in that session
// "fixed" means the agent made the mistake and corrected it: worth upfront guidance in
// AGENTS.md so it stops happening. "kept" means the agent disagreed or ignored the hint:
// a likely false positive, or a rule that needs rewording.

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
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
// review-rule also needs the Wilson 95% lower bound of the kept share to clear KEPT_LOWER,
// so 3 of 5 ignored is not enough but 4 of 5 is.
const MIN_EVENTS = 5;
const MIN_SESSIONS = 3;
const KEPT_LOWER = 0.3;
const MS_PER_DAY = 86_400_000;

function isCheckRecord(value: unknown): value is CheckRecord {
  const r = value as CheckRecord;
  return Boolean(r && typeof r.ts === "string" && typeof r.repo === "string" && typeof r.file === "string" && Array.isArray(r.flagged));
}

export function summarize(allRecords: CheckRecord[]): RuleSummary[] {
  const records = allRecords.filter((r) => !r.error);
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
      if (decided >= MIN_EVENTS && wilsonLower(s.kept, decided) >= KEPT_LOWER) suggestion = "review-rule";
      else if (s.fixed >= MIN_EVENTS && sessions >= MIN_SESSIONS) suggestion = "add-guidance";
      return { ...s, sessions, files: _files.size, suggestion, excerpts: s.excerpts.slice(-5) };
    })
    .sort((a, b) => b.flags - a.flags);
}

// Wilson score interval lower bound (95%) for k successes in n trials.
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - margin) / denom;
}

const TEST_FILE = /(\.|_)(test|spec)s?\.|__tests__\/|(^|\/)tests?\/|Tests\//;

// Where in the repo a file sits: its first two directories, plus whether it is a test.
export function areaOf(repo: string, file: string): { area: string; test: boolean } {
  const rel = isAbsolute(file) ? relative(repo, file) : file; // Codex logs repo-relative paths
  const dir = dirname(rel);
  return { area: dir === "." ? "(root)" : dir.split("/").slice(0, 2).join("/"), test: TEST_FILE.test(rel) };
}

// One finding = the first flag of a rule in a (session, file) thread, with its outcome.
type Finding = { rule: string; session: string; repo: string; file: string; ts: string; outcome: "fixed" | "kept" | "unknown" };

export function findingsOf(allRecords: CheckRecord[]): Finding[] {
  const byThread = new Map<string, CheckRecord[]>();
  for (const r of allRecords.filter((r) => !r.error)) {
    const key = `${r.session ?? "?"}|${r.repo}|${r.file}`;
    byThread.set(key, [...(byThread.get(key) ?? []), r]);
  }
  const out: Finding[] = [];
  for (const checks of byThread.values()) {
    checks.sort((a, b) => a.ts.localeCompare(b.ts));
    const last = checks[checks.length - 1];
    const seen = new Set<string>();
    checks.forEach((c, i) => {
      for (const f of c.flagged) {
        if (seen.has(f.rule)) continue;
        seen.add(f.rule);
        const outcome = i === checks.length - 1 ? "unknown" : last.flagged.some((g) => g.rule === f.rule) ? "kept" : "fixed";
        out.push({ rule: f.rule, session: c.session ?? "?", repo: c.repo, file: c.file, ts: c.ts, outcome });
      }
    });
  }
  return out;
}

export type Cluster = {
  rule: string;
  area: string;
  test: boolean;
  findings: number;
  sessions: number;
  files: number;
  fixed: number;
  kept: number;
  unknown: number;
  per100Checks: number; // findings per 100 checks of files in the same area and test/non-test group
  keptLower: number; // Wilson 95% lower bound of kept / (fixed + kept)
  action: "add-guidance" | "review-rule" | "watch";
};

// Group findings by rule × repo area × test/non-test. A rule that is noisy only in tests, or a
// mistake that only happens in one package, is a different fix than a repo-wide pattern.
export function clusters(records: CheckRecord[]): Cluster[] {
  const exposure = new Map<string, number>();
  for (const r of records.filter((r) => !r.error)) {
    const { area, test } = areaOf(r.repo, r.file);
    exposure.set(`${area}|${test}`, (exposure.get(`${area}|${test}`) ?? 0) + 1);
  }
  const groups = new Map<string, Finding[]>();
  for (const f of findingsOf(records)) {
    const { area, test } = areaOf(f.repo, f.file);
    const key = `${f.rule}|${area}|${test}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.entries()]
    .map(([key, fs]) => {
      const [rule, area, test] = key.split("|");
      const count = (o: Finding["outcome"]) => fs.filter((f) => f.outcome === o).length;
      const fixed = count("fixed");
      const kept = count("kept");
      const sessions = new Set(fs.map((f) => f.session)).size;
      const keptLower = wilsonLower(kept, fixed + kept);
      let action: Cluster["action"] = "watch";
      if (fixed + kept >= MIN_EVENTS && keptLower >= KEPT_LOWER) action = "review-rule";
      else if (fixed >= MIN_EVENTS && sessions >= MIN_SESSIONS) action = "add-guidance";
      return {
        rule,
        area,
        test: test === "true",
        findings: fs.length,
        sessions,
        files: new Set(fs.map((f) => f.file)).size,
        fixed,
        kept,
        unknown: count("unknown"),
        per100Checks: (100 * fs.length) / (exposure.get(`${area}|${test}`) ?? fs.length),
        keptLower,
        action,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || b.findings - a.findings);
}

export type Comparison = {
  rule: string;
  at: string;
  before: { sessions: number; checks: number; findings: number; per100Checks: number; fixed: number; kept: number };
  after: { sessions: number; checks: number; findings: number; per100Checks: number; fixed: number; kept: number };
  diffPer100: number;
  ci95: [number, number]; // session-level bootstrap of the after − before difference
};

// Did a change (new guidance line, reworded rule) reduce how often the rule fires? Exposure is
// checks of files with the extensions the rule has ever flagged; sessions are the resampling
// unit because checks within one session are not independent.
export function compare(records: CheckRecord[], rule: string, at: string, reps = 2000, seed = 1): Comparison {
  const ok = records.filter((r) => !r.error);
  const exts = new Set(
    findingsOf(ok)
      .filter((f) => f.rule === rule)
      .map((f) => extname(f.file)),
  );
  const exposed = ok.filter((r) => exts.has(extname(r.file)));
  const cut = Date.parse(at);
  const perSession = (rs: CheckRecord[]) => {
    const found = findingsOf(rs).filter((f) => f.rule === rule);
    const sessions = [...new Set(rs.map((r) => r.session ?? "?"))];
    return sessions.map((s) => ({
      checks: rs.filter((r) => (r.session ?? "?") === s).length,
      findings: found.filter((f) => f.session === s),
    }));
  };
  const side = (rs: CheckRecord[]) => {
    const ss = perSession(rs);
    const checks = ss.reduce((n, s) => n + s.checks, 0);
    const fs = ss.flatMap((s) => s.findings);
    return {
      ss,
      stats: {
        sessions: ss.length,
        checks,
        findings: fs.length,
        per100Checks: checks ? (100 * fs.length) / checks : 0,
        fixed: fs.filter((f) => f.outcome === "fixed").length,
        kept: fs.filter((f) => f.outcome === "kept").length,
      },
    };
  };
  const before = side(exposed.filter((r) => Date.parse(r.ts) < cut));
  const after = side(exposed.filter((r) => Date.parse(r.ts) >= cut));
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  const resampledRate = (ss: typeof before.ss) => {
    let checks = 0;
    let found = 0;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[Math.floor(rand() * ss.length)];
      checks += s.checks;
      found += s.findings.length;
    }
    return checks ? (100 * found) / checks : 0;
  };
  const diffs: number[] = [];
  if (before.ss.length && after.ss.length) {
    for (let i = 0; i < reps; i++) diffs.push(resampledRate(after.ss) - resampledRate(before.ss));
    diffs.sort((a, b) => a - b);
  }
  return {
    rule,
    at,
    before: before.stats,
    after: after.stats,
    diffPer100: after.stats.per100Checks - before.stats.per100Checks,
    ci95: diffs.length ? [diffs[Math.floor(reps * 0.025)], diffs[Math.floor(reps * 0.975)]] : [Number.NaN, Number.NaN],
  };
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
    .filter((r) => (!repo || r.repo === repo) && Date.parse(r.ts) >= since)
    .filter((r) => !relative(r.repo, resolve(r.repo, r.file)).startsWith("..")); // pre-2026-09-27 logs include scratch files outside the repo
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      days: { type: "string", default: "30" },
      json: { type: "boolean", default: false },
      log: { type: "string" },
      clusters: { type: "boolean", default: false },
      compare: { type: "string" },
      at: { type: "string" },
    },
  });
  const path = values.log ?? findingsLogPath();
  if (!path) throw new Error("findings log is disabled (JEV_LINT_FINDINGS_LOG=off)");
  const records = loadRecords(path, { repo: values.repo, days: Number(values.days) });
  const summary = summarize(records);
  if (values.compare) {
    if (!values.at) throw new Error("--compare needs --at <ISO date of the change>");
    const c = compare(records, values.compare, values.at);
    if (values.json) console.log(JSON.stringify(c, null, 2));
    else {
      const row = (label: string, s: Comparison["before"]) =>
        `${label} ${String(s.sessions).padStart(4)} sessions ${String(s.checks).padStart(6)} checks ${String(s.findings).padStart(4)} findings  ${s.per100Checks.toFixed(1).padStart(5)} per 100 checks  fixed ${s.fixed} kept ${s.kept}`;
      console.log(`${c.rule}, change at ${c.at}`);
      console.log(row("before", c.before));
      console.log(row("after ", c.after));
      console.log(
        `difference ${c.diffPer100.toFixed(1)} per 100 checks, 95% CI ${c.ci95[0].toFixed(1)} to ${c.ci95[1].toFixed(1)} (session bootstrap)`,
      );
    }
  } else if (values.clusters) {
    const cs = clusters(records);
    if (values.json) console.log(JSON.stringify(cs, null, 2));
    else {
      console.log(
        "rule                              area                          test  findings sessions per100  fixed kept unk  keptLB  action",
      );
      for (const c of cs) {
        console.log(
          `${c.rule.padEnd(34)}${c.area.slice(0, 30).padEnd(30)}${(c.test ? "yes" : "no").padEnd(6)}${String(c.findings).padStart(8)}${String(c.sessions).padStart(9)}${c.per100Checks.toFixed(1).padStart(7)}${String(c.fixed).padStart(7)}${String(c.kept).padStart(5)}${String(c.unknown).padStart(4)}${c.keptLower.toFixed(2).padStart(8)}  ${c.action}`,
        );
      }
    }
  } else if (values.json) {
    console.log(
      JSON.stringify({ log: path, checks: records.length, failed: records.filter((r) => r.error).length, rules: summary }, null, 2),
    );
  } else {
    const failed = records.filter((r) => r.error);
    console.log(
      `${records.length - failed.length} checks, ${failed.length} failed, in ${path}${values.repo ? ` for ${resolve(values.repo)}` : ""} (last ${values.days} days)`,
    );
    for (const f of failed.slice(-5)) console.log(`  failed: ${f.ts} ${f.file}: ${f.error}`);
    const timed = records.filter((r) => typeof r.latencyMs === "number" && !r.error);
    if (timed.length) {
      const lat = timed.map((r) => r.latencyMs as number).sort((a, b) => a - b);
      const tokens = timed.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
      const asked = timed.reduce((n, r) => n + (r.asked ?? 0), 0);
      const total = asked + timed.reduce((n, r) => n + (r.gatedOut ?? 0), 0);
      console.log(
        `judge: median ${lat[Math.floor(lat.length / 2)]} ms, p90 ${lat[Math.floor(lat.length * 0.9)]} ms; ${tokens} input tokens (~$${((tokens * 0.042) / 1e6).toFixed(5)} at Jev list price); ${asked} of ${total} rules asked after the gate`,
      );
    }
    console.log("rule                                    flags  high  med  sessions  fixed  kept  unknown  suggestion");
    for (const s of summary) {
      console.log(
        `${s.rule.padEnd(40)}${String(s.flags).padStart(5)}${String(s.high).padStart(6)}${String(s.medium).padStart(5)}${String(s.sessions).padStart(10)}${String(s.fixed).padStart(7)}${String(s.kept).padStart(6)}${String(s.unknown).padStart(9)}  ${s.suggestion}`,
      );
    }
  }
}
