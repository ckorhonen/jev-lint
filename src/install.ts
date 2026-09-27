#!/usr/bin/env bun
// Install or update the jev-lint hook for Claude Code and Codex, idempotently.
//   bun ~/Repos/jev-lint/src/install.ts                 # check only: key, configs, skills (no writes)
//   bun ~/Repos/jev-lint/src/install.ts --apply         # write hooks (backs up each file first)
//   options: --claude-only | --codex-only, --project <repo> (Claude hook in <repo>/.claude/settings.json),
//            --async (Claude: background check that wakes the agent), --skills (link skills), --smoke
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
import { keyFilePath } from "./jev";

const REPO = resolve(import.meta.dir, "..");
const HOOK = join(REPO, "src/hook.ts");
const MODEL = "jev-1.13.0";
const SYNC_TIMEOUT_S = 15; // the agent waits on a synchronous check
const ASYNC_TIMEOUT_S = 180; // a background check can take longer (slow local judges)
const SMOKE_TIMEOUT_MS = 30_000;

type HookCommand = { type: "command"; command: string; timeout: number; statusMessage?: string; asyncRewake?: boolean };
type HookGroup = { matcher: string; hooks: HookCommand[] };
type HookConfig = { hooks?: Record<string, HookGroup[] | undefined> } & Record<string, unknown>;

export function hookGroup(agent: "claude" | "codex", opts: { async?: boolean; bun?: string } = {}): HookGroup {
  const bun = opts.bun ?? Bun.which("bun") ?? process.execPath; // the PATH shim survives bun upgrades
  const rewake = agent === "claude" && opts.async;
  const command = `${rewake ? "JEV_LINT_MODE=rewake " : ""}JEV_LINT_MODEL=${MODEL} ${bun} ${HOOK}`;
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

const isJevLint = (h: HookCommand) => /jev-lint\/src\/hook\.ts/.test(h.command);

// Which bun binary runs the hook doesn't matter (Homebrew vs ~/.bun), so it isn't a change.
const sameHook = (a: HookGroup, b: HookGroup) => {
  const normal = (g: HookGroup) => JSON.stringify(g).replace(/[^\s"]*\/bun /g, "bun ");
  return normal(a) === normal(b);
};

// Returns the merged config and what happened. Pure, so it is unit-tested.
export function mergeHook(config: HookConfig, group: HookGroup): { config: HookConfig; action: "added" | "updated" | "unchanged" } {
  const post = [...(config.hooks?.PostToolUse ?? [])];
  const index = post.findIndex((g) => g.hooks?.some(isJevLint));
  let action: "added" | "updated" | "unchanged" = "added";
  if (index === -1) post.push(group);
  else if (sameHook(post[index], group)) action = "unchanged";
  else {
    // Keep any unrelated hooks that share the group; swap only the jev-lint command.
    // A group's matcher is shared by all its hooks, so never change it under other hooks:
    // leave them in their group and give jev-lint its own.
    const others = post[index].hooks.filter((h) => !isJevLint(h));
    if (others.length) {
      post[index] = { ...post[index], hooks: others };
      post.push(group);
    } else post[index] = group;
    action = "updated";
  }
  return { config: { ...config, hooks: { ...config.hooks, PostToolUse: post } }, action };
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

function writeConfig(path: string, group: HookGroup, apply: boolean): string {
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; not touching it`);
  const current = parsed as HookConfig;
  const { config, action } = mergeHook(current, group);
  if (apply && action !== "unchanged") {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) copyFileSync(path, `${path}.bak-jev-lint-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return `${path}: ${action}${apply || action === "unchanged" ? "" : " (dry run; pass --apply)"}`;
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
    env: { ...process.env, JEV_LINT_FINDINGS_LOG: "off", JEV_LINT_MODEL: MODEL },
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
    },
  });
  if (values["codex-only"] && values.project) {
    console.error("Codex has no project-scoped hook config; drop --project or --codex-only");
    process.exit(1);
  }
  console.log(`jev-lint at ${REPO}`);
  console.log(`bun: ${process.execPath}`);
  console.log(`TypeSafe key: ${keyStatus()}`);
  if (!values["codex-only"]) {
    const path = values.project ? join(resolve(values.project), ".claude/settings.json") : join(homedir(), ".claude/settings.json");
    console.log(`Claude Code: ${writeConfig(path, hookGroup("claude", { async: values.async }), values.apply)}`);
  }
  if (!values["claude-only"] && !values.project) {
    console.log(`Codex: ${writeConfig(join(homedir(), ".codex/hooks.json"), hookGroup("codex"), values.apply)}`);
    console.log(`Codex: ${codexFeatureStatus()}; the first run asks you to trust the hook`);
  }
  if (values.skills) for (const line of linkSkills(values.apply)) console.log(`skill ${line}`);
  if (values.smoke) console.log(smoke());
}
