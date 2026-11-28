import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

test("PR worker replies before EOF, processes every file once, and reloads repo rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-review-"));
  mkdirSync(join(dir, ".jev-lint"));
  const config = join(dir, ".jev-lint/config.json");
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { state, questions } = await req.json();
      requests.push(state.file_path);
      return Response.json({
        model: "fixture",
        usage: { input_tokens: 1, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: k === "ts-no-magic-numbers" ? 1 : 0 }])),
      });
    },
  });
  const child = spawn(process.execPath, [join(import.meta.dir, "../src/review.ts")], {
    cwd: dir,
    env: {
      ...process.env,
      JEV_LINT_SCOPE: "all",
      JEV_LINT_PROVIDER: "typesafe",
      TYPESAFE_BASE_URL: String(server.url).replace(/\/$/, ""),
      JEV_LINT_PACKS: "hygiene,repo",
      JEV_LINT_TIERS: "high,medium",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const nextReceipt = async () => {
    const next = await lines.next();
    if (next.done) throw new Error("worker exited before replying");
    return JSON.parse(next.value);
  };
  const files = Array.from({ length: 17 }, (_, i) => `src/retry-${i}.ts`);
  const send = (names: string[]) =>
    child.stdin.write(
      `${JSON.stringify({
        cwd: dir,
        tool_name: "apply_patch",
        tool_input: { patch: names.map((f) => `*** Update File: ${f}\n+setTimeout(fn, 1370);`).join("\n") },
      })}\n`,
    );
  try {
    child.stdin.write("{bad json\n");
    expect(await nextReceipt()).toHaveProperty("error");
    send(files);
    const first = await nextReceipt();
    expect(first.metrics.checkedFiles).toBe(files.length);
    expect(requests.sort()).toEqual([...files].sort());
    expect(first.results.map((r: { filePath: string }) => r.filePath)).toEqual(files);
    expect(first.results[0].findings[0].ruleId).toBe("ts-no-magic-numbers");
    writeFileSync(config, JSON.stringify({ disable: ["ts-no-magic-numbers"] }));
    send(files.slice(0, 1));
    const second = await nextReceipt();
    expect(second.results[0].findings).toEqual([]);
    expect(requests.length).toBe(files.length + 1);
  } finally {
    child.stdin.end();
    child.kill();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
