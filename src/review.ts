#!/usr/bin/env bun
// Stream private PR hook events as JSON Lines. Each line gets one independent receipt.
import { read } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { MAX_FILES, runChecks } from "./checks";
import { extractChanges } from "./extract";
import { clearRepoCache } from "./repoRules";
import { clearGateCache } from "./ruleGate";
import { isInsideRepo } from "./scope";

// Read the pipe without waiting for EOF, including on Bun 1.2.
async function* stdinChunks() {
  while (true) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytes = await new Promise<number>((resolve, reject) =>
      read(0, buffer, 0, buffer.length, null, (err, n) => (err ? reject(err) : resolve(n))),
    );
    if (bytes === 0) return;
    yield buffer.subarray(0, bytes);
  }
}
const input = createInterface({ input: Readable.from(stdinChunks()), crlfDelay: Infinity });
const tiers = new Set((process.env.JEV_LINT_TIERS ?? "high,medium").split(","));
const timeoutMs = Number(process.env.JEV_LINT_TIMEOUT_MS ?? 8000);
async function review(raw: string) {
  const event = JSON.parse(raw);
  if (!event || typeof event.tool_name !== "string" || !event.tool_input) throw new Error("invalid review");
  const cwd = event.cwd ?? process.cwd();
  const changes = extractChanges(event).filter((c) => process.env.JEV_LINT_SCOPE === "all" || isInsideRepo(c.filePath, cwd));
  clearRepoCache();
  clearGateCache();
  const results = [];
  const errors: string[] = [];
  const batchSize = 2 * MAX_FILES;
  for (let i = 0; i < changes.length; i += batchSize) {
    const settled = await runChecks(changes.slice(i, i + batchSize), { cwd, timeoutMs });
    for (const outcome of settled) {
      if (!outcome.ok) {
        errors.push(/timeout|deadline/i.test(outcome.error) ? "timeout" : "check_failed");
      } else if (outcome.value) {
        const { filePath, model, findings } = outcome.value;
        results.push({ filePath, model, findings: findings.filter((f) => tiers.has(f.tier)) });
      }
    }
  }
  return {
    metrics: {
      selectedFiles: changes.length,
      checkedFiles: results.length,
      failedFiles: errors.length,
      skippedFiles: changes.length - results.length - errors.length,
    },
    results,
    errors,
  };
}

for await (const raw of input) {
  const receipt = await review(raw).catch(() => ({ error: "invalid_or_failed_review" }));
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(`${JSON.stringify(receipt)}\n`, (err) => (err ? reject(err) : resolve())),
  );
}
