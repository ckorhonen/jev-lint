// End-to-end eval: run Claude Code headless on real tasks with and without the hook,
// then grade the final code blind to condition.
//   bun eval/e2e/run.ts --conditions none,jev,jev-high --reps 2 --concurrency 4
// Runs live outside the repo (E2E_ROOT) so no repo-level CLAUDE.md or git state leaks in.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const REPO = join(import.meta.dir, "../..");
const E2E_ROOT = process.env.E2E_ROOT ?? join(process.env.TMPDIR ?? "/tmp", "jev-lint-e2e");

const { values: args } = parseArgs({
  options: {
    conditions: { type: "string", default: "none,jev,jev-high" },
    reps: { type: "string", default: "2" },
    concurrency: { type: "string", default: "4" },
    model: { type: "string", default: "sonnet" },
    tasks: { type: "string", default: "" },
    "tasks-file": { type: "string", default: "eval/e2e/tasks.json" },
    tag: { type: "string", default: "" },
  },
});

// scaffold defaults to lang; "react" is a TypeScript scaffold with React types installed.
type Task = { id: string; lang: "typescript" | "swift"; scaffold?: string; prompt: string };
type Condition = "none" | "jev" | "jev-high";

const HOOK_ENV: Record<Exclude<Condition, "none">, string> = {
  jev: "JEV_LINT_TIERS=high,medium",
  "jev-high": "JEV_LINT_TIERS=high",
};

function settingsFor(condition: Condition, runDir: string) {
  if (condition === "none") return { hooks: {} };
  const command = `${HOOK_ENV[condition]} JEV_LINT_LOG='${join(runDir, "jev-log.jsonl")}' bun '${join(REPO, "src/hook.ts")}'`;
  return { hooks: { PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command, timeout: 15 }] }] } };
}

function runClaude(task: Task, condition: Condition, runDir: string, workDir: string) {
  const settingsPath = join(runDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settingsFor(condition, runDir)));
  const cliArgs = [
    "-p",
    task.prompt,
    "--model",
    args.model as string,
    "--setting-sources",
    "project",
    "--settings",
    settingsPath,
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    "3",
    "--no-session-persistence",
  ];
  const started = Date.now();
  return new Promise<{ exitCode: number; wallMs: number }>((resolve) => {
    const child = spawn("claude", cliArgs, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const killer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      writeFileSync(join(runDir, "transcript.jsonl"), Buffer.concat(out));
      writeFileSync(join(runDir, "stderr.txt"), Buffer.concat(err));
      resolve({ exitCode: code ?? -1, wallMs: Date.now() - started });
    });
  });
}

function sourceFiles(workDir: string, lang: Task["lang"]) {
  const root = join(workDir, lang === "typescript" ? "src" : "Sources/App");
  const ext = lang === "typescript" ? /\.(ts|tsx)$/ : /\.swift$/;
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (ext.test(name)) files.push(full);
    }
  };
  walk(root);
  return files;
}

function buildCheck(workDir: string, lang: Task["lang"]) {
  const result =
    lang === "typescript"
      ? spawnSync(join(REPO, "node_modules/.bin/tsc"), ["--noEmit", "-p", workDir], { encoding: "utf8" })
      : spawnSync("swift", ["build"], { cwd: workDir, encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.slice(-2000) };
}

// Hook feedback is injected as context and does not appear in stream-json, so reaction
// to feedback is measured from the hook log (see hookStats).
function transcriptStats(runDir: string) {
  const lines = readFileSync(join(runDir, "transcript.jsonl"), "utf8").split("\n").filter(Boolean);
  let edits = 0;
  let result: Record<string, unknown> = {};
  for (const line of lines) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "result") result = msg;
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_use" && ["Write", "Edit", "MultiEdit"].includes(block.name)) {
          edits++;
        }
      }
    }
  }
  return {
    edits,
    costUsd: Number(result.total_cost_usd ?? 0),
    durationMs: Number(result.duration_ms ?? 0),
    numTurns: Number(result.num_turns ?? 0),
    isError: Boolean(result.is_error),
  };
}

function hookStats(runDir: string) {
  const file = join(runDir, "jev-log.jsonl");
  if (!existsSync(file))
    return { calls: 0, findingsShown: 0, highShown: 0, mediumShown: 0, errors: 0, meanLatencyMs: 0, editsAfterFeedback: 0 };
  const entries = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const results = entries.flatMap((e) => e.results);
  const findings = results.flatMap((r: any) => r.findings);
  const firstFeedback = entries.findIndex((e) => e.results.some((r: any) => r.findings.length));
  return {
    calls: entries.length,
    findingsShown: findings.length,
    highShown: findings.filter((f: any) => f.tier === "high").length,
    mediumShown: findings.filter((f: any) => f.tier === "medium").length,
    errors: entries.reduce((n, e) => n + e.errors.length, 0),
    meanLatencyMs: results.length ? results.reduce((n: number, r: any) => n + r.latencyMs, 0) / results.length : 0,
    editsAfterFeedback: firstFeedback < 0 ? 0 : entries.length - firstFeedback - 1,
  };
}

async function runOne(task: Task, condition: Condition, rep: number) {
  const runDir = join(E2E_ROOT, task.id, `${condition}-r${rep}`);
  if (existsSync(join(runDir, "result.json"))) return JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
  const workDir = join(runDir, "work");
  mkdirSync(runDir, { recursive: true });
  const scaffold = join(REPO, "eval/e2e/scaffold", task.scaffold ?? task.lang);
  cpSync(scaffold, workDir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes(".build") });
  if (existsSync(join(scaffold, "node_modules"))) symlinkSync(join(scaffold, "node_modules"), join(workDir, "node_modules"));

  const claude = await runClaude(task, condition, runDir, workDir);
  const files = sourceFiles(workDir, task.lang).map((f) => ({ path: relative(workDir, f), content: readFileSync(f, "utf8") }));
  const result = {
    task: task.id,
    lang: task.lang,
    condition,
    rep,
    exitCode: claude.exitCode,
    wallMs: claude.wallMs,
    build: buildCheck(workDir, task.lang),
    transcript: transcriptStats(runDir),
    hook: hookStats(runDir),
    files,
  };
  writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2));
  console.error(
    `done ${task.id} ${condition} r${rep}: build=${result.build.ok} cost=$${result.transcript.costUsd.toFixed(2)} hookFindings=${result.hook.findingsShown}`,
  );
  return result;
}

async function main() {
  const allTasks = JSON.parse(readFileSync(join(REPO, args["tasks-file"] as string), "utf8")) as Task[];
  const only = (args.tasks as string).split(",").filter(Boolean);
  const tasks = only.length ? allTasks.filter((t) => only.includes(t.id)) : allTasks;
  const conditions = (args.conditions as string).split(",") as Condition[];
  const reps = Number(args.reps);

  // Interleave conditions so any drift in model/service behavior hits all of them equally.
  const jobs: [Task, Condition, number][] = [];
  for (let rep = 1; rep <= reps; rep++) for (const task of tasks) for (const c of conditions) jobs.push([task, c, rep]);

  const results: unknown[] = [];
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) results.push(await runOne(...job));
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  mkdirSync(join(REPO, "eval/results"), { recursive: true });
  const out = `eval/results/e2e-runs${args.tag ? `-${args.tag}` : ""}.json`;
  writeFileSync(join(REPO, out), JSON.stringify(results, null, 2));
  console.error(`wrote ${results.length} runs to ${out} (work dirs under ${E2E_ROOT})`);
}

await main();
