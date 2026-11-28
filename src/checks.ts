// The hosted TypeSafe hook can send its eight selected files in one wave. Local servers
// and other providers keep the four-worker limit. Results stay in input order.
import type { ChangedFile } from "./extract";
import type { LintResult } from "./lint";

export const MAX_FILES = 8;
const DEFAULT_PARALLEL = 4;

// Serializable, so the daemon can send it over its socket.
export type Settled = { ok: true; value: LintResult | undefined } | { ok: false; error: string };

export async function runChecks(changes: ChangedFile[], opts: { timeoutMs: number; cwd?: string }): Promise<Settled[]> {
  const settled: Settled[] = [];
  const deadline = performance.now() + opts.timeoutMs;
  const { lintChange } = await import("./lint");
  let next = 0;
  async function worker() {
    while (next < changes.length) {
      const index = next++;
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) {
        settled[index] = { ok: false, error: "check deadline exceeded" };
        continue;
      }
      try {
        const value = await lintChange(changes[index], { ...opts, timeoutMs: remaining });
        settled[index] = { ok: true, value };
      } catch (error) {
        settled[index] = { ok: false, error: String(error) };
      }
    }
  }
  const hostedTypeSafe =
    (process.env.JEV_LINT_PROVIDER ?? "typesafe") === "typesafe" &&
    (process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai") === "https://api.typesafe.ai";
  const parallel = hostedTypeSafe ? MAX_FILES : DEFAULT_PARALLEL;
  await Promise.all(Array.from({ length: Math.min(changes.length, parallel) }, worker));
  return settled;
}

export function isChangedFile(value: unknown): value is ChangedFile {
  const c = value as ChangedFile;
  return Boolean(c && typeof c.filePath === "string" && typeof c.addedCode === "string" && typeof c.changeKind === "string");
}

export function isSettledList(value: unknown): value is Settled[] {
  return Array.isArray(value) && value.every((s) => s && typeof s === "object" && typeof (s as Settled).ok === "boolean");
}
