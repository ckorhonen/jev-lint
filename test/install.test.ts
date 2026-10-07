import { describe, expect, test } from "bun:test";
import { hookGroup, installedMode, isJevLint, mergeHook, recheckGroup } from "../src/install";

test("ownership requires literal bun execution, not mentions, suffixes or expansions", () => {
  for (const command of [
    "echo /tmp/jev-lint/src/hook.ts is unavailable",
    "bun /tmp/jev-lint/src/hook.ts.bak",
    "bun /tmp/jev-lint/src/hook.ts; echo audit",
    'bun "/tmp/jev-lint/src/hook\\.ts"',
    "bun /tmp/*/jev-lint/src/hook.ts",
    "bun $ROOT/jev-lint/src/hook.ts",
  ])
    expect(isJevLint({ type: "command", command, timeout: 15 })).toBe(false);
  expect(
    isJevLint({
      type: "command",
      command: "JEV_LINT_PROVIDER=openai bun '/tmp/custom old/src/hook.ts'",
      statusMessage: "jev-lint",
      timeout: 15,
    }),
  ).toBe(true);
});

test("quoted and escaped assignment names are executable words; legacy tilde paths migrate", () => {
  for (const command of [
    "'NOT_AN_ASSIGNMENT=x' bun /tmp/jev-lint/src/hook.ts",
    "\\NOT_AN_ASSIGNMENT=x bun /tmp/jev-lint/src/hook.ts",
    '"JEV_LINT_MODEL"=x bun /tmp/jev-lint/src/hook.ts',
  ])
    expect(isJevLint({ type: "command", command, timeout: 15 })).toBe(false);
  for (const command of [
    "JEV_LINT_MODEL='jev-1.13.0' bun ~/Repos/jev-lint/src/hook.ts",
    'JEV_LINT_MODEL="jev-1.13.0" bun /tmp/jev-lint/src/hook.ts',
  ])
    expect(isJevLint({ type: "command", command, timeout: 15 })).toBe(true);
});

test("provider changes coalesce every owned duplicate while preserving mixed-group hooks", () => {
  const old = hookGroup("claude", { bun: "/usr/bin/bun" });
  const audit = { type: "command" as const, command: "echo /tmp/jev-lint/src/hook.ts", timeout: 5 };
  const updated = hookGroup("claude", { async: true });
  const merged = mergeHook({ hooks: { PostToolUse: [old, { matcher: "*", hooks: [old.hooks[0], audit] }, old] } }, updated);
  expect(merged.action).toBe("updated");
  const groups = merged.config.hooks?.PostToolUse ?? [];
  expect(groups.flatMap((g) => g.hooks).filter(isJevLint)).toEqual(updated.hooks);
  expect(groups).toContainEqual({ matcher: "*", hooks: [audit] });
  expect(mergeHook(merged.config, updated).action).toBe("unchanged");
});

test("binary normalization never conceals a changed credential file named bun", () => {
  const first = hookGroup("claude");
  first.hooks[0].command = "JEV_LINT_PROVIDER=typesafe TYPESAFE_API_KEY_FILE='/tmp/one/bun' /usr/bin/bun /tmp/jev-lint/src/hook.ts";
  const second = structuredClone(first);
  second.hooks[0].command = second.hooks[0].command.replace("/tmp/one/bun", "/tmp/two/bun");
  expect(mergeHook({ hooks: { PostToolUse: [first] } }, second).action).toBe("updated");
});

describe("install mergeHook", () => {
  const group = hookGroup("claude", { bun: "/usr/bin/bun" });

  test("recognises its hook by this checkout's path or by the jev-lint name, not any hook.ts", () => {
    expect(isJevLint(group.hooks[0])).toBe(true);
    expect(
      isJevLint({ type: "command", command: "JEV_LINT_MODEL=jev-1.13.0 /usr/bin/bun /home/u/Repos/jev-lint/src/hook.ts", timeout: 15 }),
    ).toBe(true);
    expect(isJevLint({ type: "command", command: "/usr/bin/bun /home/u/tools/other-linter/src/hook.ts", timeout: 15 })).toBe(false);
  });

  test("installedMode reads pre/async/re-check back from a config, for --upgrade", () => {
    expect(installedMode({}).installed).toBe(false);
    const plain = mergeHook({}, group).config;
    expect(installedMode(plain)).toEqual({ installed: true, pre: false, async: false, recheck: false });
    let withRecheck = plain;
    for (const event of ["Stop", "SubagentStop"])
      withRecheck = mergeHook(withRecheck, recheckGroup({ bun: "/usr/bin/bun" }), event, (h) => /recheck\.ts/.test(h.command)).config;
    expect(installedMode(withRecheck).recheck).toBe(true);
    const asyncCfg = mergeHook({}, hookGroup("claude", { bun: "/usr/bin/bun", async: true })).config;
    expect(installedMode(asyncCfg).async).toBe(true);
    const preCfg = mergeHook({}, group, "PreToolUse").config;
    expect(installedMode(preCfg)).toMatchObject({ installed: true, pre: true });
  });

  test("adds the hook next to unrelated hooks", () => {
    const other = { matcher: "*", hooks: [{ type: "command" as const, command: "other", timeout: 5 }] };
    const { config, action } = mergeHook({ model: "x", hooks: { PostToolUse: [other] } }, group);
    expect(action).toBe("added");
    expect(config.hooks?.PostToolUse).toEqual([other, group]);
    expect(config.model).toBe("x");
  });

  test("is idempotent and updates an old jev-lint command in place", () => {
    const once = mergeHook({}, group).config;
    expect(mergeHook(once, group).action).toBe("unchanged");
    expect(mergeHook(once, hookGroup("claude", { bun: "/opt/homebrew/bin/bun" })).action).toBe("unchanged");
    const asyncGroup = hookGroup("claude", { bun: "/usr/bin/bun", async: true });
    const { config, action } = mergeHook(once, asyncGroup);
    expect(action).toBe("updated");
    expect(config.hooks?.PostToolUse).toHaveLength(1);
    expect(config.hooks?.PostToolUse?.[0].hooks[0].asyncRewake).toBe(true);
  });

  test("codex never gets rewake and matches apply_patch", () => {
    const codex = hookGroup("codex", { async: true, bun: "/usr/bin/bun" });
    expect(codex.matcher).toContain("apply_patch");
    expect(codex.hooks[0].asyncRewake).toBeUndefined();
  });

  test("updating a jev-lint hook that shares a group never changes the other hook's matcher", () => {
    const other = { type: "command" as const, command: "audit", timeout: 5 };
    const old = { type: "command" as const, command: "bun /x/jev-lint/src/hook.ts", timeout: 15 };
    const { config, action } = mergeHook({ hooks: { PostToolUse: [{ matcher: "*", hooks: [other, old] }] } }, group);
    expect(action).toBe("updated");
    expect(config.hooks?.PostToolUse).toEqual([{ matcher: "*", hooks: [other] }, group]);
  });

  test("the re-check goes on Stop without a matcher, idempotently, next to other Stop hooks", async () => {
    const { recheckGroup } = await import("../src/install");
    const other = { hooks: [{ type: "command" as const, command: "notify", timeout: 5 }] };
    const recheck = recheckGroup({ bun: "/usr/bin/bun" });
    const isRecheck = (h: { command: string }) => /jev-lint\/src\/recheck\.ts/.test(h.command);
    const once = mergeHook({ hooks: { Stop: [other] } }, recheck, "Stop", isRecheck);
    expect(once.action).toBe("added");
    expect(once.config.hooks?.Stop).toEqual([other, recheck]);
    expect(recheck.matcher).toBeUndefined();
    expect(mergeHook(once.config, recheck, "Stop", isRecheck).action).toBe("unchanged");
    expect(once.config.hooks?.PostToolUse).toBeUndefined();
  });

  test("--pre moves the hook from PostToolUse to PreToolUse and back, keeping other hooks", async () => {
    const { removeHook } = await import("../src/install");
    const other = { matcher: "*", hooks: [{ type: "command" as const, command: "audit", timeout: 5 }] };
    const after = mergeHook({ hooks: { PostToolUse: [other] } }, group).config;
    let pre = mergeHook(after, group, "PreToolUse").config;
    pre = removeHook(pre, "PostToolUse").config;
    expect(pre.hooks?.PostToolUse).toEqual([other]);
    expect(pre.hooks?.PreToolUse).toEqual([group]);
    const back = removeHook(mergeHook(pre, group, "PostToolUse").config, "PreToolUse").config;
    expect(back.hooks?.PreToolUse).toBeUndefined();
    expect(back.hooks?.PostToolUse).toEqual([other, group]);
    expect(removeHook(back, "PreToolUse").removed).toBe(false);
  });
});
