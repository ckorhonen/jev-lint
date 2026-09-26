import { describe, expect, test } from "bun:test";
import { summarize } from "../src/findings";
import type { CheckRecord } from "../src/findingsLog";

let clock = 0;
function check(session: string, file: string, rules: string[], tier: "high" | "medium" = "high"): CheckRecord {
  clock += 1000;
  return {
    ts: new Date(Date.UTC(2026, 8, 26) + clock).toISOString(),
    session,
    repo: "/repo",
    file,
    changeKind: "edit",
    model: "jev-1.13.0",
    flagged: rules.map((rule) => ({ rule, p: 0.9, tier })),
    ...(rules.length ? { excerpt: "code" } : {}),
  };
}

describe("findings outcomes", () => {
  test("fixed when a later check of the file no longer flags the rule", () => {
    const [s] = summarize([check("a", "x.ts", ["r"]), check("a", "x.ts", [])]);
    expect([s.fixed, s.kept, s.unknown]).toEqual([1, 0, 0]);
  });

  test("kept when the rule is still flagged at the last check", () => {
    const [s] = summarize([check("a", "x.ts", ["r"]), check("a", "x.ts", ["r"])]);
    expect([s.fixed, s.kept, s.unknown]).toEqual([0, 1, 0]);
  });

  test("unknown when the file is never checked again in that session", () => {
    const [s] = summarize([check("a", "x.ts", ["r"]), check("b", "x.ts", [])]);
    expect([s.fixed, s.kept, s.unknown]).toEqual([0, 0, 1]);
  });

  test("recurring fixes across sessions suggest guidance; recurring kept flags suggest reviewing the rule", () => {
    const records: CheckRecord[] = [];
    for (const session of ["a", "b", "c"]) records.push(check(session, "x.ts", ["often-fixed"]), check(session, "x.ts", []));
    for (const session of ["d", "e", "f"]) records.push(check(session, "y.ts", ["often-kept"]), check(session, "y.ts", ["often-kept"]));
    const byRule = Object.fromEntries(summarize(records).map((s) => [s.rule, s]));
    expect(byRule["often-fixed"].suggestion).toBe("add-guidance");
    expect(byRule["often-kept"].suggestion).toBe("review-rule");
  });

  test("a single noisy session is only watched", () => {
    const records = [check("a", "x.ts", ["r"]), check("a", "x.ts", []), check("a", "z.ts", ["r"]), check("a", "z.ts", [])];
    expect(summarize(records)[0].suggestion).toBe("watch");
  });
});
