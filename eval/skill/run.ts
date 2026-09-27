// Does the jev-lint-rules skill onboard a real repo well? Runs the skill headless (dry run,
// stopping at the proposal) on pinned copies of real repos and scores the proposal against
// hand-checked gold annotations.
//   bun eval/skill/run.ts [--cases a,b] [--reps 2] [--agent claude|codex] [--tag name] [--grade-only]
//
// Fixtures are PRIVATE and live outside this repo (default ~/.local/share/jev-lint/skill-evals,
// override with JEV_LINT_SKILL_EVALS): cases/<name>.json, and runs/ + results/ written here.
// Only aggregate, anonymized numbers (repo-a, repo-b…) belong in the public notebook.
//
// Case file:
//   { "name": "repo-a", "repo": "/abs/path", "commit": "<sha>", "languages": ["typescript"],
//     "mustRead": ["docs/review.md", ...],                        // guidance a careful engineer reads
//     "conventions": [{ "id": "c1", "text": "...", "source": "docs/review.md:32", "jevCheckable": true }],
//     "covered": [{ "id": "d1", "text": "no explicit any", "by": "biome noExplicitAny (error, CI)" }] }
//
// Scores per run:
//   readRecall        share of mustRead files the agent actually opened (from the transcript)
//   conventionRecall  share of jevCheckable conventions a proposed rule addresses (Luna mapping)
//   dupes             proposed rules that duplicate a deterministic check (Luna mapping to `covered`)
//   ungrounded        proposed rules that map to no convention and no best practice for the stack
//   citationsValid    share of cited file:line sources that exist at the pinned commit
//   wellFormed        share of rules with "Does `added_code`" questions, true/false/fix, valid `when`
//   withinBudget      at most 12 rules per language
//   wroteNothing      the repo copy is unchanged (the dry run must not write)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const JEV = join(import.meta.dir, "../..");
const ROOT = process.env.JEV_LINT_SKILL_EVALS ?? join(homedir(), ".local/share/jev-lint/skill-evals");
const JUDGE_MODEL = process.env.GRADER_MODEL ?? "gpt-6-luna";
const JUDGE_EFFORT = process.env.GRADER_EFFORT ?? "low";
const BUDGET_PER_LANGUAGE = 12;
const RUN_TIMEOUT_MS = 30 * 60_000;
const JUDGE_TIMEOUT_MS = 180_000;
const RETRY_BASE_MS = 2000;

const { values: args } = parseArgs({
  options: {
    cases: { type: "string" },
    reps: { type: "string", default: "1" },
    agent: { type: "string", default: "claude" },
    model: { type: "string", default: "sonnet" },
    tag: { type: "string", default: "default" },
    "grade-only": { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
  },
});

type Convention = { id: string; text: string; source: string; jevCheckable: boolean };
type Covered = { id: string; text: string; by: string };
type Case = {
  name: string;
  repo: string;
  commit: string;
  languages: string[];
  mustRead: string[];
  conventions: Convention[];
  covered: Covered[];
};
type ProposedRule = {
  id: string;
  language: string;
  question: string;
  true: string;
  false: string;
  fix: string;
  when?: string[];
  paths?: string[];
  source: string;
};
type Proposal = {
  read: string[];
  rules: ProposedRule[];
  configChanges: string[];
  dropped: { idea: string; reason: string }[];
  research: { framework: string; version?: string; urls: string[] }[];
};

const PROPOSAL_SCHEMA = `{
  "read": ["repo-relative paths you read in full"],
  "rules": [{ "id": "repo-…", "language": "typescript", "question": "Does \`added_code\` …", "true": "…", "false": "…", "fix": "…",
              "when": ["regex"], "paths": ["optional globs"], "source": "file:line (or best-practices/<lang>.md#id)" }],
  "configChanges": ["linter/CI changes proposed instead of rules"],
  "research": [{ "framework": "react", "version": "19.1", "urls": ["https://… (checked YYYY-MM-DD)"] }],
  "dropped": [{ "idea": "…", "reason": "…" }]
}`;

function prompt(outDir: string) {
  return [
    `Onboard this repository to jev-lint by following the skill at ${JEV}/.agents/skills/jev-lint-rules/SKILL.md (JEV=${JEV}) and the references it links.`,
    "This is a DRY RUN for an evaluation: do steps 1–5 only and stop at the proposal. Assume the user is not available; do not ask questions.",
    "Do not create, edit or delete any file in this repository, and do not run validate.ts. Probes that need files go in a scratch directory outside the repo.",
    `Write the proposal exactly as you would show it to the user to ${outDir}/proposal.md, and the same content as JSON to ${outDir}/proposal.json with this shape:\n${PROPOSAL_SCHEMA}`,
  ].join("\n\n");
}

function checkout(c: Case, dir: string) {
  rmSync(dir, { recursive: true, force: true });
  const clone = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", c.repo, dir], { encoding: "utf8" });
  if (clone.status !== 0) throw new Error(`clone ${c.name}: ${clone.stderr}`);
  const co = spawnSync("git", ["-C", dir, "checkout", "--quiet", c.commit], { encoding: "utf8" });
  if (co.status !== 0) throw new Error(`checkout ${c.name}@${c.commit}: ${co.stderr}`);
}

function runAgent(workDir: string, outDir: string) {
  const text = prompt(outDir);
  const [cmd, cliArgs, env] =
    args.agent === "codex"
      ? [
          process.env.CODEX_BIN ?? "/opt/homebrew/bin/codex",
          ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", text],
          process.env,
        ]
      : [
          "claude",
          [
            "-p",
            text,
            "--model",
            args.model as string,
            "--setting-sources",
            "project",
            "--strict-mcp-config",
            "--permission-mode",
            "bypassPermissions",
            "--add-dir",
            JEV,
            outDir,
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-budget-usd",
            "8",
            "--no-session-persistence",
          ],
          process.env,
        ];
  const started = Date.now();
  return new Promise<{ exitCode: number; wallMs: number }>((resolve) => {
    const child = spawn(cmd, cliArgs as string[], { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const killer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(killer);
      writeFileSync(join(outDir, "transcript.jsonl"), Buffer.concat(out));
      writeFileSync(join(outDir, "stderr.txt"), Buffer.concat(err));
      resolve({ exitCode: code ?? -1, wallMs: Date.now() - started });
    });
  });
}

// Files the agent opened: Read tool calls, plus paths named in shell commands (cat, sed, head…).
export function filesOpened(transcript: string, workDir: string, mustRead: string[]): Set<string> {
  const opened = new Set<string>();
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let text = line;
    try {
      text = JSON.stringify(JSON.parse(line));
    } catch {
      continue;
    }
    for (const path of mustRead) {
      if (text.includes(join(workDir, path)) || new RegExp(`(^|[\\s'"/])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text))
        opened.add(path);
    }
  }
  return opened;
}

function transcriptStats(transcript: string) {
  let costUsd = 0;
  for (const line of transcript.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; total_cost_usd?: number };
      if (event.type === "result") costUsd = event.total_cost_usd ?? 0;
    } catch {
      // not JSON (codex prints some plain lines)
    }
  }
  return { costUsd };
}

// Sources look like "AGENTS.md:17; src/a.ts:109,134 (adapted from best-practices/generic.md …)".
// Valid when every cited file exists at the pinned commit and every line number is in range.
export function citationValid(source: string, workDir: string): boolean {
  const parts = source
    .replace(/\([^)]*\)/g, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  return parts.every((part) => {
    if (part.includes("best-practices/") || /^https?:\/\//.test(part)) return true; // menus and web sources aren't files
    const m = /^([^\s:]+)(?::([\d,\s–-]+))?$/.exec(part);
    if (!m) return false;
    const file = join(workDir, m[1]);
    if (!existsSync(file)) return false;
    const lines = readFileSync(file, "utf8").split("\n").length;
    const numbers = (m[2] ?? "")
      .split(/[^\d]+/)
      .filter(Boolean)
      .map(Number);
    return numbers.every((n) => n >= 1 && n <= lines);
  });
}

function wellFormed(r: ProposedRule): boolean {
  const gatesOk = (r.when ?? []).every((w) => {
    try {
      new RegExp(w, "i");
      return true;
    } catch {
      return false;
    }
  });
  return /^Does `added_code`/.test(r.question) && Boolean(r.true && r.false && r.fix) && gatesOk;
}

// The agent writes proposal.json; check the shape before trusting it.
export function parseProposal(text: string): Proposal | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const p = value as Partial<Proposal>;
  if (!p || !Array.isArray(p.rules) || !Array.isArray(p.read)) return undefined;
  const rules = p.rules.filter((r): r is ProposedRule => Boolean(r && typeof r.id === "string" && typeof r.question === "string"));
  return {
    read: p.read.filter((x): x is string => typeof x === "string"),
    rules: rules.map((r) => ({ ...r, language: r.language ?? "unknown", source: r.source ?? "" })),
    configChanges: Array.isArray(p.configChanges) ? p.configChanges : [],
    dropped: Array.isArray(p.dropped) ? p.dropped : [],
    research: Array.isArray(p.research) ? p.research : [],
  };
}

async function judge(c: Case, proposal: Proposal) {
  const rules = proposal.rules.map((r) => `- ${r.id} (${r.language}): ${r.question}\n  true: ${r.true}\n  false: ${r.false}`).join("\n");
  const conventions = c.conventions.map((x) => `- ${x.id}: ${x.text}`).join("\n");
  const covered = c.covered.map((x) => `- ${x.id}: ${x.text} (enforced by ${x.by})`).join("\n");
  const content = [
    "You are grading a proposal of lint rules for a repository against a reference annotation.",
    `Team conventions (reference):\n${conventions || "(none)"}`,
    `Already enforced by deterministic tools (reference):\n${covered || "(none)"}`,
    `Proposed rules:\n${rules || "(none)"}`,
    'For each proposed rule, give: `convention` = the id of the team convention it mainly enforces, or "none"; `duplicates` = the id of an already-enforced check it duplicates (same pattern, not merely the same topic), or "none"; `grounded` = true if it enforces a team convention or a widely accepted best practice for this stack that fits this repo, false if it is generic filler or contradicts the repo.',
  ].join("\n\n");
  const schema = {
    type: "object",
    properties: {
      rules: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            convention: { type: "string" },
            duplicates: { type: "string" },
            grounded: { type: "boolean" },
          },
          required: ["id", "convention", "duplicates", "grounded"],
          additionalProperties: false,
        },
      },
    },
    required: ["rules"],
    additionalProperties: false,
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        reasoning_effort: JUDGE_EFFORT,
        messages: [{ role: "user", content }],
        response_format: { type: "json_schema", json_schema: { name: "mapping", strict: true, schema } },
      }),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    if (res.ok) {
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      return (
        JSON.parse(json.choices[0].message.content) as {
          rules: { id: string; convention: string; duplicates: string; grounded: boolean }[];
        }
      ).rules;
    }
    if (attempt >= 4 || (res.status !== 429 && res.status < 500))
      throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await Bun.sleep(RETRY_BASE_MS * 2 ** attempt);
  }
}

async function score(c: Case, runDir: string, workDir: string) {
  const transcript = existsSync(join(runDir, "transcript.jsonl")) ? readFileSync(join(runDir, "transcript.jsonl"), "utf8") : "";
  const proposalPath = join(runDir, "proposal.json");
  if (!existsSync(proposalPath)) return { case: c.name, run: runDir, error: "no proposal.json" };
  const proposal = parseProposal(readFileSync(proposalPath, "utf8"));
  if (!proposal) return { case: c.name, run: runDir, error: "proposal.json does not match the requested shape" };
  const opened = filesOpened(transcript, workDir, c.mustRead);
  const mapping = await judge(c, proposal);
  const checkable = c.conventions.filter((x) => x.jevCheckable);
  const addressed = new Set(mapping.map((m) => m.convention));
  const perLanguage = new Map<string, number>();
  for (const r of proposal.rules) perLanguage.set(r.language, (perLanguage.get(r.language) ?? 0) + 1);
  const status = spawnSync("git", ["-C", workDir, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim();
  const share = (n: number, d: number) => (d ? n / d : null);
  return {
    case: c.name,
    run: runDir,
    rules: proposal.rules.length,
    readRecall: share(opened.size, c.mustRead.length),
    unread: c.mustRead.filter((p) => !opened.has(p)),
    conventionRecall: share(checkable.filter((x) => addressed.has(x.id)).length, checkable.length),
    // The budget caps how many conventions one proposal can reach, so also score against that ceiling.
    recallAtBudget: share(checkable.filter((x) => addressed.has(x.id)).length, Math.min(checkable.length, BUDGET_PER_LANGUAGE)),
    missedConventions: checkable.filter((x) => !addressed.has(x.id)).map((x) => x.id),
    dupes: mapping.filter((m) => m.duplicates !== "none").map((m) => `${m.id}→${m.duplicates}`),
    ungrounded: mapping.filter((m) => !m.grounded).map((m) => m.id),
    citationsValid: share(proposal.rules.filter((r) => citationValid(r.source, workDir)).length, proposal.rules.length),
    wellFormed: share(proposal.rules.filter(wellFormed).length, proposal.rules.length),
    withinBudget: [...perLanguage.values()].every((n) => n <= BUDGET_PER_LANGUAGE),
    wroteNothing: status === "",
    // Web research: frameworks researched, and rules whose evidence is an external URL.
    researched: proposal.research.filter((r) => r.urls?.some((u) => /^https?:\/\//.test(u))).length,
    urlRules: proposal.rules.filter((r) => /https?:\/\//.test(r.source)).length,
    testValidity: proposal.rules.some((r) => /test-cannot-fail|test.*(can.?not|never) fail/i.test(`${r.id} ${r.question}`)),
    ...transcriptStats(transcript),
    mapping,
  };
}

async function main() {
  const caseDir = join(ROOT, "cases");
  if (!existsSync(caseDir)) throw new Error(`no cases in ${caseDir} (private fixtures live outside the repo)`);
  const wanted = args.cases?.split(",");
  const cases = readdirSync(caseDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(caseDir, f), "utf8")) as Case)
    .filter((c) => !wanted || wanted.includes(c.name));
  const jobs = cases.flatMap((c) => Array.from({ length: Number(args.reps) }, (_, i) => ({ c, rep: i + 1 })));
  const results: unknown[] = [];
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { c, rep } = job;
      const runDir = join(ROOT, "runs", args.tag as string, args.agent as string, `${c.name}-${rep}`);
      const workDir = join(runDir, "repo");
      try {
        if (!args["grade-only"]) {
          mkdirSync(runDir, { recursive: true });
          checkout(c, workDir);
          const { exitCode, wallMs } = await runAgent(workDir, runDir);
          writeFileSync(join(runDir, "run.json"), JSON.stringify({ exitCode, wallMs }));
          console.error(`${c.name} rep ${rep}: exit ${exitCode}, ${Math.round(wallMs / 1000)} s`);
        }
        const scored = await score(c, runDir, workDir);
        const run = existsSync(join(runDir, "run.json")) ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) : {};
        results.push({ ...scored, rep, ...run });
      } catch (error) {
        results.push({ case: c.name, rep, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  mkdirSync(join(ROOT, "results"), { recursive: true });
  const out = join(ROOT, "results", `${args.tag}-${args.agent}.json`);
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), judge: `${JUDGE_MODEL}/${JUDGE_EFFORT}`, results }, null, 2));
  const pct = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 100)}%`.padStart(5) : "    —");
  console.log("case        rep rules  read  conv @budg dupes ungr  cite  form budget clean  web  cost");
  for (const r of results as Record<string, unknown>[]) {
    if (r.error) {
      console.log(`${String(r.case).padEnd(12)}${String(r.rep).padStart(3)}  ${r.error}`);
      continue;
    }
    console.log(
      `${String(r.case).padEnd(12)}${String(r.rep).padStart(3)}${String(r.rules).padStart(6)}${pct(r.readRecall)} ${pct(r.conventionRecall)}${pct(r.recallAtBudget)}${String((r.dupes as string[]).length).padStart(6)}${String((r.ungrounded as string[]).length).padStart(5)} ${pct(r.citationsValid)} ${pct(r.wellFormed)}  ${r.withinBudget ? "yes" : "NO "}   ${r.wroteNothing ? "yes" : "NO "} ${String(r.researched ?? 0).padStart(3)}  $${Number(r.costUsd ?? 0).toFixed(2)}`,
    );
  }
  console.log(`\n${out}`);
}

if (import.meta.main) await main();
