import { describe, expect, test } from "bun:test";
import type { CheckRecord } from "../src/findingsLog";
import { unresolved } from "../src/recheck";

const rec = (over: Partial<CheckRecord>): CheckRecord => ({
  ts: "2026-09-27T12:00:00.000Z",
  session: "s1",
  repo: "/r",
  file: "a.ts",
  tool: "Edit",
  changeKind: "edit",
  model: "m",
  flagged: [],
  ...over,
});
const NOW = Date.parse("2026-09-27T13:00:00.000Z");
const flag = [{ rule: "ts-no-empty-catch", p: 0.9, tier: "high" as const }];

describe("recheck: which files still need an outcome", () => {
  test("only files whose latest check in this session still has findings", () => {
    const records = [
      rec({ file: "a.ts", flagged: flag }),
      rec({ file: "b.ts", flagged: flag }),
      rec({ file: "b.ts", ts: "2026-09-27T12:30:00.000Z" }), // fixed later
      rec({ file: "c.ts", flagged: flag, session: "other" }),
    ];
    expect(unresolved(records, { session_id: "s1" }, NOW).map((r) => r.file)).toEqual(["a.ts"]);
  });

  test("SubagentStop only looks at that subagent's files; re-checked files are skipped until edited again", () => {
    const records = [
      rec({ file: "a.ts", flagged: flag, agent: "sub1" }),
      rec({ file: "b.ts", flagged: flag, agent: "sub2" }),
      rec({ file: "c.ts", flagged: flag }),
      rec({ file: "c.ts", flagged: flag, tool: "recheck", ts: "2026-09-27T12:40:00.000Z" }),
    ];
    expect(unresolved(records, { session_id: "s1", agent_id: "sub1" }, NOW).map((r) => r.file)).toEqual(["a.ts"]);
    expect(
      unresolved(records, { session_id: "s1" }, NOW)
        .map((r) => r.file)
        .sort(),
    ).toEqual(["a.ts", "b.ts"]);
  });

  test("ignores records older than a day", () => {
    expect(unresolved([rec({ flagged: flag, ts: "2026-09-25T12:00:00.000Z" })], { session_id: "s1" }, NOW)).toEqual([]);
  });
});
