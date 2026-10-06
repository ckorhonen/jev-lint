import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Case, jevModel, judgeClef, judgeDecisions, judgeJev } from "../eval/systems";
import { daemonSocketPath } from "../src/daemonClient";
import { decisionsResponse, openaiKey } from "../src/decisions";
import { hookGroup, recheckGroup } from "../src/install";
import { askNouls, judgeModel, judgeProvider, type NoulQuestion } from "../src/jev";
import { lintChange } from "../src/lint";

const names = ["JEV_LINT_PROVIDER", "JEV_LINT_MODEL", "OPENAI_API_KEY", "OPENAI_API_KEY_FILE"];
const question: NoulQuestion = { type: "noul", instructions: "Is this unsafe?", criteria: { true: "Unsafe", false: "Safe" } };
const response = (ids = ["rule"]) => ({
  model: "gpt-6-luna",
  answers: ids.map((name) => ({ type: "predicate", name, probability: 0.9 })),
  usage: {
    input_tokens: 42,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 42,
  },
});
let saved: Record<string, string | undefined>;
let mock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  process.env.JEV_LINT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "mock-key";
  mock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response()));
});
afterEach(() => {
  mock.mockRestore();
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

test("documented POST contract translates state and criteria without System One fields", async () => {
  const state = { added_code: "code", language: "typescript" };
  const result = await askNouls(state, { rule: question });
  expect(result).toEqual({
    model: "gpt-6-luna",
    answers: { rule: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 42, output_tokens: 0 },
  });
  const [url, init] = mock.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/decisions");
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("error");
  expect(init?.headers).toEqual({ Authorization: "Bearer mock-key", "Content-Type": "application/json" });
  expect(JSON.parse(String(init?.body))).toEqual({
    model: "gpt-6-luna",
    input: JSON.stringify(state),
    questions: [{ type: "predicate", name: "rule", instructions: "Is this unsafe?\nTrue when: Unsafe\nFalse when: Safe" }],
  });
});
test("string input and optional criteria preserve evidence", async () => {
  await askNouls("plain text", { rule: { type: "noul", instructions: "Check" } });
  expect(JSON.parse(String(mock.mock.calls[0][1]?.body)).input).toBe("plain text");
});
test("ordered null names are valid and endpoints probabilities are accepted", () => {
  const r = response(["a", "b"]);
  expect(
    decisionsResponse(
      {
        ...r,
        answers: [
          { type: "predicate", name: null, probability: 0 },
          { type: "predicate", name: null, probability: 1 },
        ],
      },
      ["a", "b"],
    ).answers.b.noul,
  ).toBe(1);
});
test.each([
  { ...response(), answers: [] },
  { ...response(), answers: [...response().answers, ...response().answers] },
  { ...response(), answers: [{ type: "predicate", name: "wrong", probability: 0.9 }] },
  { ...response(), answers: [{ type: "predicate", probability: 0.9 }] },
  ...[-1, 2, null, "0.9"].map((probability) => ({ ...response(), answers: [{ type: "predicate", name: "rule", probability }] })),
  { ...response(), answers: [{ type: "choice", name: "rule", probability: 0.9 }] },
  { ...response(), usage: { input_tokens: -1, output_tokens: 0 } },
  { ...response(), usage: { input_tokens: 42 } },
  { ...response(), model: null },
  null,
])("malformed contracts reject rather than reporting clean code %#", async (r) => {
  mock.mockResolvedValue(Response.json(r));
  await expect(askNouls({}, { rule: question })).rejects.toThrow("OpenAI Decisions");
});
test("refusal rejects the complete check, including mixed and unnamed answers", () => {
  for (const name of ["b", null]) {
    expect(() =>
      decisionsResponse({ ...response(["a", "b"]), answers: [response(["a"]).answers[0], { type: "refusal", name }] }, ["a", "b"]),
    ).toThrow("refused");
  }
});
test("invalid JSON propagates as a failed check", async () => {
  mock.mockResolvedValue(new Response("not json"));
  await expect(askNouls({}, { rule: question })).rejects.toThrow();
});
test("credential, model, base URL and empty question preflight never sends code", async () => {
  delete process.env.OPENAI_API_KEY;
  await expect(askNouls({}, { rule: question })).rejects.toThrow("OPENAI_API_KEY");
  process.env.OPENAI_API_KEY = "mock-key";
  await expect(askNouls({}, { rule: question }, { model: "clef" })).rejects.toThrow("gpt-6-luna");
  await expect(askNouls({}, { rule: question }, { provider: "openai", baseUrl: "http://localhost" })).rejects.toThrow("baseUrl");
  await expect(askNouls({}, {})).rejects.toThrow("at least one");
  expect(mock).not.toHaveBeenCalled();
});
test.each([400, 401, 403])("HTTP %i does not retry or expose bodies", async (status) => {
  mock.mockResolvedValue(new Response("sensitive body", { status }));
  await expect(askNouls({}, { rule: question }, { retries: 3 })).rejects.toThrow(`OpenAI Decisions ${status}`);
  expect(mock).toHaveBeenCalledTimes(1);
});
test.each([429, 500])("transient HTTP %i retries with a shared deadline", async (status) => {
  mock.mockResolvedValueOnce(new Response("busy", { status, headers: { "retry-after": "0.001" } }));
  await askNouls({}, { rule: question }, { retries: 1 });
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.calls[0][1]?.signal).toBe(mock.mock.calls[1][1]?.signal);
});
test("deadline bounds retries and network errors are not retried", async () => {
  mock.mockResolvedValue(new Response("busy", { status: 429, headers: { "retry-after": "60" } }));
  await expect(askNouls({}, { rule: question }, { retries: 1, timeoutMs: 10 })).rejects.toThrow();
  expect(mock).toHaveBeenCalledTimes(1);
  mock.mockRejectedValue(new Error("network"));
  await expect(askNouls({}, { rule: question }, { retries: 2 })).rejects.toThrow("network");
  expect(mock).toHaveBeenCalledTimes(2);
});
test("private key files, env precedence and installer selection without secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "decisions-key-"));
  try {
    const file = join(dir, "a'b key");
    writeFileSync(file, "file-key\n", { mode: 0o600 });
    process.env.OPENAI_API_KEY_FILE = file;
    expect(openaiKey()).toBe("mock-key");
    delete process.env.OPENAI_API_KEY;
    expect(openaiKey()).toBe("file-key");
    chmodSync(file, 0o644);
    expect(openaiKey()).toBeUndefined();
    for (const group of [hookGroup("claude"), hookGroup("codex"), recheckGroup()]) {
      const command = group.hooks[0].command;
      expect(command).toContain("JEV_LINT_PROVIDER=openai");
      expect(command).toContain("gpt-6-luna");
      expect(command).toContain("OPENAI_API_KEY_FILE=");
      expect(command).not.toContain("OPENAI_API_KEY=");
      expect(command).not.toContain("file-key");
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("daemon identity changes for key and file; provider defaults remain independent", () => {
  const baseline = daemonSocketPath();
  process.env.OPENAI_API_KEY = "different";
  expect(daemonSocketPath()).not.toBe(baseline);
  process.env.OPENAI_API_KEY = "mock-key";
  process.env.OPENAI_API_KEY_FILE = "/tmp/different";
  expect(daemonSocketPath()).not.toBe(baseline);
  expect(judgeModel()).toBe("gpt-6-luna");
  process.env.JEV_LINT_MODEL = "gpt-6-luna";
  expect(jevModel()).toBe("jev-latest");
  delete process.env.JEV_LINT_MODEL;
  delete process.env.JEV_LINT_PROVIDER;
  expect(judgeProvider()).toBe("typesafe");
  expect(judgeModel()).toBe("jev-latest");
  expect(judgeModel("cloudflare")).toBe("clef");
});
test("Decisions findings retain gates and tiers; judge forces provider despite Clef shell", async () => {
  mock.mockImplementation(
    Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return Response.json(response(body.questions.map((q: { name: string }) => q.name)));
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const result = await lintChange(
    { filePath: "/tmp/test.ts", addedCode: "try { f(); } catch (e) {}", changeKind: "write" },
    { packs: ["hygiene"] },
  );
  expect(result?.findings.find((f) => f.ruleId === "ts-no-empty-catch")?.tier).toBe("high");
  process.env.JEV_LINT_PROVIDER = "cloudflare";
  process.env.JEV_LINT_MODEL = "clef";
  const c: Case = {
    id: "mock",
    lang: "typescript",
    split: "dev",
    pack: "hygiene",
    labels: [],
    payload: { tool_name: "Write", tool_input: { file_path: "/tmp/test.ts", content: "try { f(); } catch (e) {}" } },
  };
  const judgment = await judgeDecisions(c);
  expect(judgment.models).toEqual(["gpt-6-luna"]);
  expect(judgment.inputTokens).toBe(42);
  expect(judgment.scores["ts-no-empty-catch"]).toBe(0.9);
  // No Cloudflare credentials: its judge must not silently use OpenAI.
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  try {
    await expect(judgeClef(c)).rejects.toThrow("account ID");
  } finally {
    if (account !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = account;
  }
});
test("missing credentials leave hook silent and fail open in a subprocess", () => {
  const dir = mkdtempSync(join(tmpdir(), "decisions-hook-"));
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY_FILE;
    const run = spawnSync(process.execPath, [join(import.meta.dir, "../src/hook.ts")], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: dir,
        tool_name: "Write",
        tool_input: { file_path: join(dir, "test.ts"), content: "try { f(); } catch (e) {}" },
      }),
      env: { ...process.env, JEV_LINT_DAEMON: "off", JEV_LINT_FINDINGS_LOG: "off" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("Jev comparisons do not inherit a Decisions or Clef shell model", async () => {
  const c: Case = {
    id: "mixed-shell",
    lang: "typescript",
    split: "dev",
    pack: "hygiene",
    labels: [],
    payload: { tool_name: "Write", tool_input: { file_path: "/tmp/test.ts", content: "try { f(); } catch (e) {}" } },
  };
  mock.mockImplementation(
    Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("jev-latest");
        return Response.json({
          model: "jev-latest",
          usage: { input_tokens: 1, output_tokens: 0 },
          answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }])),
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  for (const model of ["gpt-6-luna", "clef", "clef-flash"]) {
    process.env.JEV_LINT_MODEL = model;
    await judgeJev(c, "http://127.0.0.1:8009");
  }
});
