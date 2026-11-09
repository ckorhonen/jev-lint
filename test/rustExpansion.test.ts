import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractChanges } from "../src/extract";
import { RULE_FILES, ruleApplies } from "../src/lint";

const root = join(import.meta.dir, "..");
const scope = {
  practices: [
    "rs-http-error-status-unchecked",
    "rs-broadcast-lag-ends-consumer",
    "rs-timeout-detaches-spawned-task",
    "rs-select-send-drops-message",
  ],
  security: ["rs-shell-command-interpolation", "rs-zip-entry-path-traversal", "rs-path-string-prefix-containment"],
};

type Fixture = {
  id: string;
  lang: string;
  split: string;
  scope: string[];
  labels: string[];
  payload: Parameters<typeof extractChanges>[0];
};

describe("Rust expansion evaluation fixtures", () => {
  const allIds = new Set<string>();
  for (const [pack, ids] of Object.entries(scope)) {
    for (const split of ["dev", "holdout"]) {
      test(`${pack} ${split} has valid independent coverage and recall-safe gates`, () => {
        const cases = readFileSync(join(root, `eval/cases/rust.${pack}.v9.${split}.jsonl`), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Fixture);
        const rules = Object.values(RULE_FILES).flatMap((sets) =>
          sets.filter((set) => set.language === "rust").flatMap((set) => set.rules),
        );
        for (const c of cases) {
          expect(allIds.has(c.id)).toBe(false);
          allIds.add(c.id);
          expect(c.lang).toBe("rust");
          expect(c.split).toBe(split);
          expect([...c.scope].sort()).toEqual([...ids].sort());
          expect(new Set(c.labels).size).toBe(c.labels.length);
          for (const id of c.labels) {
            expect(ids).toContain(id);
            const rule = rules.find((r) => r.id === id);
            expect(rule).toBeDefined();
            expect(extractChanges(c.payload).some((change) => rule && ruleApplies(rule, change.addedCode))).toBe(true);
          }
        }
        for (const id of ids) {
          expect(cases.filter((c) => c.labels.includes(id)).length).toBeGreaterThanOrEqual(5);
          expect(cases.filter((c) => !c.labels.includes(id)).length).toBeGreaterThanOrEqual(3);
        }
        expect(cases.some((c) => c.labels.length > 1)).toBe(true);
        expect(cases.filter((c) => c.labels.length === 0).length).toBeGreaterThanOrEqual(8);
      });
    }
  }
});
