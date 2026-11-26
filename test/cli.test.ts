import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    expect(out.at(-1)).toContain("bunx @ckorhonen/jev-lint setup");
    expect(runCli(["--version"], io)).toBe(0);
    expect(out.at(-1)).toBe(`jev-lint ${packageVersion()}`);
    expect(runCli(["bogus"], io)).toBe(1);
    expect(err.at(-1)).toContain('unknown command "bogus"');
    expect(runCli(["check", "a.ts"], io)).toBe(0);
    expect(calls).toEqual([{ scriptPath: join(REPO, "src/check.ts"), args: ["a.ts"] }]);
  });

  test("package.json publishes publicly under the scoped @ckorhonen/jev-lint name with jev-lint bin", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      name?: string;
      publishConfig?: { access?: string };
      bin?: Record<string, string>;
    };
    expect(pkg.name).toBe("@ckorhonen/jev-lint");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.bin?.["jev-lint"]).toBe("./bin/jev-lint.mjs");
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
    expect(isEphemeralRoot("/home/user/.npm/_npx/abc123/node_modules/@ckorhonen/jev-lint", {})).toBe(true);
    expect(isEphemeralRoot("/tmp/bunx-1000-@ckorhonen+jev-lint@0.1.0/node_modules/@ckorhonen/jev-lint", {})).toBe(true);
    expect(isEphemeralRoot(root, {})).toBe(true);
    expect(isEphemeralRoot(REPO, { JEV_LINT_STAGE: "1" })).toBe(true);
    expect(isEphemeralRoot(root, { JEV_LINT_STAGE: "0" })).toBe(false);
  });

  test("stablePackageDir honors JEV_LINT_INSTALL_DIR and XDG_DATA_HOME", () => {
    expect(stablePackageDir({ JEV_LINT_INSTALL_DIR: join(root, "custom") })).toBe(join(root, "custom"));
    expect(stablePackageDir({ XDG_DATA_HOME: join(root, "xdg") })).toBe(join(root, "xdg", "jev-lint", "pkg"));
  });

  test("stageRuntime refuses symlink targets, symlink parents, and non-empty unrelated directories", () => {
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link-pkg");
    symlinkSync(real, link);
    expect(() => stageRuntime(REPO, link)).toThrow("is a symlink");
    expect(() => stageRuntime(REPO, join(link, "pkg"))).toThrow("is a symlink");

    const unrelated = join(root, "existing-user-dir");
    mkdirSync(unrelated);
    const keepFile = join(unrelated, "important.txt");
    writeFileSync(keepFile, "do not delete");
    expect(() => stageRuntime(REPO, unrelated)).toThrow("unrelated files");
    expect(readFileSync(keepFile, "utf8")).toBe("do not delete");

    const otherPkg = join(root, "other-pkg");
    mkdirSync(otherPkg);
    writeFileSync(join(otherPkg, "package.json"), JSON.stringify({ name: "other-package" }));
    expect(() => stageRuntime(REPO, otherPkg)).toThrow("unrelated files");

    const legacyStaged = join(root, "legacy-staged");
    mkdirSync(legacyStaged);
    writeFileSync(join(legacyStaged, "package.json"), JSON.stringify({ name: "jev-lint" }));
    stageRuntime(REPO, legacyStaged);
    const replacedPkg = JSON.parse(readFileSync(join(legacyStaged, "package.json"), "utf8")) as { name?: string };
    expect(replacedPkg.name).toBe("@ckorhonen/jev-lint");
  });

  test("preview writes nothing; apply stages runtime, installs hooks/skills, and migrates git-checkout hooks", () => {
    const home = join(root, "home");
    const staged = join(home, ".local/share/jev-lint/pkg");
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    // Pre-populate a legacy checkout skill symlink (even dangling) to verify migration updates it,
    // plus a custom non-jev-lint skill symlink to verify user customizations are left untouched.
    symlinkSync("/old/checkout/jev-lint/.agents/skills/jev-lint-setup", join(home, ".claude/skills/jev-lint-setup"));
    const customSkill = join(root, "custom-skills/.agents/skills/jev-lint-learn");
    mkdirSync(customSkill, { recursive: true });
    symlinkSync(customSkill, join(home, ".claude/skills/jev-lint-learn"));
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
    const ephemeralPkg = join(root, "bunx-1000-@ckorhonen+jev-lint@0.1.0");
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
    expect(readlinkSync(join(home, ".claude/skills/jev-lint-setup"))).toBe(join(staged, ".agents/skills/jev-lint-setup"));
    expect(readlinkSync(join(home, ".claude/skills/jev-lint-learn"))).toBe(customSkill);

    // Re-running apply is idempotent.
    const rerun = spawnSync(process.execPath, [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--apply", "--claude-only"], {
      env: cliEnv,
      encoding: "utf8",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("hook unchanged");

    // Package-mode upgrade preserves non-default judge provider settings (e.g. OpenAI Decisions).
    const decisionsApply = spawnSync(
      process.execPath,
      [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--apply", "--claude-only", "--pre", "--no-recheck"],
      { env: { ...cliEnv, JEV_LINT_PROVIDER: "openai", JEV_LINT_MODEL: "gpt-6-luna" }, encoding: "utf8" },
    );
    expect(decisionsApply.status).toBe(0);

    const upgraded = spawnSync(process.execPath, [join(ephemeralPkg, "bin/jev-lint.mjs"), "upgrade"], {
      env: cliEnv,
      encoding: "utf8",
    });
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).toContain(`upgrade: package v${packageVersion()}`);
    expect(upgraded.stdout).toContain("before-the-write, no re-check");
    const afterUpgrade = JSON.parse(readFileSync(claudeSettings, "utf8"));
    expect(afterUpgrade.hooks.PreToolUse).toHaveLength(1);
    expect(afterUpgrade.hooks.PreToolUse[0].hooks[0].command).toContain("JEV_LINT_PROVIDER=openai");
    expect(afterUpgrade.hooks.PreToolUse[0].hooks[0].command).toContain("JEV_LINT_MODEL='gpt-6-luna'");
    expect(afterUpgrade.hooks.PostToolUse).toBeUndefined();
    expect(afterUpgrade.hooks.Stop).toBeUndefined();

    // Upgrading Codex when Claude has a different provider preserves each agent's own provider.
    const codexApply = spawnSync(process.execPath, [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--apply", "--codex-only"], {
      env: { ...cliEnv, JEV_LINT_PROVIDER: "typesafe" },
      encoding: "utf8",
    });
    expect(codexApply.status).toBe(0);
    const dualUpgrade = spawnSync(process.execPath, [join(ephemeralPkg, "bin/jev-lint.mjs"), "upgrade"], {
      env: cliEnv,
      encoding: "utf8",
    });
    expect(dualUpgrade.status).toBe(0);
    const claudeAfterDual = JSON.parse(readFileSync(claudeSettings, "utf8"));
    const codexAfterDual = JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8"));
    expect(claudeAfterDual.hooks.PreToolUse[0].hooks[0].command).toContain("JEV_LINT_PROVIDER=openai");
    expect(codexAfterDual.hooks.PostToolUse[0].hooks[0].command).toContain("JEV_LINT_PROVIDER=typesafe");
  });

  test("first-time --skills creates missing target agent skill directory on --apply", () => {
    const home = join(root, "fresh-home");
    mkdirSync(home);
    const ephemeralPkg = join(root, "bunx-fresh-@ckorhonen+jev-lint@0.1.0");
    stageRuntime(REPO, ephemeralPkg);
    const cliEnv = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(home, ".local/share") };

    const preview = spawnSync(process.execPath, [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--claude-only", "--skills"], {
      env: cliEnv,
      encoding: "utf8",
    });
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("jev-lint-rules: would link");
    expect(existsSync(join(home, ".claude/skills"))).toBe(false);

    const applied = spawnSync(
      process.execPath,
      [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--apply", "--claude-only", "--skills"],
      { env: cliEnv, encoding: "utf8" },
    );
    expect(applied.status).toBe(0);
    expect(lstatSync(join(home, ".claude/skills/jev-lint-rules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, ".codex/skills"))).toBe(false);

    // --codex-only --skills ignores a symlinked ~/.claude/skills directory.
    const codexHome = join(root, "codex-only-home");
    mkdirSync(join(codexHome, ".claude"), { recursive: true });
    const symlinkTarget = join(root, "external-claude-skills");
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, join(codexHome, ".claude/skills"));
    const codexOnly = spawnSync(
      process.execPath,
      [join(ephemeralPkg, "bin/jev-lint.mjs"), "install", "--apply", "--codex-only", "--skills"],
      { env: { PATH: process.env.PATH, HOME: codexHome, XDG_DATA_HOME: join(codexHome, ".local/share") }, encoding: "utf8" },
    );
    expect(codexOnly.status).toBe(0);
    expect(lstatSync(join(codexHome, ".codex/skills/jev-lint-rules")).isSymbolicLink()).toBe(true);
  });

  test("npm-packed artifact installs through npx and the staged hook completes a judged write", async () => {
    const npm = Bun.which("npm");
    const npx = Bun.which("npx");
    if (!npm || !npx) return;

    const pack = spawnSync(npm, ["pack", "--silent", "--pack-destination", root], { cwd: REPO, encoding: "utf8" });
    if (pack.status !== 0) throw new Error(`npm pack failed (${pack.status}):\n${pack.stdout}\n${pack.stderr}`);
    const tarballName = readdirSync(root).find((name) => name.endsWith(".tgz"));
    if (!tarballName) throw new Error("npm pack produced no tarball");
    const tarball = join(root, tarballName);

    const home = join(root, "npx-home");
    mkdirSync(home, { recursive: true });
    const cliEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      npm_config_cache: join(root, "npm-cache"),
    };
    const install = spawnSync(npx, ["--yes", "--package", tarball, "--", "jev-lint", "install", "--apply", "--claude-only", "--skills"], {
      env: cliEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (install.status !== 0) throw new Error(`npx install failed (${install.status}):\n${install.stdout}\n${install.stderr}`);

    const staged = join(home, ".local/share/jev-lint/pkg");
    expect(install.stdout).toContain(`runtime: staged to ${staged}`);
    expect(existsSync(join(staged, "src/hook.ts"))).toBe(true);
    expect(existsSync(join(staged, "rules/typescript.json"))).toBe(true);
    expect(lstatSync(join(home, ".claude/skills/jev-lint-setup")).isSymbolicLink()).toBe(true);

    const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    const command = settings.hooks.PostToolUse[0].hooks[0].command;
    expect(command).toContain(join(staged, "src/hook.ts"));
    expect(command).not.toContain("_npx");

    type SystemOneRequest = {
      model?: string;
      state?: { language?: string; file_path?: string; added_code?: string };
      questions?: Record<string, unknown>;
    };
    const seen: SystemOneRequest[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/systemone") return new Response("not found", { status: 404 });
        const body = (await request.json()) as SystemOneRequest;
        seen.push(body);
        const answers = Object.fromEntries(
          Object.keys(body.questions ?? {}).map((id) => [id, { type: "noul", noul: id === "ts-no-empty-catch" ? 0.99 : 0 }]),
        );
        return Response.json({ model: body.model ?? "mock", answers, usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    try {
      const repo = join(root, "target-repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      const file = join(repo, "smoke.ts");
      const content = "export async function load(url: string) {\n  try {\n    return await fetch(url);\n  } catch (e) {}\n}\n";
      writeFileSync(file, content);
      const event = {
        hook_event_name: "PostToolUse",
        cwd: repo,
        tool_name: "Write",
        session_id: "package-e2e",
        tool_input: { file_path: file, content },
      };
      const child = Bun.spawn(["sh", "-c", command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_STATE_HOME: join(home, ".local", "state"),
          TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`,
          JEV_LINT_DAEMON: "off",
        },
      });
      child.stdin.write(JSON.stringify(event));
      child.stdin.end();
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status !== 0) throw new Error(`staged hook failed (${status}):\n${stdout}\n${stderr}`);
      expect(stderr).toBe("");
      const output = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(output.hookSpecificOutput?.additionalContext).toContain("ts-no-empty-catch");
      expect(seen).toHaveLength(1);
      expect(seen[0].model).toBe("jev-1.13.0");
      expect(seen[0].state?.language).toBe("typescript");
      expect(seen[0].state?.added_code).toBe(content);
      expect(seen[0].questions).toHaveProperty("ts-no-empty-catch");
      const log = readFileSync(join(home, ".local/state/jev-lint/findings.jsonl"), "utf8");
      expect(log).toContain('"rule":"ts-no-empty-catch"');
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("staged jev-lint/pkg hook path is recognized by mergeHook as owned", () => {
    const stagedHook = hookGroup("claude", { bun: "/usr/bin/bun", root: "/home/u/.local/share/jev-lint/pkg" });
    expect(isJevLint(stagedHook.hooks[0])).toBe(true);
    const fresh = hookGroup("claude", { bun: "/usr/bin/bun" });
    const merged = mergeHook({ hooks: { PostToolUse: [stagedHook] } }, fresh);
    expect(merged.action).toBe("updated");
    expect(merged.config.hooks?.PostToolUse).toHaveLength(1);
  });
});
