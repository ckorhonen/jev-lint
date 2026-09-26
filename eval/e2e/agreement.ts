// Jev vs the GPT-5.5 grader on real agent-written files (all E2E final files):
// the synthetic sets are clean-cut; this measures agreement on the real distribution.
//   bun eval/e2e/agreement.ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lintChange } from "../../src/lint";

const REPO = join(import.meta.dir, "../..");
const GRADER_CACHE = join(REPO, "eval/results/cache", `grader-${process.env.GRADER_MODEL ?? "gpt-5.5"}`);
const runs = JSON.parse(readFileSync(join(REPO, "eval/results/e2e-runs.json"), "utf8")) as {
  lang: string;
  files: { path: string; content: string }[];
}[];

const seen = new Set<string>();
const pairs: { rule: string; jev: number; grader: number; evidence: string; path: string }[] = [];
for (const run of runs) {
  for (const file of run.files) {
    const key = createHash("sha256").update(`${run.lang}\n${file.path}\n${file.content}`).digest("hex").slice(0, 16);
    const cacheFile = join(GRADER_CACHE, `${key}.json`);
    if (seen.has(key) || !existsSync(cacheFile)) continue;
    seen.add(key);
    const verdict = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, { instances: number; evidence: string }>;
    const result = await lintChange(
      { filePath: file.path, addedCode: file.content, changeKind: "write" },
      { timeoutMs: 30_000, retries: 3 },
    );
    if (!result) continue;
    for (const [rule, v] of Object.entries(verdict)) {
      pairs.push({ rule, jev: result.probabilities[rule] ?? 0, grader: v.instances, evidence: v.evidence, path: file.path });
    }
  }
}
writeFileSync(join(REPO, "eval/results/e2e-agreement.json"), JSON.stringify(pairs, null, 2));
console.log(`${seen.size} files, ${pairs.length} rule judgments`);
