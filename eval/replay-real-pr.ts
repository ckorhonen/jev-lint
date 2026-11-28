// Replay one public benchmark PR against this checkout. Explicit --live enables billed Decisions calls.
// Emits only aggregate timing, token counts, and rule/file predictions for comparison to the frozen labels.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "./results/real-pr-hook-2026-11-28.json";

const pr = process.argv[2];
const pins = Object.entries(manifest.prPins).find(([number]) => number === pr)?.[1];
if (!pins || !process.argv.includes("--live")) throw Error("Usage: bun eval/replay-real-pr.ts <benchmark PR number> --live");
const root = join(import.meta.dir, "..");
function git(args: string[]) {
  const child = Bun.spawnSync(["git", "-C", root, ...args]);
  if (!child.success) throw Error("Benchmark commit or diff unavailable in local git objects");
  return child.stdout.toString();
}
const [base, head] = pins;
const files = git(["diff", "--name-only", base, head, "--", "*.ts"]).split("\n").filter(Boolean);
const sections = files.flatMap((file) => {
  const patch = git(["diff", "--no-ext-diff", "--unified=0", base, head, "--", file]);
  const firstHunk = patch.indexOf("\n@@");
  if (firstHunk < 0) return [];
  const lines = patch
    .slice(firstHunk)
    .split("\n")
    .filter((line) => line.startsWith("+"));
  return lines.length ? [`*** Update File: ${file}\n${lines.join("\n")}`] : [];
});
if (!sections.length || sections.length > 16 || sections.join("\n").length > 120000) throw Error("Unexpected corpus size");
const dir = mkdtempSync(join(tmpdir(), "jev-pr-replay-"));
const results: string[][] = [];
const usagePath = join(dir, "usage.jsonl");
const phasePath = join(dir, "phases.jsonl");
const phases: { phase: string; timeMs: number; request?: number }[] = [];
let watchdogExpired = false;
let checked = 0;
let tokens = 0;
const start = performance.now();
try {
  for (let i = 0; i < sections.length; i += 8) {
    const log = join(dir, `event-${i}.jsonl`);
    const event = { cwd: dir, tool_name: "apply_patch", tool_input: { patch: sections.slice(i, i + 8).join("\n") } };
    phases.push({ phase: "hook_spawn", timeMs: Date.now() });
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "replay-usage.ts"), join(root, "src/hook.ts")], {
      cwd: root,
      stdin: new Blob([JSON.stringify(event)]),
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        JEV_LINT_SCOPE: "all",
        JEV_REPLAY_USAGE: usagePath,
        JEV_REPLAY_PHASES: phasePath,
        JEV_LINT_PACKS: "hygiene,practices,security,tests,performance,repo",
        JEV_LINT_CANDIDATES: "off",
        JEV_LINT_GATE: "on",
        JEV_LINT_TIMEOUT_MS: "8000",
        JEV_LINT_TIERS: "high,medium",
        JEV_LINT_HIGH: "0.8",
        JEV_LINT_MEDIUM: "0.5",
        JEV_LINT_PROVIDER: "openai",
        JEV_LINT_MODEL: "gpt-6-luna",
        JEV_LINT_DAEMON: "off",
        JEV_LINT_FINDINGS_LOG: "off",
        JEV_LINT_LOG: log,
      },
    });
    const watchdog = setTimeout(() => {
      watchdogExpired = true;
      phases.push({ phase: "watchdog_kill", timeMs: Date.now() });
      child.kill("SIGKILL");
    }, 22000);
    try {
      if ((await child.exited) !== 0) throw Error("hook process failed or timed out");
      const row = JSON.parse(readFileSync(log, "utf8"));
      checked += row.metrics.checkedFiles;
      tokens += row.metrics.inputTokens;
      for (const file of row.results) for (const finding of file.findings) results.push([file.filePath, finding.ruleId]);
    } finally {
      clearTimeout(watchdog);
      phases.push({ phase: "hook_exit", timeMs: Date.now() });
    }
  }
} finally {
  if (existsSync(phasePath)) {
    for (const line of readFileSync(phasePath, "utf8").trim().split("\n")) phases.push(JSON.parse(line));
  }
  phases.sort((a, b) => a.timeMs - b.timeMs);
  const seconds = (performance.now() - start) / 1000;
  const expected = new Set(
    manifest.labels.filter((r) => String(r.pr) === pr).flatMap((r) => r.labels.map((id) => JSON.stringify([r.file, id]))),
  );
  const tp = results.filter((pair) => expected.has(JSON.stringify(pair))).length;
  let observedUsd = 0;
  if (existsSync(usagePath))
    for (const line of readFileSync(usagePath, "utf8").trim().split("\n")) {
      const u = JSON.parse(line);
      const { cached_tokens, cache_write_tokens } = u.input_tokens_details;
      observedUsd +=
        (0.1 * (u.input_tokens - cached_tokens - cache_write_tokens) + 0.01 * cached_tokens + 0.125 * cache_write_tokens) / 1e6;
    }
  console.log(
    JSON.stringify({
      pr,
      seconds,
      watchdogExpired,
      phases,
      observedUsageUsd: observedUsd,
      invoicedUsd: null,
      fixRate: null,
      precision: results.length ? tp / results.length : null,
      recall: expected.size ? tp / expected.size : null,
      files: sections.length,
      checked,
      complete: checked === sections.length,
      successfulInputTokens: tokens,
      findings: results,
    }),
  );
  rmSync(dir, { recursive: true, force: true });
}
