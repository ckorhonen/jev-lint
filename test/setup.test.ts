import { expect, test } from "bun:test";
import { guidedSetup, providerEnvironment, type SetupProvider, setupGuidance } from "../src/setup";

test.each(["typesafe", "clef", "decisions"] as SetupProvider[])(
  "%s selects an independent provider without inherited model leakage",
  (provider) => {
    const original = { JEV_LINT_PROVIDER: "cloudflare", JEV_LINT_MODEL: "clef-flash", OPENAI_API_KEY: "dummy-secret" };
    const env = providerEnvironment(provider, original);
    expect(env.JEV_LINT_PROVIDER).toBe(provider === "clef" ? "cloudflare" : provider === "decisions" ? "openai" : "typesafe");
    expect(env.JEV_LINT_MODEL).toBe(provider === "clef" ? "clef-flash" : provider === "decisions" ? "gpt-6-luna" : "jev-1.13.0");
    expect(original.JEV_LINT_PROVIDER).toBe("cloudflare");
    expect(setupGuidance(provider)).not.toContain("dummy-secret");
  },
);

test("new installs keep TypeSafe and previews decline by default", async () => {
  const calls: string[][] = [];
  const answers = ["", ""];
  expect(
    await guidedSetup({
      env: {},
      ask: async () => answers.shift() ?? "",
      log() {},
      run: (args, env) => {
        calls.push(args);
        expect(env.JEV_LINT_PROVIDER).toBe("typesafe");
        return 0;
      },
    }),
  ).toBe(0);
  expect(calls).toEqual([[]]);
});

test.each(["clef", "clef-flash", "gpt-6-luna"])("unmarked foreign %s model does not leak into TypeSafe", (model) => {
  expect(providerEnvironment("typesafe", { JEV_LINT_MODEL: model }).JEV_LINT_MODEL).toBe("jev-1.13.0");
});

test("interactive choice retains current provider and applies only after preview confirmation", async () => {
  const calls: string[][] = [];
  const answers = ["", "yes"];
  await guidedSetup({
    env: { JEV_LINT_PROVIDER: "openai" },
    ask: async () => answers.shift() ?? "",
    log() {},
    installerArgs: ["--project", "relative folder"],
    run: (args, env) => {
      calls.push(args);
      expect(env.JEV_LINT_MODEL).toBe("gpt-6-luna");
      return 0;
    },
  });
  expect(calls).toEqual([
    ["--project", "relative folder"],
    ["--project", "relative folder", "--apply"],
  ]);
});

test.each([false, true])("explicit provider apply=%s preserves argv paths and does not prompt", async (apply) => {
  const calls: string[][] = [];
  await guidedSetup({
    provider: "clef",
    apply,
    env: {},
    log() {},
    installerArgs: ["--claude-only", "--project", "folder 'quoted'; $(literal)"],
    run: (args) => {
      calls.push(args);
      return 0;
    },
  });
  expect(calls).toHaveLength(apply ? 2 : 1);
  expect(calls[0][2]).toBe("folder 'quoted'; $(literal)");
  if (apply) expect(calls[1].at(-1)).toBe("--apply");
});

test("preview failure prevents apply", async () => {
  let runs = 0;
  expect(
    await guidedSetup({
      provider: "decisions",
      apply: true,
      env: {},
      log() {},
      run: () => {
        runs++;
        return 7;
      },
    }),
  ).toBe(7);
  expect(runs).toBe(1);
});

test.each(["--smoke", "--upgrade", "--apply"])("guided preview rejects %s before running anything", async (arg) => {
  await expect(
    guidedSetup({
      provider: "typesafe",
      env: {},
      installerArgs: [arg],
      log() {},
      run: () => {
        throw new Error("unexpected run");
      },
    }),
  ).rejects.toThrow("not preview options");
});

test("noninteractive choice and invalid interactive selection fail before writes", async () => {
  const opts = {
    env: {},
    log() {},
    run: () => {
      throw new Error("unexpected run");
    },
  };
  await expect(guidedSetup(opts)).rejects.toThrow("needs a terminal");
  await expect(guidedSetup({ ...opts, ask: async () => "invalid" })).rejects.toThrow("Choose 1");
});
