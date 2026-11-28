import type { Rule } from "./lint";

// Keyed by the patterns themselves, not the rule id: two repos can reuse an id with
// different gates, and an edited `when` must take effect in the long-lived daemon.
const gateCache = new Map<string, RegExp[]>();

export function clearGateCache() {
  gateCache.clear();
}

function gatePatterns(when: string[]): RegExp[] {
  const key = when.join("\0");
  let patterns = gateCache.get(key);
  if (!patterns) {
    patterns = when.flatMap((source) => {
      try {
        return [new RegExp(source, "im")];
      } catch {
        return []; // a broken pattern must not hide the rule; see ruleApplies
      }
    });
    gateCache.set(key, patterns);
  }
  return patterns;
}

export function ruleApplies(rule: Rule, code: string): boolean {
  if (!rule.when?.length) return true;
  const patterns = gatePatterns(rule.when);
  return patterns.length === 0 || patterns.some((re) => re.test(code));
}

// Character offset of the earliest match of any `when` pattern, or undefined when there is
// none (no patterns, all broken, or the gate was off and nothing matched).
export function firstGateMatch(when: string[] | undefined, code: string): number | undefined {
  if (!when?.length) return undefined;
  let first: number | undefined;
  for (const re of gatePatterns(when)) {
    const m = re.exec(code);
    if (m && (first === undefined || m.index < first)) first = m.index;
  }
  return first;
}
