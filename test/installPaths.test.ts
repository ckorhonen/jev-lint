import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { credentialPath, hookGroup, judgeCommandEnv } from "../src/install";

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
const installer = join(import.meta.dir, "../src/install.ts");
beforeEach(() => {
  root = realpathSync(mkdtempSync("/tmp/jev-install-path-"));
  cwd = process.cwd();
  env = { ...process.env };
  process.env.JEV_LINT_PROVIDER = "typesafe";
  delete process.env.JEV_LINT_MODEL;
});
afterEach(() => {
  process.chdir(cwd);
  process.env = env;
  rmSync(root, { recursive: true, force: true });
});

test("shell commands preserve spaces, quotes and literal shell syntax in binary paths", () => {
  const binary = join(root, "bun folder 'quote' $(literal);", "bun");
  mkdirSync(join(binary, ".."), { recursive: true });
  writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const command = hookGroup("claude", { bun: binary }).hooks[0].command;
  const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual([join(import.meta.dir, "../src/hook.ts")]);
});

test.each(["typesafe", "cloudflare", "openai"])("%s credential command preserves symlink/.. and does not store secrets", (provider) => {
  const keyName =
    provider === "typesafe" ? "TYPESAFE_API_KEY_FILE" : provider === "cloudflare" ? "CLOUDFLARE_API_TOKEN_FILE" : "OPENAI_API_KEY_FILE";
  mkdirSync(join(root, "target/nested"), { recursive: true });
  symlinkSync(join(root, "target/nested"), join(root, "link"));
  writeFileSync(join(root, "target/key '$(literal)'"), "dummy-private", { mode: 0o600 });
  process.chdir(root);
  process.env.JEV_LINT_PROVIDER = provider;
  process.env.CLOUDFLARE_ACCOUNT_ID = "a".repeat(32);
  process.env[keyName] = "link/../key '$(literal)'";
  const absolute = `${root}/link/../key '$(literal)'`;
  expect(credentialPath(process.env[keyName])).toBe(absolute);
  const command = judgeCommandEnv();
  const run = spawnSync("sh", ["-c", `${command} ${JSON.stringify(process.execPath)} -e 'console.log(process.env.${keyName})'`], {
    cwd: "/tmp",
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  expect(run.stdout.trim()).toBe(absolute);
  expect(readFileSync(run.stdout.trim(), "utf8")).toBe("dummy-private");
  expect(command).not.toContain("dummy-private");
});

test("local CLI preview writes nothing; apply backs up, preserves unrelated hooks and is idempotent", () => {
  const project = join(root, "project 'quote' with spaces");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const config = join(project, ".claude/settings.json");
  const original = JSON.stringify({ model: "user-choice", hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }] } });
  writeFileSync(config, original);
  const run = (apply = false) =>
    spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "../src/setup.ts"),
        "--provider",
        "decisions",
        "--claude-only",
        "--project",
        project,
        ...(apply ? ["--apply"] : []),
      ],
      { env: { PATH: process.env.PATH, HOME: root, OPENAI_API_KEY: "dummy-private" }, encoding: "utf8" },
    );
  const preview = run();
  expect(preview.status).toBe(0);
  expect(preview.stdout).toContain("no model request");
  expect(preview.stdout).not.toContain("dummy-private");
  expect(readFileSync(config, "utf8")).toBe(original);
  expect(run(true).status).toBe(0);
  const backups = () => readdirSync(join(project, ".claude")).filter((name) => name.includes("bak-jev-lint"));
  expect(backups()).toHaveLength(1);
  expect(readFileSync(join(project, ".claude", backups()[0]), "utf8")).toBe(original);
  const installed = readFileSync(config, "utf8");
  expect(JSON.parse(installed).model).toBe("user-choice");
  expect(installed).toContain("user-hook");
  expect(installed).toContain("JEV_LINT_PROVIDER=openai");
  expect(installed).not.toContain("dummy-private");
  expect(run(true).status).toBe(0);
  expect(readFileSync(config, "utf8")).toBe(installed);
  expect(backups()).toHaveLength(1);
  expect(existsSync(join(root, ".codex/hooks.json"))).toBe(false);
});

test("a checkout with spaces and apostrophes has recognised, idempotent quoted hook paths", () => {
  const checkout = join(root, "custom checkout 'name'");
  mkdirSync(join(checkout, "src"), { recursive: true });
  for (const file of ["install.ts", "jev.ts", "decisions.ts"])
    copyFileSync(join(import.meta.dir, "../src", file), join(checkout, "src", file));
  const probe = `import { hookGroup, isJevLint, mergeHook, recheckGroup, installedMode } from ${JSON.stringify(join(checkout, "src/install.ts"))};
    const group = hookGroup("claude", {bun:"/usr/bin/bun"});
    const config = mergeHook({}, group).config;
    console.log(JSON.stringify({recognised: isJevLint(group.hooks[0]), action: mergeHook(config,group).action,
      installed: installedMode(config).installed, command: group.hooks[0].command, recheck: recheckGroup().hooks[0].command}));`;
  const run = spawnSync(process.execPath, ["--eval", probe], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result).toMatchObject({ recognised: true, action: "unchanged", installed: true });
  expect(result.command).toContain("custom checkout");
  expect(result.recheck).toContain("custom checkout");
});

test("relative project symlink/.. paths reach the filesystem target rather than a lexical sibling", () => {
  mkdirSync(join(root, "target/nested"), { recursive: true });
  symlinkSync(join(root, "target/nested"), join(root, "link"));
  const run = spawnSync(process.execPath, [installer, "--project", "link/..", "--apply"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, TYPESAFE_API_KEY: "dummy-private" },
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  expect(existsSync(join(root, "target/.claude/settings.json"))).toBe(true);
  expect(existsSync(join(root, ".claude/settings.json"))).toBe(false);
});

test("applying to a symlink config refuses without modifying the target or creating backups", () => {
  mkdirSync(join(root, "project/.claude"), { recursive: true });
  const target = join(root, "user-settings.json");
  writeFileSync(target, "{}");
  symlinkSync(target, join(root, "project/.claude/settings.json"));
  const run = spawnSync(process.execPath, [installer, "--project", join(root, "project"), "--apply"], {
    env: { PATH: process.env.PATH, HOME: root, TYPESAFE_API_KEY: "dummy-private" },
    encoding: "utf8",
  });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("is a symlink");
  expect(readFileSync(target, "utf8")).toBe("{}");
  expect(readdirSync(join(root, "project/.claude"))).toEqual(["settings.json"]);
});

test("--no-recheck removes old provider rechecks without removing unrelated Stop hooks", () => {
  const project = join(root, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const config = join(project, ".claude/settings.json");
  const run = (provider: string, ...args: string[]) =>
    spawnSync(process.execPath, [installer, "--project", project, "--apply", ...args], {
      env: { PATH: process.env.PATH, HOME: root, JEV_LINT_PROVIDER: provider, TYPESAFE_API_KEY: "dummy", OPENAI_API_KEY: "dummy" },
      encoding: "utf8",
    });
  expect(run("typesafe").status).toBe(0);
  const parsed = JSON.parse(readFileSync(config, "utf8"));
  parsed.hooks.Stop.push({ hooks: [{ type: "command", command: "user-stop" }] });
  writeFileSync(config, JSON.stringify(parsed));
  expect(run("openai", "--no-recheck").status).toBe(0);
  const updated = JSON.parse(readFileSync(config, "utf8"));
  expect(updated.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "user-stop" }] }]);
  expect(updated.hooks.SubagentStop).toBeUndefined();
  expect(updated.hooks.PostToolUse[0].hooks[0].command).toContain("JEV_LINT_PROVIDER=openai");
});
