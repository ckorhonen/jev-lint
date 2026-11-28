import type { Rule } from "./lint";
import { firstGateMatch } from "./ruleGate";

export type WarningEvidence = { reason: string; detail?: string; snippetLine?: number };

// Only describe simple signatures or calls whose positional flags are visible together.
// A gate hit anywhere in the edit is too weak to identify the expression the model judged.
function booleanExample(code: string): Omit<WarningEvidence, "reason"> {
  const lines = code.split("\n");
  for (const [i, line] of lines.entries()) {
    const signature = /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(([^(){}"'\x60/]+)\)/.exec(line);
    if (signature) {
      const names = signature[2].split(",").flatMap((param) => {
        const name = /^\s*([\w$]+)\??\s*(?::\s*boolean(?:\s*=\s*(?:true|false))?|=\s*(?:true|false))\s*$/.exec(param);
        return name ? [name[1]] : [];
      });
      if (names.length >= 2) return { snippetLine: i + 1, detail: `${signature[1]} declares positional flags ${names.join(", ")}.` };
    }
    const call = /^\s*(?:return\s+)?(?:await\s+)?([\w$.]+)\s*\(([\w$.,\s]*)\)\s*;?\s*$/.exec(line);
    if (call) {
      const positions = call[2].split(",").flatMap((arg, index) => (/^(?:true|false)$/.test(arg.trim()) ? [index + 1] : []));
      if (positions.length >= 2)
        return { snippetLine: i + 1, detail: `${call[1]} passes boolean literals at positions ${positions.join(", ")}.` };
    }
  }
  return { detail: "Model judgment only. Check that multiple flags belong to the same call or signature before editing." };
}

export function warningEvidence(rule: Rule, code: string): WarningEvidence {
  if (rule.id === "ts-boolean-trap") return { reason: rule.true, ...booleanExample(code) };
  const at = firstGateMatch(rule.when, code);
  return {
    reason: rule.true,
    ...(at === undefined
      ? {}
      : { snippetLine: code.slice(0, at).split("\n").length, detail: "First matching rule trigger in the checked text." }),
  };
}
