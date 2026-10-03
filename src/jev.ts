// Minimal TypeSafe System One client (POST /v1/systemone). No SDK dependency so the
// hook starts fast under bun.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const isTypeSafe = (url: string) => {
  const host = new URL(url).hostname;
  return host === "typesafe.ai" || host.endsWith(".typesafe.ai");
};
const KEYCHAIN_SERVICE = "typesafe-api-key";

let cachedKey: string | undefined;

// A user-only file, for machines where the Keychain can't be used (Linux, SSH sessions).
export function keyFilePath(): string {
  return process.env.TYPESAFE_API_KEY_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jev-lint/api-key");
}

function readKeyFile(): string | undefined {
  try {
    const path = keyFilePath();
    if ((statSync(path).mode & 0o077) !== 0) return undefined; // refuse a key others can read
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined; // no key file
  }
}

// Order: TYPESAFE_API_KEY, then the key file, then the macOS Keychain (typesafe-api-key).
export function apiKey(): string | undefined {
  if (!cachedKey && process.env.TYPESAFE_API_KEY) cachedKey = process.env.TYPESAFE_API_KEY;
  if (!cachedKey) cachedKey = readKeyFile();
  if (!cachedKey && process.platform === "darwin") {
    // Bounded: a locked keychain can show an unlock prompt and block forever.
    const out = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", timeout: 2000 });
    if (out.status === 0 && out.stdout.trim()) cachedKey = out.stdout.trim();
  }
  return cachedKey;
}

export type JudgeProvider = "typesafe" | "cloudflare";
export type JudgeOptions = { model?: string; timeoutMs?: number; retries?: number; baseUrl?: string; provider?: JudgeProvider };

export function judgeProvider(): JudgeProvider {
  const provider = process.env.JEV_LINT_PROVIDER ?? "typesafe";
  if (provider !== "typesafe" && provider !== "cloudflare") throw new Error(`Unknown JEV_LINT_PROVIDER: ${provider}`);
  return provider;
}

export function judgeModel(provider = judgeProvider()): string {
  return process.env.JEV_LINT_MODEL ?? (provider === "cloudflare" ? "clef" : "jev-latest");
}

export function cloudflareKey(): string | undefined {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const path = process.env.CLOUDFLARE_API_TOKEN_FILE;
  if (!path) return undefined;
  try {
    if ((statSync(path).mode & 0o077) !== 0) return undefined;
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

// Cloudflare wraps System One responses in the Workers AI REST envelope. Validate
// every requested answer so a truncated or malformed response cannot look like clean code.
function cloudflareResponse(value: unknown, ids: string[]): JevResponse {
  const envelope = value as { success?: boolean; result?: JevResponse } | null;
  const result = envelope?.result;
  if (envelope?.success !== true || !result || typeof result.model !== "string" || !result.answers || !result.usage)
    throw new Error("Cloudflare invalid response envelope");
  for (const id of ids) {
    const answer = result.answers[id];
    if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
      throw new Error(`Cloudflare invalid or missing Noul answer: ${id}`);
  }
  for (const count of [result.usage.input_tokens, result.usage.output_tokens]) {
    if (!Number.isInteger(count) || count < 0) throw new Error("Cloudflare invalid token usage");
  }
  return result;
}

async function askCloudflare(state: unknown, questions: Record<string, NoulQuestion>, opts: JudgeOptions): Promise<JevResponse> {
  if (opts.baseUrl) throw new Error("baseUrl cannot be combined with the Cloudflare provider");
  const model = opts.model ?? judgeModel("cloudflare");
  if (model !== "clef" && model !== "clef-flash") throw new Error("Cloudflare model must be clef or clef-flash");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID");
  const key = cloudflareKey();
  if (!key) throw new Error("CLOUDFLARE_API_TOKEN or a mode-600 CLOUDFLARE_API_TOKEN_FILE is required");
  const entries = Object.entries(questions);
  if (!entries.length) throw new Error("Cloudflare requires at least one question");
  // Clef accepts at most 64 questions. All batches share the same deadline; the
  // hook still fails open if any batch fails. Typical gated edits need one batch.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const results: JevResponse[] = [];
  for (let i = 0; i < entries.length; i += 64) {
    const batch = entries.slice(i, i + 64);
    const body = JSON.stringify({ state, model, questions: Object.fromEntries(batch) });
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal,
        redirect: "error",
      });
      if (res.ok) {
        results.push(
          cloudflareResponse(
            await res.json(),
            batch.map(([id]) => id),
          ),
        );
        break;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= (opts.retries ?? 0)) throw new Error(`Cloudflare ${res.status}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, delay);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
  return {
    model: results[0].model,
    answers: Object.assign({}, ...results.map((r) => r.answers)),
    usage: {
      input_tokens: results.reduce((n, r) => n + r.usage.input_tokens, 0),
      output_tokens: results.reduce((n, r) => n + r.usage.output_tokens, 0),
    },
  };
}

export async function askNouls(state: unknown, questions: Record<string, NoulQuestion>, opts: JudgeOptions = {}): Promise<JevResponse> {
  const provider = opts.provider ?? (opts.baseUrl ? "typesafe" : judgeProvider());
  if (provider === "cloudflare") return askCloudflare(state, questions, opts);
  const baseUrl = opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL;
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
