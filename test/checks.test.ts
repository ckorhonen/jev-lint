import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { runChecks } from "../src/checks";

const changes = Array.from({ length: 8 }, (_, i) => ({
  filePath: `/tmp/check-deadline-${i}.ts`,
  addedCode: "try { run(); } catch (e) {}",
  changeKind: "write" as const,
}));
const names = ["JEV_LINT_PROVIDER", "TYPESAFE_BASE_URL", "TYPESAFE_API_KEY", "JEV_LINT_GATE"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.JEV_LINT_PROVIDER = "typesafe";
  process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:1";
  process.env.JEV_LINT_GATE = "off";
});
afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function mockFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(handler, { preconnect: fetch.preconnect }));
}

function controlledTimeouts() {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timer = spyOn(globalThis, "setTimeout");
  return {
    budgets: () => timer.mock.calls.map(([, ms]) => ms),
    advance: (ms: number) => {
      now += ms;
    },
    expire: async (signal: AbortSignal | null | undefined): Promise<Response> => {
      const duration = timer.mock.calls.at(-1)?.[1];
      if (!signal || typeof duration !== "number") throw new Error("request is missing a timeout signal");
      const expires = now + duration;
      await Promise.resolve();
      now = Math.max(now, expires);
      throw new DOMException("request timed out", "TimeoutError");
    },
    restore: () => {
      timer.mockRestore();
      clock.mockRestore();
    },
  };
}

test("all file batches share one deadline and expired files are recorded as failures", async () => {
  const time = controlledTimeouts();
  const mock = mockFetch((_url, init) => time.expire(init?.signal));
  try {
    const results = await runChecks(changes, { timeoutMs: 400 });
    expect(results).toHaveLength(8);
    expect(results.slice(0, 4)).toEqual(Array(4).fill({ ok: false, error: "TimeoutError: request timed out" }));
    expect(results.slice(4)).toEqual(Array(4).fill({ ok: false, error: "check deadline exceeded" }));
    expect(mock).toHaveBeenCalledTimes(4);
    expect(time.budgets()).toEqual([400, 400, 400, 400]);
  } finally {
    mock.mockRestore();
    time.restore();
  }
});

test("later batches use the remaining budget while preserving successful results and order", async () => {
  const time = controlledTimeouts();
  const started = Promise.withResolvers<void>();
  const firstBatch = changes.slice(0, 4).map(() => Promise.withResolvers<void>());
  const completed: string[] = [];
  const mock = mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const index = changes.findIndex((change) => change.filePath === body.state.file_path);
    if (index >= 0 && index < firstBatch.length) {
      if (index === 3) started.resolve();
      await firstBatch[index].promise;
      completed.push(body.state.file_path);
      return Response.json({
        model: "mock",
        answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0 }])),
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    }
    return time.expire(init?.signal);
  });
  try {
    const pending = runChecks(changes, { timeoutMs: 400 });
    await started.promise;
    const initialCalls = mock.mock.calls.length;
    time.advance(225);
    for (const request of [...firstBatch].reverse()) request.resolve();
    const results = await pending;
    expect(initialCalls).toBe(4);
    expect(mock).toHaveBeenCalledTimes(8);
    expect(time.budgets()).toEqual([400, 400, 400, 400, 175, 175, 175, 175]);
    const firstPaths = changes.slice(0, 4).map((change) => change.filePath);
    expect(completed).toEqual(firstPaths.reverse());
    expect(results).toHaveLength(8);
    for (let i = 0; i < 4; i++) {
      const result = results[i];
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.filePath).toBe(changes[i].filePath);
    }
    expect(results.slice(4)).toEqual(Array(4).fill({ ok: false, error: "TimeoutError: request timed out" }));
  } finally {
    mock.mockRestore();
    time.restore();
  }
});

test("an exhausted budget starts no requests", async () => {
  const mock = mockFetch(async () => {
    throw new Error("unexpected request");
  });
  try {
    const results = await runChecks(changes, { timeoutMs: 0 });
    expect(results).toEqual(Array(8).fill({ ok: false, error: "check deadline exceeded" }));
    expect(mock).not.toHaveBeenCalled();
  } finally {
    mock.mockRestore();
  }
});

test("TypeSafe bounds a stalled transport and body even when cancellation is ignored", async () => {
  const { askNouls } = await import("../src/jev");
  const mock = spyOn(globalThis, "fetch");
  const options = { baseUrl: "http://127.0.0.1:1", timeoutMs: 30 };
  try {
    mock.mockReturnValueOnce(new Promise<Response>(() => {}));
    const stalledBody = new Response();
    stalledBody.text = () => new Promise(() => {});
    mock.mockResolvedValueOnce(stalledBody);
    for (let i = 0; i < 2; i++) {
      await expect(askNouls({}, {}, options)).rejects.toThrow("TypeSafe deadline exceeded");
      expect(mock.mock.calls[i][1]?.signal?.aborted).toBe(true);
    }
    expect(mock).toHaveBeenCalledTimes(2);
  } finally {
    mock.mockRestore();
  }
});

test("hosted TypeSafe dispatches eight files in one wave and preserves input order", async () => {
  process.env.JEV_LINT_PROVIDER = "typesafe";
  process.env.TYPESAFE_BASE_URL = "https://api.typesafe.ai";
  process.env.TYPESAFE_API_KEY = "test-fixture";
  let active = 0;
  let peak = 0;
  const mock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        active++;
        peak = Math.max(peak, active);
        const { state } = JSON.parse(String(init?.body));
        await Bun.sleep(state.file_path === changes[0].filePath ? 20 : 1);
        active--;
        return Response.json({ model: "test", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const results = await runChecks(changes, { timeoutMs: 1000 });
    expect(peak).toBe(8);
    expect(mock).toHaveBeenCalledTimes(8);
    expect(results.map((r) => r.ok && r.value?.filePath)).toEqual(changes.map((c) => c.filePath));
  } finally {
    mock.mockRestore();
  }
});
