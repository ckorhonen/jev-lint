#!/usr/bin/env bun
// Generate docs/packs/<pack>.md from the rule files, their evidence (rules/sources/) and the
// labeled eval cases. Every example is a real case the eval scores: a flagged one (bad), a
// hard negative that looks similar but is fine (good), and the rule's own explanation (why).
//   bun scripts/pack-docs.ts
// Holdout numbers come from eval/results/pack-status.json when present.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { extractChanges } from "../src/extract";
import { BUILT_IN_PACKS, type BuiltInPack, RULE_FILES, type Rule } from "../src/lint";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "docs/packs");
const MAX_EXAMPLE_LINES = 24;

type Case = {
  id: string;
  split: string;
  scope?: string[];
  labels: string[];
  notes?: string;
  payload: { tool_name: string; tool_input: Record<string, unknown> };
};
type Status = Record<string, { precision: number; recall: number; positives: number }>;

const PACK_INTRO: Record<BuiltInPack, string> = {
  hygiene: "Small code-hygiene rules: the things a careful reviewer flags in any language.",
  practices:
    "Opinionated framework and language practices: React and Server Actions, SwiftUI and Swift concurrency, Kotlin coroutines and Compose, Rust async, Python async and ORMs, Rails, Bazel, and common security mistakes. Each one needs judgment about what the code means, so no linter can check it.",
  tests:
    "Test hygiene: tests that can't fail, flaky tests (real clocks, unseeded randomness, real network, fixed sleeps, order-dependent assertions, shared state), and tests bent to pass (titles that contradict their assertions, test-only branches in production code). Coding agents are prone to all of these, because a passing test looks like success.",
  performance:
    "Snippet-visible performance problems: queries or writes per item in a loop (N+1), sync I/O on request paths, unbounded queries, independent calls awaited one by one, and the opposite mistake, unbounded fan-out with no concurrency limit.",
};

function loadCases(): Case[] {
  const dir = join(ROOT, "eval/cases");
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) =>
      readFileSync(join(dir, n), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Case),
    );
}

function addedCode(c: Case): { file: string; code: string } | undefined {
  const [change] = extractChanges({ hook_event_name: "PostToolUse", ...c.payload });
  return change ? { file: basename(change.filePath), code: change.addedCode.trim() } : undefined;
}

// Prefer short, single-rule examples from the dev split (the holdout stays unseen by readers who tune).
function pick(cases: Case[], want: (c: Case) => boolean): { file: string; code: string } | undefined {
  const scored = cases
    .filter(want)
    .map((c) => ({ c, ex: addedCode(c) }))
    .filter((x) => x.ex && x.ex.code.split("\n").length <= MAX_EXAMPLE_LINES)
    .sort(
      (a, b) =>
        (a.c.split === "dev" ? 0 : 1) - (b.c.split === "dev" ? 0 : 1) ||
        tooShort(a.ex?.code) - tooShort(b.ex?.code) ||
        (a.ex?.code.length ?? 0) - (b.ex?.code.length ?? 0),
    );
  return scored[0]?.ex;
}

const MIN_EXAMPLE_LINES = 3;
const tooShort = (code = "") => (code.split("\n").length < MIN_EXAMPLE_LINES ? 1 : 0);

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;
const FENCE_LANG: Record<string, string> = {
  typescript: "ts",
  swift: "swift",
  python: "python",
  kotlin: "kotlin",
  rust: "rust",
  ruby: "ruby",
  bazel: "starlark",
};

type Meta = { evidence?: { grade?: string; url?: string; source?: string }[]; aiRelevance?: string; whyNotLinter?: string };

function meta(language: string, pack: string, id: string): Meta | undefined {
  const path = join(ROOT, "rules/sources", `${language}.${pack}.json`);
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, "utf8")) as Record<string, Meta>)[id];
}

function evidence(language: string, pack: string, id: string): string {
  const m = meta(language, pack, id);
  const links = (m?.evidence ?? [])
    .filter((e) => e.url && /^https?:/.test(e.url) && (e.grade === "A" || e.grade === "B"))
    .slice(0, 2)
    .map((e) => `[${new URL(e.url as string).hostname}](${e.url})`);
  return links.length ? `Sources: ${links.join(", ")}` : "";
}

function main() {
  const cases = loadCases();
  const status: Status = existsSync(join(ROOT, "eval/results/pack-status.json"))
    ? JSON.parse(readFileSync(join(ROOT, "eval/results/pack-status.json"), "utf8"))
    : {};
  mkdirSync(OUT, { recursive: true });
  const index: string[] = [];
  for (const pack of BUILT_IN_PACKS) {
    const sets = RULE_FILES[pack];
    const lines = [`# ${pack[0].toUpperCase()}${pack.slice(1)} pack`, "", PACK_INTRO[pack], ""];
    lines.push(
      "Each rule shows code the check flags (**bad**), similar code it leaves alone (**good**), and why. The examples are real cases from the eval set. _Candidate_ rules are still being evaluated and are not asked by the hook yet.",
      "",
    );
    let count = 0;
    for (const set of [...sets].sort((a, b) => a.language.localeCompare(b.language))) {
      if (!set.rules.length) continue;
      lines.push(`## ${set.language[0].toUpperCase()}${set.language.slice(1)}`, "");
      for (const r of set.rules as Rule[]) {
        count++;
        const inScope = (c: Case) => !c.scope || c.scope.includes(r.id);
        const bad = pick(cases, (c) => inScope(c) && c.labels.length === 1 && c.labels[0] === r.id);
        const good = pick(cases, (c) => inScope(c) && !c.labels.includes(r.id) && (c.notes ?? "").includes(r.id));
        const s = status[r.id];
        const badge = r.status === "candidate" ? " _(candidate)_" : "";
        lines.push(`### \`${r.id}\`${badge}`, "", r.question.replaceAll("`added_code`", "the new code"), "");
        // Research notes carry a relevance level and evidence grades ("High: … (C)"); readers need neither.
        const why = meta(set.language, pack, r.id)
          ?.aiRelevance?.replace(/\s*\((?:grade\s*)?[A-D](?:[-/][A-D])?\)|\s*\(inferred\)/gi, "")
          .replace(/^(?:(?:very\s+)?(?:high|medium|low)(?:\s*[-–/]\s*(?:high|medium|low))?\s*[:.–-]?\s*)+/i, "")
          .trim();
        lines.push(`**Catches:** ${r.true}`, "");
        if (why) lines.push(`**Why it matters:** ${why}`, "");
        lines.push(`**Fix:** ${r.fix}`, "");
        if (bad) lines.push(`**Bad** (\`${bad.file}\`):`, "", fence(FENCE_LANG[set.language] ?? "", bad.code), "");
        if (good)
          lines.push(`**Good** (\`${good.file}\`, looks similar but is fine):`, "", fence(FENCE_LANG[set.language] ?? "", good.code), "");
        lines.push(`**Not flagged:** ${r.false}`, "");
        const ev = evidence(set.language, pack, r.id);
        if (s)
          lines.push(
            `Holdout: precision ${Math.round(s.precision * 100)}%, recall ${Math.round(s.recall * 100)}% (${s.positives} violations in the holdout set).${ev ? ` ${ev}` : ""}`,
            "",
          );
        else if (ev) lines.push(ev, "");
      }
    }
    writeFileSync(join(OUT, `${pack}.md`), `${lines.join("\n").trimEnd()}\n`);
    index.push(`- [${pack}](${pack}.md): ${count} rules`);
  }
  writeFileSync(
    join(OUT, "README.md"),
    `# Built-in rule packs\n\nGenerated by \`bun scripts/pack-docs.ts\` from \`rules/\`, \`rules/sources/\` and \`eval/cases/\`.\n\n${index.join("\n")}\n`,
  );
  console.log(index.join("\n"));
}

main();
