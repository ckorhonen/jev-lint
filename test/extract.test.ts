import { describe, expect, test } from "bun:test";
import { extractChanges, parseApplyPatch } from "../src/extract";
import { formatFeedback, ruleSetFor, tierFor } from "../src/lint";

describe("extractChanges", () => {
  test("Write returns full content", () => {
    expect(extractChanges({ tool_name: "Write", tool_input: { file_path: "a.ts", content: "x" } })).toEqual([
      { filePath: "a.ts", addedCode: "x", changeKind: "write" },
    ]);
  });

  test("Edit returns only new_string", () => {
    const [change] = extractChanges({ tool_name: "Edit", tool_input: { file_path: "a.ts", old_string: "old", new_string: "new" } });
    expect(change.addedCode).toBe("new");
  });

  test("MultiEdit joins every new_string", () => {
    const [change] = extractChanges({
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "a.swift",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      },
    });
    expect(change.addedCode).toBe("b\n\nd");
  });

  test("unrelated tools produce nothing", () => {
    expect(extractChanges({ tool_name: "Bash", tool_input: { command: "ls" } })).toEqual([]);
  });
});

describe("parseApplyPatch", () => {
  test("keeps + lines per file and skips deletes, context and - lines", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ function f",
      " context",
      "-removed",
      "+added one",
      "+added two",
      "*** Add File: src/b.ts",
      "+new file",
      "*** Delete File: src/c.ts",
      "*** End Patch",
    ].join("\n");
    expect(parseApplyPatch(patch)).toEqual([
      { filePath: "src/a.ts", addedCode: "added one\nadded two", changeKind: "patch" },
      { filePath: "src/b.ts", addedCode: "new file", changeKind: "patch" },
    ]);
  });

  test("CRLF patches parse like LF patches", () => {
    const patch = "*** Begin Patch\r\n*** Update File: src/a.ts\r\n@@\r\n-old\r\n+new line\r\n*** End Patch\r\n";
    expect(parseApplyPatch(patch)).toEqual([{ filePath: "src/a.ts", addedCode: "new line", changeKind: "patch" }]);
  });

  test("a patch with only removals yields nothing", () => {
    expect(parseApplyPatch("*** Begin Patch\n*** Update File: a.ts\n-x\n*** End Patch")).toEqual([]);
  });
});

describe("lint helpers", () => {
  test("language routing by extension", () => {
    expect(ruleSetFor("/x/App.swift")?.language).toBe("swift");
    expect(ruleSetFor("/x/page.TSX")?.language).toBe("typescript");
    expect(ruleSetFor("/x/README.md")).toBeUndefined();
  });

  test("tiers", () => {
    const t = { high: 0.8, medium: 0.5 };
    expect(tierFor(0.95, t)).toBe("high");
    expect(tierFor(0.6, t)).toBe("medium");
    expect(tierFor(0.2, t)).toBeUndefined();
  });

  test("feedback is empty when there are no findings", () => {
    const base = {
      filePath: "a.ts",
      changeKind: "edit" as const,
      language: "typescript",
      probabilities: {},
      latencyMs: 1,
      inputTokens: 1,
      model: "m",
      asked: 1,
      gatedOut: 0,
    };
    expect(formatFeedback([{ ...base, findings: [] }])).toBe("");
    const text = formatFeedback([{ ...base, findings: [{ ruleId: "r", probability: 0.6, tier: "medium", fix: "do x" }] }]);
    expect(text).toContain("double-check");
    expect(text).toContain("r (p=0.60): do x");
    expect(text).toContain("only the code this edit added");
    const whole = formatFeedback([{ ...base, changeKind: "write", findings: [{ ruleId: "r", probability: 0.9, tier: "high", fix: "x" }] }]);
    expect(whole).toContain("whole file");
  });
});

describe("rule gate", () => {
  test("a rule with no matching `when` pattern is skipped; rules without `when` always apply", async () => {
    const { gateRules } = await import("../src/lint");
    const set = {
      language: "typescript",
      extensions: [".ts"],
      rules: [
        { id: "effect", question: "q", true: "t", false: "f", fix: "x", when: ["useEffect"] },
        { id: "always", question: "q", true: "t", false: "f", fix: "x" },
        { id: "broken", question: "q", true: "t", false: "f", fix: "x", when: ["(unclosed"] },
      ],
    };
    expect(gateRules(set, "const a = 1;").rules.map((r) => r.id)).toEqual(["always", "broken"]);
    expect(gateRules(set, "useEffect(() => {}, [])").rules.map((r) => r.id)).toEqual(["effect", "always", "broken"]);
  });
});
