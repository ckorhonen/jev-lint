// "Is the hook worth it, if a code reviewer would catch the issue anyway?"
//   E2E_TAG=entry5 E2E_ROOT=<runs dir> bun eval/e2e/remediate.ts --conditions none,jev,jev-rewake
//
// For each finished E2E run, the AI reviewer's findings (all of them, as a real review would
// send them) go back to the agent in a copy of its work directory: one fix round with Claude
// Code headless, no hook. We record the round's cost and time and collect the final files so
// grade.ts can score them (tag `<tag>-fix`). Runs with no review findings need no round.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const REPO = join(import.meta.dir, "../..");
const TAG = process.env.E2E_TAG ?? "entry5";
const E2E_ROOT = process.env.E2E_ROOT as string;
const { values: args } = parseArgs({
  options: {
    conditions: { type: "string", default: "none,jev,jev-rewake" },
    concurrency: { type: "string", default: "4" },
    model: { type: "string", default: "sonnet" },
    // Keep the async Jev hook on during the fix round too (the realistic always-on setup).
    hook: { type: "boolean", default: false },
  },
});

type Finding = { file: string; line: number; severity: string; title: string; explanation: string; rule: string };
type Reviewed = { task: string; lang: "typescript" | "swift"; condition: string; rep: number; findings: Finding[] };

function prompt(findings: Finding[]) {
  const list = findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.file}:${f.line} — ${f.title}. ${f.explanation}`).join("\n");
  return `A code reviewer left these comments on your change. Address each one in the code, or if you disagree, leave it and say why in one line. Keep the build passing.\n\n${list}`;
}

function sourceFiles(dir: string, lang: string) {
  const root = join(dir, lang === "typescript" ? "src" : "Sources/App");
  const ext = lang === "typescript" ? /\.(ts|tsx)$/ : /\.swift$/;
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (ext.test(n)) out.push(f);
    }
  };
  walk(root);
  return out;
}

function runClaude(text: string, cwd: string, runDir: string) {
  const settings = join(runDir, "settings.json");
  const hook = {
    type: "command",
    command: `JEV_LINT_MODE=rewake JEV_LINT_FINDINGS_LOG='${join(runDir, "findings.jsonl")}' JEV_LINT_LOG='${join(runDir, "jev-log.jsonl")}' bun '${join(REPO, "src/hook.ts")}'`,
    timeout: 180,
    asyncRewake: true,
  };
  writeFileSync(settings, JSON.stringify(args.hook ? { hooks: { PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [hook] }] } } : { hooks: {} }));
  const cli = ["-p", text, "--model", args.model as string, "--setting-sources", "project", "--settings", settings, "--strict-mcp-config",
    "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "3", "--no-session-persistence"];
  const started = Date.now();
  return new Promise<{ wallMs: number; costUsd: number; durationMs: number; turns: number }>((resolve) => {
    const child = spawn("claude", cli, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    const killer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.on("close", () => {
      clearTimeout(killer);
      const text = Buffer.concat(out).toString();
      writeFileSync(join(runDir, "transcript.jsonl"), text);
      let result: Record<string, unknown> = {};
      for (const line of text.split("\n")) {
        try {
          const m = JSON.parse(line);
          if (m.type === "result") result = m;
        } catch {}
      }
      resolve({ wallMs: Date.now() - started, costUsd: Number(result.total_cost_usd ?? 0), durationMs: Number(result.duration_ms ?? 0), turns: Number(result.num_turns ?? 0) });
    });
  });
}

async function main() {
  const conditions = (args.conditions as string).split(",");
  const reviewed = (JSON.parse(readFileSync(join(REPO, `eval/results/e2e-review-${TAG}.json`), "utf8")) as Reviewed[]).filter((r) =>
    conditions.includes(r.condition),
  );
  const runs = JSON.parse(readFileSync(join(REPO, `eval/results/e2e-runs-${TAG}.json`), "utf8")) as Record<string, any>[];
  const results: unknown[] = [];
  const queue = [...reviewed];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const base = runs.find((x) => x.task === r.task && x.condition === r.condition && x.rep === r.rep);
      const srcWork = join(E2E_ROOT, r.task, `${r.condition}-r${r.rep}`, "work");
      const suffix = args.hook ? "fixhook" : "fix";
      const runDir = join(E2E_ROOT, r.task, `${r.condition}-r${r.rep}-${suffix}`);
      const done = join(runDir, "result.json");
      if (existsSync(done)) {
        results.push(JSON.parse(readFileSync(done, "utf8")));
        continue;
      }
      mkdirSync(runDir, { recursive: true });
      const work = join(runDir, "work");
      cpSync(srcWork, work, { recursive: true, verbatimSymlinks: true, filter: (s) => !s.includes(".build") });
      const fix = r.findings.length ? await runClaude(prompt(r.findings), work, runDir) : { wallMs: 0, costUsd: 0, durationMs: 0, turns: 0 };
      const files = sourceFiles(work, r.lang).map((f) => ({ path: relative(work, f), content: readFileSync(f, "utf8") }));
      const result = {
        task: r.task, lang: r.lang, condition: `${r.condition}+${suffix}`, rep: r.rep, reviewFindings: r.findings.length,
        ruleCoveredFindings: r.findings.filter((f) => f.rule !== "none").length,
        fix, build: { ok: true }, transcript: { ...(base?.transcript ?? {}), costUsd: fix.costUsd, durationMs: fix.durationMs },
        hook: base?.hook ?? {}, original: { costUsd: base?.transcript?.costUsd, durationMs: base?.transcript?.durationMs }, files,
      };
      writeFileSync(done, JSON.stringify(result, null, 2));
      results.push(result);
      console.error(`fixed ${r.task} ${r.condition} r${r.rep}: ${r.findings.length} comments, $${fix.costUsd.toFixed(3)}, ${Math.round(fix.durationMs / 1000)}s`);
    }
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  writeFileSync(join(REPO, `eval/results/e2e-runs-${TAG}-${args.hook ? "fixhook" : "fix"}.json`), JSON.stringify(results, null, 2));
  console.error(`wrote ${results.length} fix rounds`);
}

await main();
