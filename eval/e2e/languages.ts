// Per-language E2E settings for the rule-pack languages (python, ruby, kotlin, rust, bazel).
// TypeScript and Swift keep their original, hard-coded handling in run.ts/grade.ts/review.ts
// so earlier rounds reproduce exactly.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { LANGUAGES, ruleSetForLanguage, ruleSetMatches } from "../../src/lint";

export const LEGACY_LANGS = ["typescript", "swift"] as const;
export type PackLang = "python" | "ruby" | "kotlin" | "rust" | "bazel";
export type Lang = (typeof LEGACY_LANGS)[number] | PackLang;
export const isLegacy = (lang: string) => (LEGACY_LANGS as readonly string[]).includes(lang);

// Build outputs, caches and vendored code never count as the agent's source.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "build",
  ".gradle",
  ".kotlin",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  "vendor",
  ".bundle",
]);

const BAZEL_NAMES = new Set(["BUILD", "WORKSPACE"]);

// Which files a run of this language collects. Bazel runs also collect the Python sources
// they build (the scaffold is a rules_python workspace); each file is graded with its own rules.
const SOURCE: Record<PackLang, (name: string) => boolean> = {
  python: (n) => n.endsWith(".py"),
  ruby: (n) => /\.(rb|rake)$/.test(n),
  kotlin: (n) => /\.kts?$/.test(n),
  rust: (n) => n.endsWith(".rs"),
  bazel: (n) => BAZEL_NAMES.has(n) || /\.(bazel|bzl|py)$/.test(n),
};

// Reviewer persona for review.ts.
export const REVIEW_STACK: Record<PackLang, string> = {
  python: "Python, FastAPI, SQLAlchemy, asyncio, and pytest",
  ruby: "Ruby, Rails (ActiveRecord, ActionController, ActiveJob), and RSpec",
  kotlin: "Kotlin, coroutines and Flow, Android architecture components, and JUnit",
  rust: "Rust and Tokio async",
  bazel: "Bazel (Starlark BUILD files, macros and rules) and Python",
};

/** Files the agent created or changed: matching sources that differ from the scaffold copy. */
export function packSourceFiles(workDir: string, scaffoldDir: string, lang: PackLang): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith("bazel-")) walk(full);
      } else if (SOURCE[lang](name)) {
        const original = join(scaffoldDir, relative(workDir, full));
        if (!existsSync(original) || readFileSync(original, "utf8") !== readFileSync(full, "utf8")) files.push(full);
      }
    }
  };
  walk(workDir);
  return files.sort();
}

const has = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
const OUTPUT_TAIL = 2000;
const STEP_TIMEOUT_MS = 10 * 60_000;

export type BuildResult = { ok: boolean | null; skipped?: string; output: string };

function run(cmd: string, argv: string[], cwd: string): { ok: boolean; output: string } {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", timeout: STEP_TIMEOUT_MS });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
}

// Compile/load checks, not test runs (agent-written tests may legitimately fail or need
// services). A missing toolchain yields ok: null with `skipped` set, never a failure.
export function packBuildCheck(workDir: string, lang: PackLang): BuildResult {
  const skip = (why: string): BuildResult => ({ ok: null, skipped: why, output: "" });
  const steps: [string, string[]][] = [];
  switch (lang) {
    case "python":
      if (!has("python3")) return skip("python3 not installed");
      steps.push(["python3", ["-m", "compileall", "-q", "-x", "(\\.venv|__pycache__)", "."]]);
      steps.push(["python3", ["-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"]]);
      break;
    case "ruby": {
      if (!has("ruby")) return skip("ruby not installed");
      // Every Ruby file in the work dir (no scaffold dir to diff against, so none are filtered).
      const rb = packSourceFiles(workDir, join(workDir, ".no-scaffold"), "ruby").map((f) => relative(workDir, f));
      for (const f of rb) steps.push(["ruby", ["-c", f]]);
      if (has("rspec")) steps.push(["rspec", ["--dry-run"]]);
      break;
    }
    case "kotlin":
      if (has("gradle") && has("java")) steps.push(["gradle", ["compileTestKotlin", "-q"]]);
      else return skip("gradle/JDK not installed; Kotlin build check skipped");
      break;
    case "rust":
      if (!has("cargo")) return skip("cargo not installed");
      steps.push(["cargo", ["test", "--no-run", "-q"]]);
      break;
    case "bazel":
      if (has("bazel")) steps.push(["bazel", ["query", "//..."]]);
      else if (has("bazelisk")) steps.push(["bazelisk", ["query", "//..."]]);
      else return skip("bazel/bazelisk not installed; Bazel build check skipped");
      break;
  }
  let output = "";
  for (const [cmd, argv] of steps) {
    const r = run(cmd, argv, workDir);
    output += r.output;
    if (!r.ok) return { ok: false, output: `$ ${cmd} ${argv.join(" ")}\n${output}`.slice(-OUTPUT_TAIL) };
  }
  return { ok: true, output: output.slice(-OUTPUT_TAIL) };
}

/**
 * Language whose rules grade this file. Legacy runs always use the run's language (unchanged
 * behaviour); pack runs pick the language whose rule set matches the file (Bazel runs mix
 * BUILD files and Python), falling back to the run's language.
 */
export function fileLanguage(path: string, runLang: string): string {
  if (isLegacy(runLang)) return runLang;
  const own = ruleSetForLanguage(runLang);
  if (own && ruleSetMatches(own, path)) return runLang;
  for (const lang of LANGUAGES) {
    const set = ruleSetForLanguage(lang);
    if (set && ruleSetMatches(set, basename(path))) return lang;
  }
  return runLang;
}
