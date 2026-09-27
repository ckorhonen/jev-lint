import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_PACKS, RULE_FILES, ruleSetFor, ruleSetMatches } from "../src/lint";

describe("built-in packs", () => {
  test("rule files load into their packs by file name", () => {
    expect(BUILT_IN_PACKS).toContain("tests");
    expect(RULE_FILES.tests.flatMap((s) => s.rules.map((r) => r.id))).toContain("ts-test-cannot-fail");
    expect(RULE_FILES.practices.flatMap((s) => s.rules.map((r) => r.id))).not.toContain("ts-test-cannot-fail");
  });

  test("rule ids are unique across every built-in pack", () => {
    const ids = Object.values(RULE_FILES).flatMap((sets) => sets.flatMap((s) => s.rules.map((r) => r.id)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every built-in rule has the required fields and a compiling gate", () => {
    for (const set of Object.values(RULE_FILES).flat())
      for (const r of set.rules) {
        expect(r.question.startsWith("Does `added_code`")).toBe(true);
        expect(r.true && r.false && r.fix).toBeTruthy();
        for (const w of r.when ?? []) expect(() => new RegExp(w, "im")).not.toThrow();
      }
  });
});

describe("file matching", () => {
  test("a rule set matches by extension or exact file name", () => {
    const bazel = { language: "bazel", extensions: [".bzl", ".bazel"], filenames: ["BUILD", "WORKSPACE"], rules: [] };
    expect(ruleSetMatches(bazel, "/r/pkg/BUILD")).toBe(true);
    expect(ruleSetMatches(bazel, "/r/pkg/BUILD.bazel")).toBe(true);
    expect(ruleSetMatches(bazel, "/r/defs.bzl")).toBe(true);
    expect(ruleSetMatches(bazel, "/r/BUILDING.md")).toBe(false);
  });

  test("repo rule sets can match extension-less files", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-lint-packs-"));
    mkdirSync(join(dir, ".jev-lint"));
    const rule = { id: "repo-bzl", question: "Does `added_code` do X?", true: "y", false: "n", fix: "f" };
    writeFileSync(
      join(dir, ".jev-lint/bazel.rules.json"),
      JSON.stringify({ language: "bazel", extensions: [".bzl"], filenames: ["BUILD"], rules: [rule] }),
    );
    writeFileSync(join(dir, ".jev-lint/config.json"), JSON.stringify({ packs: ["repo"] }));
    expect(ruleSetFor(join(dir, "pkg/BUILD"))?.rules.map((r) => r.id)).toEqual(["repo-bzl"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("candidate rules are skipped by the hook and included when JEV_LINT_CANDIDATES=on", () => {
    const hasCandidates = RULE_FILES.practices.some((s) => s.language === "python" && s.rules.some((r) => r.status === "candidate"));
    if (!hasCandidates) return;
    delete process.env.JEV_LINT_CANDIDATES;
    expect(ruleSetFor("/tmp/x/app.py", ["practices"])).toBeUndefined();
    process.env.JEV_LINT_CANDIDATES = "on";
    expect(ruleSetFor("/tmp/x/app.py", ["practices"])?.rules.length).toBeGreaterThan(0);
    delete process.env.JEV_LINT_CANDIDATES;
  });
});
