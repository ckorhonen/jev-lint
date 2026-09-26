import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ruleSetFor } from "../src/lint";
import { findRepoConfig } from "../src/repoRules";

const root = mkdtempSync(join(tmpdir(), "jev-lint-repo-"));
const rule = { id: "repo-x", question: "Does `added_code` do X?", true: "Yes", false: "No", fix: "Don't." };

function makeRepo(name: string, config?: object) {
  const dir = join(root, name);
  mkdirSync(join(dir, ".jev-lint"), { recursive: true });
  mkdirSync(join(dir, "src/deep"), { recursive: true });
  writeFileSync(join(dir, ".jev-lint/ts.rules.json"), JSON.stringify({ language: "typescript", extensions: [".ts"], rules: [rule] }));
  writeFileSync(join(dir, ".jev-lint/broken.rules.json"), "{ not json");
  if (config) writeFileSync(join(dir, ".jev-lint/config.json"), JSON.stringify(config));
  return dir;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("repo rule packs", () => {
  test("finds the nearest .jev-lint above a file and skips malformed files", () => {
    const repo = makeRepo("a");
    const found = findRepoConfig(join(repo, "src/deep/file.ts"));
    expect(found?.ruleSets).toHaveLength(1);
    expect(found?.ruleSets[0].rules[0].id).toBe("repo-x");
  });

  test("repo rules are added to the built-in packs by default", () => {
    const repo = makeRepo("b");
    const ids = ruleSetFor(join(repo, "src/deep/file.ts"))?.rules.map((r) => r.id) ?? [];
    expect(ids).toContain("repo-x");
    expect(ids).toContain("ts-no-explicit-any");
    expect(ids).toContain("react-effect-missing-cleanup");
  });

  test("config.json packs narrows the packs for that repo", () => {
    const repo = makeRepo("c", { packs: ["repo"] });
    expect(ruleSetFor(join(repo, "src/file.ts"))?.rules.map((r) => r.id)).toEqual(["repo-x"]);
  });

  test("explicit packs from the caller win, and relative paths resolve against cwd", () => {
    const repo = makeRepo("d", { packs: ["repo"] });
    expect(ruleSetFor("src/file.ts", ["hygiene"], repo)?.rules.map((r) => r.id)).not.toContain("repo-x");
    expect(ruleSetFor("src/file.ts", ["repo"], repo)?.rules.map((r) => r.id)).toEqual(["repo-x"]);
  });

  test("files with no matching rules get nothing", () => {
    const repo = makeRepo("e", { packs: ["repo"] });
    expect(ruleSetFor(join(repo, "src/file.swift"))).toBeUndefined();
  });
});

describe("hook resolves Codex relative paths against the event cwd", () => {
  test("relative apply_patch path picks up the repo pack from event.cwd, not the hook's own cwd", () => {
    const repo = makeRepo("f", { packs: ["repo"] });
    // Hook subprocess cwd is this repo (no .jev-lint with repo-x); event.cwd points at the target repo.
    expect(ruleSetFor("src/file.ts", undefined, repo)?.rules.map((r) => r.id)).toEqual(["repo-x"]);
    expect(ruleSetFor("src/file.ts", undefined, process.cwd())?.rules.map((r) => r.id)).not.toContain("repo-x");
  });
});
