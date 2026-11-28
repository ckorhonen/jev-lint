// Offline hook benchmark. Synthetic provider waits and token counts are fixed across revisions.
import { runChecks } from "../src/checks";

process.env.JEV_LINT_PROVIDER = "typesafe";
process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:1";
process.env.JEV_LINT_GATE = "off";
const changes = Array.from({ length: 8 }, (_, i) => ({
  filePath: `/tmp/check-${i}.ts`,
  addedCode: "try { run(); } catch (e) {}",
  changeKind: "write" as const,
}));
let calls = 0;
let inFlight = 0;
let peak = 0;
globalThis.fetch = Object.assign(
  async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const slow = /check-[04]\.ts$/.test(body.state.file_path);
    calls++;
    peak = Math.max(peak, ++inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, slow ? 100 : 8);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("deadline"));
          },
          { once: true },
        );
      });
      return Response.json({
        answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: 0 }])),
        usage: { input_tokens: 1, output_tokens: 0 },
        model: "fixture",
      });
    } finally {
      inFlight--;
    }
  },
  { preconnect: fetch.preconnect },
);

for (const timeoutMs of [1000, 160]) {
  calls = peak = 0;
  let completed = 0;
  let successfulEvents = 0;
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const results = await runChecks(changes, { timeoutMs });
    times.push(performance.now() - start);
    const checked = results.filter((r) => r.ok && r.value).length;
    completed += checked;
    if (checked === changes.length) successfulEvents++;
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      timeoutMs,
      events: times.length,
      successfulEvents,
      files: 160,
      completed,
      calls,
      peak,
      p50Ms: Math.round(times[9]),
      p95Ms: Math.round(times[18]),
      filesPerSecond: Math.round((completed * 1000) / times.reduce((a, b) => a + b, 0)),
      callsPerCompletedFile: calls / completed,
    }),
  );
}
