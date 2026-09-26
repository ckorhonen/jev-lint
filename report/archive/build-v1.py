#!/usr/bin/env python3
"""Build report/index.html from eval/results/*.json.

  python3 report/build.py [path/to/DepartureMono-Regular.woff2]

Numbers in the page come from the result files; the prose is written against the
2026-09-26 run and should be revisited if results change.
"""

import base64
import json
import random
import statistics as st
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "eval/results"
summary = json.loads((RES / "summary.json").read_text())
graded = json.loads((RES / "e2e-graded.json").read_text())
agreement = json.loads((RES / "e2e-agreement.json").read_text())

font_css = ""
if len(sys.argv) > 1 and Path(sys.argv[1]).exists():
    b64 = base64.b64encode(Path(sys.argv[1]).read_bytes()).decode()
    font_css = f"@font-face{{font-family:'Departure Mono';src:url(data:font/woff2;base64,{b64}) format('woff2');font-display:swap}}"


def res(system, lang, split, policy):
    for r in summary["results"]:
        if (r["system"], r["lang"], r["split"], r["policy"]) == (system, lang, split, policy):
            return r
    raise KeyError((system, lang, split, policy))


def pct(x):
    return f"{x * 100:.0f}%"


# ---------- offline: held-out comparison ----------
SYSTEMS = [
    ("Jev, both tiers (p ≥ 0.5)", "jev", "fixed-0.5", "s1"),
    ("Jev, high tier only (p ≥ 0.8)", "jev", "fixed-0.8", "s2"),
    ("GPT-5.4-mini judge", "llm", "high", "s3"),
    ("Regex", "regex", "high", "s4"),
]


def bar_chart(metric, title, fmt=pct, max_v=1.0, ticks=(0, 0.25, 0.5, 0.75, 1.0)):
    groups = [("TypeScript", "typescript"), ("Swift", "swift")]
    w, h, left, top, bottom = 640, 250, 44, 18, 44
    plot_w, plot_h = w - left - 12, h - top - bottom
    group_w = plot_w / len(groups)
    bar_w = (group_w - 40) / len(SYSTEMS)
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{title}" class="chart">']
    for v in ticks:
        y = top + plot_h * (1 - v / max_v)
        out.append(f'<line x1="{left}" x2="{w - 12}" y1="{y:.1f}" y2="{y:.1f}" class="grid"/>')
        out.append(f'<text x="{left - 6}" y="{y + 4:.1f}" class="tick" text-anchor="end">{fmt(v)}</text>')
    for gi, (glabel, lang) in enumerate(groups):
        gx = left + gi * group_w + 20
        for si, (_, system, policy, cls) in enumerate(SYSTEMS):
            v = res(system, lang, "holdout", policy)[metric]
            bh = plot_h * v / max_v
            x = gx + si * bar_w
            y = top + plot_h - bh
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w - 6:.1f}" height="{max(bh, 1):.1f}" class="{cls}"/>')
            out.append(f'<text x="{x + (bar_w - 6) / 2:.1f}" y="{y - 5:.1f}" class="val" text-anchor="middle">{fmt(v)}</text>')
        out.append(f'<text x="{gx + (group_w - 40) / 2:.1f}" y="{h - 16}" class="glabel" text-anchor="middle">{glabel}</text>')
    out.append("</svg>")
    return "".join(out)


legend = "".join(f'<span class="key"><i class="sw {cls}"></i>{label}</span>' for label, _, _, cls in SYSTEMS)

offline_rows = []
for label, system, policy, _ in SYSTEMS:
    for lang, lname in [("typescript", "TS"), ("swift", "Swift")]:
        r = res(system, lang, "holdout", policy)
        offline_rows.append(
            f"<tr><td>{label}</td><td>{lname}</td><td>{pct(r['precision'])}</td><td>{pct(r['recall'])}</td>"
            f"<td>{pct(r['f1'])}</td><td>{pct(r['cleanFalseAlarmRate'])}</td><td>{r['latency']['p50']:.0f} ms</td></tr>"
        )

# ---------- E2E ----------
conds = [("none", "No hook"), ("jev", "Jev, both tiers"), ("jev-high", "Jev, high only")]


def e2e(cond, lang=None):
    rows = [r for r in graded if r["condition"] == cond and (lang is None or r["lang"] == lang)]
    v = [r["totalViolations"] for r in rows]
    return {
        "n": len(rows),
        "mean": st.mean(v),
        "zero": sum(x == 0 for x in v),
        "build": sum(r["build"]["ok"] for r in rows),
        "cost": st.mean(r["transcript"]["costUsd"] for r in rows),
        "dur": st.mean(r["transcript"]["durationMs"] for r in rows) / 1000,
        "shown": sum(r["hook"]["findingsShown"] for r in rows),
        "high": sum(r["hook"]["highShown"] for r in rows),
        "med": sum(r["hook"]["mediumShown"] for r in rows),
        "calls": sum(r["hook"]["calls"] for r in rows),
        "errs": sum(r["hook"]["errors"] for r in rows),
    }


def paired(cond):
    diffs = []
    for r in graded:
        if r["condition"] != cond:
            continue
        base = next(b for b in graded if b["condition"] == "none" and b["task"] == r["task"] and b["rep"] == r["rep"])
        diffs.append(r["totalViolations"] - base["totalViolations"])
    random.seed(0)
    boot = sorted(st.mean(random.choices(diffs, k=len(diffs))) for _ in range(5000))
    return st.mean(diffs), boot[125], boot[4875], sum(d < 0 for d in diffs), sum(d > 0 for d in diffs)


e2e_rows = []
base = e2e("none")
for cond, label in conds:
    a = e2e(cond)
    diff = "—" if cond == "none" else "{:+.2f} (95% CI {:+.2f} to {:+.2f})".format(*paired(cond)[:3])
    e2e_rows.append(
        f"<tr><td>{label}</td><td>{a['mean']:.2f}</td><td>{diff}</td><td>{a['zero']}/{a['n']}</td><td>{a['build']}/{a['n']}</td>"
        f"<td>${a['cost']:.3f} ({(a['cost'] / base['cost'] - 1) * 100:+.0f}%)</td><td>{a['dur']:.0f}s</td><td>{a['high']} / {a['med']}</td></tr>"
    )


def e2e_chart():
    w, h, left, top, bottom = 640, 220, 44, 18, 44
    plot_w, plot_h = w - left - 12, h - top - bottom
    max_v = 3.5
    langs = [("All tasks", None), ("TypeScript", "typescript"), ("Swift", "swift")]
    group_w = plot_w / len(langs)
    bar_w = (group_w - 30) / 3
    cls = {"none": "s4", "jev": "s1", "jev-high": "s2"}
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="Graded violations per task by condition" class="chart">']
    for v in [0, 1, 2, 3]:
        y = top + plot_h * (1 - v / max_v)
        out.append(f'<line x1="{left}" x2="{w - 12}" y1="{y:.1f}" y2="{y:.1f}" class="grid"/>')
        out.append(f'<text x="{left - 6}" y="{y + 4:.1f}" class="tick" text-anchor="end">{v}</text>')
    for gi, (glabel, lang) in enumerate(langs):
        gx = left + gi * group_w + 15
        for ci, (cond, _) in enumerate(conds):
            v = e2e(cond, lang)["mean"]
            bh = plot_h * v / max_v
            x = gx + ci * bar_w
            y = top + plot_h - bh
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w - 6:.1f}" height="{bh:.1f}" class="{cls[cond]}"/>')
            out.append(f'<text x="{x + (bar_w - 6) / 2:.1f}" y="{y - 5:.1f}" class="val" text-anchor="middle">{v:.2f}</text>')
        out.append(f'<text x="{gx + (group_w - 30) / 2:.1f}" y="{h - 16}" class="glabel" text-anchor="middle">{glabel}</text>')
    out.append("</svg>")
    return "".join(out)


e2e_legend = (
    '<span class="key"><i class="sw s4"></i>No hook</span>'
    '<span class="key"><i class="sw s1"></i>Jev, both tiers</span>'
    '<span class="key"><i class="sw s2"></i>Jev, high only</span>'
)

rule_rows = []
for rule in sorted({k for r in graded for k in r["violations"]}):
    t = [sum(r["violations"].get(rule, 0) for r in graded if r["condition"] == c) for c, _ in conds]
    if any(t):
        rule_rows.append(f"<tr><td><code>{rule}</code></td>" + "".join(f"<td>{x}</td>" for x in t) + "</tr>")

# Jev vs grader on real files
agree = {}
for x in agreement:
    a = agree.setdefault(x["rule"], [0, 0, 0])
    g, j = x["grader"] > 0, x["jev"] >= 0.5
    if g and j:
        a[0] += 1
    elif j:
        a[1] += 1
    elif g:
        a[2] += 1
agree_rows = "".join(
    f"<tr><td><code>{r}</code></td><td>{v[0]}</td><td>{v[1]}</td><td>{v[2]}</td></tr>" for r, v in sorted(agree.items()) if any(v)
)
n_files = len({(x["path"], x["evidence"]) for x in agreement})

cons = summary.get("jevRunConsistency", {})
counts = summary["caseCounts"]

html = (ROOT / "report/template.html").read_text()
for key, value in {
    "{{FONT}}": font_css,
    "{{F1_CHART}}": bar_chart("f1", "Held-out F1 by system"),
    "{{FA_CHART}}": bar_chart("cleanFalseAlarmRate", "Share of clean edits that got a false alarm", max_v=0.25, ticks=(0, 0.05, 0.1, 0.15, 0.2, 0.25)),
    "{{LEGEND}}": legend,
    "{{OFFLINE_ROWS}}": "".join(offline_rows),
    "{{E2E_CHART}}": e2e_chart(),
    "{{E2E_LEGEND}}": e2e_legend,
    "{{E2E_ROWS}}": "".join(e2e_rows),
    "{{RULE_ROWS}}": "".join(rule_rows),
    "{{AGREE_ROWS}}": agree_rows,
    "{{N_DEV}}": str(counts["typescript.dev"] + counts["swift.dev"]),
    "{{N_HOLDOUT}}": str(counts["typescript.holdout"] + counts["swift.holdout"]),
    "{{CONS_MAX}}": f"{cons.get('maxAbsDiff', 0):.2f}",
    "{{CONS_P99}}": f"{cons.get('p99AbsDiff', 0):.2f}",
    "{{HOOK_CALLS}}": str(e2e("jev")["calls"] + e2e("jev-high")["calls"]),
    "{{HOOK_ERRS}}": str(e2e("jev")["errs"] + e2e("jev-high")["errs"]),
}.items():
    html = html.replace(key, value)
(ROOT / "report/index.html").write_text(html)
print("wrote report/index.html", len(html), "bytes")
