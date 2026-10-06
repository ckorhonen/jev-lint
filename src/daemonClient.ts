// Hook side of the optional daemon (see daemon.ts). JEV_LINT_DAEMON=off disables it.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isSettledList, type Settled } from "./checks";
import type { ChangedFile } from "./extract";
import { stateDir } from "./findingsLog";

// Settings that change what a check does. Each combination gets its own daemon, because
// the daemon's rules, model and endpoint are fixed by the environment it started with.
const CONFIG_ENV = [
  "JEV_LINT_MODEL",
  "JEV_LINT_PACKS",
  "JEV_LINT_GATE",
  "JEV_LINT_HIGH",
  "JEV_LINT_MEDIUM",
  "TYPESAFE_BASE_URL",
  "JEV_LINT_PROVIDER",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN_FILE",
  "OPENAI_API_KEY_FILE",
];
const CONNECT_TIMEOUT_MS = 300;
const HEALTH_TIMEOUT_MS = 200;
// At most one daemon start per socket in this window, so a daemon that crashes on startup
// can't turn every edit into a new process.
const RESPAWN_WINDOW_MS = 30_000;

export function daemonSocketPath(): string {
  // The key is part of the identity (hashed, never stored) so projects with different keys
  // never share a daemon. A Keychain key isn't known here; the daemon exits on 401/403 instead.
  const config = [
    ...CONFIG_ENV.map((k) => `${k}=${process.env[k] ?? ""}`),
    `key=${process.env.TYPESAFE_API_KEY ?? ""}`,
    `openaiKey=${process.env.OPENAI_API_KEY ?? ""}`,
    `cfKey=${process.env.CLOUDFLARE_API_TOKEN ?? ""}`,
  ].join("\n");
  const id = createHash("sha256")
    .update(`${import.meta.dir}\n${config}`)
    .digest("hex")
    .slice(0, 12);
  return join(stateDir(), `daemon-${id}.sock`);
}

export const daemonEnabled = () => process.env.JEV_LINT_DAEMON !== "off";

// Returns undefined when the daemon can't be reached, so the caller checks in process. A
// daemon that was reached but ran out of time counts as failed checks (fail open), not as a
// reason to start the whole check again and double the wait.
export async function checkViaDaemon(changes: ChangedFile[], opts: { timeoutMs: number; cwd?: string }): Promise<Settled[] | undefined> {
  try {
    const res = await fetch("http://jev-lint/check", {
      unix: daemonSocketPath(),
      method: "POST",
      body: JSON.stringify({ changes, ...opts }),
      signal: AbortSignal.timeout(opts.timeoutMs + CONNECT_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const settled: unknown = await res.json();
    return isSettledList(settled) ? settled : undefined;
  } catch (error) {
    if (!(error instanceof Error && error.name === "TimeoutError")) return undefined; // not running or a stale socket
    // Reached but too slow. If it can't even answer a health check it is wedged: replace it
    // so later checks recover instead of timing out forever.
    if (!(await healthy())) replaceWedgedDaemon();
    return changes.map(() => ({ ok: false, error: "daemon timeout" }));
  }
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch("http://jev-lint/health", { unix: daemonSocketPath(), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

function replaceWedgedDaemon() {
  const socket = daemonSocketPath();
  try {
    const pid = Number(readFileSync(`${socket}.lock`, "utf8").trim());
    if (pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    // no lock or already dead
  }
  for (const path of [socket, `${socket}.lock`]) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
  startDaemon({ force: true });
}

// Start a daemon for the next check, in its own session so it outlives this hook process
// (agents may kill the hook's process group when it exits). This check doesn't wait for it.
export function startDaemon(opts: { force?: boolean } = {}): number | undefined {
  const stamp = `${daemonSocketPath()}.started`;
  try {
    if (!opts.force && Date.now() - statSync(stamp).mtimeMs < RESPAWN_WINDOW_MS) return undefined;
  } catch {
    // never started
  }
  try {
    mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 });
    writeFileSync(stamp, "");
    const child = spawn(process.execPath, [join(import.meta.dir, "daemon.ts")], {
      detached: true,
      stdio: "ignore",
      env: process.env,
      cwd: homedir(),
    });
    child.unref();
    return child.pid;
  } catch {
    return undefined; // can't spawn: checks keep running in process
  }
}
