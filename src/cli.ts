#!/usr/bin/env bun
// Unified CLI entrypoint for `jev-lint` (`bunx @ckorhonen/jev-lint` / `npx @ckorhonen/jev-lint` / `bun src/cli.ts`).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CliCommand = {
  script: string;
  prependArgs?: string[];
  summary: string;
};

export const COMMANDS: Record<string, CliCommand> = {
  setup: { script: "setup.ts", summary: "Guided setup: choose provider, preview, and install hooks" },
  init: { script: "setup.ts", summary: "Alias for setup" },
  install: { script: "install.ts", summary: "Install or preview Claude Code / Codex hooks (--apply, --pre, --async, --skills, --smoke)" },
  upgrade: { script: "install.ts", prependArgs: ["--upgrade"], summary: "Upgrade jev-lint and re-apply installed hooks" },
  check: { script: "check.ts", summary: "Run rules over existing files to preview findings" },
  findings: { script: "findings.ts", summary: "Summarize the findings log (--repo, --days, --clusters, --compare)" },
  audit: { script: "valueAudit.ts", summary: "Grade fixed/kept findings with an LLM value audit" },
  validate: { script: "validate.ts", summary: "Validate a repo's .jev-lint rules against labeled cases" },
  inventory: { script: "inventory.ts", summary: "List a repo's instructions, skills, docs, linters, and CI configs" },
  eval: { script: "repoEval.ts", summary: "Evaluate a repo instruction or skill change with paired agent runs" },
  review: { script: "review.ts", summary: "Review a stream of private PR events (JSON Lines on stdin and stdout)" },

  hook: { script: "hook.ts", summary: "Run the PostToolUse/PreToolUse hook (reads hook event JSON on stdin)" },
  recheck: { script: "recheck.ts", summary: "Run the Stop/SubagentStop end-of-turn recheck hook (reads stdin)" },
};

const PKG_PATH = join(import.meta.dir, "..", "package.json");

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

export function usageText(): string {
  const rows = Object.entries(COMMANDS)
    .filter(([name]) => name !== "init")
    .map(([name, cmd]) => `  ${name.padEnd(11)} ${cmd.summary}`)
    .join("\n");
  return `jev-lint v${packageVersion()} — fuzzy linter for coding agents

Usage:
  jev-lint <command> [options]

Commands:
${rows}

Options:
  -h, --help      Show this help message
  -v, --version   Show version

Examples:
  bunx @ckorhonen/jev-lint setup
  bunx @ckorhonen/jev-lint install --apply --skills
  bunx @ckorhonen/jev-lint check src/app.ts
  bunx @ckorhonen/jev-lint findings --repo . --days 30`;
}

export type ParsedCli =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "command"; name: string; scriptPath: string; args: string[] }
  | { kind: "unknown"; name: string };

export function parseCli(argv: string[]): ParsedCli {
  const [first, ...rest] = argv;
  if (!first || first === "-h" || first === "--help" || first === "help") return { kind: "help" };
  if (first === "-v" || first === "--version") return { kind: "version" };
  const cmd = COMMANDS[first];
  if (!cmd) return { kind: "unknown", name: first };
  return {
    kind: "command",
    name: first,
    scriptPath: join(import.meta.dir, cmd.script),
    args: [...(cmd.prependArgs ?? []), ...rest],
  };
}

export function runCli(
  argv: string[] = process.argv.slice(2),
  io: {
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    exec?: (scriptPath: string, args: string[]) => number;
  } = {},
): number {
  const out = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const parsed = parseCli(argv);
  if (parsed.kind === "help") {
    out(usageText());
    return 0;
  }
  if (parsed.kind === "version") {
    out(`jev-lint ${packageVersion()}`);
    return 0;
  }
  if (parsed.kind === "unknown") {
    err(`jev-lint: unknown command "${parsed.name}". Run \`jev-lint --help\` for usage.`);
    return 1;
  }
  if (io.exec) return io.exec(parsed.scriptPath, parsed.args);
  const run = spawnSync(process.execPath, [parsed.scriptPath, ...parsed.args], { stdio: "inherit" });
  if (run.error) {
    err(`jev-lint: failed to run ${parsed.name}: ${run.error.message}`);
    return 1;
  }
  return run.status ?? 1;
}

if (import.meta.main) process.exit(runCli());
