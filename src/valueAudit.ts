#!/usr/bin/env bun
// Is it worth fixing? Grades every decided finding (outcome "fixed" or "kept") in the findings
// log with an LLM: would a competent reviewer have asked for this change?
//   bun src/valueAudit.ts [--log <path>] [--days 30] [--repo <path>] [--json] [--dry-run]
//
// Verdicts: bug | security | review-comment (a reviewer would have asked for the change),
// style (a matter of taste, not worth a review round-trip) | noise (the flag is wrong, or the
// excerpt doesn't support it). Outcomes come from findingsOf in findings.ts.
//
// The excerpt sent is whatever the log holds. Records from 2026-10-03 on carry the window
// around the rule's `when` match; older records only have the first 400 chars of the checked
// code, which for a whole-file write is the import block. The prompt says which one it is.
//
// Judge: gpt-6-luna at reasoning_effort low (AUDIT_MODEL / AUDIT_EFFORT override), the request
// shape of eval/systems.ts judgeLlm. Key: OPENAI_API_KEY (bun loads .env). Responses are cached
// by a hash of the prompt under eval/results/cache/value-audit/.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Finding, findingsOf, loadRecords } from "./findings";
import { findingsLogPath } from "./findingsLog";
import { RULE_FILES, type Rule } from "./lint";
import { findRepoConfig } from "./repoRules";

export const AUDIT_MODEL = process.env.AUDIT_MODEL ?? "gpt-6-luna";
export const AUDIT_EFFORT = process.env.AUDIT_EFFORT ?? "low";
const CACHE = join(import.meta.dir, "../eval/results/cache/value-audit");

export const VERDICTS = ["bug", "security", "review-comment", "style", "noise"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Grade = { verdict: Verdict; confidence: number; reason: string };
export type ExcerptKind = "flagged-lines" | "file-header" | "edit-start";
export type Graded = Finding & { excerptKind: ExcerptKind; grade: Grade; cached: boolean; inputTokens: number; outputTokens: number };

const REVIEW_WORTHY = new Set<Verdict>(["bug", "security", "review-comment"]);

export function excerptKind(f: Finding): ExcerptKind {
  if (f.line !== undefined) return "flagged-lines";
  return f.changeKind === "write" ? "file-header" : "edit-start";
}

// Built-in rules (candidates included: the log may predate a status change), then the repo's own.
export function ruleById(id: string, repo: string, file: string): Rule | undefined {
  for (const sets of Object.values(RULE_FILES))
    for (const set of sets) {
      const rule = set.rules.find((r) => r.id === id);
      if (rule) return rule;
    }
  return findRepoConfig(resolve(repo, file))
    ?.ruleSets.flatMap((s) => s.rules)
    .find((r) => r.id === id);
}

const EXCERPT_NOTE: Record<ExcerptKind, string> = {
  "flagged-lines": "The excerpt is the window around the first line matching the rule's trigger patterns (3 lines before, 6 after).",
  "file-header":
    "The excerpt is only the FIRST 400 CHARACTERS of the whole file (usually imports), not the flagged code. Do not treat the absence of the violation in it as evidence of noise; judge mainly from the rule, the file path and the outcome.",
  "edit-start":
    "The excerpt is the first 400 characters of the code this edit added; the flagged code may be further down. Judge from it, the rule, the file path and the outcome.",
};

export function auditPrompt(f: Finding, rule: Rule | undefined): string {
  const kind = excerptKind(f);
  const ruleText = rule
    ? `Question: ${rule.question}\nViolation when: ${rule.true}\nNot a violation when: ${rule.false}\nSuggested fix: ${rule.fix}`
    : "(rule text unavailable; judge from the rule id)";
  const outcome =
    f.outcome === "fixed"
      ? "fixed: the coding agent changed the code so a later check no longer flagged it"
      : "kept: the coding agent left the flagged code in place (disagreed with or ignored the hint)";
  return [
    "A fast lint model flagged code a coding agent wrote. Decide whether acting on this flag was worth it.",
    'Answer "bug" (the flagged pattern would cause incorrect behavior), "security" (a security weakness), or "review-comment" (a competent human reviewer would have asked for this change in code review) when a reviewer would have wanted the change.',
    'Answer "style" when it is a matter of taste that a reviewer would not block or comment on, and "noise" when the flag looks wrong for this code or nothing supports it.',
    "Give a confidence from 0 to 1 and a reason of at most 25 words.",
    `Rule ${f.rule}:\n${ruleText}`,
    `File: ${f.file} (${f.changeKind === "write" ? "whole-file write" : "edit"})\nOutcome: ${outcome}\nFlag probability: ${f.p}`,
    `${EXCERPT_NOTE[kind]}\n\`\`\`\n${f.excerpt || "(no excerpt stored)"}\n\`\`\``,
  ].join("\n\n");
}

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["verdict", "confidence", "reason"],
  additionalProperties: false,
};

export function isGrade(value: unknown): value is Grade {
  const g = value as Grade;
  return Boolean(g && VERDICTS.includes(g.verdict) && typeof g.confidence === "number" && typeof g.reason === "string");
}

type Graded1 = { grade: Grade; cached: boolean; inputTokens: number; outputTokens: number };
export type Grader = (prompt: string) => Promise<Graded1>;

// Same request shape as eval/systems.ts judgeLlm: chat completions, strict json_schema, retries
// on 429/5xx. The key only ever goes into the Authorization header.
export const gradeWithLlm: Grader = async (prompt) => {
  const key = createHash("sha256").update(`${AUDIT_MODEL}\n${AUDIT_EFFORT}\n${prompt}`).digest("hex").slice(0, 16);
  const cacheFile = join(CACHE, `${key}.json`);
  if (existsSync(cacheFile)) {
    try {
      const hit = JSON.parse(readFileSync(cacheFile, "utf8")) as Omit<Graded1, "cached">;
      if (isGrade(hit.grade))
        return { grade: hit.grade, inputTokens: hit.inputTokens ?? 0, outputTokens: hit.outputTokens ?? 0, cached: true };
    } catch {
      // a corrupt cache entry is re-asked, not fatal
    }
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set (environment or .env)");
  const body = {
    model: AUDIT_MODEL,
    reasoning_effort: AUDIT_EFFORT,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_schema", json_schema: { name: "value_audit", strict: true, schema: SCHEMA } },
  };
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
      const grade: unknown = JSON.parse(json.choices[0].message.content);
      if (!isGrade(grade)) throw new Error(`unexpected grade shape: ${json.choices[0].message.content.slice(0, 200)}`);
      const entry = { grade, inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(entry));
      return { ...entry, cached: false };
    }
    if (attempt >= 4 || (res.status !== 429 && res.status < 500))
      throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await Bun.sleep(1000 * 2 ** attempt);
  }
};

export function decided(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.outcome === "fixed" || f.outcome === "kept");
}

export async function audit(findings: Finding[], grade: Grader = gradeWithLlm, concurrency = 8): Promise<Graded[]> {
  const todo = decided(findings);
  const out: Graded[] = new Array(todo.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < todo.length; i = next++) {
      const f = todo[i];
      const g = await grade(auditPrompt(f, ruleById(f.rule, f.repo, f.file)));
      out[i] = { ...f, excerptKind: excerptKind(f), ...g };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return out;
}

export type Split = { n: number; worthy: number; style: number; noise: number; verdicts: Record<Verdict, number> };
export type RuleRow = { rule: string; all: Split; fixed: Split; kept: Split };

function split(gs: Graded[]): Split {
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const g of gs) verdicts[g.grade.verdict]++;
  return {
    n: gs.length,
    worthy: gs.filter((g) => REVIEW_WORTHY.has(g.grade.verdict)).length,
    style: verdicts.style,
    noise: verdicts.noise,
    verdicts,
  };
}

const row = (rule: string, gs: Graded[]): RuleRow => ({
  rule,
  all: split(gs),
  fixed: split(gs.filter((g) => g.outcome === "fixed")),
  kept: split(gs.filter((g) => g.outcome === "kept")),
});

export function tabulate(graded: Graded[]): { rules: RuleRow[]; total: RuleRow; byExcerpt: Record<ExcerptKind, RuleRow> } {
  const byRule = new Map<string, Graded[]>();
  for (const g of graded) byRule.set(g.rule, [...(byRule.get(g.rule) ?? []), g]);
  const kinds: ExcerptKind[] = ["flagged-lines", "file-header", "edit-start"];
  return {
    rules: [...byRule.entries()].map(([rule, gs]) => row(rule, gs)).sort((a, b) => b.all.n - a.all.n || a.rule.localeCompare(b.rule)),
    total: row("TOTAL", graded),
    byExcerpt: Object.fromEntries(
      kinds.map((k) => [
        k,
        row(
          k,
          graded.filter((g) => g.excerptKind === k),
        ),
      ]),
    ) as Record<ExcerptKind, RuleRow>,
  };
}

const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}%` : "-");
const cell = (s: Split) =>
  `${String(s.n).padStart(3)} ${pct(s.worthy, s.n).padStart(5)} ${pct(s.style, s.n).padStart(5)} ${pct(s.noise, s.n).padStart(5)}`;

export function formatTable(t: ReturnType<typeof tabulate>): string {
  const head = `${"rule".padEnd(34)}${"all: n  rev%  sty%  noi%".padStart(26)}${"fixed: n  rev%  sty%  noi%".padStart(28)}${"kept: n  rev%  sty%  noi%".padStart(27)}`;
  const line = (r: RuleRow) => `${r.rule.slice(0, 33).padEnd(34)}   ${cell(r.all)}     ${cell(r.fixed)}     ${cell(r.kept)}`;
  return [
    head,
    ...t.rules.map(line),
    line(t.total),
    "",
    "by excerpt kind:",
    ...Object.values(t.byExcerpt)
      .filter((r) => r.all.n)
      .map(line),
    "",
    "rev% = bug + security + review-comment (a reviewer would have asked for the change); sty% = style; noi% = noise.",
  ].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      log: { type: "string" },
      days: { type: "string", default: "30" },
      repo: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const path = values.log ?? findingsLogPath();
  if (!path) throw new Error("findings log is disabled (JEV_LINT_FINDINGS_LOG=off)");
  const findings = decided(findingsOf(loadRecords(path, { repo: values.repo, days: Number(values.days) })));
  if (values["dry-run"]) {
    const kinds: Record<string, number> = {};
    for (const f of findings) kinds[excerptKind(f)] = (kinds[excerptKind(f)] ?? 0) + 1;
    console.log(`${findings.length} decided findings in ${path} (last ${values.days} days); excerpts: ${JSON.stringify(kinds)}`);
  } else {
    const graded = await audit(findings);
    const t = tabulate(graded);
    const tokens = {
      input: graded.filter((g) => !g.cached).reduce((n, g) => n + g.inputTokens, 0),
      output: graded.filter((g) => !g.cached).reduce((n, g) => n + g.outputTokens, 0),
      cached: graded.filter((g) => g.cached).length,
    };
    if (values.json)
      console.log(
        JSON.stringify({ log: path, days: Number(values.days), model: AUDIT_MODEL, effort: AUDIT_EFFORT, tokens, ...t, graded }, null, 2),
      );
    else {
      console.log(
        `${graded.length} decided findings (fixed or kept) in ${path}${values.repo ? ` for ${resolve(values.repo)}` : ""} (last ${values.days} days), graded by ${AUDIT_MODEL} (${AUDIT_EFFORT})`,
      );
      const header = t.byExcerpt["file-header"].all.n;
      if (header)
        console.log(
          `${header} of ${graded.length} have only the file's first 400 chars as excerpt (whole-file writes logged before flagged lines were stored); their verdicts lean on the rule text and file path.`,
        );
      console.log(formatTable(t));
      console.log(`tokens this run: ${tokens.input} in, ${tokens.output} out; ${tokens.cached} answers from cache`);
    }
  }
}
