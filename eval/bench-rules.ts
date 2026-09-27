// How does the number of rules asked per edit affect Jev's accuracy, latency and tokens,
// and does splitting the rules into parallel requests help?
//   bun eval/bench-rules.ts [--cases 48] [--sizes 25,50,100] [--chunk 10]
// Writes eval/results/bench-rule-count.json.
//
// For each sampled held-out case, its own rules (the labeled scope) are the targets. Extra
// "distractor" rules from other packs and languages (then relabeled copies) pad the request
// to N questions. Every size runs as one request and as parallel requests of --chunk rules.
// Noul questions are answered independently, so target probabilities should not move with N;
// this measures whether that holds in practice and what N costs in time and tokens.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { extractChanges } from "../src/extract";
import { askNouls, type NoulQuestion } from "../src/jev";
import { buildQuestions, RULE_FILES, type Rule, ruleSetForLanguage } from "../src/lint";

const ROOT = join(import.meta.dir, "..");
const { values: args } = parseArgs({
  options: {
    cases: { type: "string", default: "48" },
    sizes: { type: "string", default: "25,50,100" },
    chunk: { type: "string", default: "10" },
    concurrency: { type: "string", default: "4" },
  },
});

type Row = {
  case: string;
  lang: string;
  pack: string;
  size: number;
  mode: string;
  targets: number;
  ms: number;
  tokens: number;
  requests: number;
  targetProbs: Record<string, number>;
  baseProbs: Record<string, number>;
  labels: string[];
};
type Summary = {
  size: number | "targets";
  mode: string;
  cases: number;
  meanAbsDrift: number;
  p99AbsDrift: number;
  maxAbsDrift: number;
  targetF1: number;
  precision: number;
  recall: number;
  msP50: number;
  msP90: number;
  tokensMean: number;
  requests: number;
};
type Case = {
  id: string;
  lang: string;
  pack: "hygiene" | "practices";
  labels: string[];
  scope?: string[];
  payload: { tool_name: string; tool_input: Record<string, unknown> };
};

function loadHoldout(): Case[] {
  const out: Case[] = [];
  for (const [file, lang, pack] of [
    ["typescript.holdout.jsonl", "typescript", "hygiene"],
    ["typescript.practices.holdout.jsonl", "typescript", "practices"],
    ["swift.holdout.jsonl", "swift", "hygiene"],
    ["swift.practices.holdout.jsonl", "swift", "practices"],
  ] as const) {
    for (const line of readFileSync(join(ROOT, "eval/cases", file), "utf8").split("\n")) {
      if (line.trim()) out.push({ ...JSON.parse(line), lang, pack });
    }
  }
  return out;
}

// Deterministic sample: every k-th case per file, balanced across the four files.
function sample(cases: Case[], n: number) {
  const groups = new Map<string, Case[]>();
  for (const c of cases) groups.set(`${c.lang}.${c.pack}`, [...(groups.get(`${c.lang}.${c.pack}`) ?? []), c]);
  const per = Math.ceil(n / groups.size);
  return [...groups.values()].flatMap((g) => g.filter((_, i) => i % Math.max(1, Math.floor(g.length / per)) === 0).slice(0, per));
}

const ALL_RULES: Rule[] = Object.values(RULE_FILES).flatMap((sets) => sets.flatMap((s) => s.rules));

function questionsFor(targets: Rule[], size: number): Record<string, NoulQuestion> {
  const ids = new Set(targets.map((r) => r.id));
  const pool = ALL_RULES.filter((r) => !ids.has(r.id));
  const padded = [...targets];
  for (let copy = 0; padded.length < size; copy++) {
    for (const r of pool) {
      if (padded.length >= size) break;
      padded.push(copy === 0 ? r : { ...r, id: `${r.id}~${copy}` });
    }
  }
  return buildQuestions({ language: "", extensions: [], rules: padded });
}

async function run(state: unknown, questions: Record<string, NoulQuestion>, chunk: number | undefined) {
  const entries = Object.entries(questions);
  const parts = chunk
    ? Array.from({ length: Math.ceil(entries.length / chunk) }, (_, i) => Object.fromEntries(entries.slice(i * chunk, (i + 1) * chunk)))
    : [questions];
  const started = performance.now();
  const responses = await Promise.all(parts.map((q) => askNouls(state, q, { timeoutMs: 60_000, retries: 4 })));
  const ms = performance.now() - started;
  const answers: Record<string, number> = {};
  let tokens = 0;
  for (const r of responses) {
    tokens += r.usage.input_tokens;
    for (const [k, v] of Object.entries(r.answers)) answers[k] = v.noul;
  }
  return { ms, tokens, requests: parts.length, answers };
}

async function main() {
  const cases = sample(loadHoldout(), Number(args.cases));
  const sizes = (args.sizes as string).split(",").map(Number);
  const chunk = Number(args.chunk);
  const rows: Row[] = [];
  const queue = [...cases];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const change = extractChanges({ tool_name: c.payload.tool_name, tool_input: c.payload.tool_input })[0];
      if (!change?.addedCode.trim()) continue;
      const rules = (ruleSetForLanguage(c.lang, [c.pack])?.rules ?? []).filter((r) => !c.scope || c.scope.includes(r.id));
      const state = { language: c.lang, file_path: change.filePath, added_code: change.addedCode };
      const base = await run(state, buildQuestions({ language: c.lang, extensions: [], rules }), undefined);
      const record = (size: number, mode: string, r: Awaited<ReturnType<typeof run>>) =>
        rows.push({
          case: c.id,
          lang: c.lang,
          pack: c.pack,
          size,
          mode,
          targets: rules.length,
          ms: r.ms,
          tokens: r.tokens,
          requests: r.requests,
          targetProbs: Object.fromEntries(rules.map((t) => [t.id, r.answers[t.id] ?? 0])),
          baseProbs: Object.fromEntries(rules.map((t) => [t.id, base.answers[t.id] ?? 0])),
          labels: c.labels.filter((l) => rules.some((t) => t.id === l)),
        });
      record(0, "targets-only", base);
      for (const size of sizes) {
        const qs = questionsFor(rules, size);
        record(size, "one-request", await run(state, qs, undefined));
        record(size, `parallel-${chunk}`, await run(state, qs, chunk));
      }
      console.error(`${c.id}: done`);
    }
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));

  // Summaries per (size, mode): target drift vs the targets-only call, target F1 at 0.5, time, tokens.
  const summary: Summary[] = [];
  const keys = [...new Set(rows.map((r) => `${r.size}|${r.mode}`))];
  for (const key of keys) {
    const [size, mode] = key.split("|");
    const rs = rows.filter((r) => `${r.size}|${r.mode}` === key);
    const diffs: number[] = [];
    let tp = 0,
      fp = 0,
      fn = 0;
    for (const r of rs) {
      for (const [id, p] of Object.entries(r.targetProbs)) {
        diffs.push(Math.abs(p - r.baseProbs[id]));
        const pred = p >= 0.5,
          actual = r.labels.includes(id);
        tp += Number(pred && actual);
        fp += Number(pred && !actual);
        fn += Number(!pred && actual);
      }
    }
    diffs.sort((a, b) => a - b);
    const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
    const P = tp + fp ? tp / (tp + fp) : 1,
      R = tp + fn ? tp / (tp + fn) : 1;
    summary.push({
      size: mode === "targets-only" ? "targets" : Number(size),
      mode,
      cases: rs.length,
      meanAbsDrift: diffs.reduce((a, b) => a + b, 0) / diffs.length,
      p99AbsDrift: diffs[Math.floor(diffs.length * 0.99)],
      maxAbsDrift: diffs.at(-1) ?? 0,
      targetF1: P + R ? (2 * P * R) / (P + R) : 0,
      precision: P,
      recall: R,
      msP50: ms[Math.floor(ms.length / 2)],
      msP90: ms[Math.floor(ms.length * 0.9)],
      tokensMean: rs.reduce((n, r) => n + r.tokens, 0) / rs.length,
      requests: rs[0]?.requests ?? 0,
    });
  }
  writeFileSync(
    join(ROOT, "eval/results/bench-rule-count.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), cases: cases.length, chunk, summary, rows }, null, 2),
  );
  for (const s of summary) {
    console.log(
      `${String(s.size).padStart(7)} ${s.mode.padEnd(12)} F1 ${(s.targetF1 * 100).toFixed(0)}%  drift mean ${s.meanAbsDrift.toFixed(3)} p99 ${s.p99AbsDrift.toFixed(3)}  p50 ${Math.round(s.msP50)} ms p90 ${Math.round(s.msP90)} ms  tokens ${Math.round(s.tokensMean)}  requests ${s.requests}`,
    );
  }
}

await main();
