// Hook side of the optional daemon (see daemon.ts). JEV_LINT_DAEMON=off disables it.

import type { ChangedFile } from "./extract";
import { isSettledList, type Settled } from "./results";
import { stateDir } from "./state";

// Settings that change what a check does. Each combination gets its own daemon, because
// the daemon's rules, model and endpoint are fixed by the environment it started with.
const CONFIG_ENV = [
  "JEV_LINT_MODEL",
  "JEV_LINT_PACKS",
  "JEV_LINT_GATE",
  "JEV_LINT_HIGH",
  "JEV_LINT_MEDIUM",
  "TYPESAFE_BASE_URL",
  "TYPESAFE_API_KEY_FILE",
  "JEV_LINT_PROVIDER",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN_FILE",
  "OPENAI_API_KEY_FILE",
];
const CONNECT_TIMEOUT_MS = 300;
// At most one daemon start per socket in this window, so a daemon that crashes on startup
// can't turn every edit into a new process.
const RESPAWN_WINDOW_MS = 30_000;

function isAbsolutePath(file: string): boolean {
  return file.startsWith("/") || file.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(file);
}

// The child starts in the home directory. Preserve the caller's credential file
// location, and hash that same absolute path so project-relative files isolate.
function daemonEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const sep = process.platform === "win32" ? "\\" : "/";
  // Do not collapse '..': symlink/.. traversal can select a different key file.
  for (const name of ["OPENAI_API_KEY_FILE", "CLOUDFLARE_API_TOKEN_FILE", "TYPESAFE_API_KEY_FILE"]) {
    const file = env[name];
    if (file && !isAbsolutePath(file)) env[name] = `${process.cwd()}${sep}${file}`;
  }
  return env;
}

export function daemonSocketPath(env = daemonEnvironment()): string {
  // The key is part of the identity (hashed, never stored) so projects with different keys
  // never share a daemon. A Keychain key isn't known here; the daemon exits on 401/403 instead.
  const config = [
    ...CONFIG_ENV.map((k) => `${k}=${env[k] ?? ""}`),
    `key=${env.TYPESAFE_API_KEY ?? ""}`,
    `openaiKey=${env.OPENAI_API_KEY ?? ""}`,
    `cfKey=${env.CLOUDFLARE_API_TOKEN ?? ""}`,
  ].join("\n");
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(`${import.meta.dir}\n${config}`);
  const id = hash.digest("hex").slice(0, 12);
  return `${stateDir()}/daemon-${id}.sock`;
}

export const daemonEnabled = () => process.env.JEV_LINT_DAEMON !== "off";

type DaemonHttp = { status: number; body: string } | "timeout" | undefined;

function parseHttp(chunks: Buffer[]): { status: number; body: string; complete: boolean } | undefined {
  const raw = Buffer.concat(chunks);
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) return undefined;
  const header = raw.subarray(0, end).toString("latin1");
  const status = Number(header.split(" ", 2)[1]);
  if (!Number.isInteger(status)) return undefined;
  const match = /\r\ncontent-length:\s*(\d+)/i.exec(header);
  if (!match) return { status, body: "", complete: true };
  const length = Number(match[1]);
  const start = end + 4;
  if (raw.length < start + length) return { status, body: "", complete: false };
  return { status, body: raw.subarray(start, start + length).toString("utf8"), complete: true };
}

// Minimal HTTP/1.1 POST over the daemon's Unix socket. `fetch` initializes several
// milliseconds of networking machinery in every short-lived hook process; Bun.connect
// does not, which is significant when the daemon itself answers in about a millisecond.
function postDaemon(path: string, body: string, timeoutMs: number): Promise<DaemonHttp> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let activeSocket: Bun.Socket | undefined;
    let done = false;
    const finish = (value: DaemonHttp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        activeSocket?.terminate(); // a wedged daemon must not keep this short-lived hook alive
      } catch {
        // already closed
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const request = Buffer.concat([
      Buffer.from(
        `POST /check HTTP/1.1\r\nHost: jev-lint\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`,
      ),
      Buffer.from(body),
    ]);
    let offset = 0;
    const send = (socket: Bun.Socket) => {
      try {
        while (offset < request.length) {
          const written = socket.write(request, offset, request.length - offset);
          if (written < 0) {
            finish(undefined);
            return;
          }
          offset += written;
          if (written === 0 || offset < request.length) return; // wait for drain when backpressured
        }
      } catch {
        finish(undefined);
      }
    };
    void Bun.connect({
      unix: path,
      socket: {
        binaryType: "buffer",
        open(socket) {
          activeSocket = socket;
          send(socket);
        },
        drain: send,
        data(socket, data) {
          chunks.push(data);
          const parsed = parseHttp(chunks);
          if (parsed?.complete) {
            socket.end();
            finish({ status: parsed.status, body: parsed.body });
          }
        },
        close() {
          const parsed = parseHttp(chunks);
          finish(parsed?.complete ? { status: parsed.status, body: parsed.body } : undefined);
        },
        error() {
          finish(undefined);
        },
        connectError() {
          finish(undefined);
        },
      },
    }).catch(() => finish(undefined));
  });
}

// Returns undefined when the daemon can't be reached, so the caller checks in process. A
// daemon that was reached but ran out of time counts as failed checks (fail open), not as a
// reason to start the whole check again and double the wait.
export async function checkViaDaemon(changes: ChangedFile[], opts: { timeoutMs: number; cwd?: string }): Promise<Settled[] | undefined> {
  const res = await postDaemon(daemonSocketPath(), JSON.stringify({ changes, ...opts }), opts.timeoutMs + CONNECT_TIMEOUT_MS);
  if (res === "timeout") {
    // A lock PID alone cannot prove process ownership (PIDs can be reused). Leave
    // cleanup to the daemon's idle/source-change/drain shutdown rather than kill
    // or unlink an unverified owner. A wedged daemon may keep failing checks until
    // it shuts down or its owner explicitly restarts it; the hook stays fail-open.
    return changes.map(() => ({ ok: false, error: "daemon timeout" }));
  }
  if (!res || res.status < 200 || res.status >= 300) return undefined;
  try {
    const settled: unknown = JSON.parse(res.body);
    return isSettledList(settled) ? settled : undefined;
  } catch {
    return undefined;
  }
}

// Start a daemon for the next check, in its own session so it outlives this hook process
// (agents may kill the hook's process group when it exits). This check doesn't wait for it.
type Spawn = typeof import("node:child_process").spawn;

export function startDaemon(opts: { force?: boolean } = {}, spawnImpl?: Spawn): number | undefined {
  // This path runs only when the daemon is absent. Keeping node:fs, node:path,
  // node:os and node:child_process out of the module startup saves several milliseconds
  // from every warm hook invocation (Bun initializes those builtin modules eagerly).
  const spawn = spawnImpl ?? (require("node:child_process") as typeof import("node:child_process")).spawn;
  const { mkdirSync, statSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { homedir } = require("node:os") as typeof import("node:os");
  const { dirname, join } = require("node:path") as typeof import("node:path");
  const env = daemonEnvironment();
  const stamp = `${daemonSocketPath(env)}.started`;
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
      env,
      cwd: homedir(),
    });
    child.unref();
    return child.pid;
  } catch {
    return undefined; // can't spawn: checks keep running in process
  }
}
