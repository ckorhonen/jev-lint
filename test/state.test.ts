import { afterEach, expect, spyOn, test } from "bun:test";
import { daemonSocketPath } from "../src/daemonClient";
import { findingsLogPath } from "../src/findingsLog";
import { stateDir } from "../src/state";

const os = require("node:os") as typeof import("node:os");

const names = ["HOME", "USERPROFILE", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"];
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("XDG_STATE_HOME does not need a home directory", () => {
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  process.env.XDG_STATE_HOME = "/tmp/custom-state/";
  const homeMock = spyOn(os, "homedir").mockImplementation(() => {
    throw new Error("no passwd entry");
  });
  try {
    expect(stateDir()).toBe("/tmp/custom-state/jev-lint");
    expect(homeMock).not.toHaveBeenCalled();
  } finally {
    homeMock.mockRestore();
  }
});

test("a missing home directory falls back without throwing", () => {
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.XDG_STATE_HOME;
  delete process.env.XDG_RUNTIME_DIR;
  const homeMock = spyOn(os, "homedir").mockImplementation(() => {
    throw new Error("no passwd entry");
  });
  try {
    expect(stateDir()).toBeUndefined();
    expect(daemonSocketPath()).toBeUndefined();
    expect(findingsLogPath()).toBeUndefined();
  } finally {
    homeMock.mockRestore();
  }
});

test("XDG_RUNTIME_DIR is the fallback when home resolution fails", () => {
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.XDG_STATE_HOME;
  process.env.XDG_RUNTIME_DIR = "/run/user/1000/";
  const homeMock = spyOn(os, "homedir").mockImplementation(() => {
    throw new Error("no passwd entry");
  });
  try {
    expect(stateDir()).toBe("/run/user/1000/jev-lint");
  } finally {
    homeMock.mockRestore();
  }
});
