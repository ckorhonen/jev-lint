// Findings log, daemon sockets and pre-mode denials live here. XDG_STATE_HOME lets tests
// (and non-standard setups) keep them out of the real state directory. There is no shared-/tmp
// fallback: predictable paths there let another local user read code excerpts or claim sockets.
export function stateDir(): string | undefined {
  const trim = (path: string) => path.replace(/[\\/]+$/, "");
  if (process.env.XDG_STATE_HOME) return `${trim(process.env.XDG_STATE_HOME)}/jev-lint`;

  // HOME/USERPROFILE avoids initializing node:os in every short-lived hook process.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) return `${trim(home)}/.local/state/jev-lint`;
  try {
    return `${(require("node:os") as typeof import("node:os")).homedir().replace(/[\\/]+$/, "")}/.local/state/jev-lint`;
  } catch {
    // A user-only runtime dir is safe when the account has no resolvable home. Without
    // either one, callers disable stateful features rather than writing to shared /tmp.
    return process.env.XDG_RUNTIME_DIR ? `${trim(process.env.XDG_RUNTIME_DIR)}/jev-lint` : undefined;
  }
}
