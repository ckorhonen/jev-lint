// Benchmark subprocess preload. Observe the same JSON read as the production adapter.
// Record usage even when an answered request later fails adapter validation.
import { appendFileSync } from "node:fs";

const path = process.env.JEV_REPLAY_USAGE;
const trace = process.env.JEV_REPLAY_PHASES;
let next = 0;
function mark(phase: string, request?: number) {
  if (trace) appendFileSync(trace, `${JSON.stringify({ phase, request, pid: process.pid, timeMs: Date.now() })}\n`);
}
if (path) {
  mark("hook_preload");
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      if (args[0] !== "https://api.openai.com/v1/decisions" && args[0] !== "https://api.typesafe.ai/v1/systemone") return original(...args);
      const request = ++next;
      mark("provider_dispatch", request);
      let response: Response;
      try {
        response = await original(...args);
      } catch (error) {
        mark("provider_fetch_error", request);
        throw error;
      }
      mark("response_headers", request);
      if (response.ok) {
        const read = response.json.bind(response);
        response.json = async () => {
          const data = await read();
          mark("response_decoded", request);
          appendFileSync(path, `${JSON.stringify(data.usage)}\n`);
          return data;
        };
      }
      return response;
    },
    { preconnect: original.preconnect },
  );
}
