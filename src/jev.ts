// Minimal TypeSafe System One client (POST /v1/systemone). No SDK dependency so the
// hook starts fast under bun.

import { spawnSync } from "node:child_process";

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};

export type JevResponse = {
  model: string;
  answers: Record<string, { type: "noul"; noul: number }>;
  usage: { input_tokens: number; output_tokens: number };
};

// Any server speaking the same `POST /v1/systemone` protocol works, e.g. a local Kev or
// Laya server: TYPESAFE_BASE_URL=http://127.0.0.1:8009. Local servers need no key.
const DEFAULT_BASE_URL = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";
const isTypeSafe = (url: string) => new URL(url).hostname.endsWith("typesafe.ai");
const KEYCHAIN_SERVICE = "typesafe-api-key";

let cachedKey: string | undefined;

export function apiKey(): string | undefined {
  if (!cachedKey && process.env.TYPESAFE_API_KEY) cachedKey = process.env.TYPESAFE_API_KEY;
  if (!cachedKey && process.platform === "darwin") {
    const out = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" });
    if (out.status === 0 && out.stdout.trim()) cachedKey = out.stdout.trim();
  }
  return cachedKey;
}

export async function askNouls(
  state: unknown,
  questions: Record<string, NoulQuestion>,
  opts: { model?: string; timeoutMs?: number; retries?: number; baseUrl?: string } = {},
): Promise<JevResponse> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const key = isTypeSafe(baseUrl) ? apiKey() : "local";
  if (!key) throw new Error("TYPESAFE_API_KEY not set and no Keychain item 'typesafe-api-key'");

  const body = JSON.stringify({ state, model: opts.model ?? process.env.JEV_LINT_MODEL ?? "jev-latest", questions });
  const retries = opts.retries ?? 0;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.ok) return (await res.json()) as JevResponse;

    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const retryAfterSec = Number(res.headers.get("retry-after"));
    await Bun.sleep(retryAfterSec > 0 ? retryAfterSec * 1000 : 500 * 2 ** attempt);
  }
}
