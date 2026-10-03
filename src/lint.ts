import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChangedFile } from "./extract";
import { askNouls, type JudgeProvider, type NoulQuestion } from "./jev";
import { findRepoConfig } from "./repoRules";

// `when`: optional regex sources (case-insensitive). The rule is only asked when one of
// them matches the added code — a cheap, recall-safe gate that cuts model calls.
// `paths`: optional globs relative to the repo root (the directory holding .jev-lint/). The rule
// is only asked for files matching one of them, e.g. ["src/routes/**", "**/*.tsx"].
// `status: "candidate"`: a built-in rule still being evaluated. The hook skips it; the eval
// harness (JEV_LINT_CANDIDATES=on) includes it. Rules ship by dropping the status after they
// pass on the holdout split.
export type Rule = {
  id: string;
  question: string;
  true: string;
  false: string;
  fix: string;
  when?: string[];
  paths?: string[];
  // Glob patterns (matched against the file's full path) where the rule is never asked,
  // e.g. test files for a rule that only makes sense in production code.
  excludePaths?: string[];
  // Per-rule confidence cutoffs, overriding the global THRESHOLDS. `medium: null` turns off
  // the "double-check" tier for this rule, so only high-confidence findings are shown.
  thresholds?: RuleThresholds;
  status?: "candidate";
};
export type RuleThresholds = { high?: number; medium?: number | null };
// `filenames`: exact file names that belong to the set when the extension alone can't say
// (Bazel's BUILD, BUILD.bazel, WORKSPACE, MODULE.bazel).
export type RuleSet = { language: string; extensions: string[]; filenames?: string[]; rules: Rule[] };
export type Tier = "high" | "medium";
export type Finding = { ruleId: string; probability: number; tier: Tier; fix: string };

// Built-in packs live in rules/<language>.json ("hygiene") and rules/<language>.<pack>.json.
// "hygiene": small code-hygiene rules. "practices": opinionated framework and language best
// practices. "security": security mistakes visible in the added code. "tests": test hygiene (tests that can't fail, and other test smells).
// "performance": snippet-visible performance problems. "repo": rules from the nearest
// `.jev-lint/` directory (see repoRules.ts). One Jev call covers all packs.
export const BUILT_IN_PACKS = ["hygiene", "practices", "security", "tests", "performance"] as const;
export type BuiltInPack = (typeof BUILT_IN_PACKS)[number];
export type Pack = BuiltInPack | "repo";

const RULES_DIR = join(import.meta.dir, "../rules");

function loadBuiltIns(): Record<BuiltInPack, RuleSet[]> {
  const packs = Object.fromEntries(BUILT_IN_PACKS.map((p) => [p, [] as RuleSet[]])) as Record<BuiltInPack, RuleSet[]>;
  for (const name of readdirSync(RULES_DIR)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const parts = name.slice(0, -".json".length).split(".");
    const pack = (parts.length === 1 ? "hygiene" : parts[1]) as BuiltInPack;
    if (!packs[pack]) continue;
    const set = JSON.parse(readFileSync(join(RULES_DIR, name), "utf8")) as RuleSet;
    packs[pack].push(set);
  }
  return packs;
}
export const RULE_FILES: Record<BuiltInPack, RuleSet[]> = loadBuiltIns();
export const LANGUAGES = [...new Set(Object.values(RULE_FILES).flatMap((sets) => sets.map((s) => s.language)))];

export const DEFAULT_PACKS = (process.env.JEV_LINT_PACKS ?? "hygiene,practices,security,tests,performance,repo").split(",") as Pack[];

function mergeRuleSets(sets: RuleSet[]): RuleSet | undefined {
  if (!sets.length) return undefined;
  return { language: sets[0].language, extensions: sets[0].extensions, filenames: sets[0].filenames, rules: sets.flatMap((s) => s.rules) };
}

const builtIn = (pack: Pack) => (pack === "repo" ? [] : (RULE_FILES[pack] ?? []));

export function ruleSetMatches(set: RuleSet, filePath: string): boolean {
  return set.extensions.includes(extname(filePath).toLowerCase()) || Boolean(set.filenames?.includes(basename(filePath)));
}

// Built-in packs only: used by the eval harness, which works per language.
export function ruleSetForLanguage(language: string, packs: Pack[] = DEFAULT_PACKS): RuleSet | undefined {
  const merged = mergeRuleSets(packs.flatMap((pack) => builtIn(pack).filter((s) => s.language === language)));
  if (merged && process.env.JEV_LINT_CANDIDATES !== "on") merged.rules = merged.rules.filter((r) => r.status !== "candidate");
  return merged?.rules.length ? merged : undefined;
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
  const wantsRepo = !packs || packs.includes("repo");
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const repo = wantsRepo ? findRepoConfig(absolute) : undefined;
  const chosen = packs ?? ((repo?.packs as Pack[] | undefined) || DEFAULT_PACKS);
  const sets = chosen
    .flatMap((pack) => (pack === "repo" ? (repo?.ruleSets ?? []) : builtIn(pack)))
    .filter((s) => ruleSetMatches(s, filePath));
  // Later packs can't redefine an id already asked; repo rules should use their own prefix.
  const seen = new Set<string>();
  const merged = mergeRuleSets(sets);
  const relPath = repo ? relative(dirname(repo.dir), absolute) : filePath;
  const excluded = (r: Rule) => r.excludePaths?.some((glob) => matchesGlob(glob, absolute)) ?? false;
  const off = (r: Rule) =>
    excluded(r) ||
    repo?.disable?.includes(r.id) ||
    repo?.skipPaths?.[r.id]?.some((glob) => matchesGlob(glob, relPath)) ||
    !rulePathsMatch(r, relPath);
  const candidates = process.env.JEV_LINT_CANDIDATES === "on";
  if (merged)
    merged.rules = merged.rules
      .filter((r) => (candidates || r.status !== "candidate") && !off(r) && !seen.has(r.id) && seen.add(r.id))
      // A repo's config.json can tune any rule's cutoffs (built-in or its own).
      .map((r) => (repo?.thresholds?.[r.id] ? { ...r, thresholds: { ...r.thresholds, ...repo.thresholds[r.id] } } : r));
  return merged?.rules.length ? merged : undefined;
}

// Glob match with Bun.Glob; an invalid glob never matches rather than breaking the hook.
export function matchesGlob(glob: string, path: string): boolean {
  try {
    return new Bun.Glob(glob).match(path);
  } catch {
    return false;
  }
}

export function rulePathsMatch(rule: Rule, relPath: string): boolean {
  return !rule.paths?.length || rule.paths.some((glob) => matchesGlob(glob, relPath));
}

// Keyed by the patterns themselves, not the rule id: two repos can reuse an id with
// different gates, and an edited `when` must take effect in the long-lived daemon.
const gateCache = new Map<string, RegExp[]>();

export function clearGateCache() {
  gateCache.clear();
}

export function ruleApplies(rule: Rule, code: string): boolean {
  if (!rule.when?.length) return true;
  const key = rule.when.join("\0");
  let patterns = gateCache.get(key);
  if (!patterns) {
    patterns = rule.when.flatMap((source) => {
      try {
        return [new RegExp(source, "im")];
      } catch {
        return []; // a broken pattern must not hide the rule; see below
      }
    });
    gateCache.set(key, patterns);
  }
  return patterns.length === 0 || patterns.some((re) => re.test(code));
}

export function gateRules(ruleSet: RuleSet, code: string): RuleSet {
  return { ...ruleSet, rules: ruleSet.rules.filter((r) => ruleApplies(r, code)) };
}

export function buildQuestions(ruleSet: RuleSet): Record<string, NoulQuestion> {
  return Object.fromEntries(
    ruleSet.rules.map((rule) => [rule.id, { type: "noul", instructions: rule.question, criteria: { true: rule.true, false: rule.false } }]),
  );
}

export function tierFor(probability: number, thresholds = THRESHOLDS, rule?: RuleThresholds): Tier | undefined {
  const high = rule?.high ?? thresholds.high;
  const medium = rule?.medium === null ? undefined : (rule?.medium ?? thresholds.medium);
  if (probability >= high) return "high";
  if (medium !== undefined && probability >= medium) return "medium";
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
  asked: number; // rules sent to the model after gating
  gatedOut: number; // rules skipped by their `when` patterns
};

export async function lintChange(
  change: ChangedFile,
  opts: {
    timeoutMs?: number;
    retries?: number;
    thresholds?: typeof THRESHOLDS;
    packs?: Pack[];
    cwd?: string;
    baseUrl?: string;
    provider?: JudgeProvider;
    model?: string;
    gate?: boolean;
    onlyRules?: string[]; // ask just these rules (the end-of-session re-check)
  } = {},
): Promise<LintResult | undefined> {
  const full = ruleSetFor(change.filePath, opts.packs, opts.cwd);
  const ruleSet = full && opts.onlyRules ? { ...full, rules: full.rules.filter((r) => opts.onlyRules?.includes(r.id)) } : full;
  if (ruleSet && !ruleSet.rules.length) return undefined;
  if (!ruleSet || !change.addedCode.trim() || change.addedCode.length > MAX_ADDED_CHARS) return undefined;

  const gate = opts.gate ?? process.env.JEV_LINT_GATE !== "off";
  const asked = gate ? gateRules(ruleSet, change.addedCode) : ruleSet;
  const state = { language: ruleSet.language, file_path: change.filePath, added_code: change.addedCode };
  const started = performance.now();
  const response = asked.rules.length
    ? await askNouls(state, buildQuestions(asked), opts)
    : { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, model: "gated" };
  const latencyMs = performance.now() - started;

  const probabilities: Record<string, number> = {};
  const findings: Finding[] = [];
  for (const rule of ruleSet.rules) {
    const probability = (response.answers as Record<string, { noul: number }>)[rule.id]?.noul ?? 0;
    probabilities[rule.id] = probability;
    const tier = tierFor(probability, opts.thresholds, rule.thresholds);
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
    asked: asked.rules.length,
    gatedOut: ruleSet.rules.length - asked.rules.length,
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
