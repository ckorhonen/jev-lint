// Documented Decisions API predicate contract, adapted to the internal Noul shape.
import { readFileSync, statSync } from "node:fs";
import type { JevResponse, JudgeOptions, NoulQuestion } from "./jev";

export function openaiKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const path = process.env.OPENAI_API_KEY_FILE;
  if (!path) return undefined;
  try {
    if ((statSync(path).mode & 0o077) !== 0) return undefined;
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function decisionsResponse(value: unknown, ids: string[]): JevResponse {
  const result = value as {
    model?: unknown;
    answers?: { type?: unknown; name?: unknown; probability?: unknown }[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  } | null;
  if (!result || typeof result.model !== "string" || !Array.isArray(result.answers) || result.answers.length !== ids.length)
    throw new Error("OpenAI Decisions invalid response envelope");
  const answers: JevResponse["answers"] = {};
  for (const [i, id] of ids.entries()) {
    const answer = result.answers[i];
    // Answers are ordered; names are optional in the API. Accept null names but
    // reject mismatches rather than attaching a probability to the wrong rule.
    if (!answer || (answer.name !== null && answer.name !== id)) throw new Error("OpenAI Decisions mismatched answer name");
    if (answer.type === "refusal") throw new Error("OpenAI Decisions refused a question");
    if (
      answer.type !== "predicate" ||
      typeof answer.probability !== "number" ||
      !Number.isFinite(answer.probability) ||
      answer.probability < 0 ||
      answer.probability > 1
    )
      throw new Error("OpenAI Decisions invalid predicate answer");
    Object.defineProperty(answers, id, { value: { type: "noul", noul: answer.probability }, enumerable: true });
  }
  const input = result.usage?.input_tokens;
  const output = result.usage?.output_tokens;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    !Number.isInteger(input) ||
    !Number.isInteger(output) ||
    input < 0 ||
    output < 0
  )
    throw new Error("OpenAI Decisions invalid token usage");
  return { model: result.model, answers, usage: { input_tokens: input, output_tokens: output } };
}

export async function askDecisions(state: unknown, questions: Record<string, NoulQuestion>, opts: JudgeOptions): Promise<JevResponse> {
  if (opts.baseUrl) throw new Error("baseUrl cannot be combined with the OpenAI Decisions provider");
  const model = opts.model ?? process.env.JEV_LINT_MODEL ?? "gpt-6-luna";
  if (model !== "gpt-6-luna") throw new Error("OpenAI Decisions model must be gpt-6-luna");
  const key = openaiKey();
  if (!key) throw new Error("OPENAI_API_KEY or a mode-600 OPENAI_API_KEY_FILE is required");
  const entries = Object.entries(questions);
  if (!entries.length) throw new Error("OpenAI Decisions requires at least one question");
  const body = JSON.stringify({
    model,
    input: typeof state === "string" ? state : JSON.stringify(state),
    questions: entries.map(([name, q]) => ({
      type: "predicate",
      name,
      instructions: [
        q.instructions,
        q.criteria?.true && `True when: ${q.criteria.true}`,
        q.criteria?.false && `False when: ${q.criteria.false}`,
      ]
        .filter(Boolean)
        .join("\n"),
    })),
  });
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/decisions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal,
      redirect: "error",
    });
    if (res.ok)
      return decisionsResponse(
        await res.json(),
        entries.map(([id]) => id),
      );
    if ((res.status !== 429 && res.status < 500) || attempt >= (opts.retries ?? 0)) throw new Error(`OpenAI Decisions ${res.status}`);
    const retryAfter = Number(res.headers.get("retry-after"));
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt,
      );
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
