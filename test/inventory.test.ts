import { describe, expect, test } from "bun:test";
import { classify, referencedPaths } from "../src/inventory";

describe("inventory classify", () => {
  test.each([
    ["AGENTS.md", "instructions"],
    ["packages/api/CLAUDE.md", "instructions"],
    [".cursor/rules/react.mdc", "instructions"],
    [".github/copilot-instructions.md", "instructions"],
    [".claude/skills/deploy/SKILL.md", "skills"],
    [".agents/skills/x/references/y.md", "skills"],
    ["CONTRIBUTING.md", "docs"],
    ["docs/adr/0003-use-zod.md", "docs"],
    ["docs/style-guide.md", "docs"],
    ["eslint.config.mjs", "linters"],
    [".swiftlint.yml", "linters"],
    ["pyproject.toml", "linters"],
    [".luacheckrc", "linters"],
    [".github/workflows/ci.yml", "ci"],
    [".pre-commit-config.yaml", "ci"],
    [".jev-lint/typescript.rules.json", "jev-lint"],
    ["skill/SKILL.md", "skills"],
    ["docs/ownership.md", "docs"],
  ] as const)("%s is %s", (path, group) => expect(classify(path)).toBe(group));

  test("ignores vendored and generated trees and ordinary docs", () => {
    expect(classify("node_modules/pkg/README.md")).toBeUndefined();
    expect(classify("Pods/Foo/README.md")).toBeUndefined();
    expect(classify("docs/api/users.md")).toBeUndefined();
    expect(classify("src/index.ts")).toBeUndefined();
  });

  test("referencedPaths finds links and backticked paths, relative to the file and the root", () => {
    const text = "See [ownership](ownership.md#table), `config/rules.json`, `src/index.ts` and [site](https://x.dev/a.md).";
    expect(referencedPaths(text, "docs/review.md").sort()).toEqual([
      "config/rules.json",
      "docs/config/rules.json",
      "docs/ownership.md",
      "ownership.md",
    ]);
  });
});
