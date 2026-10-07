import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { takeDaemonLock } from "../src/daemonLock";

let root: string;
let lock: string;
beforeEach(() => {
  root = mkdtempSync("/tmp/jev-lock-");
  lock = join(root, "daemon.sock.lock");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test.each(["fifo", "symlink", "oversized"])("unexpected %s lock state is never read or removed on acquisition or release", (kind) => {
  const owner = takeDaemonLock(lock, () => {});
  unlinkSync(lock);
  if (kind === "fifo") expect(spawnSync("mkfifo", [lock]).status).toBe(0);
  else if (kind === "symlink") {
    const target = join(root, "unrelated");
    writeFileSync(target, String(process.pid));
    symlinkSync(target, lock);
  } else writeFileSync(lock, "0".repeat(33));
  const inode = lstatSync(lock).ino;
  expect(
    takeDaemonLock(
      lock,
      () => {
        throw new Error("unexpected cleanup");
      },
      { alive: () => false },
    ),
  ).toBeUndefined();
  expect(
    owner?.release(() => {
      throw new Error("unexpected release cleanup");
    }),
  ).toBe(false);
  expect(lstatSync(lock).ino).toBe(inode);
  expect(existsSync(`${lock}.guard`)).toBe(false);
});

test("a contender observing a dead owner excludes another contender until replacement completes", () => {
  writeFileSync(lock, "123", { mode: 0o600 });
  let blocked = false;
  const owner = takeDaemonLock(lock, () => {}, {
    ownerPid: 456,
    alive: (pid) => {
      expect(pid).toBe(123);
      blocked =
        takeDaemonLock(
          lock,
          () => {
            throw new Error("competing cleanup");
          },
          { ownerPid: 789, alive: () => false },
        ) === undefined;
      expect(readFileSync(lock, "utf8")).toBe("123");
      return false;
    },
  });
  expect(blocked).toBe(true);
  expect(owner).toBeDefined();
  expect(readFileSync(lock, "utf8")).toBe("456");
  expect(existsSync(`${lock}.guard`)).toBe(false);
  expect(
    takeDaemonLock(
      lock,
      () => {
        throw new Error("live owner cleanup");
      },
      { ownerPid: 789, alive: () => true },
    ),
  ).toBeUndefined();
  expect(readFileSync(lock, "utf8")).toBe("456");
});

test("startup socket cleanup and shutdown cleanup exclude other ownership transactions", () => {
  const owner = takeDaemonLock(
    lock,
    () => {
      expect(takeDaemonLock(lock, () => {}, { ownerPid: 789 })).toBeUndefined();
    },
    { ownerPid: 456 },
  );
  expect(
    owner?.release(() => {
      expect(takeDaemonLock(lock, () => {}, { ownerPid: 789 })).toBeUndefined();
      expect(readFileSync(lock, "utf8")).toBe("456");
    }),
  ).toBe(true);
  expect(existsSync(lock)).toBe(false);
  expect(existsSync(`${lock}.guard`)).toBe(false);
  expect(takeDaemonLock(lock, () => {}, { ownerPid: 789 })).toBeDefined();
});

test("an old owner cannot remove a successor lock or run socket cleanup", () => {
  const old = takeDaemonLock(lock, () => {}, { ownerPid: 456 });
  unlinkSync(lock);
  const successor = takeDaemonLock(lock, () => {}, { ownerPid: 789 });
  expect(successor).toBeDefined();
  expect(
    old?.release(() => {
      throw new Error("must not touch successor socket");
    }),
  ).toBe(false);
  expect(readFileSync(lock, "utf8")).toBe("789");
});

test("an abandoned guard is never reaped and leaves state files untouched", () => {
  mkdirSync(`${lock}.guard`, { mode: 0o700 });
  writeFileSync(lock, "123");
  const inode = statSync(`${lock}.guard`).ino;
  expect(
    takeDaemonLock(
      lock,
      () => {
        throw new Error("must not clean socket");
      },
      { alive: () => false },
    ),
  ).toBeUndefined();
  expect(readFileSync(lock, "utf8")).toBe("123");
  expect(statSync(`${lock}.guard`).ino).toBe(inode);
});

test("permission-denied liveness probes do not recover a possibly live lock", () => {
  writeFileSync(lock, "123");
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  });
  try {
    expect(
      takeDaemonLock(lock, () => {
        throw new Error("must not clean socket");
      }),
    ).toBeUndefined();
    expect(kill).toHaveBeenCalledWith(123, 0);
    expect(readFileSync(lock, "utf8")).toBe("123");
  } finally {
    kill.mockRestore();
  }
});

test("guard is released after a failed startup callback", () => {
  expect(() =>
    takeDaemonLock(lock, () => {
      throw new Error("startup failed");
    }),
  ).toThrow("startup failed");
  expect(existsSync(`${lock}.guard`)).toBe(false);
  expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
});

test("concurrent real processes recovering a stale lock elect exactly one owner", async () => {
  writeFileSync(lock, "invalid-dead-owner", { mode: 0o600 });
  const gate = join(root, "release");
  const probe = `import {existsSync} from "node:fs";
    import {takeDaemonLock} from ${JSON.stringify(join(import.meta.dir, "../src/daemonLock.ts"))};
    const owner = takeDaemonLock(${JSON.stringify(lock)}, () => {});
    console.log(JSON.stringify({acquired: Boolean(owner),pid:process.pid}));
    if(owner){const until=Date.now()+5000; while(!existsSync(${JSON.stringify(gate)}) && Date.now()<until) await Bun.sleep(10); owner.release(()=>{});}`;
  const children = Array.from({ length: 6 }, () =>
    Bun.spawn([process.execPath, "--eval", probe], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" }),
  );
  const results = await Promise.all(
    children.map(async (child) => {
      const chunk = await child.stdout.getReader().read();
      return JSON.parse(new TextDecoder().decode(chunk.value));
    }),
  );
  try {
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    const winner = results.find((result) => result.acquired);
    expect(readFileSync(lock, "utf8")).toBe(String(winner.pid));
  } finally {
    writeFileSync(gate, "release");
  }
  expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array(6).fill(0));
  expect(existsSync(lock)).toBe(false);
  expect(existsSync(`${lock}.guard`)).toBe(false);
}, 10_000);
