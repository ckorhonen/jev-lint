// Offline eval: judge every labeled case with each system (cached), then score.
//   bun eval/run.ts                         # all systems, all packs, all splits
//   bun eval/run.ts --systems jev --runs 3  # subset / run-to-run consistency
// Writes eval/results/summary.json.
//
// Each case belongs to one rule pack ("hygiene" or "practices"); judges are asked only
// that pack's rules, and only those rules are scored.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Pack, RULE_FILES, ruleSetForLanguage } from "../src/lint";
import { type Case, type Judgment, judgeJev, judgeLlm, judgeLocal, judgeRegex, LLM_MODEL, LOCAL_NAME, REGEX_RULES } from "./systems";

const ROOT = join(import.meta.dir, "..");
const RESULTS = join(ROOT, "eval/results");
const LANGS = ["typescript", "swift"] as const;
const SPLITS = ["dev", "holdout"] as const;
type BuiltInPack = Exclude<Pack, "repo">;
const PACKS: BuiltInPack[] = ["hygiene", "practices"];

// Thresholds were fixed before any data was seen; the sweep below shows the alternatives.
const HIGH = 0.8;
const MEDIUM = 0.5;
const SWEEP = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

const { values: args } = parseArgs({
  options: {
    systems: { type: "string", default: "jev,llm,regex" },
    concurrency: { type: "string", default: "8" },
    runs: { type: "string", default: "1" },
    out: { type: "string", default: "summary.json" },
    splits: { type: "string", default: "dev,holdout" },
  },
});

const JUDGES = { jev: (c: Case) => judgeJev(c), llm: judgeLlm, regex: judgeRegex, local: judgeLocal } as const;
type SystemName = keyof typeof JUDGES;

function loadCases(): Case[] {
  const cases: Case[] = [];
  for (const lang of LANGS) {
    for (const split of SPLITS) {
      for (const pack of PACKS) {
        const file = join(ROOT, `eval/cases/${lang}.${pack === "hygiene" ? "" : `${pack}.`}${split}.jsonl`);
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (line.trim()) cases.push({ ...JSON.parse(line), pack });
        }
      }
    }
  }
  return cases;
}

// Cache key changes whenever that pack's rule text or the judge model changes.
const packHash = (pack: BuiltInPack) => createHash("sha256").update(JSON.stringify(RULE_FILES[pack])).digest("hex").slice(0, 10);
function cacheDir(system: SystemName, run: number, pack: BuiltInPack) {
  const variant =
    system === "llm" ? LLM_MODEL : system === "jev" ? (process.env.JEV_LINT_MODEL ?? "jev-latest") : system === "local" ? LOCAL_NAME : "v1";
  return join(RESULTS, "cache", `${system}-${variant}-${packHash(pack)}-r${run}`);
}

async function judgeAll(system: SystemName, cases: Case[], run: number) {
  const out = new Map<string, Judgment>();
  const queue = [...cases];
  let done = 0;
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const dir = cacheDir(system, run, c.pack);
      mkdirSync(dir, { recursive: true });
      // Key on content too: a case id whose payload changed must not reuse a stale judgment.
      const payloadHash = createHash("sha256").update(JSON.stringify(c.payload)).digest("hex").slice(0, 12);
      const file = join(dir, `${c.id}-${payloadHash}.json`);
      if (existsSync(file)) {
        out.set(c.id, JSON.parse(readFileSync(file, "utf8")));
        continue;
      }
      let judgment: Judgment;
      try {
        judgment = await JUDGES[system](c);
        writeFileSync(file, JSON.stringify(judgment));
      } catch (err) {
        judgment = { scores: {}, latencyMs: 0, inputTokens: 0, outputTokens: 0, error: String(err) };
      }
      out.set(c.id, judgment);
      if (++done % 50 === 0) console.error(`${system} r${run}: ${done} judged`);
    }
  };
  await Promise.all(Array.from({ length: system === "regex" ? 1 : Number(args.concurrency) }, worker));
  return out;
}

type Counts = { tp: number; fp: number; fn: number };
const prf = ({ tp, fp, fn }: Counts) => {
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
};

const ruleIds = (lang: string, pack: Pack) => ruleSetForLanguage(lang, [pack])?.rules.map((r) => r.id) ?? [];

function score(cases: Case[], judgments: Map<string, Judgment>, threshold: number, ruleFilter?: (id: string) => boolean) {
  const total: Counts = { tp: 0, fp: 0, fn: 0 };
  const perRule: Record<string, Counts> = {};
  let cleanCases = 0;
  let cleanFlagged = 0;
  for (const c of cases) {
    const j = judgments.get(c.id);
    if (!j || j.error) continue;
    const ids = ruleIds(c.lang, c.pack).filter((id) => !ruleFilter || ruleFilter(id));
    let anyFlag = false;
    for (const id of ids) {
      const predicted = (j.scores[id] ?? 0) >= threshold;
      const actual = c.labels.includes(id);
      perRule[id] ??= { tp: 0, fp: 0, fn: 0 };
      if (predicted && actual) total.tp++, perRule[id].tp++;
      if (predicted && !actual) total.fp++, perRule[id].fp++;
      if (!predicted && actual) total.fn++, perRule[id].fn++;
      anyFlag ||= predicted;
    }
    if (!c.labels.some((l) => ids.includes(l))) {
      cleanCases++;
      if (anyFlag) cleanFlagged++;
    }
  }
  return {
    ...prf(total),
    cleanCases,
    cleanFalseAlarmRate: cleanCases ? cleanFlagged / cleanCases : 0,
    perRule: Object.fromEntries(Object.entries(perRule).map(([id, c]) => [id, prf(c)])),
  };
}

// How often findings in [lo, hi) are real: the precision of the "double-check" tier.
function bandPrecision(cases: Case[], judgments: Map<string, Judgment>, lo: number, hi: number) {
  let real = 0;
  let total = 0;
  for (const c of cases) {
    const j = judgments.get(c.id);
    if (!j || j.error) continue;
    for (const [id, p] of Object.entries(j.scores)) {
      if (p >= lo && p < hi) {
        total++;
        if (c.labels.includes(id)) real++;
      }
    }
  }
  return { findings: total, real, precision: total ? real / total : null };
}

function latencyStats(cases: Case[], judgments: Map<string, Judgment>) {
  const judged = cases.map((c) => judgments.get(c.id)).filter((j): j is Judgment => Boolean(j && !j.error));
  const values = judged.map((j) => j.latencyMs).sort((a, b) => a - b);
  const q = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 0;
  return {
    p50: q(0.5),
    p90: q(0.9),
    n: values.length,
    tokens: {
      input: judged.reduce((n, j) => n + j.inputTokens, 0),
      output: judged.reduce((n, j) => n + j.outputTokens, 0),
    },
  };
}

async function main() {
  const splits = (args.splits as string).split(",");
  const cases = loadCases().filter((c) => splits.includes(c.split));
  const systems = (args.systems as string).split(",") as SystemName[];
  const runs = Number(args.runs);
  console.error(`${cases.length} cases; systems=${systems.join(",")} runs=${runs}`);

  const judgments: Partial<Record<SystemName, Map<string, Judgment>[]>> = {};
  for (const system of systems) {
    const eligible = system === "regex" ? cases.filter((c) => c.pack === "hygiene") : cases;
    judgments[system] = [];
    for (let run = 1; run <= (system === "regex" ? 1 : runs); run++) {
      (judgments[system] as Map<string, Judgment>[]).push(await judgeAll(system, eligible, run));
    }
  }

  const caseCounts: Record<string, number> = {};
  for (const c of cases) caseCounts[`${c.pack}.${c.lang}.${c.split}`] = (caseCounts[`${c.pack}.${c.lang}.${c.split}`] ?? 0) + 1;
  const errors: Record<string, number> = {};
  const results: Record<string, unknown>[] = [];
  const sweeps: Record<string, unknown>[] = [];
  const bands: Record<string, unknown>[] = [];

  for (const system of systems) {
    const runsForSystem = judgments[system] as Map<string, Judgment>[];
    errors[system] = [...runsForSystem[0].values()].filter((j) => j.error).length;
    for (const pack of PACKS) {
      if (system === "regex" && pack !== "hygiene") continue;
      for (const lang of LANGS) {
        for (const split of SPLITS) {
          const subset = cases.filter((c) => c.pack === pack && c.lang === lang && c.split === split);
          if (!subset.length) continue;
          const policies: Record<string, number> =
            system === "jev" || system === "local"
              ? { high: HIGH, "high+medium": MEDIUM }
              : system === "llm"
                ? { high: 0.9, "high+medium": 0.6 }
                : { high: 1 };
          const regexCovered = ruleIds(lang, "hygiene").filter((id) => REGEX_RULES[id]);
          for (const [policy, threshold] of Object.entries(policies)) {
            const scored = runsForSystem.map((m) => score(subset, m, threshold));
            results.push({
              system,
              pack,
              lang,
              split,
              policy,
              threshold,
              ...scored[0],
              runF1: runs > 1 ? scored.map((s) => s.f1) : undefined,
              regexCoveredRules:
                pack === "hygiene" ? prf(score(subset, runsForSystem[0], threshold, (id) => regexCovered.includes(id))) : undefined,
              latency: latencyStats(subset, runsForSystem[0]),
            });
          }
          if (system === "jev" || system === "local") {
            for (const t of SWEEP) {
              const s = score(subset, runsForSystem[0], t);
              sweeps.push({
                system,
                pack,
                lang,
                split,
                threshold: t,
                precision: s.precision,
                recall: s.recall,
                f1: s.f1,
                cleanFalseAlarmRate: s.cleanFalseAlarmRate,
              });
            }
            for (const [lo, hi] of [
              [0.8, 1.01],
              [0.5, 0.8],
              [0.3, 0.5],
              [0.1, 0.3],
            ]) {
              bands.push({ system, pack, lang, split, lo, hi, ...bandPrecision(subset, runsForSystem[0], lo, hi) });
            }
          }
        }
      }
    }
  }

  // Run-to-run consistency for jev: absolute probability difference across repeated runs.
  let jevRunConsistency: unknown;
  const jevRuns = judgments.jev ?? [];
  if (jevRuns.length > 1) {
    const diffs: number[] = [];
    for (const c of cases) {
      const a = jevRuns[0].get(c.id)?.scores ?? {};
      for (const other of jevRuns.slice(1)) {
        const b = other.get(c.id)?.scores ?? {};
        for (const id of Object.keys(a)) diffs.push(Math.abs(a[id] - (b[id] ?? 0)));
      }
    }
    diffs.sort((x, y) => x - y);
    jevRunConsistency = { maxAbsDiff: diffs.at(-1), p99AbsDiff: diffs[Math.floor(diffs.length * 0.99)] };
  }

  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, args.out as string),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        llmModel: LLM_MODEL,
        thresholds: { HIGH, MEDIUM },
        caseCounts,
        errors,
        jevRunConsistency,
        results,
        sweeps,
        bands,
      },
      null,
      2,
    ),
  );

  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4);
  console.log("system  pack       lang        split    policy        P    R    F1  cleanFA  p50ms");
  for (const r of results as Array<Record<string, any>>) {
    console.log(
      `${r.system.padEnd(7)} ${r.pack.padEnd(10)} ${r.lang.padEnd(11)} ${r.split.padEnd(8)} ${String(r.policy).padEnd(12)} ${pct(r.precision)} ${pct(r.recall)} ${pct(r.f1)}   ${pct(r.cleanFalseAlarmRate)}  ${Math.round(r.latency.p50)}`,
    );
  }
  console.log("errors:", JSON.stringify(errors), "consistency:", JSON.stringify(jevRunConsistency));
}

await main();
