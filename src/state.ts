// Findings log, daemon sockets and pre-mode denials live here. XDG_STATE_HOME lets tests
// (and non-standard setups) keep them out of the real state directory.
export function stateDir(): string {
  // HOME/USERPROFILE avoids initializing node:os in every short-lived hook process.
  const home = process.env.HOME || process.env.USERPROFILE || (require("node:os") as typeof import("node:os")).homedir();
  const base = process.env.XDG_STATE_HOME || `${home}/.local/state`;
  return `${base.replace(/[\\/]+$/, "")}/jev-lint`;
}
