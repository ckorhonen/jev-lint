import { describe, expect, test } from "bun:test";
import { areaOf, clusters, compare, summarize, threadOf, wilsonLower } from "../src/findings";
import { type CheckRecord, toRecords } from "../src/findingsLog";

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
    for (const session of ["a", "b", "c", "d", "e"]) records.push(check(session, "x.ts", ["often-fixed"]), check(session, "x.ts", []));
    for (const session of ["f", "g", "h", "i", "j"])
      records.push(check(session, "y.ts", ["often-kept"]), check(session, "y.ts", ["often-kept"]));
    const byRule = Object.fromEntries(summarize(records).map((s) => [s.rule, s]));
    expect(byRule["often-fixed"].suggestion).toBe("add-guidance");
    expect(byRule["often-kept"].suggestion).toBe("review-rule");
  });

  test("a single noisy session is only watched", () => {
    const records = [check("a", "x.ts", ["r"]), check("a", "x.ts", []), check("a", "z.ts", ["r"]), check("a", "z.ts", [])];
    expect(summarize(records)[0].suggestion).toBe("watch");
  });

  test("three events across three sessions is still only watched", () => {
    const records: CheckRecord[] = [];
    for (const session of ["a", "b", "c"]) records.push(check(session, "x.ts", ["r"]), check(session, "x.ts", []));
    expect(summarize(records)[0].suggestion).toBe("watch");
  });

  test("a rule ignored 3 of 5 times is not yet a confident review-rule", () => {
    const records: CheckRecord[] = [];
    for (const s of ["a", "b", "c"]) records.push(check(s, "y.ts", ["r"]), check(s, "y.ts", ["r"]));
    for (const s of ["d", "e"]) records.push(check(s, "y.ts", ["r"]), check(s, "y.ts", []));
    expect(summarize(records)[0].suggestion).toBe("watch");
  });
});

describe("clusters and comparisons", () => {
  test("wilsonLower is conservative for small samples", () => {
    expect(wilsonLower(5, 5)).toBeCloseTo(0.566, 2);
    expect(wilsonLower(0, 0)).toBe(0);
  });

  test("areaOf keeps two directory levels and marks tests", () => {
    expect(areaOf("/repo", "/repo/apps/web/src/x.test.ts")).toEqual({ area: "apps/web", test: true });
    expect(areaOf("/repo", "/repo/x.ts")).toEqual({ area: "(root)", test: false });
    expect(areaOf("/repo", "apps/tools/inbox/x.test.mjs")).toEqual({ area: "apps/tools", test: true });
  });

  test("the same rule splits into a test cluster and a source cluster", () => {
    const records: CheckRecord[] = [];
    for (const s of ["a", "b", "c", "d", "e"]) {
      records.push(check(s, "/repo/src/a.test.ts", ["magic"]), check(s, "/repo/src/a.test.ts", ["magic"]));
      records.push(check(s, "/repo/src/a.ts", ["magic"]), check(s, "/repo/src/a.ts", []));
    }
    const byTest = Object.fromEntries(clusters(records).map((c) => [String(c.test), c]));
    expect(byTest.true.action).toBe("review-rule");
    expect(byTest.false.action).toBe("add-guidance");
    expect(byTest.false.per100Checks).toBe(50);
  });

  test("compare reports the rate change around a date with a bootstrap interval", () => {
    clock = 0;
    const records: CheckRecord[] = [];
    for (const s of ["a", "b", "c", "d"]) records.push(check(s, "x.ts", ["r"]), check(s, "x.ts", []));
    const at = new Date(Date.UTC(2026, 8, 26) + clock + 1).toISOString();
    for (const s of ["e", "f", "g", "h"]) records.push(check(s, "x.ts", []), check(s, "x.ts", []));
    const c = compare(records, "r", at, 500);
    expect(c.before.per100Checks).toBe(50);
    expect(c.after.per100Checks).toBe(0);
    expect(c.ci95[1]).toBeLessThan(0);
  });
});

describe("threads", () => {
  const sub = (session: string, agent: string, file: string, rules: string[]) => ({ ...check(session, file, rules), agent });

  test("records without agent key by session, so older logs still work", () => {
    expect(threadOf({ session: "s" })).toBe("s");
    expect(threadOf({})).toBe("?");
    expect(threadOf({ session: "s", agent: "a1" })).toBe("s/a1");
  });

  test("subagents sharing a session_id keep separate outcomes for the same file", () => {
    // Subagent a1 flags and never returns; a2 later writes the file cleanly. Keyed by session
    // alone that would read as "fixed"; per thread it is unknown for a1.
    const [s] = summarize([sub("root", "a1", "x.ts", ["r"]), sub("root", "a2", "x.ts", [])]);
    expect([s.fixed, s.kept, s.unknown]).toEqual([0, 0, 1]);
  });

  test("subagents of one conversation count as one session", () => {
    const records = ["a1", "a2", "a3"].flatMap((a) => [sub("root", a, "x.ts", ["r"]), sub("root", a, "x.ts", [])]);
    const [s] = summarize(records);
    expect([s.fixed, s.sessions]).toEqual([3, 1]);
  });

  test("toRecords stores agent_id only when the hook fired inside a subagent", () => {
    const result = { filePath: "/repo/x.ts", changeKind: "edit" as const, model: "m", findings: [], latencyMs: 1 };
    const change = { filePath: "/repo/x.ts", addedCode: "x", changeKind: "edit" as const };
    const [main] = toRecords([result] as never, [change], { session_id: "root", cwd: "/repo" });
    const [child] = toRecords([result] as never, [change], { session_id: "root", agent_id: "t2", cwd: "/repo" });
    expect(main.agent).toBeUndefined();
    expect("agent" in main).toBe(false);
    expect([child.session, child.agent]).toEqual(["root", "t2"]);
  });
});
