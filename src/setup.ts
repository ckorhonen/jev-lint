#!/usr/bin/env bun
// Guided local setup. No credentials are entered here and no model is contacted.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

export type SetupProvider = "typesafe" | "clef" | "decisions";
const providers = ["typesafe", "clef", "decisions"] as const;
const labels = { typesafe: "TypeSafe Jev", clef: "Cloudflare Clef", decisions: "OpenAI Decisions" };
const help = `Usage: bun src/setup.ts [--provider typesafe|clef|decisions] [--apply] [installer options]
Without --provider, choose interactively, preview, then confirm installation.
With --provider, preview only; add --apply to authorize local configuration writes.
Options: --claude-only, --codex-only, --project <path>, --pre, --async, --no-recheck, --skills.
No model requests or credential creation. Network smoke tests are separate: src/install.ts --smoke.`;

export function providerEnvironment(provider: SetupProvider, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {
    ...env,
    JEV_LINT_PROVIDER: provider === "clef" ? "cloudflare" : provider === "decisions" ? "openai" : "typesafe",
  };
  // An inherited model from another provider must not cross the provider boundary.
  const unchanged = selected.JEV_LINT_PROVIDER === (env.JEV_LINT_PROVIDER ?? "typesafe");
  const model = env.JEV_LINT_MODEL;
  const compatible =
    provider === "clef"
      ? model === "clef" || model === "clef-flash"
      : provider === "decisions"
        ? model === "gpt-6-luna"
        : !["clef", "clef-flash", "gpt-6-luna"].includes(model ?? "");
  selected.JEV_LINT_MODEL =
    unchanged && model && compatible ? model : provider === "clef" ? "clef" : provider === "decisions" ? "gpt-6-luna" : "jev-1.13.0";
  return selected;
}

export function setupGuidance(provider: SetupProvider): string {
  const credential =
    provider === "typesafe"
      ? "Existing TYPESAFE_API_KEY, a private TYPESAFE_API_KEY_FILE (default ~/.config/jev-lint/api-key), or macOS Keychain service typesafe-api-key."
      : provider === "clef"
        ? "Existing CLOUDFLARE_ACCOUNT_ID (32 hex characters), plus CLOUDFLARE_API_TOKEN or private CLOUDFLARE_API_TOKEN_FILE."
        : "Existing OPENAI_API_KEY or private OPENAI_API_KEY_FILE; Decisions uses gpt-6-luna.";
  return `${labels[provider]}: ${credential}\nCredential files must be mode 600. Supply credentials in the agent environment; never paste keys into this guide or hook configuration.\nLocal setup makes no model request. After installation, edits and full Write/recheck files plus rule context are sent to ${labels[provider]}.`;
}

type SetupOptions = {
  provider?: SetupProvider;
  apply?: boolean;
  installerArgs?: string[];
  env: NodeJS.ProcessEnv;
  ask?: (question: string) => Promise<string>;
  run: (args: string[], env: NodeJS.ProcessEnv) => number;
  log: (message: string) => void;
};

export async function guidedSetup(opts: SetupOptions): Promise<number> {
  const args = opts.installerArgs ?? [];
  if (args.some((arg) => ["--apply", "--smoke", "--upgrade"].includes(arg)))
    throw new Error("Apply, upgrade and network smoke are not preview options.");
  let provider = opts.provider;
  if (!provider) {
    if (!opts.ask) throw new Error("Interactive setup needs a terminal; use --provider typesafe|clef|decisions for a local preview.");
    const current = opts.env.JEV_LINT_PROVIDER;
    const defaultChoice = current === "cloudflare" ? 2 : current === "openai" ? 3 : 1;
    opts.log("Choose a provider:\n  1. TypeSafe Jev (default for a new install)\n  2. Cloudflare Clef\n  3. OpenAI Decisions");
    const choice = (await opts.ask(`Provider [${defaultChoice}]: `)).trim().toLowerCase() || String(defaultChoice);
    provider = providers[Number(choice) - 1] ?? providers.find((item) => item === choice);
    if (!provider) throw new Error("Choose 1, 2, 3, typesafe, clef or decisions.");
  }
  const env = providerEnvironment(provider, opts.env);
  opts.log(setupGuidance(provider));
  const preview = opts.run(args, env);
  if (preview !== 0) return preview;
  const apply = opts.provider
    ? opts.apply
    : /^(y|yes)$/i.test((await opts.ask?.("Apply these local configuration changes with backups? [y/N]: "))?.trim() ?? "");
  if (!apply) {
    opts.log("Preview complete. No configuration changes applied.");
    return 0;
  }
  return opts.run([...args, "--apply"], env);
}

if (import.meta.main) {
  let terminal: ReturnType<typeof createInterface> | undefined;
  try {
    const { values } = parseArgs({
      options: {
        provider: { type: "string" },
        apply: { type: "boolean" },
        help: { type: "boolean" },
        "claude-only": { type: "boolean" },
        "codex-only": { type: "boolean" },
        project: { type: "string" },
        pre: { type: "boolean" },
        async: { type: "boolean" },
        "no-recheck": { type: "boolean" },
        skills: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(help);
      process.exit(0);
    }
    if (values.provider && !providers.includes(values.provider as SetupProvider))
      throw new Error("--provider must be typesafe, clef or decisions.");
    const installerArgs = Object.entries(values).flatMap(([name, value]) =>
      ["provider", "apply", "help"].includes(name) || !value ? [] : typeof value === "string" ? [`--${name}`, value] : [`--${name}`],
    );
    if (!values.provider && process.stdin.isTTY && process.stdout.isTTY)
      terminal = createInterface({ input: process.stdin, output: process.stdout });
    process.exitCode = await guidedSetup({
      provider: values.provider as SetupProvider | undefined,
      apply: values.apply,
      installerArgs,
      env: process.env,
      ask: terminal ? terminal.question.bind(terminal) : undefined,
      log: console.log,
      run: (args, env) =>
        spawnSync(process.execPath, [join(import.meta.dir, "install.ts"), ...args], { env, stdio: "inherit" }).status ?? 1,
    });
  } catch (error) {
    console.error(`Setup: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    terminal?.close();
  }
}
