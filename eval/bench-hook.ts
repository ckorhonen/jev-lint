// Local hook performance benchmark: process latency, daemon behavior and API bytes.
// Never touches production: it spins up a local /v1/systemone server and temporary repos.
//   bun eval/bench-hook.ts [--runs 15] [--delay 0] [--json out.json]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "src/hook.ts");

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "15" },
    delay: { type: "string", default: "0" },
    json: { type: "string" },
  },
});

const runs = Math.max(1, Number(args.runs));
const delayMs = Math.max(0, Number(args.delay));

type ApiRecord = { bytesIn: number; bytesOut: number; questions: number; stateBytes: number };
const apiRecords: ApiRecord[] = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/v1/systemone") return new Response("not found", { status: 404 });
    const text = await req.text();
    const parsed = JSON.parse(text) as { questions?: Record<string, unknown>; state?: unknown };
    if (delayMs) await Bun.sleep(delayMs);
    const answers = Object.fromEntries(Object.keys(parsed.questions ?? {}).map((id) => [id, { type: "noul", noul: 0.01 }]));
    const body = JSON.stringify({
      model: "bench-local",
      answers,
      usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 0 },
    });
    apiRecords.push({
      bytesIn: Buffer.byteLength(text),
      bytesOut: Buffer.byteLength(body),
      questions: Object.keys(parsed.questions ?? {}).length,
      stateBytes: Buffer.byteLength(JSON.stringify(parsed.state ?? {})),
    });
    return Response.json(JSON.parse(body));
  },
});

type HookRun = { ms: number; code: number | null; stdout: string; stderr: string };

function runHook(event: unknown, env: NodeJS.ProcessEnv, cwd: string): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [HOOK], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ ms: performance.now() - started, code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function stats(samples: HookRun[]) {
  const values = samples.map((s) => s.ms);
  return {
    runs: samples.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
    failures: samples.filter((s) => s.code !== 0 || s.stderr).length,
  };
}

function byteStats(count: number) {
  const totalIn = apiRecords.reduce((n, r) => n + r.bytesIn, 0);
  const totalOut = apiRecords.reduce((n, r) => n + r.bytesOut, 0);
  const questions = apiRecords.reduce((n, r) => n + r.questions, 0);
  return {
    apiRequests: apiRecords.length,
    questions,
    bytesInPerHook: count ? totalIn / count : 0,
    bytesOutPerHook: count ? totalOut / count : 0,
    bytesInPerRequest: apiRecords.length ? totalIn / apiRecords.length : 0,
    bytesOutPerRequest: apiRecords.length ? totalOut / apiRecords.length : 0,
    meanQuestionsPerRequest: apiRecords.length ? questions / apiRecords.length : 0,
    meanStateBytesPerRequest: apiRecords.length ? apiRecords.reduce((n, r) => n + r.stateBytes, 0) / apiRecords.length : 0,
  };
}

function fixtureEvent(cwd: string, file: string, addedCode: string, tool = "Edit") {
  return {
    hook_event_name: "PostToolUse",
    tool_name: tool,
    session_id: "bench-session",
    cwd,
    tool_input: tool === "Write" ? { file_path: file, content: addedCode } : { file_path: file, old_string: "", new_string: addedCode },
  };
}

function patchEvent(cwd: string, files: { file: string; code: string }[]) {
  const patch = [
    "*** Begin Patch",
    ...files.flatMap(({ file, code }) => [
      `*** Update File: ${file}`,
      "@@",
      ...code
        .trimEnd()
        .split("\n")
        .map((line) => `+${line}`),
    ]),
    "*** End Patch",
  ].join("\n");
  return {
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    session_id: "bench-session",
    cwd,
    tool_input: { command: patch },
  };
}

async function daemonPid(stateHome: string): Promise<number | undefined> {
  let names: string[] = [];
  try {
    names = readdirSync(join(stateHome, "jev-lint")).filter((name) => name.startsWith("daemon-") && name.endsWith(".sock"));
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const res = await fetch("http://jev-lint/health", { unix: join(stateHome, "jev-lint", name), signal: AbortSignal.timeout(200) });
      if (res.ok) return ((await res.json()) as { pid?: number }).pid;
    } catch {
      // try the next socket
    }
  }
  return undefined;
}

async function waitForDaemon(stateHome: string): Promise<number | undefined> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pid = await daemonPid(stateHome);
    if (pid) return pid;
    await Bun.sleep(25);
  }
  return undefined;
}

function benchEnv(stateHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`,
    JEV_LINT_PROVIDER: "typesafe",
    JEV_LINT_MODEL: "bench-model",
    JEV_LINT_FINDINGS_LOG: "off",
    ...extra,
  };
  for (const key of [
    "JEV_LINT_LOG",
    "JEV_LINT_DEBUG",
    "JEV_LINT_PACKS",
    "JEV_LINT_GATE",
    "JEV_LINT_HIGH",
    "JEV_LINT_MEDIUM",
    "TYPESAFE_API_KEY",
    "TYPESAFE_API_KEY_FILE",
  ])
    delete env[key];
  return env;
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "jev-hook-bench-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

const smallCode = "export function identity(value: string): string { return value }\n";
const triggerCode = `export async function loadUser(userId: string) {
  console.log("loading user", userId)
  const response = await fetch("/api/users/" + userId)
  const data = await response.json()
  localStorage.setItem("user", JSON.stringify(data))
  return data
}
`;
const largeCode = `${Array.from({ length: 180 }, (_, i) => `export function helper${i}(value: string): string { return value + ${JSON.stringify("x".repeat(40))} }`).join("\n")}\n`;

async function main() {
  const fixture = makeFixture();
  const stateRoot = mkdtempSync(join(tmpdir(), "jev-hook-state-"));
  const daemonPids = new Set<number>();
  const scenarios = [
    { name: "noop-unknown-file", event: fixtureEvent(fixture, join(fixture, "notes.txt"), smallCode) },
    { name: "small-ts-edit", event: fixtureEvent(fixture, join(fixture, "src/small.ts"), smallCode) },
    { name: "trigger-ts-edit", event: fixtureEvent(fixture, join(fixture, "src/trigger.ts"), triggerCode) },
    { name: "large-ts-write", event: fixtureEvent(fixture, join(fixture, "src/large.ts"), largeCode, "Write") },
    {
      name: "multi-file-patch",
      event: patchEvent(fixture, [
        { file: join(fixture, "src/a.ts"), code: smallCode },
        { file: join(fixture, "src/b.ts"), code: triggerCode },
        { file: join(fixture, "src/c.ts"), code: smallCode },
        { file: join(fixture, "src/d.ts"), code: triggerCode },
        { file: join(fixture, "src/e.ts"), code: smallCode },
        { file: join(fixture, "src/f.ts"), code: triggerCode },
        { file: join(fixture, "src/g.ts"), code: smallCode },
        { file: join(fixture, "src/h.ts"), code: triggerCode },
      ]),
    },
  ];

  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    runs,
    delayMs,
    scenarios: {} as Record<string, unknown>,
  };
  const out = results.scenarios as Record<string, unknown>;

  try {
    for (const scenario of scenarios) {
      const row: Record<string, unknown> = {};
      for (const mode of ["cold", "warm"] as const) {
        const stateHome = join(stateRoot, mode);
        mkdirSync(stateHome, { recursive: true });
        const env = benchEnv(stateHome, mode === "cold" ? { JEV_LINT_DAEMON: "off" } : {});
        if (mode === "warm") {
          await runHook(scenario.event, env, fixture);
          const pid = await waitForDaemon(stateHome);
          if (pid) daemonPids.add(pid);
        }
        for (let i = 0; i < 2; i++) await runHook(scenario.event, env, fixture);
        apiRecords.length = 0;
        const samples: HookRun[] = [];
        for (let i = 0; i < runs; i++) samples.push(await runHook(scenario.event, env, fixture));
        row[mode] = { latencyMs: stats(samples), transfer: byteStats(samples.length) };
      }
      out[scenario.name] = row;
      const cold = row.cold as { latencyMs: { p50: number }; transfer: { bytesInPerHook: number; bytesOutPerHook: number } };
      const warm = row.warm as { latencyMs: { p50: number }; transfer: { bytesInPerHook: number; bytesOutPerHook: number } };
      console.log(
        `${scenario.name.padEnd(18)} cold p50 ${cold.latencyMs.p50.toFixed(1)} ms / ${cold.transfer.bytesInPerHook.toFixed(0)}+${cold.transfer.bytesOutPerHook.toFixed(0)} B; warm p50 ${warm.latencyMs.p50.toFixed(1)} ms / ${warm.transfer.bytesInPerHook.toFixed(0)}+${warm.transfer.bytesOutPerHook.toFixed(0)} B`,
      );
    }
  } finally {
    for (const pid of daemonPids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
    server.stop(true);
    rmSync(fixture, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }

  if (args.json) writeFileSync(args.json as string, `${JSON.stringify(results, null, 2)}\n`);
}

await main();
