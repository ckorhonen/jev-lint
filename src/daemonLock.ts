// Serialize daemon ownership changes. Never reap an existing guard: a stale
// observer must not remove a successor's lock, socket, or guard.
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";

function withGuard<T>(lock: string, action: () => T): T | undefined {
  const guard = `${lock}.guard`;
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch {
    return undefined; // Busy/abandoned guard: caller falls back to in-process checks.
  }
  try {
    return action();
  } finally {
    rmdirSync(guard); // Only the creator releases it; nobody reaps another guard.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. Permission errors are not permission to recover.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export type DaemonLock = { release: (cleanup: () => void) => boolean };

export function takeDaemonLock(
  lock: string,
  acquired: () => void,
  opts: { ownerPid?: number; alive?: (pid: number) => boolean } = {},
): DaemonLock | undefined {
  const pid = opts.ownerPid ?? process.pid;
  const alive = opts.alive ?? pidAlive;
  return withGuard(lock, () => {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      const info = lstatSync(lock);
      if (!info.isFile() || info.size > 32) return undefined; // Unexpected state is not permission to read or remove it.
      const owner = Number(readFileSync(lock, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && alive(owner)) return undefined;
      // Every creator/releaser uses the guard, so nobody can replace this stale
      // file between observation and unlink. No PID is signalled for cleanup.
      unlinkSync(lock);
      fd = openSync(lock, "wx", 0o600);
    }
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    const inode = statSync(lock).ino;
    acquired(); // Stale socket cleanup must also happen before releasing the guard.
    return {
      release(cleanup) {
        return (
          withGuard(lock, () => {
            const info = lstatSync(lock);
            if (!info.isFile() || info.size > 32 || info.ino !== inode || readFileSync(lock, "utf8").trim() !== String(pid)) return false;
            cleanup();
            unlinkSync(lock);
            return true;
          }) ?? false
        );
      },
    };
  });
}
