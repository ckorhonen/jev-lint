#!/usr/bin/env bun
// List everything in a repo that says what the team values or already enforces, so the
// jev-lint-rules skill reads all of it (not a sample) before proposing rules.
//   bun ~/Repos/jev-lint/src/inventory.ts [repo] [--json]
//
// Groups: agent instructions, skills, docs (README, CONTRIBUTING, style guides, ADRs),
// linter/formatter/type-checker configs, CI and hooks, existing .jev-lint files, and the
// languages actually present (by tracked file count).

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

export type Group = "instructions" | "skills" | "docs" | "linters" | "ci" | "jev-lint" | "referenced";

// First match wins; patterns are tested against the repo-relative path.
const PATTERNS: [Group, RegExp][] = [
  ["jev-lint", /(^|\/)\.jev-lint\//],
  ["skills", /(^|\/)\.(claude|agents|codex|cursor)\/skills\/.+\.md$|(^|\/)SKILL\.md$|(^|\/)skills?\/.+\.md$/i],
  [
    "instructions",
    /(^|\/)(AGENTS|CLAUDE|GEMINI|CODEX)(\.local)?\.md$|(^|\/)\.cursorrules$|(^|\/)\.windsurfrules$|(^|\/)\.cursor\/rules\/|(^|\/)\.github\/(copilot-instructions\.md|instructions\/)|(^|\/)\.claude\/(commands|agents|rules)\/.+\.md$|(^|\/)\.clinerules/i,
  ],
  [
    "linters",
    /(^|\/)(\.?eslint(rc)?(\.[a-z]+)?|eslint\.config\.[a-z]+|biome\.jsonc?|\.oxlintrc\.json|oxlint\.json|tsconfig(\.[\w-]+)?\.json|\.prettierrc(\.[a-z]+)?|prettier\.config\.[a-z]+|\.swiftlint\.ya?ml|\.swiftformat|\.swift-format|ruff\.toml|\.ruff\.toml|pyproject\.toml|setup\.cfg|\.flake8|mypy\.ini|\.pylintrc|\.golangci\.(ya?ml|toml|json)|clippy\.toml|\.clippy\.toml|rustfmt\.toml|Cargo\.toml|detekt(-config)?\.ya?ml|\.editorconfig|\.rubocop(_todo)?\.yml|\.standard\.yml|\.luacheckrc|selene\.toml|stylua\.toml|\.stylua\.toml|sgconfig\.yml|\.semgrep\.ya?ml|\.dependency-cruiser\.[a-z]+|\.importlinter)$/i,
  ],
  [
    "ci",
    /(^|\/)\.github\/workflows\/.+\.ya?ml$|(^|\/)\.gitlab-ci\.yml$|(^|\/)\.circleci\/config\.yml$|(^|\/)\.buildkite\/|(^|\/)(Makefile|justfile|Taskfile\.ya?ml|lefthook\.ya?ml|\.pre-commit-config\.yaml|\.lintstagedrc(\.[a-z]+)?|dangerfile\.[a-z]+)$|(^|\/)\.husky\/[^_]/i,
  ],
  [
    "docs",
    /(^|\/)(README|CONTRIBUTING|STYLE|STYLEGUIDE|CONVENTIONS|ARCHITECTURE|DEVELOPMENT|HACKING|CODING[_-]?(STANDARDS|GUIDELINES))(\.[a-z]+)?$|(^|\/)docs?\/.*(style|convention|guideline|standard|architecture|pattern|practice|contribut|review|adr|decision).*\.(md|mdx|rst|txt)$|(^|\/)(adr|adrs|decisions)\/.+\.(md|mdx)$|^docs?\/[^/]+\.(md|mdx)$/i,
  ],
];

// Directories that hold vendored or generated code, not the team's own guidance.
const IGNORED = /(^|\/)(node_modules|vendor|Pods|Carthage|\.build|build|dist|target|third_party|\.venv|venv)\//;

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript (React)",
  ".js": "javascript",
  ".jsx": "javascript (React)",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".swift": "swift",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".java": "java",
  ".rb": "ruby",
  ".lua": "lua",
  ".luau": "luau",
  ".cs": "csharp",
  ".php": "php",
  ".ex": "elixir",
  ".exs": "elixir",
  ".dart": "dart",
  ".c": "c",
  ".cc": "c++",
  ".cpp": "c++",
  ".m": "objective-c",
  ".scala": "scala",
};

export type Inventory = {
  repo: string;
  languages: { language: string; files: number }[];
  files: Record<Group, { path: string; lines: number }[]>;
};

const countLines = (text: string) => (text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length);

const REFERENCE_EXTS = /\.(md|mdx|txt|rst|json|jsonc|ya?ml|toml)$/i;

// Repo paths a guidance file points at: markdown links and backticked paths, resolved against
// the file's directory and against the repo root.
export function referencedPaths(text: string, from: string): string[] {
  const raw = [
    ...text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g),
    ...text.matchAll(/`([\w./-]+\/[\w.-]+|[\w-]+\.(?:md|json|ya?ml|toml))`/g),
  ].map((m) => m[1]);
  const out = new Set<string>();
  for (const r of raw) {
    if (/^[a-z]+:/i.test(r) || !REFERENCE_EXTS.test(r)) continue;
    const clean = r.replace(/^\.\//, "");
    out.add(clean.replace(/^\//, ""));
    const dir = dirname(from);
    if (dir !== ".") out.add(normalize(join(dir, clean)));
  }
  return [...out];
}

export function classify(path: string): Group | undefined {
  if (IGNORED.test(path)) return undefined;
  return PATTERNS.find(([, re]) => re.test(path))?.[0];
}

export function inventory(repoPath: string): Inventory {
  const repo = resolve(repoPath);
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" });
  if (listed.status !== 0) throw new Error(`${repo} is not a git repository (git ls-files failed)`);
  const paths = listed.stdout.split("\n").filter(Boolean);

  const files = { instructions: [], skills: [], docs: [], linters: [], ci: [], "jev-lint": [], referenced: [] } as Inventory["files"];
  const counts = new Map<string, number>();
  for (const path of paths) {
    const language = IGNORED.test(path) ? undefined : LANGUAGES[extname(path).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    const group = classify(path);
    if (!group) continue;
    const full = join(repo, path);
    let lines = 0;
    try {
      if (statSync(full).isFile()) lines = countLines(readFileSync(full, "utf8"));
    } catch (error) {
      lines = -1; // listed but unreadable (deleted in the worktree, permissions); shown as "?"
      if (process.env.DEBUG) console.error(`inventory: ${path}: ${error}`);
    }
    files[group].push({ path, lines });
  }
  // package.json scripts often wire up linters, so list the root one with the linters.
  if (paths.includes("package.json"))
    files.linters.push({ path: "package.json", lines: countLines(readFileSync(join(repo, "package.json"), "utf8")) });
  // One hop of references: guidance often says "see docs/ownership.md" or `config/rules.json`.
  const listedSet = new Set(Object.values(files).flatMap((list) => list.map((f) => f.path)));
  const tracked = new Set(paths);
  for (const group of ["instructions", "skills", "docs"] as const) {
    for (const f of files[group]) {
      if (f.lines <= 0) continue;
      for (const ref of referencedPaths(readFileSync(join(repo, f.path), "utf8"), f.path)) {
        if (tracked.has(ref) && !listedSet.has(ref) && !IGNORED.test(ref)) {
          listedSet.add(ref);
          files.referenced.push({ path: ref, lines: countLines(readFileSync(join(repo, ref), "utf8")) });
        }
      }
    }
  }
  const languages = [...counts.entries()].map(([language, n]) => ({ language, files: n })).sort((a, b) => b.files - a.files);
  return { repo, languages, files };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { json: { type: "boolean", default: false } }, allowPositionals: true });
  const inv = inventory(positionals[0] ?? process.cwd());
  if (values.json) console.log(JSON.stringify(inv, null, 2));
  else {
    console.log(`# Inventory of ${basename(inv.repo)} (${inv.repo})\n`);
    console.log(`Languages: ${inv.languages.map((l) => `${l.language} ${l.files}`).join(", ") || "none detected"}\n`);
    const titles: Record<Group, string> = {
      instructions: "Agent instructions (read all)",
      skills: "Skills (read all)",
      docs: "Docs: README, CONTRIBUTING, style guides, ADRs (read all)",
      linters: "Linter, formatter and type-checker configs (read all; they decide what Jev must NOT check)",
      ci: "CI, hooks and task runners (read to see which checks actually block)",
      "jev-lint": "Existing jev-lint rules",
      referenced: "Files the guidance above points to (read prose in full; skim data files for conventions)",
    };
    for (const group of Object.keys(titles) as Group[]) {
      const list = inv.files[group];
      console.log(`## ${titles[group]}: ${list.length}`);
      for (const f of list) console.log(`- ${f.path} (${f.lines < 0 ? "?" : f.lines} lines)`);
      console.log();
    }
    const total = Object.values(inv.files).reduce((n, list) => n + list.reduce((m, f) => m + Math.max(f.lines, 0), 0), 0);
    console.log(`Total: ${total} lines to read.`);
  }
}
