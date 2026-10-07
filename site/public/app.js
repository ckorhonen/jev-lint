// jev-lint.dev — progressive enhancement only. The page is complete without this file.
(() => {
  document.documentElement.classList.add("js");
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // Timings (ms)
  const TOAST_MS = 2600;

  /* ── Setup prompt: Claude Code / Codex variants ─────────────────────── */
  const BASE = `Set up jev-lint for me: https://jevlint.dev
Source: https://github.com/ckorhonen/jev-lint
Clone it to ~/Repos/jev-lint if it isn't there, then follow its jev-lint-setup skill
(.agents/skills/jev-lint-setup/SKILL.md): use TypeSafe Jev by default; if I choose OpenAI
Decisions API or Cloudflare Clef, follow its README setup. Check the selected provider's
credentials without printing them, show me the dry run, install
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
        $(".setup-prompt").open = true;
        location.hash = "#setup";
      }
    });
  }

})();
