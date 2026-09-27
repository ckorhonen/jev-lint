// jev-lint.dev — progressive enhancement only. The page is complete without this file.
(() => {
  document.documentElement.classList.add("js");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ease = (t) => 1 - (1 - t) ** 4;
  // Timings (ms)
  const CHECK_MS = 300; // one jev-lint check, ~0.3 s
  const TOAST_MS = 2600;
  const COUNT_MS = 1400;
  const TYPE_MS = 28;
  const HOLD_FLAG_MS = 3200;
  const HOLD_OK_MS = 3600;

  /* ── Setup prompt: Claude Code / Codex variants ─────────────────────── */
  const BASE = `Set up jev-lint for me: https://github.com/ckorhonen/jev-lint
Clone it to ~/Repos/jev-lint if it isn't there, then follow its jev-lint-setup skill
(.agents/skills/jev-lint-setup/SKILL.md): check my TypeSafe key, show me the dry run, install
the hook once I confirm, and run the smoke test. Then use its jev-lint-rules skill on this
repo: read all of our agent instructions, skills, docs and linter configs, and propose rules
for me to approve before writing anything.`;
  const AGENTS = {
    claude: { name: "Claude Code", tail: "I'm using Claude Code, so install the hook for Claude Code (--claude-only)." },
    codex: {
      name: "Codex",
      tail: "I'm using Codex, so install the hook for Codex (--codex-only); it needs [features] hooks = true in ~/.codex/config.toml, and I'll trust the hook the first time.",
    },
  };
  let agent = "claude";
  try {
    const saved = localStorage.getItem("jl-agent");
    if (saved && AGENTS[saved]) agent = saved;
  } catch {
    // Storage can be blocked (private mode); the default agent is fine.
  }
  const promptFor = (a) => `${BASE}\n${AGENTS[a].tail}`;
  const setAgent = (a) => {
    agent = a;
    for (const b of $$("[data-agent]")) b.setAttribute("aria-pressed", String(b.dataset.agent === a));
    for (const el of $$("[data-agent-name]")) el.textContent = AGENTS[a].name;
    const m = $("[data-term-mode]");
    if (m) m.textContent = m.textContent.replace(/^(Claude Code|Codex)/, AGENTS[a].name);
    const pre = $("[data-prompt]");
    if (pre) pre.textContent = promptFor(a);
    try {
      localStorage.setItem("jl-agent", a);
    } catch {
      // Remembering the choice is a convenience only.
    }
  };
  for (const b of $$("[data-agent]")) b.addEventListener("click", () => setAgent(b.dataset.agent));
  setAgent(agent);

  const toast = $("[data-toast]");
  let toastTimer;
  const say = (msg) => {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), TOAST_MS);
  };
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false; // reported to the user below
      }
      ta.remove();
      return ok;
    }
  };
  for (const btn of $$("[data-copy]")) {
    const label = btn.firstChild.textContent;
    btn.addEventListener("click", async () => {
      const ok = await copyText(promptFor(agent));
      if (ok) {
        btn.dataset.done = "1";
        btn.firstChild.textContent = "Copied. Now paste it.";
        say(`Copied. Paste it into ${AGENTS[agent].name}.`);
        setTimeout(() => {
          btn.dataset.done = "";
          btn.firstChild.textContent = label;
        }, TOAST_MS);
      } else {
        say("Couldn't copy. Select the prompt in the Setup section instead.");
        location.hash = "#setup";
      }
    });
  }

  /* ── Count-ups: HTML holds the final value; we pad so width never changes ── */
  const fmt = (v, dec, width) => v.toFixed(dec).padStart(width, " ");
  const countUp = (el, dur = COUNT_MS) => {
    const to = Number.parseFloat(el.dataset.count);
    const dec = Number(el.dataset.dec || 0);
    const width = to.toFixed(dec).length;
    if (reduce) return;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(to * ease(t), dec, width);
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = to.toFixed(dec);
    };
    el.textContent = fmt(0, dec, width);
    requestAnimationFrame(step);
  };

  /* ── Scroll reveals, bars and counters ───────────────────────────────── */
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        io.unobserve(el);
        el.classList.add("in");
        if (el.matches("[data-count]")) countUp(el);
        for (const c of $$("[data-count]", el)) countUp(c);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
  );
  if (!reduce) {
    for (const el of $$(".rv, [data-anim], [data-draw]")) io.observe(el);
    // Standalone counters not inside an animated block
    for (const el of $$("[data-count]")) if (!el.closest("[data-anim]") && !el.closest(".rv")) io.observe(el);
    // Counters inside reveal blocks animate when their block reveals
  } else {
    for (const el of $$(".rv, [data-anim], [data-draw]")) el.classList.add("in");
  }

  /* ── Stopwatch gag ──────────────────────────────────────────────────── */
  const sw = $("[data-stopwatch]");
  const runWatch = () => {
    if (!sw || reduce) return;
    const t0 = performance.now();
    const tick = (now) => {
      const ms = Math.min(CHECK_MS, now - t0);
      sw.textContent = (ms / 1000).toFixed(3);
      if (ms < CHECK_MS) requestAnimationFrame(tick);
    };
    sw.textContent = "0.000";
    requestAnimationFrame(tick);
  };
  $("[data-stopwatch-run]")?.addEventListener("click", runWatch);
  if (sw) {
    const swIO = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        runWatch();
        swIO.disconnect();
      }
    });
    swIO.observe(sw);
  }
  const gag = $("[data-gag]");
  const start = performance.now();
  if (gag) {
    const upd = () => {
      gag.textContent = Math.floor((performance.now() - start) / CHECK_MS).toLocaleString("en-US");
    };
    upd();
    setInterval(upd, CHECK_MS);
  }

  /* ── Hero terminal loop: type → flag (red) → fix (green) → no findings ── */
  const code = $("[data-term-code]");
  const hook = $("[data-term-hook]");
  const mode = $("[data-term-mode]");
  if (!code || !hook || reduce) return;

  const HEAD = [
    ["kw", "export function", "tx", " UserCard({ id }: Props) {"],
    ["kw", "  const", "tx", " [user, setUser] = useState<User>();"],
    ["tx", " "],
  ];
  const TAIL = [["tx", " "], ["kw", "  return", "tx", " <UserView user={user} />;"], ["tx", "}"]];
  const BAD = ["  useEffect(() => {", "    fetchUser(id).then(setUser);", "  }, [id]);"];
  const GOOD = [
    "  useEffect(() => {",
    "    let stale = false;",
    "    fetchUser(id).then((u) => {",
    "      if (!stale) setUser(u);",
    "    });",
    "    return () => { stale = true; };",
    "  }, [id]);",
  ];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const line = (n, cls, html) => `<div class="ln ${cls}"><u>${n}</u><span>${html}</span></div>`;
  const toks = (t) => {
    let h = "";
    for (let i = 0; i < t.length; i += 2) h += `<span class="${t[i]}">${esc(t[i + 1])}</span>`;
    return h;
  };
  const render = (mid, midCls, caretAt) => {
    let n = 0;
    let html = "";
    for (const t of HEAD) html += line(++n, "", toks(t));
    mid.forEach((m, i) => {
      const c = typeof midCls === "function" ? midCls(i) : midCls;
      html += line(++n, c, `<span class="tx">${esc(m)}</span>${caretAt === i ? '<span class="caret"></span>' : ""}`);
    });
    for (const t of TAIL) html += line(++n, "", toks(t));
    code.innerHTML = html;
  };
  // All hook states are rendered up front in one grid cell, so the panel's height never changes.
  const setHook = (state) => {
    hook.className = `hook ${state === "bad" || state === "ok" ? state : ""}`.trim();
    for (const el of $$("[data-state]", hook)) el.toggleAttribute("data-on", el.dataset.state === state);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nap = async (ms) => {
    await sleep(ms);
    await gate();
  };
  let visible = true;
  let paused = false;
  new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
  }).observe(code);
  const toggle = $("[data-term-toggle]");
  toggle?.addEventListener("click", () => {
    paused = !paused;
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? "play" : "pause";
  });
  const gate = async () => {
    while (!visible || paused) await sleep(250);
  };
  const typeLines = async (lines, cls) => {
    const done = [];
    for (let i = 0; i < lines.length; i++) {
      for (let c = 0; c <= lines[i].length; c += 2) {
        render([...done, lines[i].slice(0, c)], cls, done.length);
        await nap(TYPE_MS);
      }
      done.push(lines[i]);
    }
    render(done, cls);
  };
  const check = async (result) => {
    setHook("wait");
    const w = $("[data-w]", hook);
    const t0 = performance.now();
    while (performance.now() - t0 < CHECK_MS) {
      w.textContent = `${((performance.now() - t0) / 1000).toFixed(3)} s`;
      await sleep(16);
    }
    setHook(result);
  };
  const loop = async () => {
    await sleep(2600); // let the static first frame (the "flagged" state) be seen
    for (;;) {
      await gate();
      mode.textContent = `${AGENTS[agent].name} · Edit`;
      setHook("idle");
      render([], "");
      await nap(500);
      await typeLines(BAD, "");
      await check("bad");
      render(BAD, "flag");
      await nap(HOLD_FLAG_MS);
      mode.textContent = `${AGENTS[agent].name} · Edit (fix)`;
      render(BAD, (i) => (i === 1 ? "del" : "flag"));
      code.querySelectorAll(".ln.del span .tx").forEach((s) => {
        s.outerHTML = `<s>${s.innerHTML}</s>`;
      });
      await nap(900);
      const kept = GOOD.slice(0, 1);
      render(kept, "");
      for (let i = 1; i < GOOD.length - 1; i++) {
        const line = GOOD[i];
        for (let c = 0; c <= line.length; c += 2) {
          render([...kept, line.slice(0, c), GOOD[GOOD.length - 1]], (k) => (k > 0 && k <= i ? "add" : ""), kept.length);
          await nap(TYPE_MS);
        }
        kept.push(line);
      }
      render(GOOD, (k) => (k > 0 && k < GOOD.length - 1 ? "add" : ""));
      await check("ok");
      await nap(HOLD_OK_MS);
    }
  };
  loop();
})();
