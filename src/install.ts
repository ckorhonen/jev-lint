#!/usr/bin/env bun
// Install or update the jev-lint hook for Claude Code and Codex, idempotently.
//   bun src/install.ts                 # check only: key, configs, skills (no writes)
//   bun src/install.ts --apply         # write hooks (backs up each file first)
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
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { openaiKey } from "./decisions";
import { cloudflareKey, judgeModel, judgeProvider, keyFilePath } from "./jev";

const REPO = resolve(import.meta.dir, "..");
const HOOK = join(REPO, "src/hook.ts");
const MODEL = "jev-1.13.0";
const RUNTIME_ENTRIES = ["package.json", "bin", "src", "rules", ".agents/skills"] as const;
const STAGED_TOP_ENTRIES = new Set(RUNTIME_ENTRIES.map((entry) => entry.split("/")[0]));
const STAGED_PACKAGE_NAMES = new Set(["@ckorhonen/jev-lint", "jev-lint"]);

function isSafeToReplaceStagedDir(targetDir: string): boolean {
  const entries = readdirSync(targetDir);
  if (entries.length === 0) return true;
  if (!entries.every((entry) => STAGED_TOP_ENTRIES.has(entry))) return false;
  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" && STAGED_PACKAGE_NAMES.has(pkg.name);
  } catch {
    return false;
  }
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Detect ephemeral bunx/npx cache directories so hooks never point at a temp path that gets cleaned up.
export function isEphemeralRoot(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.JEV_LINT_STAGE === "1") return true;
  if (env.JEV_LINT_STAGE === "0") return false;
  if (existsSync(join(root, ".git"))) return false;
  const resolved = realOrResolved(root);
  const tmp = realOrResolved(tmpdir());
  if (resolved === tmp || resolved.startsWith(`${tmp}${sep}`)) return true;
  const segments = resolved.split(sep);
  return segments.some((s) => s === "_npx" || s === "bunx" || s.startsWith("bunx-"));
}

export function stablePackageDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JEV_LINT_INSTALL_DIR) return resolve(env.JEV_LINT_INSTALL_DIR);
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "jev-lint", "pkg");
}

// Atomically copy the self-contained runtime payload to a stable user-owned directory.
export function stageRuntime(sourceRoot: string, targetDir: string): void {
  const parent = dirname(targetDir);
  if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`${parent} is a symlink; review its target and set JEV_LINT_INSTALL_DIR explicitly`);
  const existing = lstatSync(targetDir, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new Error(`${targetDir} is a symlink; review its target and set JEV_LINT_INSTALL_DIR explicitly`);
  if (existing && (!existing.isDirectory() || !isSafeToReplaceStagedDir(targetDir)))
    throw new Error(`${targetDir} contains unrelated files; point JEV_LINT_INSTALL_DIR to an empty or dedicated jev-lint directory`);
  mkdirSync(parent, { recursive: true });
  const temp = mkdtempSync(join(parent, ".jev-lint-stage-"));
  let backup: string | undefined;
  try {
    for (const entry of RUNTIME_ENTRIES) {
      const src = join(sourceRoot, entry);
      if (!existsSync(src)) continue;
      const dst = join(temp, entry);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
    }
    if (existsSync(targetDir)) {
      backup = `${targetDir}.old-${process.pid}-${Date.now()}`;
      renameSync(targetDir, backup);
    }
    renameSync(temp, targetDir);
    if (backup) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (backup && !existsSync(targetDir)) {
      try {
        renameSync(backup, targetDir);
      } catch {
        // leave backup intact for manual recovery
      }
    }
    throw error;
  }
}
const installedModel = () => process.env.JEV_LINT_MODEL ?? (judgeProvider() !== "typesafe" ? judgeModel() : MODEL);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Preserve symlink/.. traversal when anchoring a credential path for another cwd.
export const credentialPath = (value: string) => (isAbsolute(value) ? value : `${process.cwd()}${sep}${value}`);
const projectSettingsPath = (value: string) => `${credentialPath(value)}${sep}.claude${sep}settings.json`;

// Persist non-secret provider settings for both hooks. Credentials stay in the
// agent environment or a private token file, never in hook configuration.
export function judgeCommandEnv(): string {
  const provider = judgeProvider();
  const model = installedModel();
  if (provider === "typesafe") {
    const keyFile = process.env.TYPESAFE_API_KEY_FILE;
    return `JEV_LINT_PROVIDER=typesafe JEV_LINT_MODEL=${model === MODEL ? MODEL : shellQuote(model)}${keyFile ? ` TYPESAFE_API_KEY_FILE=${shellQuote(credentialPath(keyFile))}` : ""}`;
  }
  if (provider === "openai") {
    if (model !== "gpt-6-luna") throw new Error("OpenAI Decisions model must be gpt-6-luna");
    const keyFile = process.env.OPENAI_API_KEY_FILE;
    return `JEV_LINT_PROVIDER=openai JEV_LINT_MODEL=${shellQuote(model)}${keyFile ? ` OPENAI_API_KEY_FILE=${shellQuote(credentialPath(keyFile))}` : ""}`;
  }
  if (model !== "clef" && model !== "clef-flash") throw new Error("Cloudflare model must be clef or clef-flash");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID");
  const tokenFile = process.env.CLOUDFLARE_API_TOKEN_FILE;
  return `JEV_LINT_PROVIDER=cloudflare JEV_LINT_MODEL=${shellQuote(model)} CLOUDFLARE_ACCOUNT_ID=${shellQuote(account)}${
    tokenFile ? ` CLOUDFLARE_API_TOKEN_FILE=${shellQuote(credentialPath(tokenFile))}` : ""
  }`;
}
const SYNC_TIMEOUT_S = 15; // the agent waits on a synchronous check
const ASYNC_TIMEOUT_S = 180; // a background check can take longer (slow local judges)
const SMOKE_TIMEOUT_MS = 30_000;

type HookCommand = { type: "command"; command: string; timeout: number; statusMessage?: string; asyncRewake?: boolean };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HookConfig = { hooks?: Record<string, HookGroup[] | undefined> } & Record<string, unknown>;

export function hookGroup(agent: "claude" | "codex", opts: { async?: boolean; bun?: string; root?: string } = {}): HookGroup {
  const bun = opts.bun ?? Bun.which("bun") ?? process.execPath; // the PATH shim survives bun upgrades
  const hook = opts.root ? join(opts.root, "src/hook.ts") : HOOK;
  const rewake = agent === "claude" && opts.async;
  const command = `${rewake ? "JEV_LINT_MODE=rewake " : ""}${judgeCommandEnv()} ${shellQuote(bun)} ${shellQuote(hook)}`;
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
// Parse only literal shell words; never evaluate expansions or compound commands
// while deciding which user hooks this installer owns.
function literalWords(command: string): { words: string[]; assignments: Set<number> } | undefined {
  const words: string[] = [];
  const assignments = new Set<number>();
  let word = "";
  let quote = "";
  let started = false;
  let literalName = true;
  let equals = false;
  const finish = () => {
    if (started) {
      if (literalName && /^[A-Za-z_]\w*=/.test(word)) assignments.add(words.length);
      words.push(word);
    }
    word = "";
    started = false;
    literalName = true;
    equals = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = "";
      else word += ch;
    } else if (ch === "\\" && quote !== "'") {
      if (!equals) literalName = false;
      if (quote === '"' && !["$", "`", '"', "\\"].includes(command[i + 1])) {
        word += ch;
        continue;
      }
      if (++i >= command.length) return undefined;
      word += command[i];
      started = true;
    } else if (quote === '"') {
      if (ch === '"') quote = "";
      else if (ch === "$" || ch === "`") return undefined;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      if (!equals) literalName = false;
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (ch === "\n" || ch === "\r") return undefined;
      finish();
    } else if (ch === "~" && !started && command[i + 1] === "/") {
      word = homedir();
      started = true;
    } else if (/[;$`|&<>()*?[~#]/.test(ch)) return undefined;
    else {
      if (ch === "=") equals = true;
      word += ch;
      started = true;
    }
  }
  if (quote) return undefined;
  finish();
  return { words, assignments };
}

function invocation(h: HookCommand): { words: string[]; binary: number; script: string } | undefined {
  const parsed = literalWords(h.command);
  if (!parsed) return undefined;
  const { words, assignments } = parsed;
  const binary = words.findIndex((_, index) => !assignments.has(index));
  if (binary < 0 || basename(words[binary]) !== "bun" || !words[binary + 1]) return undefined;
  return { words, binary, script: words[binary + 1] };
}

export const isJevLint = (h: HookCommand) => {
  const script = invocation(h)?.script;
  return Boolean(
    script &&
      (script === HOOK ||
        /(?:^|\/)jev-lint\/(?:pkg\/)?src\/hook\.ts$/.test(script) ||
        (h.statusMessage === "jev-lint" && isAbsolute(script) && script.endsWith("/src/hook.ts"))),
  );
};
function recheckOwner(config: HookConfig): (h: HookCommand) => boolean {
  const oldScripts = new Set(
    ["PreToolUse", "PostToolUse"].flatMap((event) =>
      (config.hooks?.[event] ?? [])
        .flatMap((group) => group.hooks)
        .filter(isJevLint)
        .map((hook) => invocation(hook)?.script.replace(/hook\.ts$/, "recheck.ts")),
    ),
  );
  return (h) => {
    const script = invocation(h)?.script;
    return Boolean(
      script &&
        (script === RECHECK ||
          oldScripts.has(script) ||
          /(?:^|\/)jev-lint\/(?:pkg\/)?src\/recheck\.ts$/.test(script) ||
          (h.statusMessage === "jev-lint recheck" && isAbsolute(script) && script.endsWith("/src/recheck.ts"))),
    );
  };
}
const RECHECK_TIMEOUT_S = 20;
export const RECHECK_EVENTS = ["Stop", "SubagentStop"] as const;

// End-of-turn re-check for the learning loop (see src/recheck.ts): no matcher, since Stop events have no tool.
export function recheckGroup(opts: { bun?: string; root?: string } = {}): HookGroup {
  const bun = opts.bun ?? Bun.which("bun") ?? process.execPath;
  const recheck = opts.root ? join(opts.root, "src/recheck.ts") : RECHECK;
  return {
    hooks: [
      {
        type: "command",
        command: `${judgeCommandEnv()} ${shellQuote(bun)} ${shellQuote(recheck)}`,
        timeout: RECHECK_TIMEOUT_S,
        statusMessage: "jev-lint recheck",
      },
    ],
  };
}

// Which bun binary runs the hook doesn't matter (Homebrew vs ~/.bun), so it isn't a change.
const sameHook = (a: HookGroup, b: HookGroup) => {
  const normal = (g: HookGroup) =>
    JSON.stringify({
      ...g,
      hooks: g.hooks.map((h) => {
        const parsed = invocation(h);
        if (!parsed) return h;
        const words = [...parsed.words];
        words[parsed.binary] = "bun";
        return { ...h, command: words };
      }),
    });
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
  const indexes = post.flatMap((g, index) => (g.hooks?.some(ours) ? [index] : []));
  const index = indexes[0] ?? -1;
  let action: "added" | "updated" | "unchanged" = "added";
  if (index === -1) post.push(group);
  else if (indexes.length === 1 && sameHook(post[index], group)) action = "unchanged";
  else {
    // Keep any unrelated hooks that share the group; swap only the jev-lint command.
    // A group's matcher is shared by all its hooks, so never change it under other hooks:
    // leave them in their group and give jev-lint its own.
    let placed = false;
    const kept = post.flatMap((existing) => {
      if (!existing.hooks.some(ours)) return [existing];
      const others = existing.hooks.filter((h) => !ours(h));
      if (others.length) return [{ ...existing, hooks: others }];
      if (!placed) {
        placed = true;
        return [group];
      }
      return [];
    });
    if (!placed) kept.push(group);
    post.splice(0, post.length, ...kept);
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

const PERSISTED_PROVIDER_VARS = new Set([
  "JEV_LINT_PROVIDER",
  "JEV_LINT_MODEL",
  "TYPESAFE_API_KEY_FILE",
  "OPENAI_API_KEY_FILE",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN_FILE",
]);

// Recover non-secret provider env assignments persisted on the existing hook so --upgrade
// keeps Clef or Decisions installs on their configured provider instead of resetting to TypeSafe.
export function installedProviderEnv(config: HookConfig): Record<string, string> {
  const first = ["PreToolUse", "PostToolUse"]
    .flatMap((event) => (config.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).filter(isJevLint))
    .at(0);
  if (!first) return {};
  const parsed = literalWords(first.command);
  if (!parsed) return {};
  const env: Record<string, string> = {};
  for (const index of parsed.assignments) {
    const word = parsed.words[index];
    const eq = word.indexOf("=");
    if (eq === -1) continue;
    const key = word.slice(0, eq);
    if (PERSISTED_PROVIDER_VARS.has(key)) env[key] = word.slice(eq + 1);
  }
  return env;
}

function withProviderEnv<T>(preserved: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(preserved)) {
    if (process.env[key] === undefined) {
      saved.set(key, undefined);
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
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
    recheck: RECHECK_EVENTS.some((e) => (config.hooks?.[e] ?? []).some((g) => g.hooks?.some(recheckOwner(config)))),
  };
}

function readConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HookConfig) : {};
}

// --upgrade: in a git checkout, pull and reinstall; in package mode, report the package version.
function upgradeCheckout(): string {
  if (!existsSync(join(REPO, ".git"))) {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version?: string };
    return `package v${pkg.version ?? "0.0.0"}`;
  }
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
function writeConfig(path: string, group: HookGroup, apply: boolean, recheck: boolean, pre = false, root = REPO): string {
  if (lstatSync(dirname(path), { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`${dirname(path)} is a symlink; review its target and configure that location explicitly before applying`);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`${path} is a symlink; review its target and configure that location explicitly before applying`);
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; not touching it`);
  let config = parsed as HookConfig;
  const isJevLintRecheck = recheckOwner(config);
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
      const merged = mergeHook(config, recheckGroup({ root }), event, isJevLintRecheck);
      config = merged.config;
      actions.push(`${event} re-check ${merged.action}`);
    }
  } else {
    for (const event of RECHECK_EVENTS) {
      const removed = removeHook(config, event, isJevLintRecheck);
      config = removed.config;
      if (removed.removed) actions.push(`${event} re-check removed`);
    }
  }
  const changed = actions.some((a) => !a.endsWith("unchanged"));
  let backup: string | undefined;
  if (apply && changed) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      backup = `${path}.bak-jev-lint-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(path, backup);
    }
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return `${path}: ${actions.join(", ")}${apply || !changed ? "" : " (dry run; pass --apply)"}${backup ? `; backup: ${backup}` : ""}`;
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

function isJevLintSkillLink(linkTarget: string, name: string): boolean {
  const normalized = linkTarget.replaceAll("\\", "/");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|/)jev-lint/(?:pkg/)?\\.agents/skills/${escaped}$`).test(normalized);
}

function linkSkills(apply: boolean, root = REPO, targets: { claude?: boolean; codex?: boolean } = {}): string[] {
  const source = join(root, ".agents/skills");
  const listFrom = existsSync(source) ? source : join(REPO, ".agents/skills");
  const out: string[] = [];
  const candidates: Array<{ dir: string; createIfMissing: boolean }> = [{ dir: join(homedir(), ".agents/skills"), createIfMissing: false }];
  if (targets.claude) candidates.push({ dir: join(homedir(), ".claude/skills"), createIfMissing: true });
  if (targets.codex) candidates.push({ dir: join(homedir(), ".codex/skills"), createIfMissing: true });
  for (const { dir, createIfMissing } of candidates) {
    const dirExists = existsSync(dir);
    if (!dirExists && !createIfMissing) continue;
    if (lstatSync(dirname(dir), { throwIfNoEntry: false })?.isSymbolicLink() || lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${dir} is a symlink; review its target before linking skills`);
    if (!dirExists && apply) mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(listFrom)) {
      const target = join(dir, name);
      const desired = join(source, name);
      const existing = dirExists ? lstatSync(target, { throwIfNoEntry: false }) : undefined;
      if (existing) {
        if (existing.isSymbolicLink()) {
          const current = readlinkSync(target);
          if (current !== desired && isJevLintSkillLink(current, name)) {
            if (apply) {
              unlinkSync(target);
              symlinkSync(desired, target);
              out.push(`${target}: updated`);
            } else out.push(`${target}: would update`);
            continue;
          }
        }
        out.push(`${target}: exists`);
      } else if (apply) {
        symlinkSync(desired, target);
        out.push(`${target}: linked`);
      } else out.push(`${target}: would link`);
    }
  }
  return out;
}

// One real check through the hook: a Write with an empty catch should come back flagged.
function smoke(root = REPO): string {
  const hook = existsSync(join(root, "src/hook.ts")) ? join(root, "src/hook.ts") : HOOK;
  const dir = mkdtempSync(join(tmpdir(), "jev-lint-smoke-"));
  const file = join(dir, "smoke.ts");
  const content = "export async function load(url: string) {\n  try {\n    return await fetch(url);\n  } catch (e) {}\n}\n";
  writeFileSync(file, content);
  const event = { hook_event_name: "PostToolUse", cwd: dir, tool_name: "Write", tool_input: { file_path: file, content } };
  const run = spawnSync(process.execPath, [hook], {
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
  try {
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
    let claudePreserved: Record<string, string> = {};
    let codexPreserved: Record<string, string> = {};
    if (values.upgrade) {
      // Pull first, so the modes below are detected and re-applied with the new code.
      console.log(`upgrade: ${upgradeCheckout()}`);
      const claudePath = values.project ? projectSettingsPath(values.project) : join(homedir(), ".claude/settings.json");
      const claudeConfig = readConfig(claudePath);
      const codexConfig = readConfig(join(homedir(), ".codex/hooks.json"));
      const mode = installedMode(claudeConfig);
      const codexMode = installedMode(codexConfig);
      if (!mode.installed && !codexMode.installed) {
        console.error("upgrade: jev-lint is not installed here; run without --upgrade (and with --apply) to install");
        process.exit(1);
      }
      if (!process.env.JEV_LINT_PROVIDER) {
        if (mode.installed) claudePreserved = installedProviderEnv(claudeConfig);
        if (codexMode.installed) codexPreserved = installedProviderEnv(codexConfig);
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
    const ephemeral = isEphemeralRoot(REPO);
    const targetRoot = ephemeral ? stablePackageDir() : REPO;
    console.log(`jev-lint at ${targetRoot}`);
    console.log(
      values.apply
        ? "Local setup: applying hook configuration (backups created for changed files)."
        : "Local setup preview: no hook or skill changes will be written. Use --apply when ready.",
    );
    console.log(
      "Setup does not contact a model unless --smoke is explicitly supplied. Installed hooks send code to the selected provider on future edits.",
    );
    console.log(`bun: ${process.execPath}`);
    const statusPreserved = !values["codex-only"] ? claudePreserved : codexPreserved;
    withProviderEnv(statusPreserved, () => {
      console.log(
        judgeProvider() === "cloudflare"
          ? `Cloudflare token: ${cloudflareKey() ? "present" : "MISSING"} (must be available to the agent at runtime)`
          : judgeProvider() === "openai"
            ? `OpenAI key: ${openaiKey() ? "present" : "MISSING"} (must be available to the agent at runtime)`
            : `TypeSafe key: ${keyStatus()}`,
      );
    });
    try {
      if (!values["codex-only"]) withProviderEnv(claudePreserved, () => judgeCommandEnv());
      if (!values["claude-only"] && !values.project) withProviderEnv(codexPreserved, () => judgeCommandEnv());
    } catch (error) {
      console.error(`Provider setup: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
    if (ephemeral) {
      if (values.apply) {
        stageRuntime(REPO, targetRoot);
        console.log(`runtime: staged to ${targetRoot}`);
      } else {
        console.log(`runtime: would stage to ${targetRoot} (dry run; pass --apply)`);
      }
    }
    if (!values["codex-only"]) {
      const path = values.project ? projectSettingsPath(values.project) : join(homedir(), ".claude/settings.json");
      const result = withProviderEnv(claudePreserved, () =>
        writeConfig(
          path,
          hookGroup("claude", { async: values.async, root: targetRoot }),
          values.apply,
          !values["no-recheck"],
          values.pre,
          targetRoot,
        ),
      );
      console.log(`Claude Code: ${result}`);
    }
    if (!values["claude-only"] && !values.project) {
      const result = withProviderEnv(codexPreserved, () =>
        writeConfig(
          join(homedir(), ".codex/hooks.json"),
          hookGroup("codex", { root: targetRoot }),
          values.apply,
          !values["no-recheck"],
          false,
          targetRoot,
        ),
      );
      console.log(`Codex: ${result}`);
      console.log(`Codex: ${codexFeatureStatus()}; the first run asks you to trust the hook`);
      if (values.pre) console.log("Codex: --pre applies to Claude Code only for now; Codex keeps checking after the write");
    }
    if (values.skills)
      for (const line of linkSkills(values.apply, targetRoot, {
        claude: !values["codex-only"],
        codex: !values["claude-only"] && !values.project,
      }))
        console.log(`skill ${line}`);
    if (values.smoke) {
      withProviderEnv(statusPreserved, () => {
        console.log(
          `Network smoke test: sending a synthetic TypeScript fixture and rule context to ${judgeProvider()} (${installedModel()}); API charges may apply.`,
        );
        console.log(smoke(targetRoot));
      });
    }
  } catch (error) {
    console.error(`Setup could not complete: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
