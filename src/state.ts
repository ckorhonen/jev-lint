import { homedir } from "node:os";

// Findings log, daemon sockets and pre-mode denials live here. XDG_STATE_HOME lets tests
// (and non-standard setups) keep them out of the real state directory.
export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || `${homedir()}/.local/state`;
  return `${base.replace(/[\\/]+$/, "")}/jev-lint`;
}
