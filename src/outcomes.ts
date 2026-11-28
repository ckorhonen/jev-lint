// One state per warning in a file and agent thread. A patch can introduce a warning,
// but only a successful whole-file recheck covering the rule can establish clearance.
import type { CheckRecord, Flagged } from "./findingsLog";

export type WarningState = {
  first: CheckRecord;
  hit: Flagged;
  outcome: "unknown" | "fixed" | "kept";
  evidence?: "scoped-recheck" | "legacy-recheck";
  checkedAt?: string;
  pending: boolean;
};

export function trackedFiles(records: CheckRecord[]) {
  const files = new Map<string, { latestEdit: CheckRecord; warnings: Map<string, WarningState> }>();
  for (const row of [...records].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (row.error) continue;
    const key = JSON.stringify([row.session, row.agent, row.repo, row.file]);
    let file = files.get(key);
    if (row.tool !== "recheck" && row.changeKind !== "recheck") {
      if (!file) {
        file = { latestEdit: row, warnings: new Map() };
        files.set(key, file);
      }
      file.latestEdit = row;
      for (const w of file.warnings.values()) {
        if (w.outcome === "kept") w.pending = true;
      }
      for (const hit of row.flagged) {
        const old = file.warnings.get(hit.rule);
        file.warnings.set(hit.rule, { first: old?.first ?? row, hit: old?.hit ?? hit, outcome: "unknown", pending: true });
      }
      continue;
    }

    if (!file || !row.session || (row.recheckOf && row.recheckOf !== file.latestEdit.ts)) continue;
    const flags = new Set(row.flagged.map((hit) => hit.rule));
    // Older stop hooks targeted only the last edit's flagged rules. Infer absence
    // only if the recorded number evaluated agrees with the entire original scope.
    const original = file.latestEdit.flagged.map((hit) => hit.rule);
    const complete =
      row.asked !== undefined &&
      row.gatedOut !== undefined &&
      row.asked + row.gatedOut === original.length &&
      [...flags].every((rule) => original.includes(rule));
    const scope = row.checkedRules ?? (complete ? original : [...flags]);
    for (const rule of scope) {
      const warning = file.warnings.get(rule);
      if (!warning) continue;
      warning.outcome = flags.has(rule) ? "kept" : "fixed";
      warning.evidence = row.checkedRules ? "scoped-recheck" : "legacy-recheck";
      warning.checkedAt = row.ts;
      warning.pending = false;
    }
  }
  return [...files.values()];
}
