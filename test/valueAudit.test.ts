import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findingsOf, loadRecords } from "../src/findings";
import { type CheckRecord, findingsLogPath } from "../src/findingsLog";
import { audit, auditPrompt, excerptKind, formatTable, type Grader, isGrade, ruleById, tabulate } from "../src/valueAudit";

const dir = mkdtempSync(join(tmpdir(), "jev-lint-audit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let clock = 0;
function rec(session: string, file: string, rules: string[], extra: Partial<CheckRecord> = {}): CheckRecord {
  clock += 1000;
  return {
    ts: new Date(Date.now() - 86_400_000 + clock).toISOString(),
    session,
    repo: "/repo",
    file,
    changeKind: "write",
    model: "m",
    flagged: rules.map((rule) => ({ rule, p: 0.9, tier: "high" as const })),
    ...(rules.length ? { excerpt: 'import { x } from "./x";' } : {}),
    ...extra,
  };
}

// a: fixed (old header excerpt), b: kept (edit, new lines window), c: unknown (never rechecked)
const records = [
  rec("s1", "a.ts", ["ts-no-explicit-any"]),
  rec("s1", "a.ts", []),
  rec("s2", "b.ts", ["ts-no-empty-catch"], {
    changeKind: "edit",
    flagged: [{ rule: "ts-no-empty-catch", p: 0.7, tier: "medium", lines: { start: 4, text: "try { f() } catch {}" } }],
  }),
  rec("s2", "b.ts", ["ts-no-empty-catch"], { changeKind: "edit" }),
  rec("s3", "c.ts", ["ts-no-debug-console"]),
];

describe("value audit", () => {
  test("reads the log named by JEV_LINT_FINDINGS_LOG and grades only fixed or kept findings", async () => {
    const log = join(dir, "findings.jsonl");
    writeFileSync(log, records.map((r) => JSON.stringify(r)).join("\n"));
    const before = process.env.JEV_LINT_FINDINGS_LOG;
    process.env.JEV_LINT_FINDINGS_LOG = log;
    try {
      const path = findingsLogPath() as string;
      const findings = findingsOf(loadRecords(path, { days: 30 }));
      const prompts: string[] = [];
      const fake: Grader = async (prompt) => {
        prompts.push(prompt);
        const verdict = prompt.includes("ts-no-empty-catch") ? "bug" : "style";
        return { grade: { verdict, confidence: 0.8, reason: "r" }, cached: false, inputTokens: 10, outputTokens: 5 };
      };
      const graded = await audit(findings, fake);
      expect(graded.map((g) => [g.rule, g.outcome, g.excerptKind])).toEqual([
        ["ts-no-explicit-any", "fixed", "file-header"],
        ["ts-no-empty-catch", "kept", "flagged-lines"],
      ]);
      expect(prompts).toHaveLength(2);
      const t = tabulate(graded);
      expect(t.total.all).toMatchObject({ n: 2, worthy: 1, style: 1, noise: 0 });
      expect(t.rules.find((r) => r.rule === "ts-no-empty-catch")?.kept).toMatchObject({ n: 1, worthy: 1 });
      expect(t.byExcerpt["file-header"].all.n).toBe(1);
      expect(formatTable(t)).toContain("TOTAL");
    } finally {
      if (before === undefined) delete process.env.JEV_LINT_FINDINGS_LOG;
      else process.env.JEV_LINT_FINDINGS_LOG = before;
    }
  });

  test("the prompt carries the rule text and says when the excerpt is only the file header", () => {
    const [header, lines] = findingsOf(records).filter((f) => f.outcome !== "unknown");
    const rule = ruleById(header.rule, header.repo, header.file);
    expect(rule?.question).toBeTruthy();
    const p = auditPrompt(header, rule);
    expect(excerptKind(header)).toBe("file-header");
    expect(p).toContain(rule?.fix as string);
    expect(p).toContain("FIRST 400 CHARACTERS");
    expect(p).toContain("Outcome: fixed");
    const q = auditPrompt(lines, ruleById(lines.rule, lines.repo, lines.file));
    expect(q).toContain("window around the first line");
    expect(q).toContain("try { f() } catch {}");
    expect(auditPrompt(lines, undefined)).toContain("rule text unavailable");
  });

  test("grades must match the schema", () => {
    expect(isGrade({ verdict: "noise", confidence: 0.4, reason: "x" })).toBe(true);
    expect(isGrade({ verdict: "maybe", confidence: 0.4, reason: "x" })).toBe(false);
    expect(isGrade({ verdict: "bug", confidence: "high", reason: "x" })).toBe(false);
  });
});
