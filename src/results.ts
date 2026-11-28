import type { LintResult } from "./lint";

export const MAX_FILES = 8;

// Serializable, so the daemon can send it over its socket.
export type Settled = { ok: true; value: LintResult | undefined } | { ok: false; error: string };

export function isSettledList(value: unknown): value is Settled[] {
  return Array.isArray(value) && value.every((s) => s && typeof s === "object" && typeof (s as Settled).ok === "boolean");
}
