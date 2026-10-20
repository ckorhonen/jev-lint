// Lint a hook event's changed files: at most MAX_FILES files, MAX_PARALLEL at a time, so a
// large multi-file patch can't fan out into dozens of API calls. Shared by the hook (in
// process) and the daemon (which keeps the API connection open between checks).

import type { ChangedFile } from "./extract";
import { type LintResult, lintChange } from "./lint";

export const MAX_FILES = 8;
const MAX_PARALLEL = 4;

// Serializable, so the daemon can send it over its socket.
export type Settled = { ok: true; value: LintResult | undefined } | { ok: false; error: string };

export async function runChecks(changes: ChangedFile[], opts: { timeoutMs: number; cwd?: string }): Promise<Settled[]> {
  const settled: Settled[] = [];
  const deadline = performance.now() + opts.timeoutMs;
  for (let i = 0; i < changes.length; i += MAX_PARALLEL) {
    const batch = changes.slice(i, i + MAX_PARALLEL);
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) {
      settled.push(...changes.slice(i).map((): Settled => ({ ok: false, error: "check deadline exceeded" })));
      break;
    }
    const results = await Promise.allSettled(batch.map((c) => lintChange(c, { ...opts, timeoutMs: remaining })));
    for (const r of results) settled.push(r.status === "fulfilled" ? { ok: true, value: r.value } : { ok: false, error: String(r.reason) });
  }
  return settled;
}

export function isChangedFile(value: unknown): value is ChangedFile {
  const c = value as ChangedFile;
  return Boolean(c && typeof c.filePath === "string" && typeof c.addedCode === "string" && typeof c.changeKind === "string");
}

export function isSettledList(value: unknown): value is Settled[] {
  return Array.isArray(value) && value.every((s) => s && typeof s === "object" && typeof (s as Settled).ok === "boolean");
}
