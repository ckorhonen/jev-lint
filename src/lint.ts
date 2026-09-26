import { extname, isAbsolute, resolve } from "node:path";
import swiftRules from "../rules/swift.json";
import swiftPractices from "../rules/swift.practices.json";
import typescriptRules from "../rules/typescript.json";
import typescriptPractices from "../rules/typescript.practices.json";
import type { ChangedFile } from "./extract";
import { askNouls, type NoulQuestion } from "./jev";
import { findRepoConfig } from "./repoRules";

export type Rule = { id: string; question: string; true: string; false: string; fix: string };
export type RuleSet = { language: string; extensions: string[]; rules: Rule[] };
export type Tier = "high" | "medium";
export type Finding = { ruleId: string; probability: number; tier: Tier; fix: string };

// "hygiene": small code-hygiene rules. "practices": opinionated React/SwiftUI/concurrency
// best practices that a deterministic linter cannot express. "repo": rules from the
// nearest `.jev-lint/` directory (see repoRules.ts). One Jev call covers all packs.
export type Pack = "hygiene" | "practices" | "repo";
export const RULE_FILES: Record<Exclude<Pack, "repo">, RuleSet[]> = {
  hygiene: [typescriptRules, swiftRules],
  practices: [typescriptPractices, swiftPractices],
};
export const DEFAULT_PACKS = (process.env.JEV_LINT_PACKS ?? "hygiene,practices,repo").split(",") as Pack[];

function mergeRuleSets(sets: RuleSet[]): RuleSet | undefined {
  if (!sets.length) return undefined;
  return { language: sets[0].language, extensions: sets[0].extensions, rules: sets.flatMap((s) => s.rules) };
}

const builtIn = (pack: Pack) => (pack === "repo" ? [] : RULE_FILES[pack]);

// Built-in packs only: used by the eval harness, which works per language.
export function ruleSetForLanguage(language: string, packs: Pack[] = DEFAULT_PACKS): RuleSet | undefined {
  return mergeRuleSets(packs.flatMap((pack) => builtIn(pack).filter((s) => s.language === language)));
}

// Defaults chosen on the dev split (see report/); override per environment.
export const THRESHOLDS = {
  high: Number(process.env.JEV_LINT_HIGH ?? 0.8),
  medium: Number(process.env.JEV_LINT_MEDIUM ?? 0.5),
};

// Jev's accuracy drops with long, irrelevant state; very large writes are skipped
// rather than truncated so a partial view never produces confident findings.
const MAX_ADDED_CHARS = 24_000;

// Rules for one file. A repo's `.jev-lint/config.json` "packs" list applies when the caller
// did not pick packs explicitly. Relative paths (Codex patches) resolve against `cwd`.
export function ruleSetFor(filePath: string, packs?: Pack[], cwd = process.cwd()): RuleSet | undefined {
  const ext = extname(filePath).toLowerCase();
  const wantsRepo = !packs || packs.includes("repo");
  const repo = wantsRepo ? findRepoConfig(isAbsolute(filePath) ? filePath : resolve(cwd, filePath)) : undefined;
  const chosen = packs ?? ((repo?.packs as Pack[] | undefined) || DEFAULT_PACKS);
  const sets = chosen
    .flatMap((pack) => (pack === "repo" ? (repo?.ruleSets ?? []) : builtIn(pack)))
    .filter((s) => s.extensions.includes(ext));
  // Later packs can't redefine an id already asked; repo rules should use their own prefix.
  const seen = new Set<string>();
  const merged = mergeRuleSets(sets);
  if (merged) merged.rules = merged.rules.filter((r) => !seen.has(r.id) && seen.add(r.id));
  return merged?.rules.length ? merged : undefined;
}

export function buildQuestions(ruleSet: RuleSet): Record<string, NoulQuestion> {
  return Object.fromEntries(
    ruleSet.rules.map((rule) => [rule.id, { type: "noul", instructions: rule.question, criteria: { true: rule.true, false: rule.false } }]),
  );
}

export function tierFor(probability: number, thresholds = THRESHOLDS): Tier | undefined {
  if (probability >= thresholds.high) return "high";
  if (probability >= thresholds.medium) return "medium";
  return undefined;
}

export type LintResult = {
  filePath: string;
  changeKind: ChangedFile["changeKind"];
  language: string;
  probabilities: Record<string, number>;
  findings: Finding[];
  latencyMs: number;
  inputTokens: number;
  model: string;
};

export async function lintChange(
  change: ChangedFile,
  opts: { timeoutMs?: number; retries?: number; thresholds?: typeof THRESHOLDS; packs?: Pack[]; cwd?: string } = {},
): Promise<LintResult | undefined> {
  const ruleSet = ruleSetFor(change.filePath, opts.packs, opts.cwd);
  if (!ruleSet || !change.addedCode.trim() || change.addedCode.length > MAX_ADDED_CHARS) return undefined;

  const state = { language: ruleSet.language, file_path: change.filePath, added_code: change.addedCode };
  const started = performance.now();
  const response = await askNouls(state, buildQuestions(ruleSet), opts);
  const latencyMs = performance.now() - started;

  const probabilities: Record<string, number> = {};
  const findings: Finding[] = [];
  for (const rule of ruleSet.rules) {
    const probability = response.answers[rule.id]?.noul ?? 0;
    probabilities[rule.id] = probability;
    const tier = tierFor(probability, opts.thresholds);
    if (tier) findings.push({ ruleId: rule.id, probability, tier, fix: rule.fix });
  }
  findings.sort((a, b) => b.probability - a.probability);

  return {
    filePath: change.filePath,
    changeKind: change.changeKind,
    language: ruleSet.language,
    probabilities,
    findings,
    latencyMs,
    inputTokens: response.usage.input_tokens,
    model: response.model,
  };
}

export function formatFeedback(results: LintResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const high = result.findings.filter((f) => f.tier === "high");
    const medium = result.findings.filter((f) => f.tier === "medium");
    if (!high.length && !medium.length) continue;

    const scope = result.changeKind === "write" ? "checked the whole file this Write produced" : "checked only the code this edit added";
    lines.push(`jev-lint: ${result.filePath} (${scope})`);
    if (high.length) {
      lines.push("Likely violations — fix these:");
      for (const f of high) lines.push(`  - ${f.ruleId} (p=${f.probability.toFixed(2)}): ${f.fix}`);
    }
    if (medium.length) {
      lines.push("Possible violations — double-check; ignore if the code is actually fine:");
      for (const f of medium) lines.push(`  - ${f.ruleId} (p=${f.probability.toFixed(2)}): ${f.fix}`);
    }
  }
  if (lines.length) {
    lines.push("These come from a fast heuristic model and can be wrong. Don't mention this check to the user; just fix real issues.");
  }
  return lines.join("\n");
}
