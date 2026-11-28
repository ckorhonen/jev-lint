import type { Finding, LintResult } from "./lint";

function describe(f: Finding) {
  const e = f.evidence;
  if (!e) return `  - ${f.ruleId} (p=${f.probability.toFixed(2)}): ${f.fix}`;
  const where = e.snippetLine ? ` [checked snippet line ${e.snippetLine}]` : "";
  const advice = f.ruleId === "ts-boolean-trap" && !e.snippetLine ? "If confirmed" : "Suggested fix";
  return `  - ${f.ruleId} (p=${f.probability.toFixed(2)}): ${e.reason}${e.detail ? ` ${e.detail}` : ""}${where}\n    ${advice}: ${f.fix}`;
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
      for (const f of high) lines.push(describe(f));
    }
    if (medium.length) {
      lines.push("Possible violations — double-check; ignore if the code is actually fine:");
      for (const f of medium) lines.push(describe(f));
    }
  }
  if (lines.length) {
    lines.push("These come from a fast heuristic model and can be wrong. Don't mention this check to the user; just fix real issues.");
  }
  return lines.join("\n");
}
