// Offline eval: judge every labeled case with each system (cached), then score.
//   bun eval/run.ts                         # all systems, all packs, all splits
//   bun eval/run.ts --systems jev --runs 3  # subset / run-to-run consistency
// Writes eval/results/summary.json.
//
// Each case belongs to one rule pack ("hygiene" or "practices"); judges are asked only
// that pack's rules, and only those rules are scored.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { apiKey, cloudflareKey } from "../src/jev";
import { BUILT_IN_PACKS, type BuiltInPack, LANGUAGES, type Pack, RULE_FILES, ruleApplies, ruleSetForLanguage } from "../src/lint";
import {
  type Case,
  caseCode,
  type Judgment,
  jevModel,
  judgeClef,
  judgeClefFlash,
  judgeJev,
  judgeLlm,
  judgeLocal,
  judgeRegex,
  LLM_MODEL,
  LOCAL_NAME,
  REGEX_RULES,
} from "./systems";

// The harness evaluates candidate rules too (the hook skips them until they pass).
process.env.JEV_LINT_CANDIDATES ??= "on";
const ROOT = join(import.meta.dir, "..");
const RESULTS = join(ROOT, "eval/results");
const LANGS = LANGUAGES;
const SPLITS = ["dev", "holdout"] as const;
const PACKS: readonly BuiltInPack[] = BUILT_IN_PACKS;

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
    only: { type: "string" }, // comma-separated rule ids: only cases scoped to them (for tuning passes)
  },
});

const JUDGES = {
  jev: (c: Case) => judgeJev(c),
  llm: judgeLlm,
  regex: judgeRegex,
  local: judgeLocal,
  clef: judgeClef,
  "clef-flash": judgeClefFlash,
} as const;
type SystemName = keyof typeof JUDGES;

// Case files: <lang>[.<pack>][.<batch>].<split>.jsonl. No pack means hygiene; later batches
// (e.g. practices.v3) add cases for rules added after the first labeling round, and each case
// carries its label scope.
export function parseCaseFile(name: string): { lang: string; pack: BuiltInPack; split: string } | undefined {
  const parts = name.replace(/\.jsonl$/, "").split(".");
  if (parts.length < 2 || parts.length > 4) return undefined;
  const [lang, ...rest] = parts;
  const split = rest.pop() as string;
  if (rest.length && /^v\d+$/.test(rest[rest.length - 1])) rest.pop();
  const pack = (rest[0] ?? "hygiene") as BuiltInPack;
  if (rest.length > 1 || !BUILT_IN_PACKS.includes(pack)) return undefined;
  return { lang, pack, split };
}

function loadCases(): Case[] {
  const only = args.only ? new Set((args.only as string).split(",")) : undefined;
  const cases: Case[] = [];
  for (const name of readdirSync(join(ROOT, "eval/cases")).sort()) {
    const parsed = parseCaseFile(name);
    if (!parsed || !(LANGS as readonly string[]).includes(parsed.lang) || !(SPLITS as readonly string[]).includes(parsed.split)) continue;
    for (const line of readFileSync(join(ROOT, "eval/cases", name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const c = { ...JSON.parse(line), pack: parsed.pack, lang: parsed.lang } as Case;
      if (!only || (c.scope ?? []).some((id) => only.has(id))) cases.push(c);
    }
  }
  return cases;
}

// Cache key changes whenever that pack's rule text or the judge model changes.
// Keyed per pack and language, so rewording a Kotlin rule doesn't re-judge TypeScript cases.
const packHash = (pack: BuiltInPack, lang: string) =>
  createHash("sha256")
    .update(JSON.stringify(RULE_FILES[pack].filter((s) => s.language === lang)))
    .digest("hex")
    .slice(0, 10);
function cacheDir(system: SystemName, run: number, pack: BuiltInPack, lang: string) {
  const variant =
    system === "llm"
      ? LLM_MODEL
      : system === "jev"
        ? (jevModel() ?? "jev-latest")
        : system === "local"
          ? LOCAL_NAME
          : system === "clef" || system === "clef-flash"
            ? `${system}-workers-ai-v1`
            : "v1";
  return join(RESULTS, "cache", `${system}-${variant}-${packHash(pack, lang)}-r${run}`);
}

async function judgeAll(system: SystemName, cases: Case[], run: number) {
  const out = new Map<string, Judgment>();
  const queue = [...cases];
  let done = 0;
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const dir = cacheDir(system, run, c.pack, c.lang);
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
    const ids = ruleIds(c.lang, c.pack).filter((id) => (!c.scope || c.scope.includes(id)) && (!ruleFilter || ruleFilter(id)));
    let anyFlag = false;
    for (const id of ids) {
      const predicted = (j.scores[id] ?? 0) >= threshold;
      const actual = c.labels.includes(id);
      perRule[id] ??= { tp: 0, fp: 0, fn: 0 };
      const outcome = predicted && actual ? "tp" : predicted ? "fp" : actual ? "fn" : undefined;
      if (outcome) {
        total[outcome]++;
        perRule[id][outcome]++;
      }
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
      if (c.scope && !c.scope.includes(id)) continue;
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
    returnedModels: [...new Set(judged.flatMap((j) => j.models ?? []))],
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
  for (const system of systems) if (!(system in JUDGES)) throw new Error(`Unknown system: ${system}`);
  if (systems.some((s) => s === "clef" || s === "clef-flash")) {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !cloudflareKey())
      throw new Error("Clef eval requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_TOKEN_FILE)");
  }
  if (systems.includes("jev") && !process.env.TYPESAFE_BASE_URL && !apiKey()) throw new Error("Jev eval requires a TypeSafe API key");
  const runs = Number(args.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  // summary.json is the rolling default (snapshot it first, per AGENTS.md); a named experiment file is never overwritten.
  if (args.out !== "summary.json" && existsSync(join(RESULTS, args.out as string)))
    throw new Error("Output already exists; use a new --out name or snapshot the previous result first");
  console.error(`${cases.length} cases; systems=${systems.join(",")} runs=${runs}`);

  const judgments: Partial<Record<SystemName, Map<string, Judgment>[]>> = {};
  for (const system of systems) {
    const eligible = system === "regex" ? cases.filter((c) => c.pack === "hygiene") : cases;
    judgments[system] = [];
    for (let run = 1; run <= (system === "regex" ? 1 : runs); run++) {
      (judgments[system] as Map<string, Judgment>[]).push(await judgeAll(system, eligible, run));
    }
  }

  const caseById = new Map(cases.map((c) => [c.id, c]));
  // How many rules the gate leaves per edit, per pack and language.
  const gateStats: Record<string, { cases: number; rules: number; asked: number }> = {};
  for (const c of cases) {
    const rules = ruleSetForLanguage(c.lang, [c.pack])?.rules ?? [];
    const code = caseCode(c);
    const key = `${c.pack}.${c.lang}`;
    gateStats[key] ??= { cases: 0, rules: rules.length, asked: 0 };
    gateStats[key].cases++;
    gateStats[key].asked += rules.filter((r) => ruleApplies(r, code)).length;
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
    // Gated view of the same judgments: rules whose `when` patterns miss the case's code are
    // not asked, i.e. score 0. Local judges already ran gated, so this is a no-op for them.
    const gated = new Map<string, Judgment>();
    for (const [id, j] of runsForSystem[0]) {
      const c = caseById.get(id);
      if (!c) continue;
      const code = caseCode(c);
      const rules = ruleSetForLanguage(c.lang, [c.pack])?.rules ?? [];
      const applicable = new Set(rules.filter((r) => ruleApplies(r, code)).map((r) => r.id));
      gated.set(id, { ...j, scores: Object.fromEntries(Object.entries(j.scores).map(([k, v]) => [k, applicable.has(k) ? v : 0])) });
    }
    for (const pack of PACKS) {
      if (system === "regex" && pack !== "hygiene") continue;
      for (const lang of LANGS) {
        for (const split of SPLITS) {
          const subset = cases.filter((c) => c.pack === pack && c.lang === lang && c.split === split);
          if (!subset.length) continue;
          const policies: Record<string, number> =
            system === "jev" || system === "local" || system === "clef" || system === "clef-flash"
              ? { high: HIGH, "high+medium": MEDIUM }
              : system === "llm"
                ? { high: 0.9, "high+medium": 0.6 }
                : { high: 1 };
          const regexCovered = ruleIds(lang, "hygiene").filter((id) => REGEX_RULES[id]);
          if (system === "jev" || system === "llm" || system === "clef" || system === "clef-flash") {
            for (const [policy, threshold] of Object.entries(policies)) policies[`gated ${policy}`] = threshold;
          }
          for (const [policy, threshold] of Object.entries(policies)) {
            const source = policy.startsWith("gated ") ? [gated] : runsForSystem;
            const scored = source.map((m) => score(subset, m, threshold));
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
          if (system === "jev" || system === "local" || system === "clef" || system === "clef-flash") {
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
        gateStats,
        llmModel: LLM_MODEL,
        models: { jev: jevModel() ?? "jev-latest", clef: "@cf/cloudflare/clef", "clef-flash": "@cf/cloudflare/clef-flash" },
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
