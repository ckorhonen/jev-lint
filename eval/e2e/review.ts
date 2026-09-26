// "Would Jev have caught it before code review?"
//   E2E_TAG=practices bun eval/e2e/review.ts
//
// For each E2E run:
//   1. An AI code reviewer (not told our rules) reviews the final files and lists issues.
//   2. A mapper assigns each issue to one of our rules, or "none" (outside the rule set).
//   3. Jev is replayed over the agent's actual edit stream (every Write/Edit/MultiEdit in the
//      transcript) plus the final files; a reviewer issue counts as "caught before review"
//      when Jev flagged its rule on that file at p >= threshold.
//   4. Jev flags the reviewer never raised are checked by the rule grader, so we can tell
//      extra true catches from false positives.
// Writes eval/results/e2e-review-<tag>.json. All LLM judging uses gpt-6-luna at low effort.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { extractChanges } from "../../src/extract";
import { lintChange, ruleSetForLanguage } from "../../src/lint";
import { gradeFile } from "./grade";

const REPO = join(import.meta.dir, "../..");
const MODEL = process.env.REVIEW_MODEL ?? "gpt-6-luna";
const EFFORT = process.env.REVIEW_EFFORT ?? "low";
const TAG = process.env.E2E_TAG ? `-${process.env.E2E_TAG}` : "";
const E2E_ROOT = process.env.E2E_ROOT ?? join(process.env.TMPDIR ?? "/tmp", "jev-lint-e2e");
const CACHE = join(REPO, "eval/results/cache", `review-${MODEL}-${EFFORT}`);

type Run = {
  task: string;
  lang: "typescript" | "swift";
  condition: string;
  rep: number;
  files: { path: string; content: string }[];
};
type Finding = { file: string; line: number; severity: "high" | "medium" | "low"; title: string; explanation: string };

async function chat(schemaName: string, schema: object, prompt: string): Promise<any> {
  const key = createHash("sha256").update(`${schemaName}\n${prompt}`).digest("hex").slice(0, 20);
  const cacheFile = join(CACHE, `${key}.json`);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: EFFORT,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      const parsed = JSON.parse(json.choices[0].message.content);
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(parsed));
      return parsed;
    }
    if (attempt >= 4 || (res.status !== 429 && res.status < 500))
      throw new Error(`${MODEL} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await Bun.sleep(2000 * 2 ** attempt);
  }
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["file", "line", "severity", "title", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

async function review(run: Run): Promise<Finding[]> {
  const stack = run.lang === "typescript" ? "TypeScript and React" : "Swift, SwiftUI, and Swift concurrency";
  const files = run.files
    .map(
      (f) =>
        `=== ${f.path} ===\n${f.content
          .split("\n")
          .map((l, i) => `${i + 1}: ${l}`)
          .join("\n")}`,
    )
    .join("\n\n");
  const prompt = [
    `You are a senior ${stack} engineer doing a pull-request review of code a teammate just wrote.`,
    "Report every issue a strong reviewer would raise: bugs, lifecycle and concurrency mistakes, misuse of framework APIs, unsafe data handling, maintainability and best-practice problems. Skip pure formatting.",
    "One entry per distinct issue with the file path, the line number, severity (high = likely bug or crash, medium = real problem worth fixing before merge, low = nit), a short title, and a one-sentence explanation.",
    files,
  ].join("\n\n");
  return (await chat("review", REVIEW_SCHEMA, prompt)).findings;
}

async function mapFindings(run: Run, findings: Finding[]): Promise<string[]> {
  if (!findings.length) return [];
  const rules = ruleSetForLanguage(run.lang)?.rules ?? [];
  const ids = [...rules.map((r) => r.id), "none"];
  const schema = {
    type: "object",
    properties: { rules: { type: "array", items: { type: "string", enum: ids } } },
    required: ["rules"],
    additionalProperties: false,
  };
  const prompt = [
    'Map each code-review finding to the ONE lint rule below that describes the same problem, or "none" if no rule covers it. Only choose a rule when the finding is squarely what the rule describes.',
    `Rules:\n${rules.map((r) => `- ${r.id}: ${r.question.replaceAll("`added_code`", "the code")}`).join("\n")}`,
    `Findings (return exactly ${findings.length} rule ids, in order):\n${findings.map((f, i) => `${i + 1}. [${f.file}:${f.line}] ${f.title} — ${f.explanation}`).join("\n")}`,
  ].join("\n\n");
  const mapped: string[] = (await chat("map", schema, prompt)).rules;
  return findings.map((_, i) => mapped[i] ?? "none");
}

// Max Jev probability per (file basename, rule): `anyEdit` covers every edit in the transcript
// plus the final files (what the hook could have said before review); `final` covers only the
// final files (what is still there when the reviewer looks).
async function jevPreReview(run: Run, runDir: string) {
  const anyEdit: Record<string, Record<string, number>> = {};
  const final: Record<string, Record<string, number>> = {};
  const note = (target: typeof anyEdit, filePath: string, probs: Record<string, number>) => {
    const name = basename(filePath);
    target[name] ??= {};
    for (const [id, p] of Object.entries(probs)) target[name][id] = Math.max(target[name][id] ?? 0, p);
  };
  const changes = [];
  const transcript = join(runDir, "transcript.jsonl");
  if (existsSync(transcript)) {
    for (const line of readFileSync(transcript, "utf8").split("\n")) {
      if (!line.includes('"tool_use"')) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_use") changes.push(...extractChanges({ tool_name: block.name, tool_input: block.input }));
      }
    }
  }
  const finals = run.files.map((f) => ({ filePath: f.path, addedCode: f.content, changeKind: "write" as const }));
  const [editResults, finalResults] = await Promise.all([
    Promise.all(changes.map((c) => lintChange(c, { timeoutMs: 30_000, retries: 3 }))),
    Promise.all(finals.map((c) => lintChange(c, { timeoutMs: 30_000, retries: 3 }))),
  ]);
  for (const r of [...editResults, ...finalResults]) if (r) note(anyEdit, r.filePath, r.probabilities);
  for (const r of finalResults) if (r) note(final, r.filePath, r.probabilities);
  return { anyEdit, final };
}

async function main() {
  const runs = JSON.parse(readFileSync(join(REPO, `eval/results/e2e-runs${TAG}.json`), "utf8")) as Run[];
  const out: unknown[] = [];
  const queue = [...runs];
  const worker = async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      const runDir = join(E2E_ROOT, run.task, `${run.condition}-r${run.rep}`);
      const [findings, jev] = await Promise.all([review(run), jevPreReview(run, runDir)]);
      const mapped = await mapFindings(run, findings);
      const annotated = findings.map((f, i) => {
        const rule = mapped[i];
        const p = rule === "none" ? 0 : (jev.anyEdit[basename(f.file)]?.[rule] ?? 0);
        return { ...f, rule, jevProbability: p };
      });
      // Jev flags (p >= 0.5 on the final files) that no reviewer finding covers.
      const reviewed = new Set(annotated.map((f) => `${basename(f.file)}|${f.rule}`));
      const extras = [];
      for (const file of run.files) {
        const probs = jev.final[basename(file.path)] ?? {};
        const flagged = Object.entries(probs).filter(([id, p]) => p >= 0.5 && !reviewed.has(`${basename(file.path)}|${id}`));
        if (!flagged.length) continue;
        const verdict = await gradeFile(run.lang, file.path, file.content);
        for (const [id, p] of flagged)
          extras.push({ file: file.path, rule: id, jevProbability: p, graderConfirms: (verdict[id]?.instances ?? 0) > 0 });
      }
      out.push({ task: run.task, lang: run.lang, condition: run.condition, rep: run.rep, findings: annotated, jevOnly: extras });
      console.error(
        `${run.task} ${run.condition} r${run.rep}: ${findings.length} review findings, ${mapped.filter((m) => m !== "none").length} in scope, ${extras.length} Jev-only`,
      );
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  writeFileSync(join(REPO, `eval/results/e2e-review${TAG}.json`), JSON.stringify(out, null, 2));
}

await main();
