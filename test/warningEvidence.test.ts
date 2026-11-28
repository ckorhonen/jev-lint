import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warningEvidence } from "../src/warningEvidence";

const rule = {
  id: "ts-boolean-trap",
  true: "multiple positional flags",
  false: "single flag",
  fix: "Use named options.",
  question: "Multiple flags?",
};
test("two wrappers with one flag each have no local evidence span", () => {
  const code = "return judgeJev(c, undefined, false, options);\nreturn judgeJev(c, undefined, false, other);";
  expect(warningEvidence(rule, code).snippetLine).toBeUndefined();
});
test("visible positional flags identify the candidate signature or call", () => {
  expect(warningEvidence(rule, "\nfunction writeConfig(path: string, apply: boolean, recheck: boolean, pre=false) {}").detail).toContain(
    "apply, recheck, pre",
  );
  expect(warningEvidence(rule, "\nwriteConfig(path, true, false);").snippetLine).toBe(2);
});
test("author feedback persists independently of automatic outcomes", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-warning-"));
  try {
    const path = join(dir, "log");
    writeFileSync(
      path,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        repo: dir,
        file: "x.ts",
        session: "example",
        changeKind: "edit",
        tool: "Edit",
        flagged: [{ rule: rule.id, tier: "high", p: 0.99, evidence: warningEvidence(rule, "run(true, false);"), fix: rule.fix }],
      })}\n`,
    );
    const run = (...args: string[]) => {
      const r = Bun.spawnSync([process.execPath, "src/findings.ts", "--log", path, "--rule", rule.id, ...args]);
      expect(r.exitCode).toBe(0);
      return r.stdout.toString();
    };
    const first = JSON.parse(run("--json"))[0];
    expect(first.trigger.detail).toContain("positions 1, 2");
    expect(first.disposition).toBeNull();
    run("--mark", first.id, "--as", "fixed");
    const next = JSON.parse(run("--json"))[0];
    expect(next.disposition).toBe("fixed");
    expect(next.outcome).toBe("unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
