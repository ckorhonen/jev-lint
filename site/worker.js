// jevlint.dev: serve the static site, redirect www and plain HTTP to https://jevlint.dev, and answer byte-range requests for
// the demo video (Safari/iOS won't play an MP4 without 206 responses).
const APEX = "jevlint.dev";
const RANGE = /^bytes=(\d*)-(\d*)$/;

async function withRange(request, env) {
  const res = await env.ASSETS.fetch(request);
  const header = request.headers.get("range");
  if (!header || res.status !== 200) return res;

  const body = await res.arrayBuffer();
  const size = body.byteLength;
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");
  const m = RANGE.exec(header.trim());
  let start;
  let end;
  if (m && m[1] !== "") {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  } else if (m && m[2] !== "") {
    start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
    end = size - 1;
  }
  if (start === undefined || start > end || start >= size) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const onWorkersDev = url.hostname.endsWith(".workers.dev");
    if (!onWorkersDev && (url.hostname === `www.${APEX}` || url.protocol === "http:")) {
      url.hostname = APEX;
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      const res = await withRange(request, env);
      if (res.status === 200) {
        const h = new Headers(res.headers);
        h.set("Accept-Ranges", "bytes");
        return new Response(res.body, { status: 200, headers: h });
      }
      return res;
    }
    return env.ASSETS.fetch(request);
  },
};
