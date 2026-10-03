#!/usr/bin/env bun
// Optional long-lived helper for the hook. Each hook call is a new process that would
// otherwise pay for a new HTTPS connection plus TLS (~100 ms) and a Keychain lookup (~20 ms)
// on every check. The daemon keeps the API connection warm, resolves the key once, and
// serves checks over a user-only Unix socket. The hook starts it on first use and falls
// back to checking in process whenever it isn't reachable, so it can only make checks faster.
//
// Lifecycle rules (each prevents a failure found in review):
// - One daemon per socket: an exclusive lock file (with our pid) is taken before binding;
//   a second daemon started at the same moment exits.
// - Shutdown removes the socket only if it is still ours (same inode), so an old daemon
//   can never delete a newer one's socket.
// - Exits when idle for JEV_LINT_DAEMON_IDLE_MS (default 30 min), after jev-lint's own
//   source or built-in rules change (in-flight checks finish first), or when the API
//   rejects the key (401/403), so a rotated key is re-read by the next daemon.
// - Repo `.jev-lint/` rules and `when` gates are re-read on every request.

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Newest modification time across jev-lint's source and built-in rules. Taken before the
// modules below are loaded, so an edit made while starting up still triggers a restart.
function codeVersion(): number {
  let newest = 0;
  for (const dir of ["src", "rules"]) {
    for (const name of readdirSync(join(ROOT, dir))) newest = Math.max(newest, statSync(join(ROOT, dir, name)).mtimeMs);
  }
  return newest;
}
const version = codeVersion();

const { isChangedFile, runChecks } = await import("./checks");
const { daemonSocketPath } = await import("./daemonClient");
const { apiKey, judgeProvider } = await import("./jev");
const { clearGateCache } = await import("./lint");
const { clearRepoCache } = await import("./repoRules");

const DEFAULT_IDLE_MS = 30 * 60_000;
const idleSetting = Number(process.env.JEV_LINT_DAEMON_IDLE_MS);
const IDLE_MS = idleSetting > 0 ? idleSetting : DEFAULT_IDLE_MS;
// While checks are arriving, touch the API every 45 s so the pooled connection stays open.
// A GET to the API root is answered with 405 and isn't billed.
const KEEPWARM_MS = 45_000;
const KEEPWARM_WINDOW_MS = 10 * 60_000;
const DRAIN_LIMIT_MS = 20_000;
const BASE_URL = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Take `<socket>.lock` exclusively, replacing it only if its owner is dead.
function takeLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(lock, "utf8").trim());
      } catch {
        continue; // removed between our open and read: try again
      }
      if (owner > 0 && pidAlive(owner)) return false;
      try {
        unlinkSync(lock); // left by a daemon that died without cleaning up
      } catch {
        return false; // another starter removed it first; let it win
      }
    }
  }
  return false;
}

function removeIfOurs(path: string, inode: number | undefined) {
  try {
    if (inode === undefined || statSync(path).ino === inode) unlinkSync(path);
  } catch {
    // already gone
  }
}

function main() {
  const socket = daemonSocketPath();
  const lock = `${socket}.lock`;
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socket), 0o700); // also holds the findings log, which has code excerpts
  if (!takeLock(lock)) return;
  removeIfOurs(socket, undefined); // stale socket file: we hold the lock, so it has no live owner

  let lastActivity = Date.now();
  let inFlight = 0;
  let draining = false;

  const server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ pid: process.pid });
      if (url.pathname !== "/check" || req.method !== "POST") return new Response("not found", { status: 404 });
      if (draining || codeVersion() !== version) {
        drain(); // jev-lint changed: finish in-flight checks, then exit; the hook checks in process
        return new Response("stale", { status: 503 });
      }
      lastActivity = Date.now();
      inFlight++;
      try {
        const body = (await req.json()) as { changes?: unknown; timeoutMs?: unknown; cwd?: unknown };
        if (!Array.isArray(body.changes) || !body.changes.every(isChangedFile) || typeof body.timeoutMs !== "number")
          return new Response("bad request", { status: 400 });
        clearRepoCache();
        clearGateCache();
        const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
        const settled = await runChecks(body.changes, { timeoutMs: body.timeoutMs, cwd });
        if (settled.some((s) => !s.ok && /(?:TypeSafe|Cloudflare) (401|403)/.test(s.error))) drain();
        return Response.json(settled);
      } catch (error) {
        return new Response(String(error), { status: 500 });
      } finally {
        inFlight--;
        lastActivity = Date.now();
      }
    },
  });
  chmodSync(socket, 0o600);
  const inode = statSync(socket).ino;

  if (judgeProvider() === "typesafe") apiKey(); // Cloudflare must not read the TypeSafe Keychain
  const warm = () =>
    judgeProvider() === "typesafe"
      ? fetch(BASE_URL, { method: "GET", signal: AbortSignal.timeout(5000) }).catch(() => undefined)
      : undefined;
  void warm();
  const timer = setInterval(() => {
    const idle = Date.now() - lastActivity;
    if (idle > IDLE_MS && inFlight === 0) shutdown();
    else if (idle < KEEPWARM_WINDOW_MS) void warm();
  }, KEEPWARM_MS);

  function drain() {
    if (draining) return;
    draining = true;
    const started = Date.now();
    const wait = setInterval(() => {
      if (inFlight === 0 || Date.now() - started > DRAIN_LIMIT_MS) {
        clearInterval(wait);
        shutdown();
      }
    }, 50);
  }

  function shutdown() {
    clearInterval(timer);
    server.stop(true);
    removeIfOurs(socket, inode);
    try {
      if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
      unlinkSync(`${socket}.started`); // the client's respawn-limit stamp; a clean exit may be followed by a start
    } catch {
      // lock already replaced or removed
    }
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
