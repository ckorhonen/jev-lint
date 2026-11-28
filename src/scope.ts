function isAbsolutePath(file: string): boolean {
  return file.startsWith("/") || file.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(file);
}

function normalizeAbsolute(path: string): string {
  if (process.platform === "win32") {
    const { resolve } = require("node:path") as typeof import("node:path");
    return resolve(path);
  }
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

function absolutePath(file: string, cwd: string): string {
  if (process.platform === "win32") {
    const { isAbsolute, resolve } = require("node:path") as typeof import("node:path");
    return isAbsolute(file) ? file : resolve(cwd, file);
  }
  const combined = isAbsolutePath(file) ? file : `${cwd}/${file}`;
  return normalizeAbsolute(isAbsolutePath(combined) ? combined : `${process.cwd()}/${combined}`);
}

function isUnder(parent: string, child: string): boolean {
  if (process.platform === "win32") {
    const { isAbsolute, relative } = require("node:path") as typeof import("node:path");
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }
  const prefix = parent === "/" ? "/" : `${parent}/`;
  return child !== parent && child.startsWith(prefix);
}

function repoRootWithFs(absoluteFile: string, fallback: string): string {
  // This branch is rare (an edit outside cwd), so node:fs and node:path are loaded
  // only here rather than in every warm hook process.
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const { dirname, join, parse } = require("node:path") as typeof import("node:path");
  let dir = dirname(absoluteFile);
  const { root } = parse(dir);
  for (;;) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".jev-lint"))) return dir;
    if (dir === root) return fallback;
    dir = dirname(dir);
  }
}

// Fast version of findingsLog.isInsideRepo for the hook's startup path. Almost every edit
// is underneath the agent cwd, where no filesystem probe is needed; only edits outside cwd
// walk upward looking for the repository root.
export function isInsideRepo(filePath: string, cwd: string): boolean {
  const absoluteCwd = absolutePath(cwd, process.cwd());
  const absolute = absolutePath(filePath, absoluteCwd);
  if (isUnder(absoluteCwd, absolute)) return true;
  const root = repoRootWithFs(`${absoluteCwd}/_`, absoluteCwd);
  return isUnder(root, absolute);
}
