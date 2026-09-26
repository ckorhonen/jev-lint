// Three judges over the same (language, added code) input:
//   jev   — the hook's own path (one TypeSafe call, one Noul per rule)
//   llm   — a small fast LLM judge (OpenAI) given identical rule text, asked yes/maybe/no
//   regex — deterministic patterns for the rules a classic linter could express

import { extractChanges } from "../src/extract";
import { lintChange, type Pack, type RuleSet, ruleSetFor } from "../src/lint";

export type Case = {
  id: string;
  lang: "typescript" | "swift";
  split: "dev" | "holdout";
  pack: Exclude<Pack, "repo">; // which rule pack the labels cover; judges only ask that pack's rules
  payload: { tool_name: string; tool_input: Record<string, unknown> };
  labels: string[];
  notes?: string;
};

// Per rule: a probability-like score in [0,1]. jev returns calibrated probabilities;
// llm maps yes→0.9, maybe→0.6, no→0.1; regex maps match→1, no match→0.
export type Judgment = {
  scores: Record<string, number>;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
};

function changesFor(c: Case) {
  return extractChanges({ hook_event_name: "PostToolUse", ...c.payload }).filter((ch) => ruleSetFor(ch.filePath, [c.pack]));
}

function mergeMax(target: Record<string, number>, source: Record<string, number>) {
  for (const [k, v] of Object.entries(source)) target[k] = Math.max(target[k] ?? 0, v);
}

export async function judgeJev(c: Case): Promise<Judgment> {
  const scores: Record<string, number> = {};
  let latencyMs = 0;
  let inputTokens = 0;
  const results = await Promise.all(changesFor(c).map((ch) => lintChange(ch, { timeoutMs: 30_000, retries: 4, packs: [c.pack] })));
  for (const r of results) {
    if (!r) continue;
    mergeMax(scores, r.probabilities);
    latencyMs = Math.max(latencyMs, r.latencyMs); // files in one patch are judged in parallel
    inputTokens += r.inputTokens;
  }
  return { scores, latencyMs, inputTokens, outputTokens: 0 };
}

export const LLM_MODEL = process.env.BASELINE_MODEL ?? "gpt-6-luna";

function llmPrompt(ruleSet: RuleSet, filePath: string, code: string) {
  const rules = ruleSet.rules.map((r) => `- ${r.id}: ${r.question}\n  yes = ${r.true}\n  no = ${r.false}`).join("\n");
  return [
    `You are a fast code linter. Judge ONLY the added ${ruleSet.language} code below against each rule.`,
    `For each rule answer "yes" (clearly violated), "maybe" (possibly violated, worth a second look), or "no".`,
    `Rules:\n${rules}`,
    `File: ${filePath}\nAdded code:\n\`\`\`\n${code}\n\`\`\``,
  ].join("\n\n");
}

export async function judgeLlm(c: Case): Promise<Judgment> {
  const scores: Record<string, number> = {};
  let latencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const mapping: Record<string, number> = { yes: 0.9, maybe: 0.6, no: 0.1 };

  await Promise.all(
    changesFor(c).map(async (ch) => {
      const ruleSet = ruleSetFor(ch.filePath, [c.pack]) as RuleSet;
      const properties = Object.fromEntries(ruleSet.rules.map((r) => [r.id, { type: "string", enum: ["yes", "maybe", "no"] }]));
      const body = {
        model: LLM_MODEL,
        reasoning_effort: process.env.BASELINE_EFFORT ?? "low",
        messages: [{ role: "user", content: llmPrompt(ruleSet, ch.filePath, ch.addedCode) }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "lint",
            strict: true,
            schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
          },
        },
      };
      const started = performance.now();
      for (let attempt = 0; ; attempt++) {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            choices: { message: { content: string } }[];
            usage: { prompt_tokens: number; completion_tokens: number };
          };
          const answers = JSON.parse(json.choices[0].message.content) as Record<string, string>;
          mergeMax(scores, Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, mapping[v] ?? 0])));
          inputTokens += json.usage.prompt_tokens;
          outputTokens += json.usage.completion_tokens;
          break;
        }
        if (attempt >= 4 || (res.status !== 429 && res.status < 500)) {
          throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        await Bun.sleep(1000 * 2 ** attempt);
      }
      latencyMs = Math.max(latencyMs, performance.now() - started);
    }),
  );
  return { scores, latencyMs, inputTokens, outputTokens };
}

// Only rules with a reasonable single-regex encoding. Rules absent here are "not
// expressible" for the regex baseline and are compared on the covered subset only.
export const REGEX_RULES: Record<string, RegExp> = {
  "ts-no-explicit-any": /(:\s*any\b|\bas\s+any\b|<any>|\bany\[\])/,
  "ts-no-non-null-assertion": /[\w)\]]!(?=[.[\]);,\s]|$)(?!=)/m,
  "ts-no-debug-console": /console\.(log|debug|dir)\(/,
  "ts-no-empty-catch": /catch\s*(\([^)]*\))?\s*\{(\s*\/\/[^\n]*|\s*\/\*[\s\S]*?\*\/)*\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/,
  "ts-no-ts-ignore": /@ts-(ignore|nocheck)\b|@ts-expect-error\s*$/m,
  "ts-no-bare-todo": /\b(TODO|FIXME|XXX)\b(?![^\n]*(#\d+|[A-Z][A-Z0-9]+-\d+|https?:\/\/|\(@?[\w.-]+\)))/,
  "ts-no-hardcoded-secret":
    /(sk_(live|test)_|sk-[A-Za-z0-9]{8}|ghp_|AKIA[0-9A-Z]{8}|xox[bp]-|-----BEGIN [A-Z ]*PRIVATE KEY)|(password|passwd|secret|api_?key|token)\w*\s*[:=]\s*["'`][^"'`<$\s]{6,}["'`]/i,
  "swift-no-force-unwrap": /[\w)\]]!(?=[.[\]),;\s]|$)(?!=)/m,
  "swift-no-force-try": /\btry!/,
  "swift-no-force-cast": /\bas!/,
  "swift-no-debug-print": /(^|[^.\w])(print|debugPrint|dump)\(/m,
  "swift-no-empty-catch": /catch\s*(let\s+\w+\s*)?(as\s+[\w.]+\s*)?\{(\s*\/\/[^\n]*)*\s*\}/,
  "swift-no-bare-todo": /\b(TODO|FIXME|XXX)\b(?![^\n]*(#\d+|[A-Z][A-Z0-9]+-\d+|https?:\/\/|\(@?[\w.-]+\)))/,
  "swift-no-hardcoded-secret":
    /(sk_(live|test)_|sk-[A-Za-z0-9]{8}|ghp_|AKIA[0-9A-Z]{8}|xox[bp]-|-----BEGIN [A-Z ]*PRIVATE KEY)|(password|passwd|secret|api_?key|token)\w*\s*[:=]\s*"[^"<\\\s]{6,}"/i,
};

// Swift force-unwrap regex would also match IUO declarations (`var label: UILabel!`); strip them first.
function preprocessForRegex(ruleId: string, code: string) {
  if (ruleId === "swift-no-force-unwrap") return code.replace(/:\s*[\w.<>[\]]+!(?=\s|$|=)/gm, ": T").replace(/\btry!|\bas!/g, "");
  return code;
}

export async function judgeRegex(c: Case): Promise<Judgment> {
  const scores: Record<string, number> = {};
  const started = performance.now();
  for (const ch of changesFor(c)) {
    const ruleSet = ruleSetFor(ch.filePath, [c.pack]) as RuleSet;
    for (const rule of ruleSet.rules) {
      const pattern = REGEX_RULES[rule.id];
      if (!pattern) continue;
      const hit = pattern.test(preprocessForRegex(rule.id, ch.addedCode)) ? 1 : 0;
      scores[rule.id] = Math.max(scores[rule.id] ?? 0, hit);
    }
  }
  return { scores, latencyMs: performance.now() - started, inputTokens: 0, outputTokens: 0 };
}
