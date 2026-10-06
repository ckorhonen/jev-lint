import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonSocketPath, startDaemon } from "../src/daemonClient";
import { openaiKey } from "../src/decisions";

const names = ["JEV_LINT_PROVIDER", "OPENAI_API_KEY", "OPENAI_API_KEY_FILE", "XDG_STATE_HOME"];
let saved: Record<string, string | undefined>;
let originalCwd: string;
let root: string;
beforeEach(() => {
  saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  originalCwd = process.cwd();
  root = realpathSync(mkdtempSync("/tmp/jev-key-path-"));
  process.env.JEV_LINT_PROVIDER = "openai";
  delete process.env.OPENAI_API_KEY;
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

test("same relative filename in different projects isolates the daemon", () => {
  const sockets = [];
  for (const project of ["one", "two"]) {
    const cwd = join(root, project);
    mkdirSync(cwd);
    writeFileSync(join(cwd, "dummy-key"), `dummy-${project}`, { mode: 0o600 });
    process.chdir(cwd);
    process.env.OPENAI_API_KEY_FILE = "dummy-key";
    sockets.push(daemonSocketPath());
  }
  expect(sockets[0]).not.toBe(sockets[1]);
});

test("relative and absolute paths to the same key use the same daemon", () => {
  process.chdir(root);
  process.env.OPENAI_API_KEY_FILE = "dummy-key";
  const relative = daemonSocketPath();
  process.env.OPENAI_API_KEY_FILE = join(root, "dummy-key");
  expect(daemonSocketPath()).toBe(relative);
});

function assertSpawnedCredential(expectedFile: string) {
  const callerSocket = daemonSocketPath();
  const reader = join(import.meta.dir, "../src/decisions.ts");
  const client = join(import.meta.dir, "../src/daemonClient.ts");
  const probe = `import { openaiKey } from ${JSON.stringify(reader)};
    import { daemonSocketPath } from ${JSON.stringify(client)};
    console.log(JSON.stringify({ credentialMatches: openaiKey() === "dummy-expected", socket: daemonSocketPath() }));`;
  let childResult: childProcess.SpawnSyncReturns<string> | undefined;
  const mockSpawn = ((_command: string, _args: readonly string[], options: childProcess.SpawnOptions) => {
    expect(options?.cwd).toBe(homedir());
    expect(options?.env?.OPENAI_API_KEY_FILE).toBe(expectedFile);
    childResult = childProcess.spawnSync(process.execPath, ["--eval", probe], {
      cwd: options?.cwd,
      env: options?.env,
      encoding: "utf8",
      timeout: 5000,
    });
    return { pid: 12345, unref() {} } as childProcess.ChildProcess;
  }) as typeof childProcess.spawn;
  const mock = spyOn(childProcess, "spawn").mockImplementation(mockSpawn);
  try {
    expect(startDaemon()).toBe(12345);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(childResult?.status).toBe(0);
    expect(JSON.parse(childResult?.stdout ?? "{}")).toEqual({ credentialMatches: true, socket: callerSocket });
  } finally {
    mock.mockRestore();
  }
}

test("spawned daemon environment reads the caller's relative dummy key from home cwd", () => {
  process.chdir(root);
  writeFileSync("dummy-key", "dummy-expected\n", { mode: 0o600 });
  process.env.OPENAI_API_KEY_FILE = "dummy-key";
  assertSpawnedCredential(join(root, "dummy-key"));
  expect(process.env.OPENAI_API_KEY_FILE).toBe("dummy-key");
});

test.each(["relative", "absolute"])("%s symlink/.. key paths retain filesystem traversal semantics", (kind) => {
  const project = join(root, "project");
  const target = join(root, "target");
  mkdirSync(project);
  mkdirSync(join(target, "nested"), { recursive: true });
  symlinkSync(join(target, "nested"), join(project, "link"), "dir");
  writeFileSync(join(target, "dummy-key"), "dummy-expected\n", { mode: 0o600 });
  writeFileSync(join(project, "dummy-key"), "dummy-wrong\n", { mode: 0o600 });
  process.chdir(project);
  const relative = "link/../dummy-key";
  const absolute = `${project}/${relative}`;
  process.env.OPENAI_API_KEY_FILE = kind === "relative" ? relative : absolute;
  expect(openaiKey()).toBe("dummy-expected");
  assertSpawnedCredential(absolute);
  expect(process.env.OPENAI_API_KEY_FILE).toBe(kind === "relative" ? relative : absolute);
});
