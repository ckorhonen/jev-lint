import type { LintResult } from "./lint";

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
