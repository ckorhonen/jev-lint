import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkViaDaemon, daemonSocketPath, startDaemon } from "../src/daemonClient";
import { cloudflareKey } from "../src/jev";

const names = ["JEV_LINT_PROVIDER", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_FILE", "TYPESAFE_API_KEY_FILE", "XDG_STATE_HOME"];
let saved: Record<string, string | undefined>;
let originalCwd: string;
let root: string;
beforeEach(() => {
  saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  originalCwd = process.cwd();
  root = realpathSync(mkdtempSync("/tmp/jev-lifecycle-"));
  process.env.JEV_LINT_PROVIDER = "cloudflare";
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN_FILE;
  delete process.env.TYPESAFE_API_KEY_FILE;
  process.env.XDG_STATE_HOME = join(root, "state");
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("a daemon timeout never kills, deletes ownership files, or spawns a replacement", async () => {
  const socket = daemonSocketPath();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const files = [socket, `${socket}.lock`, `${socket}.started`];
  for (const file of files) writeFileSync(file, "dummy-owned-state", { mode: 0o600 });
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("dummy timeout", "TimeoutError"));
  const killMock = spyOn(process, "kill").mockImplementation(() => true);
  const spawnMock = spyOn(childProcess, "spawn").mockImplementation(() => {
    throw new Error("replacement must not spawn");
  });
  try {
    const changes = [{ filePath: "/tmp/dummy.ts", addedCode: "dummy", changeKind: "write" as const }];
    expect(await checkViaDaemon(changes, { timeoutMs: 1 })).toEqual([{ ok: false, error: "daemon timeout" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // No health probe or external fallback.
    expect(killMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    for (const file of files) expect(readFileSync(file, "utf8")).toBe("dummy-owned-state");
  } finally {
    fetchMock.mockRestore();
    killMock.mockRestore();
    spawnMock.mockRestore();
  }
});

test.each(["CLOUDFLARE_API_TOKEN_FILE", "TYPESAFE_API_KEY_FILE"])(
  "relative %s filenames in different projects isolate daemon identity",
  (name) => {
    const sockets = [];
    for (const project of ["one", "two"]) {
      const cwd = join(root, project);
      mkdirSync(cwd);
      process.chdir(cwd);
      process.env[name] = "dummy-token";
      sockets.push(daemonSocketPath());
    }
    expect(sockets[0]).not.toBe(sockets[1]);
  },
);

test("the spawned TypeSafe child retains the caller key filename without Keychain access", () => {
  process.chdir(root);
  writeFileSync("dummy-key", "dummy-expected", { mode: 0o600 });
  process.env.JEV_LINT_PROVIDER = "typesafe";
  process.env.TYPESAFE_API_KEY_FILE = "dummy-key";
  const socket = daemonSocketPath();
  const probe = `import { readFileSync } from "node:fs";
    import { daemonSocketPath } from ${JSON.stringify(join(import.meta.dir, "../src/daemonClient.ts"))};
    console.log(JSON.stringify({ credentialMatches: readFileSync(process.env.TYPESAFE_API_KEY_FILE, "utf8") === "dummy-expected", socket: daemonSocketPath() }));`;
  const spawnMock = spyOn(childProcess, "spawn").mockImplementation(((_command, _args, options) => {
    expect(options?.cwd).toBe(homedir());
    expect(options?.env?.TYPESAFE_API_KEY_FILE).toBe(join(root, "dummy-key"));
    const result = childProcess.spawnSync(process.execPath, ["--eval", probe], {
      cwd: options?.cwd,
      env: options?.env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ credentialMatches: true, socket });
    return { pid: 12345, unref() {} } as childProcess.ChildProcess;
  }) as typeof childProcess.spawn);
  try {
    expect(startDaemon()).toBe(12345);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(process.env.TYPESAFE_API_KEY_FILE).toBe("dummy-key");
  } finally {
    spawnMock.mockRestore();
  }
});

test.each(["relative", "absolute"])("%s Cloudflare symlink/.. paths retain credentials in the spawned home-cwd child", (kind) => {
  const project = join(root, "project");
  const target = join(root, "target");
  mkdirSync(project);
  mkdirSync(join(target, "nested"), { recursive: true });
  symlinkSync(join(target, "nested"), join(project, "link"), "dir");
  writeFileSync(join(target, "dummy-token"), "dummy-expected", { mode: 0o600 });
  writeFileSync(join(project, "dummy-token"), "dummy-wrong", { mode: 0o600 });
  process.chdir(project);
  const relative = "link/../dummy-token";
  const absolute = `${project}/${relative}`;
  const original = kind === "relative" ? relative : absolute;
  process.env.CLOUDFLARE_API_TOKEN_FILE = original;
  expect(cloudflareKey()).toBe("dummy-expected");
  const socket = daemonSocketPath();
  const probe = `import { cloudflareKey } from ${JSON.stringify(join(import.meta.dir, "../src/jev.ts"))};
    import { daemonSocketPath } from ${JSON.stringify(join(import.meta.dir, "../src/daemonClient.ts"))};
    console.log(JSON.stringify({ credentialMatches: cloudflareKey() === "dummy-expected", socket: daemonSocketPath() }));`;
  const spawnMock = spyOn(childProcess, "spawn").mockImplementation(((_command, _args, options) => {
    expect(options?.cwd).toBe(homedir());
    expect(options?.env?.CLOUDFLARE_API_TOKEN_FILE).toBe(absolute);
    const result = childProcess.spawnSync(process.execPath, ["--eval", probe], {
      cwd: options?.cwd,
      env: options?.env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ credentialMatches: true, socket });
    return { pid: 12345, unref() {} } as childProcess.ChildProcess;
  }) as typeof childProcess.spawn);
  try {
    expect(startDaemon()).toBe(12345);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(process.env.CLOUDFLARE_API_TOKEN_FILE).toBe(original);
  } finally {
    spawnMock.mockRestore();
  }
});
