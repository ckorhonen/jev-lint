import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, packageVersion, parseCli, runCli } from "../src/cli";
import { hookGroup, isEphemeralRoot, isJevLint, mergeHook, stablePackageDir, stageRuntime } from "../src/install";

const REPO = join(import.meta.dir, "..");
const BIN = join(REPO, "bin/jev-lint.mjs");

describe("cli parsing and dispatch", () => {
  test("help and version flags resolve cleanly", () => {
    for (const argv of [[], ["-h"], ["--help"], ["help"]]) expect(parseCli(argv)).toEqual({ kind: "help" });
    for (const argv of [["-v"], ["--version"]]) expect(parseCli(argv)).toEqual({ kind: "version" });
  });

  test("subcommands and aliases route to the expected scripts with forwarded args", () => {
    expect(parseCli(["setup", "--provider", "clef"])).toEqual({
      kind: "command",
      name: "setup",
      scriptPath: join(REPO, "src/setup.ts"),
      args: ["--provider", "clef"],
    });
    expect(parseCli(["init", "--apply"])).toEqual({
      kind: "command",
      name: "init",
      scriptPath: join(REPO, "src/setup.ts"),
      args: ["--apply"],
    });
    expect(parseCli(["upgrade", "--project", "/tmp/demo"])).toEqual({
      kind: "command",
      name: "upgrade",
      scriptPath: join(REPO, "src/install.ts"),
      args: ["--upgrade", "--project", "/tmp/demo"],
    });
    for (const name of Object.keys(COMMANDS)) {
      const parsed = parseCli([name]);
      expect(parsed.kind).toBe("command");
      if (parsed.kind === "command") expect(existsSync(parsed.scriptPath)).toBe(true);
    }
  });

  test("runCli prints help, version, unknown-command error, and delegates exec", () => {
    const out: string[] = [];
    const err: string[] = [];
    const calls: { scriptPath: string; args: string[] }[] = [];
    const io = {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      exec: (scriptPath: string, args: string[]) => {
        calls.push({ scriptPath, args });
        return 0;
      },
    };
    expect(runCli(["--help"], io)).toBe(0);
    expect(out.at(-1)).toContain("bunx jev-lint setup");
    expect(runCli(["--version"], io)).toBe(0);
    expect(out.at(-1)).toBe(`jev-lint ${packageVersion()}`);
    expect(runCli(["bogus"], io)).toBe(1);
    expect(err.at(-1)).toContain('unknown command "bogus"');
    expect(runCli(["check", "a.ts"], io)).toBe(0);
    expect(calls).toEqual([{ scriptPath: join(REPO, "src/check.ts"), args: ["a.ts"] }]);
  });
});

describe("bin/jev-lint.mjs shim", () => {
  test("runs directly under bun", () => {
    const run = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(`jev-lint ${packageVersion()}`);
  });

  test("runs under node (npx path) and reports a clear error if bun is unavailable", () => {
    const node = Bun.which("node");
    if (!node) return;
    const ok = spawnSync(node, [BIN, "--version"], {
      env: { ...process.env, JEV_LINT_BUN: process.execPath },
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe(`jev-lint ${packageVersion()}`);

    const emptyHome = mkdtempSync(join(tmpdir(), "jev-no-bun-"));
    try {
      const missing = spawnSync(node, [BIN, "--version"], {
        env: { PATH: "", HOME: emptyHome },
        encoding: "utf8",
      });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("jev-lint requires Bun");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("ephemeral package staging and zero-clone install", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "jev-cli-stage-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("isEphemeralRoot distinguishes git checkouts from bunx/npx cache paths", () => {
    expect(isEphemeralRoot(REPO, {})).toBe(false);
    expect(isEphemeralRoot("/home/user/.npm/_npx/abc123/node_modules/jev-lint", {})).toBe(true);
    expect(isEphemeralRoot("/tmp/bunx-1000-jev-lint@0.1.0/node_modules/jev-lint", {})).toBe(true);
    expect(isEphemeralRoot(root, {})).toBe(true);
    expect(isEphemeralRoot(REPO, { JEV_LINT_STAGE: "1" })).toBe(true);
    expect(isEphemeralRoot(root, { JEV_LINT_STAGE: "0" })).toBe(false);
  });

  test("stablePackageDir honors JEV_LINT_INSTALL_DIR and XDG_DATA_HOME", () => {
    expect(stablePackageDir({ JEV_LINT_INSTALL_DIR: join(root, "custom") })).toBe(join(root, "custom"));
    expect(stablePackageDir({ XDG_DATA_HOME: join(root, "xdg") })).toBe(join(root, "xdg", "jev-lint", "pkg"));
  });

  test("stageRuntime refuses symlink targets and parents", () => {
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link-pkg");
    symlinkSync(real, link);
    expect(() => stageRuntime(REPO, link)).toThrow("is a symlink");
    expect(() => stageRuntime(REPO, join(link, "pkg"))).toThrow("is a symlink");
  });

  test("preview writes nothing; apply stages runtime, installs hooks/skills, and migrates git-checkout hooks", () => {
    const home = join(root, "home");
    const staged = join(home, ".local/share/jev-lint/pkg");
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    // Pre-populate an older git-checkout hook to verify clean migration without duplicates.
    const claudeSettings = join(home, ".claude/settings.json");
    writeFileSync(
      claudeSettings,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit|MultiEdit",
              hooks: [{ type: "command", command: "JEV_LINT_MODEL=jev-1.13.0 bun ~/Repos/jev-lint/src/hook.ts", timeout: 15 }],
            },
          ],
        },
      }),
    );

    // Stage a simulated ephemeral package (no .git) under tmpdir.
    const ephemeralPkg = join(root, "bunx-1000-jev-lint@0.1.0");
    stageRuntime(REPO, ephemeralPkg);
    expect(existsSync(join(ephemeralPkg, ".git"))).toBe(false);

    const cliEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local/share"),
    };

    // Dry run preview writes nothing.
    const preview = spawnSync(process.execPath, [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--claude-only", "--skills"], {
      env: cliEnv,
      encoding: "utf8",
    });
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain(`runtime: would stage to ${staged} (dry run; pass --apply)`);
    expect(existsSync(staged)).toBe(false);

    // Apply stages the runtime, replaces the legacy checkout hook, and links skills from staged dir.
    const applied = spawnSync(
      process.execPath,
      [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--apply", "--claude-only", "--skills"],
      { env: cliEnv, encoding: "utf8" },
    );
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain(`runtime: staged to ${staged}`);
    expect(existsSync(join(staged, "src/hook.ts"))).toBe(true);
    expect(existsSync(join(staged, "rules/typescript.json"))).toBe(true);

    const settings = JSON.parse(readFileSync(claudeSettings, "utf8"));
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    const cmd: string = settings.hooks.PostToolUse[0].hooks[0].command;
    expect(cmd).toContain(join(staged, "src/hook.ts"));
    expect(cmd).not.toContain("bunx-1000");
    expect(isJevLint(settings.hooks.PostToolUse[0].hooks[0])).toBe(true);
    expect(lstatSync(join(home, ".claude/skills/jev-lint-setup")).isSymbolicLink()).toBe(true);

    // Re-running apply is idempotent.
    const rerun = spawnSync(process.execPath, [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--apply", "--claude-only"], {
      env: cliEnv,
      encoding: "utf8",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("hook unchanged");

    // Package-mode upgrade works without .git and preserves installed mode (--pre).
    const preApply = spawnSync(
      process.execPath,
      [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--apply", "--claude-only", "--pre", "--no-recheck"],
      { env: cliEnv, encoding: "utf8" },
    );
    expect(preApply.status).toBe(0);

    const upgraded = spawnSync(process.execPath, [join(ephemeralPkg, "bin/jev-lint.mjs"), "upgrade"], {
      env: cliEnv,
      encoding: "utf8",
    });
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).toContain(`upgrade: package v${packageVersion()}`);
    expect(upgraded.stdout).toContain("before-the-write, no re-check");
    const afterUpgrade = JSON.parse(readFileSync(claudeSettings, "utf8"));
    expect(afterUpgrade.hooks.PreToolUse).toHaveLength(1);
    expect(afterUpgrade.hooks.PostToolUse).toBeUndefined();
    expect(afterUpgrade.hooks.Stop).toBeUndefined();
  });

  test("staged jev-lint/pkg hook path is recognized by mergeHook as owned", () => {
    const stagedHook = hookGroup("claude", { bun: "/usr/bin/bun", root: "/home/u/.local/share/jev-lint/pkg" });
    expect(isJevLint(stagedHook.hooks[0])).toBe(true);
    const fresh = hookGroup("claude", { bun: "/usr/bin/bun" });
    const merged = mergeHook({ hooks: { PostToolUse: [stagedHook] } }, fresh);
    expect(merged.action).toBe("updated");
    expect(merged.config.hooks?.PostToolUse).toHaveLength(1);
  });
});
