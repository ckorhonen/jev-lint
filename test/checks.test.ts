import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { runChecks } from "../src/checks";

const changes = Array.from({ length: 10 }, (_, i) => ({
  filePath: `/tmp/check-deadline-${i}.ts`,
  addedCode: "try { run(); } catch (e) {}",
  changeKind: "write" as const,
}));
const names = ["JEV_LINT_PROVIDER", "TYPESAFE_BASE_URL", "JEV_LINT_GATE"];
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
  const pending = new Map<AbortSignal, { controller: AbortController; expires: number }>();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    pending.set(controller.signal, { controller, expires: now + ms });
    return controller.signal;
  });
  return {
    budgets: () => timeout.mock.calls.map(([ms]) => ms),
    advance: (ms: number) => {
      now += ms;
    },
    expire: async (signal: AbortSignal | null | undefined): Promise<Response> => {
      const request = signal && pending.get(signal);
      if (!request) throw new Error("request is missing a timeout signal");
      await Promise.resolve();
      now = Math.max(now, request.expires);
      request.controller.abort(new DOMException("request timed out", "TimeoutError"));
      throw request.controller.signal.reason;
    },
    restore: () => {
      timeout.mockRestore();
      clock.mockRestore();
    },
  };
}

test("all file batches share one deadline and expired files are recorded as failures", async () => {
  const time = controlledTimeouts();
  const mock = mockFetch((_url, init) => time.expire(init?.signal));
  try {
    const results = await runChecks(changes, { timeoutMs: 400 });
    expect(results).toHaveLength(10);
    expect(results.slice(0, 8)).toEqual(Array(8).fill({ ok: false, error: "TimeoutError: request timed out" }));
    expect(results.slice(8)).toEqual(Array(2).fill({ ok: false, error: "check deadline exceeded" }));
    expect(mock).toHaveBeenCalledTimes(8);
    expect(time.budgets()).toEqual(Array(8).fill(400));
  } finally {
    mock.mockRestore();
    time.restore();
  }
});

test("later batches use the remaining budget while preserving successful results and order", async () => {
  const time = controlledTimeouts();
  const firstBatch = changes.slice(0, 8).map(() => Promise.withResolvers<void>());
  const completed: string[] = [];
  const mock = mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const index = changes.findIndex((change) => change.filePath === body.state.file_path);
    if (index >= 0 && index < firstBatch.length) {
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
    const initialCalls = mock.mock.calls.length;
    time.advance(225);
    for (const request of [...firstBatch].reverse()) request.resolve();
    const results = await pending;
    expect(initialCalls).toBe(8);
    expect(mock).toHaveBeenCalledTimes(10);
    expect(time.budgets()).toEqual([...Array(8).fill(400), 175, 175]);
    const firstPaths = changes.slice(0, 8).map((change) => change.filePath);
    expect(completed).toEqual(firstPaths.reverse());
    expect(results).toHaveLength(10);
    for (let i = 0; i < 8; i++) {
      const result = results[i];
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value?.filePath).toBe(changes[i].filePath);
    }
    expect(results.slice(8)).toEqual(Array(2).fill({ ok: false, error: "TimeoutError: request timed out" }));
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
    expect(results).toEqual(Array(10).fill({ ok: false, error: "check deadline exceeded" }));
    expect(mock).not.toHaveBeenCalled();
  } finally {
    mock.mockRestore();
  }
});
