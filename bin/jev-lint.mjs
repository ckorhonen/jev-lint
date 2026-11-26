#!/usr/bin/env node
// Cross-runner entrypoint for `bunx jev-lint` and `npx jev-lint`.
// Under Bun, loads `src/cli.ts` directly. Under Node, locates Bun and forwards argv/stdio.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function findBun() {
  if (process.env.JEV_LINT_BUN) return process.env.JEV_LINT_BUN;
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (!probe.error && probe.status === 0) return "bun";
  const ext = process.platform === "win32" ? ".exe" : "";
  const homeBun = join(homedir(), ".bun", "bin", `bun${ext}`);
  if (existsSync(homeBun)) return homeBun;
  return undefined;
}

if (typeof process.versions.bun === "string") {
  const { runCli } = await import(CLI);
  process.exit(runCli(process.argv.slice(2)));
} else {
  const bun = findBun();
  if (!bun) {
    process.stderr.write("jev-lint requires Bun (https://bun.sh). Install it with: curl -fsSL https://bun.sh/install | bash\n");
    process.exit(1);
  }
  const run = spawnSync(bun, [CLI, ...process.argv.slice(2)], { stdio: "inherit" });
  if (run.error) {
    process.stderr.write(`jev-lint: failed to run ${bun}: ${run.error.message}\n`);
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}
