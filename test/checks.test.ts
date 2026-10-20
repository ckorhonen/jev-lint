import { afterEach, expect, spyOn, test } from "bun:test";
import { runChecks } from "../src/checks";

const changes = Array.from({ length: 8 }, (_, i) => ({
  filePath: `/tmp/check-deadline-${i}.ts`,
  addedCode: "try { run(); } catch (e) {}",
  changeKind: "write" as const,
}));
const names = ["JEV_LINT_PROVIDER", "TYPESAFE_BASE_URL", "JEV_LINT_GATE"];
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("all file batches share one deadline and expired files are recorded as failures", async () => {
  process.env.JEV_LINT_PROVIDER = "typesafe";
  process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:1";
  process.env.JEV_LINT_GATE = "off";
  const pendingFetch = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> =>
      new Promise((_, reject) => {
        const signal = init?.signal;
        signal?.throwIfAborted();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    { preconnect: fetch.preconnect },
  );
  const mock = spyOn(globalThis, "fetch").mockImplementation(pendingFetch);
  try {
    const started = performance.now();
    const results = await runChecks(changes, { timeoutMs: 400 });
    const elapsed = performance.now() - started;
    expect(results).toHaveLength(8);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(4);
    expect(elapsed).toBeLessThan(700);
  } finally {
    mock.mockRestore();
  }
});

test("later batches use the remaining budget while preserving successful results and order", async () => {
  process.env.JEV_LINT_PROVIDER = "typesafe";
  process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:1";
  process.env.JEV_LINT_GATE = "off";
  let calls = 0;
  const handler = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const index = calls++;
      if (index < 4) {
        await Bun.sleep(200);
        const body = JSON.parse(String(init?.body));
        return Response.json({
          model: "mock",
          answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0 }])),
          usage: { input_tokens: 1, output_tokens: 0 },
        });
      }
      return new Promise((_, reject) => {
        const signal = init?.signal;
        signal?.throwIfAborted();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    { preconnect: fetch.preconnect },
  );
  const mock = spyOn(globalThis, "fetch").mockImplementation(handler);
  try {
    const started = performance.now();
    const results = await runChecks(changes, { timeoutMs: 400 });
    expect(performance.now() - started).toBeLessThan(550);
    expect(mock).toHaveBeenCalledTimes(8);
    expect(results).toHaveLength(8);
    for (let i = 0; i < 4; i++) {
      const result = results[i];
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.filePath).toBe(changes[i].filePath);
    }
    expect(results.slice(4).every((result) => !result.ok)).toBe(true);
  } finally {
    mock.mockRestore();
  }
});

test("an exhausted budget starts no requests", async () => {
  const mock = spyOn(globalThis, "fetch");
  try {
    const results = await runChecks(changes, { timeoutMs: 0 });
    expect(results).toHaveLength(8);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  } finally {
    mock.mockRestore();
  }
});
