#!/usr/bin/env bun
// Validate a repo's generated rules against its labeled examples before trusting them.
//   bun ~/Repos/jev-lint/src/validate.ts [path/to/.jev-lint] [--json]
//
// .jev-lint/cases.jsonl lines: {"id","file_path","code","labels":["rule-id",...]}
// Labels must be complete: every rule in that language that the code violates.
// Exit code 1 when any rule fails the bar, so it can gate CI or an agent loop.

import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { askNouls } from "./jev";
import { buildQuestions, type RuleSet } from "./lint";
import { loadRepoDir } from "./repoRules";

const BAR = { minPositives: 3, minNegatives: 2, precisionAtHigh: 0.9, recallAtMedium: 0.8, precisionAtMedium: 0.75 };

type Case = { id: string; file_path: string; code: string; labels: string[] };
type Counts = { pos: number; neg: number; tpHigh: number; fpHigh: number; tpMed: number; fpMed: number; fnMed: number };

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean", default: false } } });
const dir = resolve(positionals[0] ?? ".jev-lint");
const casesFile = join(dir, "cases.jsonl");
if (!existsSync(dir)) throw new Error(`no ${dir}`);

const { ruleSets } = loadRepoDir(dir);
const cases: Case[] = existsSync(casesFile)
  ? readFileSync(casesFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  : [];

const setFor = (filePath: string): RuleSet | undefined => ruleSets.find((s) => s.extensions.includes(extname(filePath).toLowerCase()));

const counts: Record<string, Counts> = {};
for (const set of ruleSets)
  for (const r of set.rules) counts[r.id] = { pos: 0, neg: 0, tpHigh: 0, fpHigh: 0, tpMed: 0, fpMed: 0, fnMed: 0 };

let cleanCases = 0;
let cleanFlagged = 0;
const queue = [...cases];
const worker = async () => {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const set = setFor(c.file_path);
    if (!set) continue;
    const state = { language: set.language, file_path: c.file_path, added_code: c.code };
    const { answers } = await askNouls(state, buildQuestions(set), { timeoutMs: 30_000, retries: 3 });
    let flagged = false;
    for (const r of set.rules) {
      const p = answers[r.id]?.noul ?? 0;
      const actual = c.labels.includes(r.id);
      const k = counts[r.id];
      if (actual) k.pos++;
      else k.neg++;
      if (p >= 0.8) actual ? k.tpHigh++ : k.fpHigh++;
      if (p >= 0.5) actual ? k.tpMed++ : k.fpMed++;
      if (p < 0.5 && actual) k.fnMed++;
      flagged ||= p >= 0.5;
    }
    if (!c.labels.some((l) => set.rules.some((r) => r.id === l))) {
      cleanCases++;
      if (flagged) cleanFlagged++;
    }
  }
};
await Promise.all(Array.from({ length: 6 }, worker));

const ratio = (a: number, b: number) => (b ? a / b : null);
const report = Object.entries(counts).map(([id, k]) => {
  const precisionHigh = ratio(k.tpHigh, k.tpHigh + k.fpHigh);
  const precisionMed = ratio(k.tpMed, k.tpMed + k.fpMed);
  const recallMed = ratio(k.tpMed, k.pos);
  let verdict = "keep";
  const reasons: string[] = [];
  if (k.pos < BAR.minPositives || k.neg < BAR.minNegatives) {
    verdict = "needs-cases";
    reasons.push(`${k.pos} positives / ${k.neg} negatives (need ≥${BAR.minPositives} / ≥${BAR.minNegatives})`);
  } else {
    if (precisionHigh !== null && precisionHigh < BAR.precisionAtHigh)
      reasons.push(`precision at p≥0.8 is ${(precisionHigh * 100).toFixed(0)}%`);
    if (precisionMed !== null && precisionMed < BAR.precisionAtMedium)
      reasons.push(`precision at p≥0.5 is ${(precisionMed * 100).toFixed(0)}%`);
    if ((recallMed ?? 0) < BAR.recallAtMedium) reasons.push(`recall at p≥0.5 is ${((recallMed ?? 0) * 100).toFixed(0)}%`);
    if (reasons.length) verdict = "reword-or-drop";
  }
  return { id, ...k, precisionHigh, precisionMed, recallMed, verdict, reasons };
});

const summary = { dir, cases: cases.length, cleanCases, cleanFalseAlarmRate: ratio(cleanFlagged, cleanCases), rules: report };
if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pct = (x: number | null) => (x === null ? "  —" : `${(x * 100).toFixed(0)}%`.padStart(4));
  console.log(`${cases.length} cases, ${cleanCases} clean; clean edits flagged: ${pct(summary.cleanFalseAlarmRate)}`);
  console.log("rule                                     pos neg  P@.8  P@.5  R@.5  verdict");
  for (const r of report) {
    console.log(
      `${r.id.padEnd(40)} ${String(r.pos).padStart(3)} ${String(r.neg).padStart(3)}  ${pct(r.precisionHigh)}  ${pct(r.precisionMed)}  ${pct(r.recallMed)}  ${r.verdict}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}`,
    );
  }
}
process.exit(report.some((r) => r.verdict !== "keep") ? 1 : 0);
