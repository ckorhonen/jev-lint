// Grade the final code of every E2E run, blind to condition, with a strong LLM judge
// (independent of Jev) plus the regex judge. Writes eval/results/e2e-graded.json.
//   bun eval/e2e/grade.ts

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ruleSetForLanguage } from "../../src/lint";
import { REGEX_RULES } from "../systems";
import { fileLanguage, type Lang } from "./languages";

const REPO = join(import.meta.dir, "../..");
export const GRADER_MODEL = process.env.GRADER_MODEL ?? "gpt-6-luna";
const GRADER_EFFORT = process.env.GRADER_EFFORT ?? "low";
const CACHE = join(REPO, "eval/results/cache", `grader-${GRADER_MODEL}-${process.env.GRADER_EFFORT ?? "low"}`);

type Run = {
  task: string;
  lang: Lang;
  condition: string;
  rep: number;
  build: { ok: boolean | null; skipped?: string };
  transcript: Record<string, number | boolean>;
  hook: Record<string, number>;
  files: { path: string; content: string }[];
};

const SCAFFOLD_STUBS = new Set(["export {};", "import Foundation"]);

type Verdict = Record<string, { instances: number; evidence: string }>;

export async function gradeFile(lang: string, path: string, content: string): Promise<Verdict> {
  const ruleSet = ruleSetForLanguage(lang);
  if (!ruleSet) throw new Error(`no rules for ${lang}`);
  const key = createHash("sha256")
    .update(`${lang}\n${path}\n${content}\n${JSON.stringify(ruleSet.rules)}`)
    .digest("hex")
    .slice(0, 16);
  const cacheFile = join(CACHE, `${key}.json`);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
  const rules = ruleSet.rules
    .map((r) => `- ${r.id}: ${r.question.replaceAll("`added_code`", "the file")}\n  violation = ${r.true}\n  not a violation = ${r.false}`)
    .join("\n");
  const properties = Object.fromEntries(
    ruleSet.rules.map((r) => [
      r.id,
      {
        type: "object",
        properties: { instances: { type: "integer" }, evidence: { type: "string" } },
        required: ["instances", "evidence"],
        additionalProperties: false,
      },
    ]),
  );
  const prompt = [
    `You are a meticulous code reviewer. For each rule, count how many distinct places in this ${ruleSet.language} file violate it (0 if none).`,
    'Apply each rule\'s definition and exclusions exactly. For evidence, quote the offending line(s) briefly, or write "none".',
    `Rules:\n${rules}`,
    `File: ${path}\n\`\`\`\n${content}\n\`\`\``,
  ].join("\n\n");

  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GRADER_MODEL,
        reasoning_effort: GRADER_EFFORT,
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "grade",
            strict: true,
            schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
          },
        },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      const verdict = JSON.parse(json.choices[0].message.content) as Verdict;
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(verdict));
      return verdict;
    }
    if (attempt >= 4 || (res.status !== 429 && res.status < 500))
      throw new Error(`grader ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await Bun.sleep(2000 * 2 ** attempt);
  }
}

async function main() {
  const tag = process.env.E2E_TAG ? `-${process.env.E2E_TAG}` : "";
  const runs = JSON.parse(readFileSync(join(REPO, `eval/results/e2e-runs${tag}.json`), "utf8")) as Run[];
  const graded: unknown[] = [];
  const queue = [...runs];
  const worker = async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      const perRule: Record<string, number> = {};
      const regexPerRule: Record<string, number> = {};
      let lines = 0;
      for (const file of run.files) {
        if (SCAFFOLD_STUBS.has(file.content.trim())) continue; // untouched scaffold
        lines += file.content.split("\n").length;
        // Legacy (TypeScript/Swift) runs: always run.lang. Bazel runs grade .py files with Python rules.
        const lang = fileLanguage(file.path, run.lang);
        const verdict = await gradeFile(lang, file.path, file.content);
        for (const [id, v] of Object.entries(verdict)) perRule[id] = (perRule[id] ?? 0) + v.instances;
        // The regex baseline only exists for TypeScript and Swift.
        if (lang !== "typescript" && lang !== "swift") continue;
        for (const [id, re] of Object.entries(REGEX_RULES)) {
          if (!id.startsWith(lang === "typescript" ? "ts-" : "swift-")) continue;
          regexPerRule[id] = (regexPerRule[id] ?? 0) + (re.test(file.content) ? 1 : 0);
        }
      }
      const total = Object.values(perRule).reduce((a, b) => a + b, 0);
      graded.push({ ...run, files: undefined, lines, violations: perRule, totalViolations: total, regexHits: regexPerRule });
      console.error(`graded ${run.task} ${run.condition} r${run.rep}: ${total} violations in ${lines} lines`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  writeFileSync(join(REPO, `eval/results/e2e-graded${tag}.json`), JSON.stringify(graded, null, 2));
}

if (import.meta.main) await main();
