// Findings log, daemon sockets and pre-mode denials live here. XDG_STATE_HOME lets tests
// (and non-standard setups) keep them out of the real state directory.
export function stateDir(): string {
  const trim = (path: string) => path.replace(/[\\/]+$/, "");
  if (process.env.XDG_STATE_HOME) return `${trim(process.env.XDG_STATE_HOME)}/jev-lint`;

  // HOME/USERPROFILE avoids initializing node:os in every short-lived hook process. Even
  // when none exists, the hook must still start: fall back to a per-user temporary path.
  const home = process.env.HOME || process.env.USERPROFILE;
  const base = home ? `${trim(home)}/.local/state` : fallbackStateBase();
  return `${base}/jev-lint`;
}

function fallbackStateBase(): string {
  try {
    return `${(require("node:os") as typeof import("node:os")).homedir().replace(/[\\/]+$/, "")}/.local/state`;
  } catch {
    if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR.replace(/[\\/]+$/, "");
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    return `/tmp/jev-lint-state-${uid}`;
  }
}
