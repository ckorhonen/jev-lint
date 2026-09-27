#!/usr/bin/env bun
// Run the hook's rules over existing files, as if each had just been written, to see what
// would fire in a repo before enabling rules there (built-in packs plus its .jev-lint/).
//   bun ~/Repos/jev-lint/src/check.ts [--packs hygiene,practices,repo] <file>...
// Prints one line per finding and a per-rule count. Sends each file's content to the judge.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { lintChange, type Pack } from "./lint";

const MAX_PARALLEL = 4;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { packs: { type: "string" } } });
const packs = values.packs?.split(",") as Pack[] | undefined;
const files = positionals.map((f) => resolve(f));
if (!files.length) throw new Error("usage: check.ts [--packs …] <file>...");

const counts = new Map<string, { high: number; medium: number }>();
const queue = [...files];
let checked = 0;
await Promise.all(
  Array.from({ length: MAX_PARALLEL }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      try {
        const addedCode = readFileSync(file, "utf8");
        const result = await lintChange({ filePath: file, addedCode, changeKind: "write" }, { timeoutMs: 30_000, packs });
        if (!result) continue;
        checked++;
        for (const f of result.findings) {
          const c = counts.get(f.ruleId) ?? { high: 0, medium: 0 };
          c[f.tier]++;
          counts.set(f.ruleId, c);
          console.log(`${f.tier === "high" ? "fix  " : "check"} ${f.probability.toFixed(2)} ${f.ruleId}  ${file}`);
        }
      } catch (error) {
        console.error(`failed: ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }),
);
console.log(`\n${checked} of ${files.length} files had applicable rules`);
for (const [rule, c] of [...counts].sort((a, b) => b[1].high + b[1].medium - (a[1].high + a[1].medium)))
  console.log(`${rule.padEnd(40)} ${c.high} fix, ${c.medium} check`);
