// Decide which candidate rules ship, from a holdout summary, using the same bar as
// src/validate.ts (fixed before the new packs were measured):
//   precision ≥ 90% at p ≥ 0.8, precision ≥ 75% and recall ≥ 80% at p ≥ 0.5 (gated policies).
//   bun eval/pack-status.ts eval/results/<holdout summary>.json [--apply]
// Writes eval/results/pack-status.json (per-rule holdout numbers, used by the pack docs) and,
// with --apply, drops "status": "candidate" from rules that pass. Rules that fail stay candidates.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const BAR = { precisionAtHigh: 0.9, precisionAtMedium: 0.75, recallAtMedium: 0.8, minPositives: 3 };

type RuleStats = { tp: number; fp: number; fn: number; precision: number; recall: number };
type Result = { system: string; split: string; policy: string; perRule?: Record<string, RuleStats> };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { apply: { type: "boolean", default: false }, system: { type: "string", default: "jev" } },
});
const summary = JSON.parse(readFileSync(positionals[0], "utf8")) as { results: Result[] };
const pick = (policy: string) => {
  const out: Record<string, RuleStats> = {};
  for (const r of summary.results)
    if (r.system === values.system && r.split === "holdout" && r.policy === policy) Object.assign(out, r.perRule ?? {});
  return out;
};
const high = pick("gated high");
const medium = pick("gated high+medium");

const status: Record<
  string,
  {
    precision: number;
    recall: number;
    precisionAtHigh: number;
    positives: number;
    falsePositives: number;
    pass: boolean;
    reasons: string[];
  }
> = {};
const rulesDir = join(ROOT, "rules");
const files = readdirSync(rulesDir).filter((n) => n.endsWith(".json"));
let shipped = 0;
let held = 0;
for (const name of files) {
  const path = join(rulesDir, name);
  const set = JSON.parse(readFileSync(path, "utf8")) as { rules: { id: string; status?: string }[] };
  let changed = false;
  for (const rule of set.rules) {
    const m = medium[rule.id];
    const h = high[rule.id];
    if (!m) continue;
    const positives = m.tp + m.fn;
    const precisionAtHigh = h && h.tp + h.fp > 0 ? h.tp / (h.tp + h.fp) : 1;
    const reasons: string[] = [];
    if (positives < BAR.minPositives) reasons.push(`only ${positives} holdout positives`);
    if (precisionAtHigh < BAR.precisionAtHigh) reasons.push(`precision at p≥0.8 ${Math.round(precisionAtHigh * 100)}%`);
    if (m.precision < BAR.precisionAtMedium) reasons.push(`precision at p≥0.5 ${Math.round(m.precision * 100)}%`);
    if (m.recall < BAR.recallAtMedium) reasons.push(`recall at p≥0.5 ${Math.round(m.recall * 100)}%`);
    const pass = reasons.length === 0;
    status[rule.id] = { precision: m.precision, recall: m.recall, precisionAtHigh, positives, falsePositives: m.fp, pass, reasons };
    if (rule.status === "candidate") {
      if (pass) {
        shipped++;
        if (values.apply) {
          delete rule.status;
          changed = true;
        }
      } else held++;
    }
  }
  if (changed) writeFileSync(path, `${JSON.stringify(set, null, 2)}\n`);
}
writeFileSync(join(ROOT, "eval/results/pack-status.json"), `${JSON.stringify(status, null, 2)}\n`);
console.log(`${shipped} candidates pass${values.apply ? " (status removed)" : ""}, ${held} stay candidates`);
for (const [id, s] of Object.entries(status)) if (!s.pass) console.log(`  hold ${id}: ${s.reasons.join("; ")}`);
