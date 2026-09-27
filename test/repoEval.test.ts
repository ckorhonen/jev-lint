import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock /v1/systemone: flags every rule asked, so the judge's counting is what's tested.
const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.95 }]));
    return Response.json({ model: "mock", answers, usage: { input_tokens: 1, output_tokens: 0 } });
  },
});
process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${mock.port}`;
process.env.JEV_LINT_FINDINGS_LOG = "off";
const { judge, snapshot } = await import("../src/repoEval");

describe("repoEval judge", () => {
  test("counts target-rule findings only in files the agent added or changed", async () => {
    const repo = mkdtempSync(join(tmpdir(), "jev-lint-repoeval-"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/old.ts"), "export const a = 1;\n");
    const dir = join(repo, "..", `${repo.split("/").pop()}-snap`);
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init");
    snapshot(repo, "change", dir);
    // The "agent" adds a file with an empty catch and leaves src/old.ts alone.
    writeFileSync(join(dir, "src/config.ts"), "export function load() {\n  try { return JSON.parse('{}'); } catch (e) {}\n}\n");
    const result = await judge(dir, ["ts-no-empty-catch"]);
    expect(result.files).toEqual(["src/config.ts"]);
    expect(result.byRule["ts-no-empty-catch"]).toBe(1);
    expect(result.violations).toBe(1);
    rmSync(repo, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    mock.stop(true);
  });
});
