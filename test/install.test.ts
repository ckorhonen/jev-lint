import { describe, expect, test } from "bun:test";
import { hookGroup, mergeHook } from "../src/install";

describe("install mergeHook", () => {
  const group = hookGroup("claude", { bun: "/usr/bin/bun" });

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
});
