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

describe("files outside the working repo are skipped", () => {
  test("scratchpad and /tmp files are outside; repo files and relative patch paths are inside", async () => {
    const { isInsideRepo } = await import("../src/findingsLog");
    const repo = makeRepo("g");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(isInsideRepo(join(repo, "src/deep/file.ts"), join(repo, "src"))).toBe(true);
    expect(isInsideRepo("src/file.ts", repo)).toBe(true);
    expect(isInsideRepo("/private/tmp/claude-501/scratchpad/dbg.ts", repo)).toBe(false);
    expect(isInsideRepo(join(root, "elsewhere/x.ts"), repo)).toBe(false);
  });

  test("config.json disable and skipPaths turn off single rules", () => {
    const repo = makeRepo("h", {
      disable: ["ts-no-explicit-any"],
      skipPaths: { "ts-no-magic-numbers": ["**/*.test.ts"], "repo-x": ["["] },
    });
    const ids = (f: string) => ruleSetFor(join(repo, f))?.rules.map((r) => r.id) ?? [];
    expect(ids("src/a.ts")).not.toContain("ts-no-explicit-any");
    expect(ids("src/a.ts")).toContain("ts-no-magic-numbers");
    expect(ids("src/a.test.ts")).not.toContain("ts-no-magic-numbers");
    expect(ids("src/a.test.ts")).toContain("repo-x"); // an invalid pattern is ignored
  });

  test("a rule's paths globs narrow where it is asked", () => {
    const dir = join(root, "i");
    mkdirSync(join(dir, ".jev-lint"), { recursive: true });
    const scoped = { ...rule, id: "repo-routes", paths: ["src/routes/**"] };
    const tsx = { ...rule, id: "repo-tsx", paths: ["**/*.tsx"] };
    writeFileSync(
      join(dir, ".jev-lint/ts.rules.json"),
      JSON.stringify({ language: "typescript", extensions: [".ts", ".tsx"], rules: [scoped, tsx] }),
    );
    writeFileSync(join(dir, ".jev-lint/config.json"), JSON.stringify({ packs: ["repo"] }));
    const ids = (f: string) => ruleSetFor(join(dir, f))?.rules.map((r) => r.id) ?? [];
    expect(ids("src/routes/users.ts")).toEqual(["repo-routes"]);
    expect(ids("src/components/Button.tsx")).toEqual(["repo-tsx"]);
    expect(ids("src/lib/a.ts")).toEqual([]);
  });
});
