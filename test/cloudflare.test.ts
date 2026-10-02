import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Case, judgeClef, judgeClefFlash, judgeJev } from "../eval/systems";
import { daemonSocketPath } from "../src/daemonClient";
import { hookGroup, recheckGroup } from "../src/install";
import { askNouls, cloudflareKey, judgeModel, judgeProvider, type NoulQuestion } from "../src/jev";
import { lintChange } from "../src/lint";

const withPreconnect = (handler: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) =>
  Object.assign(handler, { preconnect: fetch.preconnect });

const names = ["JEV_LINT_PROVIDER", "JEV_LINT_MODEL", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_FILE"];
let saved: Record<string, string | undefined>;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const question: NoulQuestion = { type: "noul", instructions: "Is the code unsafe?", criteria: { true: "Yes", false: "No" } };
const response = (ids = ["rule"], p = 0.9) => ({
  success: true,
  result: {
    model: "clef",
    answers: Object.fromEntries(ids.map((id) => [id, { type: "noul" as const, noul: p }])),
    usage: { input_tokens: 12, output_tokens: 0 },
  },
});

beforeEach(() => {
  saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.JEV_LINT_PROVIDER = "cloudflare";
  process.env.CLOUDFLARE_ACCOUNT_ID = "a".repeat(32);
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(response()));
});
afterEach(() => {
  fetchMock.mockRestore();
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("optional Cloudflare judge", () => {
  test("sends the System One contract to Workers AI and unwraps the result", async () => {
    const state = { added_code: "code" };
    expect(await askNouls(state, { rule: question })).toEqual(response().result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/run/@cf/cloudflare/clef`);
    expect(init?.headers).toEqual({ Authorization: "Bearer test-token", "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ model: "clef", state, questions: { rule: question } });
    expect(init?.redirect).toBe("error");
  });
  test("selects clef-flash in both path and body", async () => {
    process.env.JEV_LINT_MODEL = "clef-flash";
    await askNouls({}, { rule: question });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toEndWith("/clef-flash");
    expect(JSON.parse(String(init?.body)).model).toBe("clef-flash");
  });
  test("batches more than 64 rules and sums usage", async () => {
    fetchMock.mockImplementation(
      withPreconnect(async (_url, init) => {
        const ids = Object.keys(JSON.parse(String(init?.body)).questions);
        expect(ids.length).toBeLessThanOrEqual(64);
        return Response.json(response(ids));
      }),
    );
    const questions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`r${i}`, question]));
    const result = await askNouls({}, questions);
    expect(Object.keys(result.answers)).toHaveLength(65);
    expect(result.usage.input_tokens).toBe(24);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(fetchMock.mock.calls[1][1]?.signal);
  });
  test("rejects missing credentials before sending code", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    await expect(askNouls({}, { rule: question })).rejects.toThrow("CLOUDFLARE_API_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test("missing Cloudflare credentials leave the edit hook silent and fail open", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), "clef-hook-"));
    try {
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
  test("switching installed hooks back persists TypeSafe explicitly", () => {
    process.env.JEV_LINT_PROVIDER = "typesafe";
    for (const group of [hookGroup("claude"), recheckGroup()]) {
      expect(group.hooks[0].command).toContain("JEV_LINT_PROVIDER=typesafe");
      expect(group.hooks[0].command).toContain("JEV_LINT_MODEL=jev-1.13.0");
    }
  });
  test("rejects an invalid account or model", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "../other";
    await expect(askNouls({}, { rule: question })).rejects.toThrow("account ID");
    process.env.CLOUDFLARE_ACCOUNT_ID = "a".repeat(32);
    await expect(askNouls({}, { rule: question }, { model: "jev-latest" })).rejects.toThrow("clef or clef-flash");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each([
    response([], 0.9),
    response(["rule"], 2),
    response(["rule"], Number.NaN),
    { success: false, result: response().result },
    { success: true, result: {} },
  ])("rejects malformed or incomplete responses %#", async (value) => {
    fetchMock.mockResolvedValue(Response.json(value));
    await expect(askNouls({}, { rule: question })).rejects.toThrow("Cloudflare");
  });
  test("does not retry authentication failures or disclose the response body", async () => {
    fetchMock.mockResolvedValue(new Response("sensitive provider detail", { status: 401 }));
    await expect(askNouls({}, { rule: question }, { retries: 3 })).rejects.toThrow("Cloudflare 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test("retries a transient failure when explicitly requested", async () => {
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "0.001" } }));
    expect((await askNouls({}, { rule: question }, { retries: 1 })).answers.rule.noul).toBe(0.9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  test("retry waits respect the shared timeout", async () => {
    fetchMock.mockResolvedValue(new Response("busy", { status: 429, headers: { "retry-after": "60" } }));
    await expect(askNouls({}, { rule: question }, { retries: 1, timeoutMs: 10 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test("explicit local endpoint retains the unwrapped System One protocol", async () => {
    fetchMock.mockResolvedValue(Response.json(response().result));
    await askNouls({}, { rule: question }, { baseUrl: "http://127.0.0.1:8009", model: "local" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8009/v1/systemone");
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: "Bearer local", "Content-Type": "application/json" });
  });
  test("TypeSafe remains the default; unknown providers fail", () => {
    delete process.env.JEV_LINT_PROVIDER;
    expect(judgeProvider()).toBe("typesafe");
    expect(judgeModel()).toBe("jev-latest");
    process.env.JEV_LINT_PROVIDER = "typo";
    expect(judgeProvider).toThrow("Unknown");
  });
  test("private token files are supported and public files refused", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), "clef-key-"));
    try {
      const file = join(dir, "token");
      writeFileSync(file, "file-token\n", { mode: 0o600 });
      process.env.CLOUDFLARE_API_TOKEN_FILE = file;
      expect(cloudflareKey()).toBe("file-token");
      chmodSync(file, 0o644);
      expect(cloudflareKey()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  test("installed main and recheck hooks persist selection without secrets", () => {
    process.env.JEV_LINT_MODEL = "clef-flash";
    process.env.CLOUDFLARE_API_TOKEN_FILE = "/tmp/a'b token";
    for (const group of [hookGroup("claude"), hookGroup("codex"), recheckGroup()]) {
      const command = group.hooks[0].command;
      expect(command).toContain("JEV_LINT_PROVIDER=cloudflare");
      expect(command).toContain("clef-flash");
      expect(command).toContain("CLOUDFLARE_API_TOKEN_FILE=");
      expect(command).not.toContain("test-token");
      expect(command).not.toContain("CLOUDFLARE_API_TOKEN=");
    }
  });
  test("daemon identity isolates provider, account, model and token", () => {
    const baseline = daemonSocketPath();
    for (const [name, value] of [
      ["JEV_LINT_PROVIDER", "typesafe"],
      ["JEV_LINT_MODEL", "clef-flash"],
      ["CLOUDFLARE_ACCOUNT_ID", "b".repeat(32)],
      ["CLOUDFLARE_API_TOKEN", "rotated"],
    ]) {
      const previous = process.env[name];
      process.env[name] = value;
      expect(daemonSocketPath()).not.toBe(baseline);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
  test("Clef findings use existing gates and tiers", async () => {
    fetchMock.mockImplementation(
      withPreconnect(async (_url, init) => Response.json(response(Object.keys(JSON.parse(String(init?.body)).questions)))),
    );
    const result = await lintChange(
      { filePath: "/tmp/example.ts", addedCode: "try { run(); } catch (e) {}", changeKind: "write" },
      { packs: ["hygiene"] },
    );
    expect(result?.findings.find((f) => f.ruleId === "ts-no-empty-catch")?.tier).toBe("high");
    expect(result?.model).toBe("clef");
  });
  test("eval judges force their own provider and model", async () => {
    const c: Case = {
      id: "test",
      lang: "typescript",
      split: "dev",
      pack: "hygiene",
      payload: { tool_name: "Write", tool_input: { file_path: "/tmp/test.ts", content: "try { f(); } catch (e) {}" } },
      labels: ["ts-no-empty-catch"],
    };
    fetchMock.mockImplementation(
      withPreconnect(async (url, init) => {
        const result = response(Object.keys(JSON.parse(String(init?.body)).questions));
        return Response.json(String(url).includes("cloudflare.com") ? result : result.result);
      }),
    );
    await judgeClef(c);
    await judgeClefFlash(c);
    await judgeJev(c, "http://127.0.0.1:8009");
    expect(String(fetchMock.mock.calls[0][0])).toEndWith("/clef");
    expect(String(fetchMock.mock.calls[1][0])).toEndWith("/clef-flash");
    expect(String(fetchMock.mock.calls[2][0])).toEndWith("/v1/systemone");
  });
});
