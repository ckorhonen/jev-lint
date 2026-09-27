#!/usr/bin/env bun
// Prove that a change to a repo's agent instructions, skills or rules helps, before keeping it.
// Runs small tasks from `.jev-lint/evals/*.json` with a headless coding agent twice: once on a
// clean copy of the base commit, once on a copy of the working tree (your proposed change).
// The jev-lint hook is OFF in both, so only the instructions differ. Jev then checks the code
// the agent wrote against each task's target rules.
//
//   bun ~/Repos/jev-lint/src/repoEval.ts [--base HEAD] [--reps 3] [--agent claude|codex] [--tasks a,b]
//
// Task file (.jev-lint/evals/<name>.json):
//   { "prompt": "Add an endpoint that …", "rules": ["repo-no-direct-db-in-routes"], "reps": 3 }
// Results: .jev-lint/evals/results/<timestamp>.json (gitignore it if you prefer).

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { lintChange } from "./lint";

const RUN_TIMEOUT_MS = 20 * 60_000;
const CHECK_TIMEOUT_MS = 30_000;
const BOOTSTRAP_REPS = 2000;

type Task = { name: string; prompt: string; rules: string[]; reps?: number };
type RunResult = {
  task: string;
  condition: "base" | "change";
  rep: number;
  exitCode: number;
  wallMs: number;
  files: string[];
  violations: number;
  byRule: Record<string, number>;
};

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "HEAD" },
    reps: { type: "string" },
    agent: { type: "string", default: "claude" },
    model: { type: "string" },
    tasks: { type: "string" },
    repo: { type: "string", default: "." },
  },
});

const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });

function loadTasks(repo: string): Task[] {
  const dir = join(repo, ".jev-lint/evals");
  if (!existsSync(dir)) throw new Error(`no ${dir}; add task files first (see docs/feedback-loop.md)`);
  const wanted = args.tasks?.split(",");
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      const t = JSON.parse(readFileSync(join(dir, n), "utf8")) as Partial<Task>;
      if (typeof t.prompt !== "string" || !Array.isArray(t.rules)) throw new Error(`${n}: needs "prompt" and "rules"`);
      return { name: n.replace(/\.json$/, ""), prompt: t.prompt, rules: t.rules, reps: t.reps };
    })
    .filter((t) => !wanted || wanted.includes(t.name));
}

// A plain directory with the repo's files, committed so the agent's changes can be diffed.
export function snapshot(repo: string, condition: "base" | "change", into: string) {
  mkdirSync(into, { recursive: true });
  if (condition === "base") {
    // No shell: the ref and paths go to git and tar as plain arguments.
    const tarball = join(into, "..", `${Date.now()}-base.tar`);
    const archive = git(repo, "archive", "--format=tar", "-o", tarball, args.base as string);
    if (archive.status !== 0) throw new Error(`git archive ${args.base}: ${archive.stderr}`);
    const untar = spawnSync("tar", ["-xf", tarball, "-C", into], { encoding: "utf8" });
    rmSync(tarball, { force: true });
    if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
  } else {
    // Tracked and untracked-but-not-ignored files, as they are on disk now.
    const listed = git(repo, "ls-files", "--cached", "--others", "--exclude-standard").stdout.split("\n").filter(Boolean);
    for (const f of listed) {
      if (!existsSync(join(repo, f))) continue;
      mkdirSync(dirname(join(into, f)), { recursive: true });
      cpSync(join(repo, f), join(into, f));
    }
  }
  git(into, "init", "-q");
  git(into, "add", "-A");
  git(into, "-c", "user.email=eval@jev-lint", "-c", "user.name=jev-lint eval", "commit", "-qm", "snapshot");
}

function runAgent(dir: string, prompt: string): Promise<{ exitCode: number; wallMs: number }> {
  const [cmd, cliArgs, env] =
    args.agent === "codex"
      ? (() => {
          // An empty CODEX_HOME (plus the user's login) means no hooks and no user config.
          const home = mkdtempSync(join(tmpdir(), "jev-lint-codexhome-"));
          const auth = join(process.env.HOME ?? "", ".codex/auth.json");
          if (existsSync(auth)) cpSync(auth, join(home, "auth.json"));
          return [
            process.env.CODEX_BIN ?? "codex",
            ["exec", "--skip-git-repo-check", "-s", "workspace-write", ...(args.model ? ["-m", args.model] : []), prompt],
            { ...process.env, CODEX_HOME: home },
          ] as const;
        })()
      : ([
          "claude",
          [
            "-p",
            prompt,
            "--settings",
            JSON.stringify({ disableAllHooks: true }),
            "--permission-mode",
            "acceptEdits",
            "--output-format",
            "json",
            "--no-session-persistence",
            ...(args.model ? ["--model", args.model] : []),
          ],
          process.env,
        ] as const);
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(cmd, [...cliArgs], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
    const killer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(killer);
      done({ exitCode: code ?? -1, wallMs: Date.now() - started });
    });
  });
}

// Jev on each file the agent added or changed (only the lines it added), counting target rules.
export async function judge(dir: string, rules: string[]) {
  const changed = git(dir, "diff", "--name-only", "HEAD").stdout.split("\n").filter(Boolean);
  const added = git(dir, "ls-files", "--others", "--exclude-standard").stdout.split("\n").filter(Boolean);
  const byRule: Record<string, number> = Object.fromEntries(rules.map((r) => [r, 0]));
  const files = [...changed, ...added];
  for (const file of files) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const addedCode = added.includes(file)
      ? readFileSync(path, "utf8")
      : git(dir, "diff", "-U0", "HEAD", "--", file)
          .stdout.split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1))
          .join("\n");
    if (!addedCode.trim()) continue;
    const result = await lintChange(
      { filePath: path, addedCode, changeKind: added.includes(file) ? "write" : "edit" },
      { timeoutMs: CHECK_TIMEOUT_MS, cwd: dir },
    ).catch(() => undefined);
    for (const f of result?.findings ?? []) if (f.ruleId in byRule) byRule[f.ruleId]++;
  }
  return { files, byRule, violations: Object.values(byRule).reduce((a, b) => a + b, 0) };
}

function pairedBootstrap(diffs: number[]): [number, number] {
  if (diffs.length < 2) return [Number.NaN, Number.NaN];
  const means: number[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < BOOTSTRAP_REPS; i++) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(rand() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(BOOTSTRAP_REPS * 0.025)], means[Math.floor(BOOTSTRAP_REPS * 0.975)]];
}

async function main() {
  const repo = resolve(args.repo as string);
  const tasks = loadTasks(repo);
  const work = mkdtempSync(join(tmpdir(), "jev-lint-repoeval-"));
  const results: RunResult[] = [];
  for (const task of tasks) {
    const reps = Number(args.reps ?? task.reps ?? 3);
    for (let rep = 1; rep <= reps; rep++) {
      // Alternate the order so time-of-day drift in the agent doesn't favour one side.
      const order: ("base" | "change")[] = rep % 2 ? ["base", "change"] : ["change", "base"];
      for (const condition of order) {
        const dir = join(work, `${task.name}-${condition}-${rep}`);
        snapshot(repo, condition, dir);
        const run = await runAgent(dir, task.prompt);
        const scored = await judge(dir, task.rules);
        results.push({ task: task.name, condition, rep, ...run, ...scored });
        console.error(
          `${task.name} ${condition} #${rep}: ${scored.violations} violation(s) in ${scored.files.length} file(s), ${Math.round(run.wallMs / 1000)} s`,
        );
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  const diffs: number[] = [];
  for (const r of results.filter((x) => x.condition === "change")) {
    const base = results.find((x) => x.condition === "base" && x.task === r.task && x.rep === r.rep);
    if (base) diffs.push(r.violations - base.violations);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
  const baseMean = mean(results.filter((r) => r.condition === "base").map((r) => r.violations));
  const changeMean = mean(results.filter((r) => r.condition === "change").map((r) => r.violations));
  const ci = pairedBootstrap(diffs);
  const summary = {
    generatedAt: new Date().toISOString(),
    base: args.base,
    agent: args.agent,
    tasks: tasks.map((t) => t.name),
    violationsPerRun: { base: baseMean, change: changeMean },
    difference: changeMean - baseMean,
    ci95: ci,
    verdict: Number.isNaN(ci[1]) ? "too few runs" : ci[1] < 0 ? "change helps" : ci[0] > 0 ? "change hurts" : "no clear difference",
    results,
  };
  const outDir = join(repo, ".jev-lint/evals/results");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${summary.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  rmSync(work, { recursive: true, force: true });
  console.log(
    `violations per run: base ${baseMean.toFixed(2)} → change ${changeMean.toFixed(2)} (difference ${summary.difference.toFixed(2)}, 95% CI ${ci[0].toFixed(2)} to ${ci[1].toFixed(2)})`,
  );
  console.log(`${summary.verdict}; ${results.length} agent runs; details in ${out}`);
}

if (import.meta.main) await main();
