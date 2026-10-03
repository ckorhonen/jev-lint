#!/usr/bin/env bun
// Install or update the jev-lint hook for Claude Code and Codex, idempotently.
//   bun ~/Repos/jev-lint/src/install.ts                 # check only: key, configs, skills (no writes)
//   bun ~/Repos/jev-lint/src/install.ts --apply         # write hooks (backs up each file first)
//   options: --pre (Claude Code: check each edit before it's applied and block high-confidence
//            findings, instead of after the write), --no-recheck (skip the end-of-turn re-check on Stop/SubagentStop), --claude-only | --codex-only, --project <repo> (Claude hook in <repo>/.claude/settings.json),
//            --async (Claude: background check that wakes the agent), --skills (link skills), --smoke
//            --upgrade: git pull this checkout, bun install, then re-apply the hooks in the mode
//            they are currently installed in (pre/async/re-check detected from the config)
//
// An existing jev-lint entry (any command running jev-lint's src/hook.ts) is replaced in place,
// never duplicated. Other hooks are left untouched.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cloudflareKey, judgeModel, judgeProvider, keyFilePath } from "./jev";

const REPO = resolve(import.meta.dir, "..");
const HOOK = join(REPO, "src/hook.ts");
const MODEL = "jev-1.13.0";
const installedModel = () => process.env.JEV_LINT_MODEL ?? (judgeProvider() === "cloudflare" ? judgeModel() : MODEL);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Persist non-secret provider settings for both hooks. Credentials stay in the
// agent environment or a private token file, never in hook configuration.
export function judgeCommandEnv(): string {
  const provider = judgeProvider();
  const model = installedModel();
  if (provider === "typesafe") return `JEV_LINT_PROVIDER=typesafe JEV_LINT_MODEL=${model === MODEL ? MODEL : shellQuote(model)}`;
  if (model !== "clef" && model !== "clef-flash") throw new Error("Cloudflare model must be clef or clef-flash");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID");
  const tokenFile = process.env.CLOUDFLARE_API_TOKEN_FILE;
  return `JEV_LINT_PROVIDER=cloudflare JEV_LINT_MODEL=${shellQuote(model)} CLOUDFLARE_ACCOUNT_ID=${shellQuote(account)}${
    tokenFile ? ` CLOUDFLARE_API_TOKEN_FILE=${shellQuote(resolve(tokenFile))}` : ""
  }`;
}
const SYNC_TIMEOUT_S = 15; // the agent waits on a synchronous check
const ASYNC_TIMEOUT_S = 180; // a background check can take longer (slow local judges)
const SMOKE_TIMEOUT_MS = 30_000;

type HookCommand = { type: "command"; command: string; timeout: number; statusMessage?: string; asyncRewake?: boolean };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HookConfig = { hooks?: Record<string, HookGroup[] | undefined> } & Record<string, unknown>;

export function hookGroup(agent: "claude" | "codex", opts: { async?: boolean; bun?: string } = {}): HookGroup {
  const bun = opts.bun ?? Bun.which("bun") ?? process.execPath; // the PATH shim survives bun upgrades
  const rewake = agent === "claude" && opts.async;
  const command = `${rewake ? "JEV_LINT_MODE=rewake " : ""}${judgeCommandEnv()} ${bun} ${HOOK}`;
  return {
    matcher: agent === "claude" ? "Write|Edit|MultiEdit" : "Edit|Write|apply_patch",
    hooks: [
      {
        type: "command",
        command,
        timeout: rewake ? ASYNC_TIMEOUT_S : SYNC_TIMEOUT_S,
        statusMessage: "jev-lint",
        ...(rewake ? { asyncRewake: true } : {}),
      },
    ],
  };
}

const RECHECK = join(REPO, "src/recheck.ts");
// Ours if it runs this checkout's script, or one from a checkout named jev-lint (an older
// install elsewhere). A clone under another name must still be recognised, or every re-run
// would add a second hook.
export const isJevLint = (h: HookCommand) => h.command.includes(HOOK) || /jev-lint\/src\/hook\.ts/.test(h.command);
const isJevLintRecheck = (h: HookCommand) => h.command.includes(RECHECK) || /jev-lint\/src\/recheck\.ts/.test(h.command);
const RECHECK_TIMEOUT_S = 20;
export const RECHECK_EVENTS = ["Stop", "SubagentStop"] as const;

// End-of-turn re-check for the learning loop (see src/recheck.ts): no matcher, since Stop events have no tool.
export function recheckGroup(opts: { bun?: string } = {}): HookGroup {
  const bun = opts.bun ?? Bun.which("bun") ?? process.execPath;
  return { hooks: [{ type: "command", command: `${judgeCommandEnv()} ${bun} ${RECHECK}`, timeout: RECHECK_TIMEOUT_S }] };
}

// Which bun binary runs the hook doesn't matter (Homebrew vs ~/.bun), so it isn't a change.
const sameHook = (a: HookGroup, b: HookGroup) => {
  const normal = (g: HookGroup) => JSON.stringify(g).replace(/[^\s"]*\/bun /g, "bun ");
  return normal(a) === normal(b);
};

// Returns the merged config and what happened. Pure, so it is unit-tested.
export function mergeHook(
  config: HookConfig,
  group: HookGroup,
  event = "PostToolUse",
  ours: (h: HookCommand) => boolean = isJevLint,
): { config: HookConfig; action: "added" | "updated" | "unchanged" } {
  const post = [...(config.hooks?.[event] ?? [])];
  const index = post.findIndex((g) => g.hooks?.some(ours));
  let action: "added" | "updated" | "unchanged" = "added";
  if (index === -1) post.push(group);
  else if (sameHook(post[index], group)) action = "unchanged";
  else {
    // Keep any unrelated hooks that share the group; swap only the jev-lint command.
    // A group's matcher is shared by all its hooks, so never change it under other hooks:
    // leave them in their group and give jev-lint its own.
    const others = post[index].hooks.filter((h) => !ours(h));
    if (others.length) {
      post[index] = { ...post[index], hooks: others };
      post.push(group);
    } else post[index] = group;
    action = "updated";
  }
  return { config: { ...config, hooks: { ...config.hooks, [event]: post } }, action };
}

function keyStatus(): string {
  if (process.env.TYPESAFE_API_KEY) return "present (TYPESAFE_API_KEY)";
  try {
    const mode = statSync(keyFilePath()).mode & 0o777;
    return mode & 0o077 ? `IGNORED: ${keyFilePath()} is readable by others (chmod 600 it)` : `present (${keyFilePath()})`;
  } catch {
    // no key file; try the Keychain
  }
  const found = spawnSync("security", ["find-generic-password", "-s", "typesafe-api-key"], { stdio: "ignore" });
  return found.status === 0 ? "present (Keychain: typesafe-api-key)" : "MISSING";
}

// Drop jev-lint's command from one event (used to switch between after- and before-the-write).
export function removeHook(
  config: HookConfig,
  event: string,
  ours: (h: HookCommand) => boolean = isJevLint,
): { config: HookConfig; removed: boolean } {
  const groups = config.hooks?.[event];
  if (!groups?.some((g) => g.hooks?.some(ours))) return { config, removed: false };
  const kept = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
  const hooks = { ...config.hooks, [event]: kept };
  if (!kept.length) delete hooks[event];
  return { config: { ...config, hooks }, removed: true };
}

// How jev-lint is installed in a config right now, so --upgrade can re-apply without the user
// restating --pre / --async / --no-recheck. Pure, so it is unit-tested.
export function installedMode(config: HookConfig): { installed: boolean; pre: boolean; async: boolean; recheck: boolean } {
  const hooksIn = (event: string) => (config.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).filter(isJevLint);
  const post = hooksIn("PostToolUse");
  const pre = hooksIn("PreToolUse");
  const main = [...pre, ...post];
  return {
    installed: main.length > 0,
    pre: pre.length > 0,
    async: main.some((h) => h.asyncRewake || /JEV_LINT_MODE=rewake/.test(h.command)),
    recheck: RECHECK_EVENTS.some((e) => (config.hooks?.[e] ?? []).some((g) => g.hooks?.some(isJevLintRecheck))),
  };
}

function readConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HookConfig) : {};
}

// --upgrade: bring this checkout up to date, then re-apply whatever is installed.
function upgradeCheckout(): string {
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf8" });
  const before = git("rev-parse", "--short", "HEAD").stdout.trim();
  const pull = git("pull", "--ff-only", "--quiet");
  if (pull.status !== 0) throw new Error(`git pull failed: ${pull.stderr.trim() || "not a fast-forward; resolve the checkout by hand"}`);
  const after = git("rev-parse", "--short", "HEAD").stdout.trim();
  const install = spawnSync(process.execPath, ["install", "--silent"], { cwd: REPO, encoding: "utf8" });
  if (install.status !== 0) throw new Error(`bun install failed: ${install.stderr.trim()}`);
  return before === after ? `already at ${after}` : `${before} → ${after}`;
}

// Main hook on PostToolUse (or PreToolUse with --pre), plus (unless disabled) the end-of-turn re-check on Stop/SubagentStop.
function writeConfig(path: string, group: HookGroup, apply: boolean, recheck: boolean, pre = false): string {
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; not touching it`);
  let config = parsed as HookConfig;
  const actions: string[] = [];
  // The hook runs on exactly one of PreToolUse / PostToolUse, so switching modes moves it.
  const [event, other] = pre ? ["PreToolUse", "PostToolUse"] : ["PostToolUse", "PreToolUse"];
  const main = mergeHook(config, group, event);
  config = main.config;
  actions.push(`${pre ? "before-the-write " : ""}hook ${main.action}`);
  const moved = removeHook(config, other);
  config = moved.config;
  if (moved.removed) actions.push(`removed from ${other}`);
  if (recheck) {
    for (const event of RECHECK_EVENTS) {
      const merged = mergeHook(config, recheckGroup(), event, isJevLintRecheck);
      config = merged.config;
      actions.push(`${event} re-check ${merged.action}`);
    }
  }
  const changed = actions.some((a) => !a.endsWith("unchanged"));
  if (apply && changed) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) copyFileSync(path, `${path}.bak-jev-lint-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return `${path}: ${actions.join(", ")}${apply || !changed ? "" : " (dry run; pass --apply)"}`;
}

function codexFeatureStatus(): string {
  const path = join(homedir(), ".codex/config.toml");
  if (!existsSync(path)) return "~/.codex/config.toml missing; add `[features]\\nhooks = true`";
  const toml = readFileSync(path, "utf8");
  const features = toml.split(/^\[/m).find((s) => s.startsWith("features]"));
  return features && /^\s*hooks\s*=\s*true/m.test(features)
    ? "Codex hooks feature enabled"
    : "Codex hooks feature NOT enabled: add `hooks = true` under `[features]` in ~/.codex/config.toml";
}

function linkSkills(apply: boolean): string[] {
  const source = join(REPO, ".agents/skills");
  const out: string[] = [];
  for (const dir of [".agents/skills", ".claude/skills", ".codex/skills"].map((d) => join(homedir(), d))) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(source)) {
      const target = join(dir, name);
      if (lstatSync(target, { throwIfNoEntry: false })) out.push(`${target}: exists`);
      else if (apply) {
        symlinkSync(join(source, name), target);
        out.push(`${target}: linked`);
      } else out.push(`${target}: would link`);
    }
  }
  return out;
}

// One real check through the hook: a Write with an empty catch should come back flagged.
function smoke(): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-lint-smoke-"));
  const file = join(dir, "smoke.ts");
  const content = "export async function load(url: string) {\n  try {\n    return await fetch(url);\n  } catch (e) {}\n}\n";
  writeFileSync(file, content);
  const event = { hook_event_name: "PostToolUse", cwd: dir, tool_name: "Write", tool_input: { file_path: file, content } };
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    cwd: dir,
    env: { ...process.env, JEV_LINT_FINDINGS_LOG: "off", JEV_LINT_MODEL: installedModel() },
    encoding: "utf8",
    timeout: SMOKE_TIMEOUT_MS,
  });
  if (run.status !== 0) return `smoke: FAILED (exit ${run.status}) ${run.stderr.slice(0, 200)}`;
  return /ts-no-empty-catch/.test(run.stdout)
    ? "smoke: ok (empty catch flagged)"
    : "smoke: FAILED, the hook ran but flagged nothing (check the key and network; the hook fails open)";
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      "claude-only": { type: "boolean", default: false },
      "codex-only": { type: "boolean", default: false },
      project: { type: "string" },
      async: { type: "boolean", default: false },
      skills: { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
      "no-recheck": { type: "boolean", default: false },
      pre: { type: "boolean", default: false },
      upgrade: { type: "boolean", default: false },
    },
  });
  if (values.upgrade) {
    // Pull first, so the modes below are detected and re-applied with the new code.
    console.log(`upgrade: ${upgradeCheckout()}`);
    const claudePath = values.project ? join(resolve(values.project), ".claude/settings.json") : join(homedir(), ".claude/settings.json");
    const mode = installedMode(readConfig(claudePath));
    const codexMode = installedMode(readConfig(join(homedir(), ".codex/hooks.json")));
    if (!mode.installed && !codexMode.installed) {
      console.error("upgrade: jev-lint is not installed here; run without --upgrade (and with --apply) to install");
      process.exit(1);
    }
    values.apply = true;
    if (!values.pre && !values.async) {
      values.pre = mode.pre;
      values.async = mode.async;
    }
    if (!values["no-recheck"]) values["no-recheck"] = !(mode.recheck || codexMode.recheck);
    if (!mode.installed) values["codex-only"] = true;
    if (!codexMode.installed) values["claude-only"] = true;
    console.log(
      `upgrade: re-applying (${values.pre ? "before-the-write" : values.async ? "async" : "after-the-write"}${values["no-recheck"] ? ", no re-check" : ", with re-check"})`,
    );
  }
  if (values.pre && values.async) {
    console.error("--pre and --async are different modes: pick one");
    process.exit(1);
  }
  if (values["codex-only"] && values.project) {
    console.error("Codex has no project-scoped hook config; drop --project or --codex-only");
    process.exit(1);
  }
  console.log(`jev-lint at ${REPO}`);
  console.log(`bun: ${process.execPath}`);
  console.log(
    judgeProvider() === "cloudflare"
      ? `Cloudflare token: ${cloudflareKey() ? "present" : "MISSING"} (must be available to the agent at runtime)`
      : `TypeSafe key: ${keyStatus()}`,
  );
  try {
    judgeCommandEnv(); // a missing account ID or an unknown model is a setup error, not a crash
  } catch (error) {
    console.error(`Cloudflare setup: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  if (!values["codex-only"]) {
    const path = values.project ? join(resolve(values.project), ".claude/settings.json") : join(homedir(), ".claude/settings.json");
    console.log(
      `Claude Code: ${writeConfig(path, hookGroup("claude", { async: values.async }), values.apply, !values["no-recheck"], values.pre)}`,
    );
  }
  if (!values["claude-only"] && !values.project) {
    console.log(`Codex: ${writeConfig(join(homedir(), ".codex/hooks.json"), hookGroup("codex"), values.apply, !values["no-recheck"])}`);
    console.log(`Codex: ${codexFeatureStatus()}; the first run asks you to trust the hook`);
    if (values.pre) console.log("Codex: --pre applies to Claude Code only for now; Codex keeps checking after the write");
  }
  if (values.skills) for (const line of linkSkills(values.apply)) console.log(`skill ${line}`);
  if (values.smoke) console.log(smoke());
}
