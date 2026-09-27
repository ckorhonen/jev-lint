import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A mock /v1/systemone that flags every question, so any asked rule comes back "high".
let calls = 0;
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    calls++;
    const body = (await req.json()) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.95 }]));
    return Response.json({ model: "mock", answers, usage: { input_tokens: 10, output_tokens: 0 } });
  },
});
// A unique base URL gives this test its own daemon socket.
process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${mock.port}`;
const { checkViaDaemon, daemonSocketPath, startDaemon } = await import("../src/daemonClient");

const repo = mkdtempSync(join(tmpdir(), "jev-lint-daemon-"));
mkdirSync(join(repo, ".git"));
const change = { filePath: join(repo, "a.ts"), addedCode: "try { run(); } catch (e) {}\n", changeKind: "write" as const };
let pid: number | undefined;

afterAll(() => {
  if (pid) process.kill(pid, "SIGTERM");
  mock.stop(true);
  rmSync(repo, { recursive: true, force: true });
});

describe("daemon", () => {
  test("returns undefined when no daemon is running, so the hook checks in process", async () => {
    expect(await checkViaDaemon([change], { timeoutMs: 2000, cwd: repo })).toBeUndefined();
  });

  test("a started daemon answers checks over its socket", async () => {
    pid = startDaemon();
    expect(pid).toBeNumber();
    let settled: Awaited<ReturnType<typeof checkViaDaemon>>;
    for (let i = 0; i < 50 && !settled; i++) {
      await Bun.sleep(100);
      settled = await checkViaDaemon([change], { timeoutMs: 2000, cwd: repo });
    }
    expect(settled).toHaveLength(1);
    const [first] = settled ?? [];
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value?.findings.some((f) => f.ruleId === "ts-no-empty-catch")).toBe(true);
    expect(daemonSocketPath()).toContain(".local/state/jev-lint/daemon-");
    expect(calls).toBeGreaterThan(0);
  }, 10_000);

  test("an edited `when` gate in .jev-lint takes effect on the next request", async () => {
    const rule = { id: "repo-gate-test", question: "Does `added_code` do X?", true: "Yes", false: "No", fix: "Don't." };
    const write = (when: string[]) =>
      writeFileSync(
        join(repo, ".jev-lint/t.rules.json"),
        JSON.stringify({ language: "typescript", extensions: [".ts"], rules: [{ ...rule, when }] }),
      );
    mkdirSync(join(repo, ".jev-lint"), { recursive: true });
    const code = { ...change, addedCode: "const alpha = 1;\n" };
    const asked = async () => {
      const [s] = (await checkViaDaemon([code], { timeoutMs: 2000, cwd: repo })) ?? [];
      return s?.ok ? (s.value?.findings.some((f) => f.ruleId === "repo-gate-test") ?? false) : undefined;
    };
    write(["neverpresent"]);
    expect(await asked()).toBe(false);
    write(["alpha"]);
    expect(await asked()).toBe(true);
  });

  test("starting more daemons while one runs leaves exactly one owner", async () => {
    const socket = daemonSocketPath();
    const owner = readFileSync(`${socket}.lock`, "utf8").trim();
    const extra = [1, 2, 3].map(() => startDaemon({ force: true }));
    await Bun.sleep(1500);
    for (const p of extra)
      expect(
        p
          ? (() => {
              try {
                process.kill(p, 0);
                return true;
              } catch {
                return false;
              }
            })()
          : false,
      ).toBe(false);
    expect(readFileSync(`${socket}.lock`, "utf8").trim()).toBe(owner);
    expect(existsSync(socket)).toBe(true);
    expect(await checkViaDaemon([change], { timeoutMs: 2000, cwd: repo })).toHaveLength(1);
  }, 10_000);
});
