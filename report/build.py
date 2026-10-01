#!/usr/bin/env python3
"""Build the Jev Lint experiment notebook (report/index.html) from eval/results.

  python3 report/build.py [path/to/DepartureMono-Regular.woff2]

The notebook is append-only in spirit: each experiment is a dated entry, newest first.
Superseded numbers stay visible and are labeled, never deleted. Snapshots of earlier
result files live in eval/results/snapshots/.
"""

import base64
import html
import json
import random
import re
import statistics as st
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "eval/results"
SNAP = RES / "snapshots"


def load(path):
    return json.loads(Path(path).read_text())


# Entries 1-4 read the results as they stood at the end of Entry 4; Entry 5 reads the latest
# (rule gate, new rules, two rules dropped), so earlier charts keep matching their prose.
summary = load(SNAP / "summary-2026-09-26-entry4-final.json")
summary5 = load(RES / "summary.json")
practices_v1 = load(SNAP / "summary-2026-09-26-practices-v1.json")
mini = load(SNAP / "summary-round1-gpt-5.4-mini-hygiene.json")
r1_graded_gpt55 = load(SNAP / "e2e-graded-round1-grader-gpt-5.5.json")
r1_agreement = load(SNAP / "e2e-agreement-round1-grader-gpt-5.5.json")
r1_graded_luna = load(RES / "e2e-graded.json")
r1_review = load(RES / "e2e-review.json")
p_graded = load(RES / "e2e-graded-practices.json")
p_review = load(RES / "e2e-review-practices.json")

RULES = {
    (lang, pack): load(ROOT / f"rules/{lang}{'' if pack == 'hygiene' else '.practices'}.json")["rules"]
    for lang in ["typescript", "swift"]
    for pack in ["hygiene", "practices"]
}
# Entries 1-4 use the rule sets as they were at the end of Entry 4 (snapshotted before Entry 5
# dropped two hygiene rules and added three practice rules).
RULES_E4 = {
    ("typescript", "hygiene"): load(SNAP / "typescript.hygiene-v1.json")["rules"],
    ("typescript", "practices"): load(SNAP / "typescript.practices-v2b.json")["rules"],
    ("swift", "hygiene"): [r for r in RULES[("swift", "hygiene")]],
    ("swift", "practices"): load(SNAP / "swift.practices-v1.json")["rules"],
}
HYGIENE_IDS = {r["id"] for (l, p), rs in RULES_E4.items() if p == "hygiene" for r in rs}
PRACTICE_IDS = {r["id"] for (l, p), rs in RULES_E4.items() if p == "practices" for r in rs}

font_css = ""
if len(sys.argv) > 1 and Path(sys.argv[1]).exists():
    b64 = base64.b64encode(Path(sys.argv[1]).read_bytes()).decode()
    font_css = f"@font-face{{font-family:'Departure Mono';src:url(data:font/woff2;base64,{b64}) format('woff2');font-display:swap}}"

esc = html.escape


def pct(x, digits=0):
    return "—" if x is None else f"{x * 100:.{digits}f}%"


def res(s, system, pack, lang, split, policy):
    for r in s["results"]:
        if (r["system"], r["pack"], r["lang"], r["split"], r["policy"]) == (system, pack, lang, split, policy):
            return r
    return None


def mini_res(lang, split, policy="high"):
    return next(r for r in mini if r["run"] == 1 and r["lang"] == lang and r["split"] == split and r["policy"] == policy)


# ---------------------------------------------------------------- chart helpers

SERIES = {"s1": "var(--s1)", "s2": "var(--s2)", "s3": "var(--s3)", "s4": "var(--s4)"}


def grouped_bars(groups, series, value_fn, title, fmt=pct, max_v=1.0, ticks=(0, 0.25, 0.5, 0.75, 1.0), height=240, tip_fn=None):
    """groups: [(label, key)], series: [(label, key, cls)], value_fn(group_key, series_key) -> float|None."""
    w, left, top, bottom = 680, 44, 20, 46
    plot_w, plot_h = w - left - 10, height - top - bottom
    gw = plot_w / len(groups)
    pad = 18
    bw = (gw - pad * 2) / len(series)
    out = [f'<svg viewBox="0 0 {w} {height}" role="img" aria-label="{esc(title)}" class="chart">']
    for v in ticks:
        y = top + plot_h * (1 - v / max_v)
        out.append(f'<line x1="{left}" x2="{w - 10}" y1="{y:.1f}" y2="{y:.1f}" class="grid"/>')
        out.append(f'<text x="{left - 6}" y="{y + 4:.1f}" class="tick" text-anchor="end">{fmt(v)}</text>')
    for gi, (glabel, gkey) in enumerate(groups):
        gx = left + gi * gw + pad
        for si, (slabel, skey, cls) in enumerate(series):
            v = value_fn(gkey, skey)
            x = gx + si * bw
            if v is None:
                out.append(f'<text x="{x + (bw - 5) / 2:.1f}" y="{top + plot_h - 4:.1f}" class="tick" text-anchor="middle">n/a</text>')
                continue
            bh = plot_h * min(v, max_v) / max_v
            y = top + plot_h - bh
            tip = tip_fn(gkey, skey, v) if tip_fn else f"{slabel} · {glabel}: {fmt(v)}"
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw - 5:.1f}" height="{max(bh, 1):.1f}" class="{cls}"><title>{esc(tip)}</title></rect>')
            out.append(f'<text x="{x + (bw - 5) / 2:.1f}" y="{y - 5:.1f}" class="val" text-anchor="middle">{fmt(v)}</text>')
        out.append(f'<text x="{gx + (gw - pad * 2) / 2:.1f}" y="{height - 18}" class="glabel" text-anchor="middle">{esc(glabel)}</text>')
    out.append("</svg>")
    legend = "".join(f'<span class="key"><i class="sw {cls}"></i>{esc(label)}</span>' for label, _, cls in series)
    return f'<figure>{"".join(out)}<div class="legend">{legend}</div></figure>'


def line_chart(lines, title, xs, height=230, y_label=""):
    """lines: [(label, cls, dash, [y...])] over shared xs (thresholds)."""
    w, left, top, bottom, right = 330, 40, 14, 34, 10
    plot_w, plot_h = w - left - right, height - top - bottom
    x0, x1 = xs[0], xs[-1]
    X = lambda x: left + plot_w * (x - x0) / (x1 - x0)
    Y = lambda y: top + plot_h * (1 - y)
    out = [f'<svg viewBox="0 0 {w} {height}" role="img" aria-label="{esc(title)}" class="chart">']
    for v in (0, 0.5, 1):
        out.append(f'<line x1="{left}" x2="{w - right}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="grid"/>')
        out.append(f'<text x="{left - 5}" y="{Y(v) + 4:.1f}" class="tick" text-anchor="end">{pct(v)}</text>')
    for x in xs:
        out.append(f'<text x="{X(x):.1f}" y="{height - 16}" class="tick" text-anchor="middle">{x:g}</text>')
    for t, lab in ((0.5, "0.5"), (0.8, "0.8")):
        out.append(f'<line x1="{X(t):.1f}" x2="{X(t):.1f}" y1="{top}" y2="{top + plot_h}" class="marker"/>')
    for label, cls, dash, ys in lines:
        pts = " ".join(f"{X(x):.1f},{Y(y):.1f}" for x, y in zip(xs, ys))
        dash_attr = 'stroke-dasharray="4 3"' if dash else ""
        out.append(f'<polyline points="{pts}" class="ln {cls}" {dash_attr}/>')
        for x, y in zip(xs, ys):
            out.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="2.6" class="pt {cls}"><title>{esc(label)} at p ≥ {x:g}: {pct(y)}</title></circle>')
    out.append(f'<text x="{left + plot_w / 2:.1f}" y="{height - 2}" class="tick" text-anchor="middle">threshold (p ≥)</text>')
    out.append("</svg>")
    return f'<div class="mini"><div class="mini-title">{esc(title)}</div>{"".join(out)}</div>'


def hbar_stack(rows, segments, title, total_label=True):
    """rows: [(label, [values per segment])], segments: [(label, cls)]. Values are counts."""
    w, left, right, row_h, top = 680, 170, 50, 30, 8
    height = top + row_h * len(rows) + 8
    max_total = max(sum(v) for _, v in rows) or 1
    scale = (w - left - right) / max_total
    out = [f'<svg viewBox="0 0 {w} {height}" role="img" aria-label="{esc(title)}" class="chart">']
    for i, (label, values) in enumerate(rows):
        y = top + i * row_h
        out.append(f'<text x="{left - 8}" y="{y + 17}" class="glabel" text-anchor="end">{esc(label)}</text>')
        x = left
        for (slabel, cls), v in zip(segments, values):
            if v <= 0:
                continue
            bw = v * scale
            out.append(f'<rect x="{x:.1f}" y="{y + 4}" width="{bw:.1f}" height="{row_h - 10}" class="{cls}"><title>{esc(label)} · {esc(slabel)}: {v:g}</title></rect>')
            if bw > 22:
                out.append(f'<text x="{x + bw / 2:.1f}" y="{y + 18.5}" class="inbar {cls}-t" text-anchor="middle">{v:g}</text>')
            x += bw
        if total_label:
            out.append(f'<text x="{x + 6:.1f}" y="{y + 18}" class="val">{sum(values):g}</text>')
    out.append("</svg>")
    legend = "".join(f'<span class="key"><i class="sw {cls}"></i>{esc(label)}</span>' for label, cls in segments)
    return f'<figure>{"".join(out)}<div class="legend">{legend}</div></figure>'


def table(headers, rows, cls=""):
    head = "".join(f"<th>{h}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows)
    return f'<div class="table {cls}"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def paired_diff(graded, cond, metric):
    diffs = []
    for r in graded:
        if r["condition"] != cond:
            continue
        base = next(b for b in graded if b["condition"] == "none" and b["task"] == r["task"] and b["rep"] == r["rep"])
        diffs.append(metric(r) - metric(base))
    random.seed(0)
    boot = sorted(st.mean(random.choices(diffs, k=len(diffs))) for _ in range(5000))
    return st.mean(diffs), boot[125], boot[4875], sum(d < 0 for d in diffs), sum(d > 0 for d in diffs)


# ---------------------------------------------------------------- numbers

LANGS = [("TypeScript", "typescript"), ("Swift", "swift")]

# Headline held-out F1 by pack/lang/system.
def f1(system, pack, lang, policy):
    r = res(summary, system, pack, lang, "holdout", policy)
    return r["f1"] if r else None


headline_groups = [("Hygiene · TS", ("hygiene", "typescript")), ("Hygiene · Swift", ("hygiene", "swift")),
                   ("Practices · TS", ("practices", "typescript")), ("Practices · Swift", ("practices", "swift"))]
headline_series = [("Jev, both tiers", ("jev", "high+medium"), "s1"), ("Jev, high tier", ("jev", "high"), "s2"),
                   ("GPT-6-Luna (low)", ("llm", "high"), "s3"), ("Regex", ("regex", "high"), "s4")]
chart_headline = grouped_bars(headline_groups, headline_series, lambda g, s: f1(s[0], g[0], g[1], s[1]), "Held-out F1 by rule pack, language and judge")

chart_fa = grouped_bars(
    headline_groups, headline_series,
    lambda g, s: (res(summary, s[0], g[0], g[1], "holdout", s[1]) or {}).get("cleanFalseAlarmRate"),
    "Clean held-out edits that got a false alarm", max_v=0.2, ticks=(0, 0.05, 0.1, 0.15, 0.2),
)

# Latency and cost per edit.
def lat(system, pack, q="p50"):
    vals = [res(summary, system, pack, l, "holdout", "high")["latency"][q] for _, l in LANGS]
    return st.mean(vals)


def cost_per_10k(system, pack):
    n = i = o = 0
    for r in summary["results"]:
        if r["system"] == system and r["pack"] == pack and r["policy"] == "high":
            n += r["latency"]["n"]
            i += r["latency"]["tokens"]["input"]
            o += r["latency"]["tokens"]["output"]
    ci, co = i / n, o / n
    return (ci * 0.042 / 1e6 if system == "jev" else ci * 0.10 / 1e6 + co * 0.50 / 1e6) * 1e4


mini_p50 = st.mean(mini_res(l, "holdout")["p50"] for _, l in LANGS)
latency_rows = [
    ("Jev", st.mean([lat("jev", "hygiene"), lat("jev", "practices")]), cost_per_10k("jev", "hygiene")),
    ("GPT-6-Luna (low)", st.mean([lat("llm", "hygiene"), lat("llm", "practices")]), cost_per_10k("llm", "hygiene")),
    ("GPT-5.4-mini (round 1)", mini_p50, 17.86),
]
chart_latency = grouped_bars(
    [(name, name) for name, _, _ in latency_rows], [("Median time per check", "lat", "s1")],
    lambda g, s: next(v for n, v, _ in latency_rows if n == g) / 1000,
    "Median seconds per check", fmt=lambda v: f"{v:.2f}s", max_v=2.0, ticks=(0, 0.5, 1.0, 1.5, 2.0), height=210,
)

# Practices v1 -> v2 (TypeScript was the only pack reworded).
def pv(s, split, policy, metric):
    r = res(s, "jev", "practices", "typescript", split, policy)
    return r[metric] if r else None


v1v2_groups = [("Dev F1", ("dev", "f1")), ("Held-out F1", ("holdout", "f1")), ("Held-out clean false alarms", ("holdout", "cleanFalseAlarmRate"))]
v1v2_series = [("v1 rules, both tiers", ("v1", "high+medium"), "s3"), ("v2 rules, both tiers", ("v2", "high+medium"), "s1"),
               ("v1 rules, high tier", ("v1", "high"), "s4"), ("v2 rules, high tier", ("v2", "high"), "s2")]
chart_v1v2 = grouped_bars(v1v2_groups, v1v2_series,
                          lambda g, s: pv(practices_v1 if s[0] == "v1" else summary, g[0], s[1], g[1]),
                          "TypeScript practices rules before and after one wording pass")

# Threshold sweeps (held-out) and tier bands.
def sweep(pack, lang, split="holdout"):
    pts = [p for p in summary["sweeps"] if p.get("system", "jev") == "jev" and p["pack"] == pack and p["lang"] == lang and p["split"] == split]
    pts.sort(key=lambda p: p["threshold"])
    return [p["threshold"] for p in pts], [p["precision"] for p in pts], [p["recall"] for p in pts]


sweep_charts = []
for pack, pname in [("hygiene", "Hygiene"), ("practices", "Practices")]:
    for lname, lang in LANGS:
        xs, P, R = sweep(pack, lang)
        sweep_charts.append(line_chart([("Precision", "s1", False, P), ("Recall", "s2", True, R)], f"{pname} · {lname}", xs))
sweep_legend = '<div class="legend"><span class="key"><i class="sw s1"></i>Precision</span><span class="key"><i class="sw s2 dash"></i>Recall</span><span class="key"><i class="sw marker"></i>0.5 and 0.8 cut-offs</span></div>'

def band(pack, lo):
    rows = [b for b in summary["bands"] if b.get("system", "jev") == "jev" and b["pack"] == pack and b["lo"] == lo]
    real, total = sum(b["real"] for b in rows), sum(b["findings"] for b in rows)
    return (real / total if total else None), real, total


band_groups = [("p ≥ 0.8 (fix)", 0.8), ("0.5–0.8 (double-check)", 0.5), ("0.3–0.5 (dropped)", 0.3), ("0.1–0.3 (dropped)", 0.1)]
band_series = [("Hygiene", "hygiene", "s1"), ("Practices", "practices", "s2")]
chart_bands = grouped_bars(band_groups, band_series, lambda g, s: band(s, g)[0], "Share of Jev findings that are real, by probability band",
                           tip_fn=lambda g, s, v: f"{s}: {band(s, g)[1]} of {band(s, g)[2]} real")

# Per-rule practices table (held-out, both tiers vs Luna).
def per_rule_rows(lang):
    j = res(summary, "jev", "practices", lang, "holdout", "high+medium")["perRule"]
    l = res(summary, "llm", "practices", lang, "holdout", "high")["perRule"]
    rows = []
    for rule in RULES_E4[(lang, "practices")]:
        a, b = j[rule["id"]], l[rule["id"]]
        cell = lambda x: f"{x['tp']}/{x['tp'] + x['fn']} found · {x['fp']} false"
        rows.append([f"<code>{rule['id']}</code>", cell(a), cell(b)])
    return rows


# Pre-review funnel (practices round, no-hook runs).
def funnel(review, cond="none", lang=None):
    rs = [r for r in review if r["condition"] == cond and (lang is None or r["lang"] == lang)]
    f = [x for r in rs for x in r["findings"]]
    ins = [x for x in f if x["rule"] != "none"]
    c8 = sum(x["jevProbability"] >= 0.8 for x in ins)
    c5 = sum(0.5 <= x["jevProbability"] < 0.8 for x in ins)
    jo = [x for r in rs for x in r["jevOnly"]]
    return {"runs": len(rs), "findings": len(f), "out": len(f) - len(ins), "in": len(ins), "c8": c8, "c5": c5,
            "miss": len(ins) - c8 - c5, "jo": len(jo), "jo_ok": sum(x["graderConfirms"] for x in jo),
            "sev": {s: sum(x["severity"] == s for x in f) for s in ("high", "medium", "low")}}


fp_all = funnel(p_review)
fp_ts = funnel(p_review, lang="typescript")
fp_sw = funnel(p_review, lang="swift")
fr1 = funnel(r1_review)
funnel_segments = [("Jev flagged it, p ≥ 0.8", "s1"), ("Jev flagged it, 0.5–0.8", "s2"), ("Rule covers it, Jev missed", "s3"), ("No rule covers it", "s4")]
chart_funnel = hbar_stack(
    [("Practices · TS", [fp_ts["c8"], fp_ts["c5"], fp_ts["miss"], fp_ts["out"]]),
     ("Practices · Swift", [fp_sw["c8"], fp_sw["c5"], fp_sw["miss"], fp_sw["out"]]),
     ("Round 1 tasks", [fr1["c8"], fr1["c5"], fr1["miss"], fr1["out"]])],
    funnel_segments, "AI reviewer findings on no-hook code, by whether Jev had already flagged them",
)
chart_extra = hbar_stack(
    [("Practices tasks", [fp_all["jo_ok"], fp_all["jo"] - fp_all["jo_ok"]]), ("Round 1 tasks", [fr1["jo_ok"], fr1["jo"] - fr1["jo_ok"]])],
    [("Confirmed by the rule grader", "s1"), ("Not confirmed", "s3")], "Jev findings the reviewer never raised",
)

# With vs without the hook (practices round).
def review_per_task(review, cond, lang=None):
    rs = [r for r in review if r["condition"] == cond and (lang is None or r["lang"] == lang)]
    f = [x for r in rs for x in r["findings"]]
    return {"in": sum(x["rule"] != "none" for x in f) / len(rs), "out": sum(x["rule"] == "none" for x in f) / len(rs),
            "high": sum(x["severity"] == "high" for x in f) / len(rs)}


def pviol(r):
    return sum(v for k, v in r["violations"].items() if k in PRACTICE_IDS)


def hviol(r):
    return sum(v for k, v in r["violations"].items() if k in HYGIENE_IDS)


def e2e_stats(graded, cond, lang=None):
    rows = [r for r in graded if r["condition"] == cond and (lang is None or r["lang"] == lang)]
    return {
        "n": len(rows), "p": st.mean(pviol(r) for r in rows), "h": st.mean(hviol(r) for r in rows),
        "all": st.mean(r["totalViolations"] for r in rows), "build": sum(r["build"]["ok"] for r in rows),
        "cost": st.mean(r["transcript"]["costUsd"] for r in rows), "dur": st.mean(r["transcript"]["durationMs"] for r in rows) / 1000,
        "high": sum(r["hook"]["highShown"] for r in rows), "med": sum(r["hook"]["mediumShown"] for r in rows),
        "calls": sum(r["hook"]["calls"] for r in rows), "errs": sum(r["hook"]["errors"] for r in rows),
    }


hook_groups = [("All tasks", None), ("React tasks", "typescript"), ("SwiftUI tasks", "swift")]
chart_hook_review = grouped_bars(
    hook_groups, [("Reviewer findings a rule covers · no hook", ("none", "in"), "s3"), ("… with hook", ("jev", "in"), "s1"),
                  ("Graded rule violations · no hook", ("none", "viol"), "s4"), ("… with hook", ("jev", "viol"), "s2")],
    lambda g, s: review_per_task(p_review, s[0], g)["in"] if s[1] == "in" else e2e_stats(p_graded, s[0], g)["all"],
    "Per task: rule-covered reviewer findings and graded violations", fmt=lambda v: f"{v:.2f}", max_v=2.5, ticks=(0, 0.5, 1, 1.5, 2, 2.5),
)
chart_hook_out = grouped_bars(
    hook_groups, [("No hook", "none", "s3"), ("With hook", "jev", "s1")],
    lambda g, s: review_per_task(p_review, s, g)["out"], "Reviewer findings no rule covers, per task",
    fmt=lambda v: f"{v:.2f}", max_v=4, ticks=(0, 1, 2, 3, 4), height=210,
)
pd_all = paired_diff(p_graded, "jev", lambda r: r["totalViolations"])
pd_p = paired_diff(p_graded, "jev", pviol)

# Round-1 (hygiene) E2E, graded two ways.
def r1_stats(graded, cond, metric):
    return st.mean(metric(r) for r in graded if r["condition"] == cond)


r1_conds = [("No hook", "none"), ("Jev, both tiers", "jev"), ("Jev, high only", "jev-high")]
chart_r1 = grouped_bars(
    [("Graded by GPT-5.5 (original)", "gpt55"), ("Re-graded by GPT-6-Luna", "luna")],
    [(label, c, cls) for (label, c), cls in zip(r1_conds, ["s4", "s1", "s2"])],
    lambda g, c: r1_stats(r1_graded_gpt55 if g == "gpt55" else r1_graded_luna, c, lambda r: r["totalViolations"] if g == "gpt55" else hviol(r)),
    "Round 1: hygiene violations per task in final code", fmt=lambda v: f"{v:.2f}", max_v=3, ticks=(0, 1, 2, 3), height=220,
)
r1d_gpt = paired_diff(r1_graded_gpt55, "jev", lambda r: r["totalViolations"])
r1d_luna = paired_diff(r1_graded_luna, "jev", hviol)

# Original round-1 comparison table (GPT-5.4-mini, preserved).
r1_table_rows = []
for lname, lang in LANGS:
    j5 = res(summary, "jev", "hygiene", lang, "holdout", "high+medium")
    j8 = res(summary, "jev", "hygiene", lang, "holdout", "high")
    m = mini_res(lang, "holdout")
    l = res(summary, "llm", "hygiene", lang, "holdout", "high")
    rx = res(summary, "regex", "hygiene", lang, "holdout", "high")
    for label, r, p50, note in [("Jev, both tiers", j5, j5["latency"]["p50"], ""), ("Jev, high tier", j8, j8["latency"]["p50"], ""),
                                ("GPT-5.4-mini", m, m["p50"], '<span class="tag old">superseded</span>'),
                                ("GPT-6-Luna (low)", l, l["latency"]["p50"], '<span class="tag new">current baseline</span>'),
                                ("Regex", rx, 0, "")]:
        r1_table_rows.append([f"{label} {note}", lname, pct(r["precision"]), pct(r["recall"]), pct(r["f1"]), pct(r["cleanFalseAlarmRate"]), f"{p50:.0f} ms"])

practice_table_rows = []
for lname, lang in LANGS:
    for label, sysname, pol in [("Jev, both tiers", "jev", "high+medium"), ("Jev, high tier", "jev", "high"), ("GPT-6-Luna (low)", "llm", "high")]:
        r = res(summary, sysname, "practices", lang, "holdout", pol)
        practice_table_rows.append([label, lname, pct(r["precision"]), pct(r["recall"]), pct(r["f1"]), pct(r["cleanFalseAlarmRate"]), f"{r['latency']['p50']:.0f} ms"])

agree = {}
for x in r1_agreement:
    a = agree.setdefault(x["rule"], [0, 0, 0])
    g, j = x["grader"] > 0, x["jev"] >= 0.5
    if g and j:
        a[0] += 1
    elif j:
        a[1] += 1
    elif g:
        a[2] += 1
agree_rows = [[f"<code>{r}</code>", v[0], v[1], v[2]] for r, v in sorted(agree.items()) if any(v)]

e_none, e_jev = e2e_stats(p_graded, "none"), e2e_stats(p_graded, "jev")
consistency = summary.get("jevRunConsistency") or {}

practice_rule_table = []
DETERMINISTIC = {
    "react-derived-state-effect": "No", "react-effect-missing-cleanup": "No", "react-effect-fetch-race": "No",
    "react-effect-for-event": "No", "react-state-mutation": "Partly (eslint-plugin-react no-direct-mutation-state, class components only)",
    "react-index-key": "Partly (react/no-array-index-key flags every index key, static lists included)",
    "react-props-mirrored-in-state": "No", "ts-unvalidated-external-data": "No", "ts-sequential-await-loop": "Partly (no-await-in-loop flags every loop, dependent ones included)",
    "ts-boolean-trap": "No", "swiftui-observedobject-owned": "No", "swiftui-state-not-private": "Partly (SwiftLint private_swiftui_state, no intent check)",
    "swiftui-expensive-body": "No", "swiftui-task-in-onappear": "No", "swift-escaping-closure-retain-cycle": "No",
    "swift-blocking-main-thread": "No", "swift-continuation-misuse": "No (the runtime catches it only when it happens)",
    "swift-unprotected-shared-state": "Partly (Swift 6 strict concurrency, if the project enables it)", "swiftui-foreach-unstable-id": "No",
    "swift-dispatch-in-async": "No",
}
for lname, lang in LANGS:
    for rule in RULES_E4[(lang, "practices")]:
        practice_rule_table.append([f"<code>{rule['id']}</code>", esc(rule["fix"]), DETERMINISTIC.get(rule["id"], "—")])

# ---------------------------------------------------------------- Entry 4: local models

LOCAL = {
    "Kev-4B (MLX)": load(RES / "summary-local-kev-4b.json"),
    "Kev-0.8B (MLX)": load(RES / "summary-local-kev-0.8b.json"),
    "Laya (PyTorch GPU)": load(RES / "summary-local-laya-en-mps.json"),
}
ENCODER_BENCH = load(RES / "local/laya-en-encoder-bench-r21-s512.json")


def local_res(name, pack, lang, policy="high+medium"):
    return res(LOCAL[name], "local", pack, lang, "holdout", policy)


def local_best(name, pack, lang):
    pts = [p for p in LOCAL[name]["sweeps"] if p["pack"] == pack and p["lang"] == lang and p["split"] == "holdout"]
    return max(pts, key=lambda p: p["f1"])


local_series = [("Jev, both tiers", "jev", "s1"), ("Kev-4B, both tiers", "Kev-4B (MLX)", "s2"),
                ("Kev-4B, best threshold", "kev4-best", "s3"), ("Kev-0.8B, both tiers", "Kev-0.8B (MLX)", "s4"),
                ("Laya, both tiers", "Laya (PyTorch GPU)", "s4")]


def local_value(g, s):
    pack, lang = g
    if s == "jev":
        return f1("jev", pack, lang, "high+medium")
    if s == "kev4-best":
        return local_best("Kev-4B (MLX)", pack, lang)["f1"]
    return local_res(s, pack, lang)["f1"]


chart_local_f1 = grouped_bars(headline_groups, local_series[:4], local_value, "Held-out F1: Jev vs local models")


def mean_p50(summary_obj, system):
    vals = [r["latency"]["p50"] for r in summary_obj["results"] if r["system"] == system and r["split"] == "holdout" and r["policy"] == "high"]
    return st.mean(vals) / 1000


latency_local = [("Jev (API)", mean_p50(summary, "jev")), ("Kev-0.8B", mean_p50(LOCAL["Kev-0.8B (MLX)"], "local")),
                 ("Laya (GPU)", mean_p50(LOCAL["Laya (PyTorch GPU)"], "local")), ("Kev-4B", mean_p50(LOCAL["Kev-4B (MLX)"], "local"))]
chart_local_lat = grouped_bars(
    [(n, n) for n, _ in latency_local], [("Median seconds per edit", "lat", "s1")],
    lambda g, s: next(v for n, v in latency_local if n == g), "Median seconds per edit on held-out edits",
    fmt=lambda v: f"{v:.2f}s", max_v=4, ticks=(0, 1, 2, 3, 4), height=210,
)

local_rows = []
for name in LOCAL:
    for (pname, pack) in [("Hygiene", "hygiene"), ("Practices", "practices")]:
        for lname, lang in LANGS:
            both = local_res(name, pack, lang)
            high = local_res(name, pack, lang, "high")
            best = local_best(name, pack, lang)
            local_rows.append([name, f"{pname} · {lname}", pct(both["f1"]), pct(both["cleanFalseAlarmRate"]),
                               f"{pct(high['precision'])} / {pct(high['recall'])}", f"{pct(best['f1'])} at {best['threshold']:g}",
                               f"{both['latency']['p50'] / 1000:.1f} s"])

kev4_high = [b for b in LOCAL["Kev-4B (MLX)"]["bands"] if b["lo"] == 0.8]
kev4_high_real, kev4_high_total = sum(b["real"] for b in kev4_high), sum(b["findings"] for b in kev4_high)

bench_rows = []
LABELS = {"cpu": "ONNX Runtime, CPU (fp32)", "coreml-ane": "Core ML, CPU + Neural Engine", "coreml-gpu": "Core ML, CPU + GPU",
          "coreml-all": "Core ML, all units", "coreml-cpu": "Core ML, CPU only", "torch-mps": "PyTorch, Metal GPU"}
for key, label in LABELS.items():
    r = ENCODER_BENCH["results"].get(key, {})
    cov = r.get("coverage")
    bench_rows.append([label, f"{r.get('median_ms', 0) / 1000:.1f} s",
                       f"{cov['coreml_nodes']} of {cov['nodes']} nodes, {cov['partitions']} pieces" if cov else "—"])

# ---------------------------------------------------------------- Entry 5: gate, async, new rules, Codex

gate_groups = [("Hygiene · TS", "hygiene.typescript"), ("Hygiene · Swift", "hygiene.swift"),
               ("Practices · TS", "practices.typescript"), ("Practices · Swift", "practices.swift")]
GS = summary5["gateStats"]
chart_gate = grouped_bars(
    gate_groups, [("Rules in the pack", "rules", "s4"), ("Rules asked per edit after the gate (mean)", "asked", "s1")],
    lambda g, k: GS[g]["rules"] if k == "rules" else GS[g]["asked"] / GS[g]["cases"],
    "Rules asked per edit with the gate", fmt=lambda v: f"{v:.1f}", max_v=14, ticks=(0, 4, 8, 12), height=220,
)
gate_rows = []
for gl, key in gate_groups:
    pack, lang = key.split(".")
    for judge, sysname in [("Jev", "jev"), ("GPT-6-Luna", "llm")]:
        a = res(summary5, sysname, pack, lang, "holdout", "high+medium")
        b = res(summary5, sysname, pack, lang, "holdout", "gated high+medium")
        gate_rows.append([judge, gl, f"{pct(a['f1'])} → {pct(b['f1'])}", f"{pct(a['recall'])} → {pct(b['recall'])}",
                          f"{pct(a['cleanFalseAlarmRate'])} → {pct(b['cleanFalseAlarmRate'])}"])

NEW_RULES = ["react-async-overlap", "react-effect-fetch-race", "swift-continuation-cancellation", "swift-continuation-stored-overwrite", "swift-continuation-misuse"]
new_rule_rows = []
for rid in NEW_RULES:
    lang = "typescript" if rid.startswith(("react", "ts")) else "swift"
    cells = [f"<code>{rid}</code>"]
    for sysname, pol in [("jev", "gated high+medium"), ("llm", "gated high+medium")]:
        v = res(summary5, sysname, "practices", lang, "holdout", pol)["perRule"].get(rid)
        cells.append(f"{v['tp']}/{v['tp'] + v['fn']} found · {v['fp']} false" if v else "—")
    new_rule_rows.append(cells)

kev_before = LOCAL["Kev-4B (MLX)"]
kev_after = load(RES / "summary-local-kev-4b-gated.json")
chart_kev_gate = grouped_bars(
    headline_groups, [("Kev-4B, all rules (Entry 4)", "before", "s3"), ("Kev-4B, gated (Entry 5)", "after", "s1")],
    lambda g, k: res(kev_before if k == "before" else kev_after, "local", g[0], g[1], "holdout", "high+medium")["f1"],
    "Kev-4B held-out F1, before and after the gate",
)
kev_lat = [mean_p50(kev_before, "local"), mean_p50(kev_after, "local")]
BATCH = load(RES / "local/kev-4b-row-batching.json")
batch_rows = [[r["edit"], r["state_tokens"], r["rules"], r["rows_per_pass_default"], f"{r['batched_s']:.1f} s", f"{r['one_row_per_pass_s']:.1f} s"] for r in BATCH["results"]]

G5 = load(RES / "e2e-graded-entry5.json")
R5 = load(RES / "e2e-review-entry5.json")
conds5 = [("No hook", "none", "s4"), ("Jev, sync", "jev", "s2"), ("Jev, async rewake", "jev-rewake", "s1"), ("Kev-4B local, async rewake", "kev-rewake", "s3")]


def e5(cond):
    rows = [r for r in G5 if r["condition"] == cond]
    rs = [r for r in R5 if r["condition"] == cond]
    f = [x for r in rs for x in r["findings"]]
    return {
        "viol": st.mean(r["totalViolations"] for r in rows), "n": len(rows), "build": sum(r["build"]["ok"] for r in rows),
        "cost": st.mean(r["transcript"]["costUsd"] for r in rows), "dur": st.mean(r["transcript"]["durationMs"] for r in rows) / 1000,
        "high": sum(r["hook"]["highShown"] for r in rows), "med": sum(r["hook"]["mediumShown"] for r in rows),
        "lat": st.mean([r["hook"]["meanLatencyMs"] for r in rows if r["hook"]["calls"]] or [0]) / 1000,
        "errs": sum(r["hook"]["errors"] for r in rows), "calls": sum(r["hook"]["calls"] for r in rows),
        "inscope": sum(x["rule"] != "none" for x in f) / len(rs), "review": len(f) / len(rs),
    }


E5 = {c: e5(c) for _, c, _ in conds5}
chart_e5_viol = grouped_bars(
    [("Graded violations / task", "viol"), ("Minutes / task (x2)", "dur")], [(l, c, k) for l, c, k in conds5],
    lambda g, c: E5[c]["viol"] if g == "viol" else E5[c]["dur"] / 30,
    "Entry 5 end-to-end: violations and time per task", fmt=lambda v: f"{v:.2f}", max_v=3, ticks=(0, 1, 2, 3), height=230,
    tip_fn=lambda g, c, v: f"{c}: {E5[c]['viol']:.2f} violations" if g == "viol" else f"{c}: {E5[c]['dur']:.0f} s per task",
)
e5_rows = []
for label, c, _ in conds5:
    a = E5[c]
    diff = "—" if c == "none" else "{:+.2f} ({:+.2f} to {:+.2f})".format(*paired_diff(G5, c, lambda r: r["totalViolations"])[:3])
    e5_rows.append([label, f"{a['viol']:.2f}", diff, f"{a['dur']:.0f} s", f"${a['cost']:.3f}", f"{a['high']} / {a['med']}" if c != "none" else "—",
                    f"{a['lat']:.1f} s" if c != "none" else "—", f"{a['inscope']:.2f}", f"{a['build']}/{a['n']}"])

GC = load(RES / "e2e-graded-codex5.json")
codex_rows = []
for label, c in [("No hook", "none"), ("Jev hook (sync)", "jev")]:
    rows = [r for r in GC if r["condition"] == c]
    diff = "—" if c == "none" else "{:+.2f} ({:+.2f} to {:+.2f}); {} better, {} worse".format(*paired_diff(GC, c, lambda r: r["totalViolations"]))
    codex_rows.append([label, f"{st.mean(r['totalViolations'] for r in rows):.2f}", diff, f"{st.mean(r['wallMs'] for r in rows) / 1000:.0f} s",
                       f"{st.mean(r['transcript']['edits'] for r in rows):.1f}", str(sum(r['hook']['findingsShown'] for r in rows)), f"{sum(r['build']['ok'] for r in rows)}/{len(rows)}"])

# ---------------------------------------------------------------- Entry 6: JevLike, and is it worth it?

JL = {"Tiny byte encoder": load(RES / "local/jevlike-tiny.json"), "Frozen Qwen2.5-0.5B + head": load(RES / "local/jevlike-qwen05b.json")}
jl_rows = []
for name, d in JL.items():
    for pack, lang in [("hygiene", "typescript"), ("hygiene", "swift"), ("practices", "typescript"), ("practices", "swift")]:
        at5 = next(r for r in d["results"] if r["pack"] == pack and r["lang"] == lang and r["policy"] == "gated high+medium")
        best = next(r for r in d["results"] if r["pack"] == pack and r["lang"] == lang and r["policy"] == "gated best-threshold")
        jev = res(summary5, "jev", pack, lang, "holdout", "gated high+medium")
        jl_rows.append([name, f"{pack.title()} · {'TS' if lang == 'typescript' else 'Swift'}", pct(at5["f1"]),
                        f"{pct(best['f1'])} at {best['threshold']:g} ({pct(best['cleanFalseAlarmRate'])} clean flagged)", pct(jev["f1"])])

FIX = load(RES / "e2e-graded-entry5-fix.json")
FIXHOOK = load(RES / "e2e-graded-entry5-fixhook.json")
pipelines = [("No hook", "none", FIX, "none+fix"), ("Jev sync (fix round unhooked)", "jev", FIX, "jev+fix"),
             ("Jev async (fix round unhooked)", "jev-rewake", FIX, "jev-rewake+fix"), ("Jev async, always on", "jev-rewake", FIXHOOK, "jev-rewake+fixhook")]


def pipe(label, cond, src, fixcond):
    fx = [r for r in src if r["condition"] == fixcond]
    base = [r for r in G5 if r["condition"] == cond]
    return {"label": label, "build_cost": st.mean(r["transcript"]["costUsd"] for r in base), "fix_cost": st.mean(r["fix"]["costUsd"] for r in fx),
            "build_s": st.mean(r["transcript"]["durationMs"] for r in base) / 1000, "fix_s": st.mean(r["fix"]["durationMs"] for r in fx) / 1000,
            "before": st.mean(r["totalViolations"] for r in base), "after": st.mean(r["totalViolations"] for r in fx),
            "comments": st.mean(r["reviewFindings"] for r in fx), "covered": st.mean(r["ruleCoveredFindings"] for r in fx)}


PIPES = [pipe(*p) for p in pipelines]
chart_pipe_cost = hbar_stack([(p["label"].replace(" (fix round unhooked)", ""), [round(p["build_cost"], 3), round(p["fix_cost"], 3)]) for p in PIPES],
                             [("Build round ($)", "s2"), ("Review fix round ($)", "s3")], "Agent cost per task, build plus one review-fix round")
chart_pipe_viol = grouped_bars([(p["label"].replace(" (fix round unhooked)", ""), p["label"]) for p in PIPES],
                               [("Before review", "before", "s3"), ("After review + fix", "after", "s1")],
                               lambda g, k: next(p[k] for p in PIPES if p["label"] == g), "Graded rule violations per task",
                               fmt=lambda v: f"{v:.2f}", max_v=3, ticks=(0, 1, 2, 3), height=230)
nonefix = {(r["task"], r["rep"]): r for r in FIX if r["condition"] == "none+fix"}


def pipe_diff(src, fixcond, key):
    d = []
    for r in src:
        if r["condition"] != fixcond:
            continue
        b = nonefix[(r["task"], r["rep"])]
        d.append(key(r) - key(b))
    random.seed(0)
    boot = sorted(st.mean(random.choices(d, k=len(d))) for _ in range(5000))
    return st.mean(d), boot[125], boot[4875], sum(x < 0 for x in d), sum(x > 0 for x in d)


pipe_rows = []
for (label, cond, src, fixcond), p in zip(pipelines, PIPES):
    total_cost = lambda r: r["original"]["costUsd"] + r["fix"]["costUsd"]
    viol = "—" if cond == "none" else "{:+.2f} ({:+.2f} to {:+.2f}); {} better, {} worse".format(*pipe_diff(src, fixcond, lambda r: r["totalViolations"]))
    cost = "—" if cond == "none" else "{:+.3f} ({:+.3f} to {:+.3f})".format(*pipe_diff(src, fixcond, total_cost)[:3])
    pipe_rows.append([label, f"{p['comments']:.2f} ({p['covered']:.2f})", f"${p['build_cost'] + p['fix_cost']:.3f}", cost,
                      f"{p['build_s'] + p['fix_s']:.0f} s", f"{p['before']:.2f} → {p['after']:.2f}", viol])

# ---------------------------------------------------------------- Entry 7: rule packs, security, faster checks

# 7.1 More rules per call. Current (pooled connection) run; the unpooled first run is kept as superseded.
BENCH = load(RES / "bench-rule-count.json")
BENCH_OLD = load(SNAP / "bench-rule-count-2026-09-27-unpooled-baseline.json")


def bench(src, size, mode):
    return next(r for r in src["summary"] if r["size"] == size and r["mode"] == mode)


bench_targets = bench(BENCH, "targets", "targets-only")
bench_own = st.mean(r["targets"] for r in BENCH["rows"] if r["mode"] == "targets-only")
bench_groups = [(f"Own rules only (~{bench_own:.0f})", "targets"), ("Padded to 25", 25), ("Padded to 50", 50), ("Padded to 100", 100)]


def bench_ms(size, mode):
    if size == "targets":
        return bench_targets["msP50"] if mode == "one-request" else None
    return bench(BENCH, size, mode)["msP50"]


chart_bench = grouped_bars(
    bench_groups, [("One request", "one-request", "s1"), ("Split into parallel requests of 10 rules", "parallel-10", "s3")],
    lambda g, m: bench_ms(g, m), "Median milliseconds per check by number of rules asked",
    fmt=lambda v: f"{v:.0f}", max_v=700, ticks=(0, 175, 350, 525, 700), height=230,
    tip_fn=lambda g, m, v: f"{m}, {g} rules: {v:.0f} ms median",
)
bench_rows = []
for label, size in bench_groups:
    for mode, mlabel in [("targets-only", "one request"), ("one-request", "one request"), ("parallel-10", "parallel, 10 per request")]:
        if (size == "targets") != (mode == "targets-only"):
            continue
        r = bench(BENCH, size, mode)
        bench_rows.append([label, mlabel, pct(r["targetF1"]), f"{r['msP50']:.0f} ms", f"{r['msP90']:.0f} ms", f"{r['tokensMean']:,.0f}", f"{r['maxAbsDrift']:.2f}"])
bench_old_rows = []
for size in (25, 50, 100):
    for mode, mlabel in [("one-request", "one request"), ("parallel-10", "parallel, 10 per request")]:
        a, b = bench(BENCH_OLD, size, mode), bench(BENCH, size, mode)
        bench_old_rows.append([f"Padded to {size}", mlabel, f"{a['msP50']:.0f} ms", f"{b['msP50']:.0f} ms"])
b100, p100 = bench(BENCH, 100, "one-request"), bench(BENCH, 100, "parallel-10")
BENCH_F1_MIN = min(r["targetF1"] for r in BENCH["summary"] if r["size"] != "targets")
BENCH_F1_MAX = max(r["targetF1"] for r in BENCH["summary"] if r["size"] != "targets")
BENCH_DRIFT = max(r["maxAbsDrift"] for r in BENCH["summary"])

# 7.2 New packs. Each rule is grouped by the pack it lives in now (21 security rules moved out of
# practices after the holdout run; their scores come from the security holdout summary).
PH = load(RES / "summary-packs-holdout.json")
SH = load(RES / "summary-security-holdout.json")
SM = load(RES / "summary-security-moved-holdout.json")
PACK_STATUS = load(RES / "pack-status.json")
BEFORE_PACKS = load(SNAP / "summary-2026-09-27-before-new-packs.json")
V4 = load(RES / "summary-v4-holdout-jev.json")
RULE_HOME = {}
for f in sorted((ROOT / "rules").glob("*.json")):
    parts = f.stem.split(".")
    for r in load(f)["rules"]:
        RULE_HOME[r["id"]] = ("hygiene" if len(parts) == 1 else parts[1], parts[0], r.get("status"))


def per_rule(s, system, policy):
    out = {}
    for r in s["results"]:
        if r["system"] == system and r["split"] == "holdout" and r["policy"] == policy:
            out.update(r.get("perRule") or {})
    return out


def rule_ids(s):
    return {k for r in s["results"] for k in (r.get("perRule") or {})}


def passes(s, system, rid):
    """Same bar as src/validate.ts and eval/pack-status.ts, set before these results."""
    m, h = per_rule(s, system, "gated high+medium").get(rid), per_rule(s, system, "gated high").get(rid)
    if not m:
        return None
    pah = h["tp"] / (h["tp"] + h["fp"]) if h and h["tp"] + h["fp"] else 1
    return m["tp"] + m["fn"] >= 3 and pah >= 0.9 and m["precision"] >= 0.75 and m["recall"] >= 0.8


NEW_CANDIDATES = sorted(rule_ids(PH) - rule_ids(BEFORE_PACKS) - rule_ids(V4))
NEW_SECURITY = sorted(rule_ids(SH) - rule_ids(SM))
MOVED_SECURITY = sorted(rule_ids(SM))
pass_jev = [r for r in NEW_CANDIDATES if passes(PH, "jev", r)]
pass_luna = [r for r in NEW_CANDIDATES if passes(PH, "llm", r)]
sec_jev = [r for r in NEW_SECURITY if passes(SH, "jev", r)]
sec_luna = [r for r in NEW_SECURITY if passes(SH, "llm", r)]
moved_same = all(per_rule(SM, "jev", "gated high+medium")[r] == per_rule(PH, "jev", "gated high+medium")[r] for r in MOVED_SECURITY)
moved_pass_same = all(passes(SM, "jev", r) == passes(PH, "jev", r) for r in MOVED_SECURITY)
if not (moved_same and moved_pass_same):
    raise SystemExit("moved security rules changed score; update the Entry 7 prose")
live = {}
for rid, (pack, _, status) in RULE_HOME.items():
    if status != "candidate":
        live[pack] = live.get(pack, 0) + 1
PACK_ORDER = ["hygiene", "practices", "security", "tests", "performance"]


def pack_f1(system, pack):
    src = SH if pack == "security" else PH
    tp = fp = fn = 0
    for rid, v in per_rule(src, system, "gated high+medium").items():
        if RULE_HOME.get(rid, (None,))[0] != pack:
            continue
        tp, fp, fn = tp + v["tp"], fp + v["fp"], fn + v["fn"]
    p, r = tp / (tp + fp), tp / (tp + fn)
    return {"f1": 2 * p * r / (p + r), "p": p, "r": r, "rules": sum(1 for rid in per_rule(src, system, "gated high+medium") if RULE_HOME.get(rid, (None,))[0] == pack)}


PF = {(s, p): pack_f1(s, p) for s in ("jev", "llm") for p in PACK_ORDER}
chart_packs = grouped_bars(
    [(p.title(), p) for p in PACK_ORDER], [("Jev, both tiers (gated)", "jev", "s1"), ("GPT-6-Luna (low, gated)", "llm", "s3")],
    lambda p, s: PF[(s, p)]["f1"], "Held-out F1 by pack, Jev vs GPT-6-Luna, all evaluated rules",
    max_v=1.0, ticks=(0, 0.25, 0.5, 0.75, 1.0), height=230,
    tip_fn=lambda p, s, v: f"{s} · {p}: F1 {pct(v, 1)}, precision {pct(PF[(s, p)]['p'], 1)}, recall {pct(PF[(s, p)]['r'], 1)} over {PF[(s, p)]['rules']} rules",
)
pack_rows = []
for p in PACK_ORDER:
    a, b = PF[("jev", p)], PF[("llm", p)]
    pack_rows.append([p.title(), str(a["rules"]), str(live.get(p, 0)), f"{pct(a['p'])} / {pct(a['r'])}", pct(a["f1"], 1), f"{pct(b['p'])} / {pct(b['r'])}", pct(b["f1"], 1)])
cand_rows = []
for rid, (pack, lang, status) in sorted(RULE_HOME.items(), key=lambda kv: (kv[1][0], kv[0])):
    if status != "candidate":
        continue
    s = PACK_STATUS[rid]
    # Drop parentheticals: the dry-run reason names a private repo's file.
    reasons = "; ".join(esc(re.sub(r"\s*\([^)]*\)", "", x)) for x in s["reasons"])
    cand_rows.append([f"<code>{rid}</code>", f"{pack} · {lang}", f"{s['positives']}", pct(s["precision"]), pct(s["recall"]), reasons])
CM = PACK_STATUS["swift-continuation-misuse"]
CM_B1 = per_rule(load(RES / "summary-packs-holdout-b1.json"), "jev", "gated high+medium")["swift-continuation-misuse"]

# 7.3 End to end with the new packs.
GP = load(RES / "e2e-graded-packs.json")
RP = load(RES / "e2e-review-packs.json")


def e7(rows, cond, metric):
    return st.mean(metric(r) for r in rows if r["condition"] == cond)


def e7_ci(rows, metric):
    return paired_diff(rows, "jev-rewake", metric)


tv = lambda r: r["totalViolations"]
covered = lambda r: sum(x["rule"] != "none" for x in r["findings"])
allf = lambda r: len(r["findings"])
wall = lambda r: r["wallMs"] / 1000
cost = lambda r: r["transcript"]["costUsd"]
E7_METRICS = [
    ("Graded rule violations / task, all tasks", GP, tv, None, 2),
    ("… SwiftUI tasks", GP, tv, "swift", 2),
    ("… React tasks", GP, tv, "typescript", 2),
    ("Reviewer findings a rule covers / task", RP, covered, None, 2),
    ("All reviewer findings / task", RP, allf, None, 2),
    ("Agent cost / task", GP, cost, None, "$"),
    ("Wall time / task", GP, wall, None, "s"),
]
E7 = {}
e7_rows = []
for label, src, metric, lang, fmt in E7_METRICS:
    rows = [r for r in src if lang is None or r["lang"] == lang]
    a, b = e7(rows, "none", metric), e7(rows, "jev-rewake", metric)
    d = e7_ci(rows, metric)
    E7[label] = (a, b, d)
    f = (lambda v: f"${v:.2f}") if fmt == "$" else (lambda v: f"{v:.0f} s") if fmt == "s" else (lambda v: f"{v:.2f}")
    fd = (lambda v: f"{v:+.2f}") if fmt in ("$", 2) else (lambda v: f"{v:+.0f}")
    e7_rows.append([label, f(a), f(b), f"{fd(d[0])} ({fd(d[1])} to {fd(d[2])})", f"{d[3]} / {d[4]} / {len(rows) // 2 - d[3] - d[4]}"])
chart_e7 = grouped_bars(
    [("All tasks", None), ("SwiftUI tasks", "swift"), ("React tasks", "typescript")],
    [("No hook", "none", "s4"), ("Jev, async rewake, all packs", "jev-rewake", "s1")],
    lambda lang, c: e7([r for r in GP if lang is None or r["lang"] == lang], c, tv),
    "Graded rule violations per task in final code, all packs", fmt=lambda v: f"{v:.2f}", max_v=3, ticks=(0, 1, 2, 3), height=220,
)
E7_HOOK = [r for r in GP if r["condition"] == "jev-rewake"]
E7_CALLS, E7_ERRS = sum(r["hook"]["calls"] for r in E7_HOOK), sum(r["hook"]["errors"] for r in E7_HOOK)
E7_HIGH, E7_MED = sum(r["hook"]["highShown"] for r in E7_HOOK), sum(r["hook"]["mediumShown"] for r in E7_HOOK)
E7_HOOK_MS = st.mean(r["hook"]["meanLatencyMs"] for r in E7_HOOK if r["hook"]["calls"])
E5_NONE = st.mean(r["totalViolations"] for r in G5 if r["condition"] == "none")

# 7.4 Fine-tuned Kev-4B. Same held-out cases as the stock gated run plus the test-validity cases;
# F1 is pooled over rules, excluding the two test-validity rules the stock run never saw.
KEV_FT = load(RES / "summary-local-kev-4b-ft.json")
TEST_RULES = {"ts-test-cannot-fail", "swift-test-cannot-fail"}


def pooled_f1(s, system, pack, lang, policy, keep):
    r = res(s, system, pack, lang, "holdout", policy)
    tp = fp = fn = 0
    for rid, v in r["perRule"].items():
        if keep(rid):
            tp, fp, fn = tp + v["tp"], fp + v["fp"], fn + v["fn"]
    p, rc = (tp / (tp + fp) if tp + fp else 1), (tp / (tp + fn) if tp + fn else 1)
    return 2 * p * rc / (p + rc) if p + rc else 0


not_test = lambda rid: rid not in TEST_RULES
FT = {
    g: {"ft": pooled_f1(KEV_FT, "local", g[0], g[1], "high+medium", not_test),
        "stock": pooled_f1(kev_after, "local", g[0], g[1], "high+medium", not_test),
        "jev": pooled_f1(summary5, "jev", g[0], g[1], "gated high+medium", not_test),
        "tests": pooled_f1(KEV_FT, "local", g[0], g[1], "high+medium", lambda rid: rid in TEST_RULES) if g[0] == "practices" else None,
        "p50": res(KEV_FT, "local", g[0], g[1], "holdout", "high+medium")["latency"]["p50"] / 1000}
    for _, g in headline_groups
}
chart_ft = grouped_bars(
    headline_groups, [("Kev-4B stock, gated (Entry 5)", "stock", "s3"), ("Kev-4B fine-tuned", "ft", "s2"), ("Jev, gated", "jev", "s1")],
    lambda g, k: FT[g][k], "Held-out F1, both tiers: stock vs fine-tuned Kev-4B vs Jev (test-validity rules excluded)",
)
ft_rng = lambda k, packs: (min(FT[g][k] for _, g in headline_groups if g[0] in packs), max(FT[g][k] for _, g in headline_groups if g[0] in packs))
FT_TESTS = [FT[g]["tests"] for _, g in headline_groups if g[0] == "practices"]
FT_P50 = [FT[g]["p50"] for _, g in headline_groups]
ft_range = lambda k, pack: "–".join(dict.fromkeys(f"{v * 100:.0f}" for v in ft_rng(k, (pack,)))) + "%"

# 7.6 Onboarding skill eval. The fixtures and per-run results are private; only anonymised
# aggregates are published. When the private result files exist, check the aggregates still match.
SKILL = {"v1": {"runs": 10, "done": 10, "rules": 10.3, "rules_min": 4, "cov": 0.35, "cov_min": 0.18, "research": 0, "tests": 0, "cost": 3.00},
         "v2": {"runs": 10, "done": 9, "rules": 12.3, "rules_min": 8, "cov": 0.39, "cov_min": 0.35, "research": 9, "tests": 2, "cost": 3.10}}
SKILL_DIR = Path.home() / ".local/share/jev-lint/skill-evals/results"
for key, fname in (("v1", "baseline-claude.json"), ("v2", "v2-claude.json")):
    p = SKILL_DIR / fname
    if not p.exists():
        continue
    rs = load(p)["results"]
    done = [r for r in rs if r.get("rules") is not None and r.get("conventionRecall") is not None]
    got = {"runs": len(rs), "done": len(done), "rules": round(st.mean(r["rules"] for r in done), 1), "rules_min": min(r["rules"] for r in done),
           "cov": round(st.mean(r["conventionRecall"] for r in done), 2), "cov_min": round(min(r["conventionRecall"] for r in done), 2),
           "research": sum((r.get("researched") or 0) > 0 for r in done), "tests": sum(bool(r.get("testValidity")) for r in done),
           "cost": round(st.mean(r["costUsd"] for r in done), 2)}
    if got != SKILL[key]:
        raise SystemExit(f"skill eval aggregates changed for {key}: {got}")
S1, S2 = SKILL["v1"], SKILL["v2"]
skill_rows = [
    ["Runs that finished", f"{S1['done']} of {S1['runs']}", f"{S2['done']} of {S2['runs']} (one hit the 30-minute cap)"],
    ["Rules proposed per run, mean (min)", f"{S1['rules']:.1f} ({S1['rules_min']})", f"{S2['rules']:.1f} ({S2['rules_min']})"],
    ["Jev-checkable conventions covered, mean (min)", f"{pct(S1['cov'])} ({pct(S1['cov_min'])})", f"{pct(S2['cov'])} ({pct(S2['cov_min'])})"],
    ["Runs that did web research", f"{S1['research']} of {S1['done']}", f"{S2['research']} of {S2['done']}"],
    ["Runs that proposed a test-validity rule", f"{S1['tests']} of {S1['done']}", f"{S2['tests']} of {S2['done']}"],
    ["Agent cost per finished run", f"${S1['cost']:.2f}", f"${S2['cost']:.2f}"],
]

# ---------------------------------------------------------------- Entry 8: local model, accuracy and speed

# The autoresearch ledgers and score files live in local/autoresearch/.autoresearch and
# round3/.autoresearch, which are not committed. The numbers the page needs are copied here;
# when the ledgers exist, they are re-read and must match, so the page can't drift from them.
AR = ROOT / "local/autoresearch"
# Round 2: (id, TUNE F1 per seed, decision, TUNE clean false alarms %, training seconds)
R2 = [("r1-baseline", (94.53,), "keep", 2.99, 11963), ("e01-thr-global", (94.19,), "discard", 4.32, None),
      ("e02-epochs1", (92.81, 91.7), "discard", 3.32, 6022), ("e03-replay500", (93.65,), "discard", 3.32, 10727),
      ("e04-gate-train", (93.42, 93.68), "keep (cost)", 3.32, 5107), ("e05-epochs3", (93.79,), "discard", 3.99, 7628),
      ("e06-pos2", (93.91,), "discard", 3.65, 6668), ("e07-lr5e5", (93.63,), "discard", 2.33, 5122),
      ("e08-focal", (93.01,), "discard", 3.32, 5114), ("e09-hardneg2", (94.58, 93.48), "discard", 3.65, 5561),
      ("e10-headlr", (92.98,), "discard", 3.32, 5136), ("e11-brier", (93.68,), "discard", 3.32, 5158),
      ("e12-paths", (95.48, 95.26), "keep", 3.32, 8254), ("e13-paths2", (93.97,), "discard", 3.99, 11437),
      ("e14-paths-hardneg2", (94.12,), "discard", 3.32, None), ("e15-dup-control", (94.6,), "discard", 3.65, None)]
# Round 3: (id, median of trial medians ms, p90 ms, subset F1, subset clean false alarms %, decision)
R3 = [("r3-baseline", 1986.8, 6223.7, 95.48, 3.28, "keep"), ("e01-wired", 1977.2, 5723.9, 95.48, 3.28, "discard"),
      ("e02-kev08", 326.8, 895.8, 75.64, 12.7, "checks_failed"), ("e03-rows", 1606.5, 3503.05, 95.48, 3.28, "keep"),
      ("e04-kev08-rf", None, None, None, None, "crash"), ("e04-kev08-rf-r", 118.3, 343.5, 71.72, 13.11, "checks_failed"),
      ("e05-q8", 1615.6, 3433.9, 95.48, 3.28, "discard"), ("e06-nofalse", 1312.3, 2629.9, 89.37, 9.02, "checks_failed"),
      ("e07-ane-probe", None, None, None, None, "discard"), ("e08-q4", 1880.2, 3965.4, 93.26, 4.1, "checks_failed"),
      ("e09-rows35", 1798.8, 4179.2, 95.48, 3.28, "discard"), ("e10-kev4b-rf", 828.1, 2813.5, 93.45, 3.69, "checks_failed"),
      ("e11-rf-cascade", 1079.7, 3082.2, 95.43, 2.87, "checks_failed"), ("e12-rf-cascade19", 1273.0, 3248.1, 96.3, 2.46, "checks_failed"),
      ("e13-rf2b-cascade", 734.4, 1914.1, 94.29, 3.28, "keep"), ("e14-fb-rf4b", 545.6, 1587.9, 92.75, 3.28, "checks_failed"),
      ("e15-band28", 533.8, 1553.9, 91.69, 4.51, "checks_failed"), ("e16-onepass", 647.7, 1786.45, 94.29, 3.28, "keep"),
      ("e17-calband", 550.9, 1879.4, 92.96, 4.92, "checks_failed"), ("e18-wired-cascade", 636.4, 1603.9, 94.29, 3.28, "discard"),
      ("e19-qos", 623.7, 1713.85, 94.29, 3.28, "discard"), ("e20-kev4b-ri", 245.3, 390.8, 72.39, 9.84, "checks_failed"),
      ("e21-chain3", 540.5, 1699.5, 94.52, 2.87, "discard"), ("e22-chain3-ab", 459.7, 1541.8, 94.52, 2.87, "keep"),
      ("e23-kev2b-rf-ep3", None, None, None, None, "discard")]
E22_PAIRED_INCUMBENT = (528.2, 668.4, 554.0, 573.0, 915.8)  # e16, measured interleaved with e22 (amendment A3)
# HOLDOUT (all 2,089 held-out edits, all five packs), scored by local/autoresearch/score.ts:
# score file -> (tp, fp, fn, clean, clean flagged, {pack: (F1 %, clean FA %)}, precision at p >= 0.8 or None)
HO = {
    "r1-baseline": (819, 40, 56, 1314, 31, {"hygiene": (94.5, 3.8), "practices": (93.9, 3.2), "security": (96.0, 0.6), "tests": (92.9, 3.7), "performance": (98.5, 0.7)}, None),
    "e12-paths": (825, 34, 50, 1314, 26, {"hygiene": (93.9, 1.9), "practices": (94.8, 2.5), "security": (97.6, 0.3), "tests": (93.4, 3.3), "performance": (97.7, 1.4)}, None),
    "mac-e12-paths": (824, 35, 51, 1314, 27, {"hygiene": (93.4, 3.8), "practices": (94.7, 2.5), "security": (97.6, 0.3), "tests": (93.4, 3.3), "performance": (97.7, 1.4)}, None),
    "r3-e16-onepass": (804, 27, 71, 1314, 22, None, 97.2),
    "r3-e22-chain3-ab": (809, 28, 66, 1314, 20, {"hygiene": (96.0, 3.8), "practices": (94.1, 1.7), "security": (93.2, 1.2), "tests": (94.3, 1.7), "performance": (98.5, 0.7)}, 96.8),
}
# Jev on the same 2,089 held-out edits, scored the same way (score.ts's scoreCases: the case's own
# pack, shipped rules, gated, p >= 0.5, in-scope rules only), from Jev's cached Entry 7 judgments in
# eval/results/cache. Computed by hand for Entry 8; there is no committed result file.
JEV_HO = (861, 19, 14, 1314, 11, {"hygiene": (100.0, 0.0), "practices": (97.5, 1.3), "security": (98.5, 0.3), "tests": (97.9, 0.7), "performance": (98.5, 1.4)}, None)


def _ar_check():
    led2, led3, sc = AR / ".autoresearch/results.jsonl", AR / "round3/.autoresearch/results.jsonl", AR / ".autoresearch/scores"
    if not (led2.exists() and led3.exists()):
        return
    got2 = []
    for line in led2.read_text().splitlines():
        r = json.loads(line)
        got2.append((r["id"], tuple(r["measured_trials"]), r.get("label") or r["disposition"], round(r["secondary_metrics"]["clean_fa"], 2), r.get("train_s")))
    got3 = []
    for line in led3.read_text().splitlines():
        r = json.loads(line)
        a, tr = r.get("accuracy") or {}, r.get("measured_trials") or []
        got3.append((r["id"], round(st.median(tr), 1) if tr else None, r.get("secondary_metrics", {}).get("p90_ms"), a.get("f1"), a.get("clean_fa"), r["disposition"]))
        if r["id"] == "e22-chain3-ab" and tuple(r["paired_incumbent_trials"]) != E22_PAIRED_INCUMBENT:
            raise SystemExit("Entry 8: e22's paired incumbent trials changed; update E22_PAIRED_INCUMBENT")
    if got2 != R2:
        raise SystemExit(f"Entry 8: round-2 ledger changed: {got2}")
    if got3 != R3:
        raise SystemExit(f"Entry 8: round-3 ledger changed: {got3}")
    for name, want in HO.items():
        d = load(sc / f"{name}.holdout.json")
        t = d["total"]
        packs = {p: (round(v["f1"] * 100, 1), round(v["cleanFA"] * 100, 1)) for p, v in d["byPack"].items()} if want[5] else None
        p8 = round(d["precisionAt08"] * 100, 1) if "precisionAt08" in d else None
        if (t["tp"], t["fp"], t["fn"], t["clean"], t["cleanFlagged"], packs, p8) != want:
            raise SystemExit(f"Entry 8: HOLDOUT score file {name} changed")


_ar_check()


def ho(row):
    tp, fp, fn, clean, cf = row[:5]
    p, r = tp / (tp + fp), tp / (tp + fn)
    return {"f1": 2 * p * r / (p + r), "p": p, "r": r, "fa": cf / clean, "pos": tp + fn, "packs": row[5], "p8": row[6]}


H = {k: ho(v) for k, v in HO.items()}
HJ = ho(JEV_HO)
f1s = lambda v: f"{v * 100:.2f}"


def r2_chart():
    """Round 2: TUNE F1 per experiment (each seed a dot), the incumbent and the +1.0 keep bar."""
    w, h, left, right, top, bottom = 680, 270, 44, 10, 16, 40
    lo, hi = 91.5, 96.5
    pw, ph = w - left - right, h - top - bottom
    gw = pw / len(R2)
    X = lambda i: left + gw * (i + 0.5)
    Y = lambda v: top + ph * (1 - (v - lo) / (hi - lo))
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="Round 2: TUNE F1 per experiment, with the incumbent and the keep bar" class="chart">']
    for v in (92, 93, 94, 95, 96):
        out.append(f'<line x1="{left}" x2="{w - right}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="grid"/>')
        out.append(f'<text x="{left - 6}" y="{Y(v) + 4:.1f}" class="tick" text-anchor="end">{v}</text>')
    # Incumbent before each experiment: the baseline until e04 is kept (cost rule), then e04 until e12.
    inc = []
    cur = None
    for rid, seeds, dec, _, _ in R2:
        inc.append(cur)
        if dec.startswith("keep"):
            cur = round(st.mean(seeds), 2)
    segs = []
    for i, v in enumerate(inc):
        if v is None:
            continue
        if segs and segs[-1][2] == v:
            segs[-1][1] = i
        else:
            segs.append([i, i, v])
    for a, b, v in segs:
        x0, x1 = X(a) - gw / 2 + 2, X(b) + gw / 2 - 2
        out.append(f'<line x1="{x0:.1f}" x2="{x1:.1f}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="ln s2" stroke-width="1.5"><title>Incumbent: {v:.2f}</title></line>')
        out.append(f'<line x1="{x0:.1f}" x2="{x1:.1f}" y1="{Y(v + 1):.1f}" y2="{Y(v + 1):.1f}" class="marker"><title>Keep bar: {v + 1:.2f}</title></line>')
    for i, (rid, seeds, dec, fa, _) in enumerate(R2):
        cls = "s1" if dec.startswith("keep") else "s3"
        short = "base" if rid == "r1-baseline" else rid.split("-")[0]
        if len(seeds) > 1:
            out.append(f'<line x1="{X(i):.1f}" x2="{X(i):.1f}" y1="{Y(max(seeds)):.1f}" y2="{Y(min(seeds)):.1f}" class="ln {cls}" stroke-width="1.5"/>')
        for s in seeds:
            out.append(f'<circle cx="{X(i):.1f}" cy="{Y(s):.1f}" r="3.6" class="pt {cls}"><title>{rid}: TUNE F1 {s:.2f}{" (seeds " + " / ".join(f"{x:.2f}" for x in seeds) + ")" if len(seeds) > 1 else ""}, {dec}</title></circle>')
        if dec.startswith("keep"):
            out.append(f'<text x="{X(i):.1f}" y="{Y(max(seeds)) - 8:.1f}" class="val" text-anchor="middle">{st.mean(seeds):.2f}</text>')
        out.append(f'<text x="{X(i):.1f}" y="{h - 22}" class="tick" text-anchor="middle">{short}</text>')
    out.append(f'<text x="{left + pw / 2:.1f}" y="{h - 4}" class="tick" text-anchor="middle">experiment, in the order run</text>')
    out.append("</svg>")
    legend = ('<span class="key"><i class="sw s1"></i>Kept</span><span class="key"><i class="sw s3"></i>Discarded</span>'
              '<span class="key"><i class="sw s2" style="height:2px"></i>Incumbent</span><span class="key"><i class="sw dash"></i>Keep bar (incumbent + 1.0)</span>')
    return f'<figure>{"".join(out)}<div class="legend">{legend}</div></figure>'


R3_TIMED = [r for r in R3 if r[1] is not None]
R3_GATE_FAIL = {"e02-kev08", "e04-kev08-rf-r", "e06-nofalse", "e08-q4", "e10-kev4b-rf", "e11-rf-cascade", "e12-rf-cascade19",
                "e14-fb-rf4b", "e15-band28", "e17-calband", "e20-kev4b-ri"}
if {r[0] for r in R3 if r[5] == "checks_failed"} != R3_GATE_FAIL:
    raise SystemExit("Entry 8: gate-failed set changed")


def ms(v):
    """Milliseconds, rounded half up like the ledger notes (1,606.5 -> 1,607)."""
    return f"{int(v + 0.5):,}"


def r3_chart():
    """Round 3: median ms per check per experiment on a log scale, best so far, and the two targets."""
    import math
    w, h, left, right, top, bottom = 680, 290, 52, 10, 14, 40
    lo, hi = 100, 2500
    pw, ph = w - left - right, h - top - bottom
    gw = pw / len(R3_TIMED)
    X = lambda i: left + gw * (i + 0.5)
    Y = lambda v: top + ph * (1 - (math.log10(v) - math.log10(lo)) / (math.log10(hi) - math.log10(lo)))
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="Round 3: median milliseconds per check per experiment, log scale, with the 343 and 230 ms targets" class="chart">']
    for v in (100, 200, 500, 1000, 2000):
        out.append(f'<line x1="{left}" x2="{w - right}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="grid"/>')
        out.append(f'<text x="{left - 6}" y="{Y(v) + 4:.1f}" class="tick" text-anchor="end">{v:,}</text>')
    out.append(f'<text x="{left - 6}" y="{top - 2}" class="tick" text-anchor="end">ms</text>')
    for v, lab in ((343, "343 ms: cloud Jev, live"), (230, "230 ms: Jev, warm connection")):
        out.append(f'<line x1="{left}" x2="{w - right}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" class="marker"/>')
        out.append(f'<text x="{left + 4}" y="{Y(v) - 4:.1f}" class="tick">{lab}</text>')
    best, pts = None, []
    for i, (rid, med, p90, f1v, fa, dec) in enumerate(R3_TIMED):
        if dec == "keep":
            best = med
        pts.append((i, best))
    step = []
    for i, b in pts:
        step.append(f"{X(i) - gw / 2:.1f},{Y(b):.1f} {X(i) + gw / 2:.1f},{Y(b):.1f}")
    out.append(f'<polyline points="{" ".join(step)}" class="ln s2" stroke-width="1.5"/>')
    for i, (rid, med, p90, f1v, fa, dec) in enumerate(R3_TIMED):
        short = "0" if rid == "r3-baseline" else str(int(rid.split("-")[0][1:]))
        gate = "gate failed" if rid in R3_GATE_FAIL else "gate passed"
        tip = f"{rid}: median {ms(med)} ms, p90 {ms(p90)} ms; subset F1 {f1v:.2f}, clean FA {fa:.1f}%; {gate}; {dec.replace('checks_failed', 'not kept')}"
        if rid in R3_GATE_FAIL:
            out.append(f'<circle cx="{X(i):.1f}" cy="{Y(med):.1f}" r="3.6" class="hollow"><title>{esc(tip)}</title></circle>')
        else:
            cls = "s1" if dec == "keep" else "s3"
            out.append(f'<circle cx="{X(i):.1f}" cy="{Y(med):.1f}" r="3.8" class="pt {cls}"><title>{esc(tip)}</title></circle>')
        if dec == "keep" or rid in ("e04-kev08-rf-r", "e20-kev4b-ri"):
            out.append(f'<text x="{X(i):.1f}" y="{Y(med) + 16:.1f}" class="val" text-anchor="middle">{ms(med)}</text>')
        out.append(f'<text x="{X(i):.1f}" y="{h - 22}" class="tick" text-anchor="middle">{short}</text>')
    out.append(f'<text x="{left + pw / 2:.1f}" y="{h - 4}" class="tick" text-anchor="middle">experiment number, in the order run (0 = baseline; e07 and e23 had no timing)</text>')
    out.append("</svg>")
    legend = ('<span class="key"><i class="sw s1"></i>Kept</span><span class="key"><i class="sw s3"></i>Passed the gate, not fast enough</span>'
              '<span class="key"><i class="sw hollow"></i>Failed the accuracy gate</span><span class="key"><i class="sw s2" style="height:2px"></i>Best so far</span>'
              '<span class="key"><i class="sw marker"></i>Targets</span>')
    return f'<figure>{"".join(out)}<div class="legend">{legend}</div></figure>'


r3 = {r[0]: r for r in R3}
E22, E16P = r3["e22-chain3-ab"], st.median(E22_PAIRED_INCUMBENT)
E8_TRAIN_H = {k: v / 3600 for k, _, _, _, v in R2 if v}
seed_spread = max(max(s) - min(s) for _, s, _, _, _ in R2 if len(s) > 1)
HE22, HE12, HE12M, HB = H["r3-e22-chain3-ab"], H["e12-paths"], H["mac-e12-paths"], H["r1-baseline"]
PACK_ORDER8 = ["hygiene", "practices", "security", "tests", "performance"]
cell = lambda d, p: f"{d['packs'][p][0]:.1f} ({d['packs'][p][1]:.1f}%)"
e8_pack_rows = [[p.title(), cell(HB, p), cell(HE12, p), cell(HE12M, p), cell(HE22, p), cell(HJ, p)] for p in PACK_ORDER8]
e8_pack_rows.append(["All packs", f"{f1s(HB['f1'])} ({pct(HB['fa'], 2)})", f"{f1s(HE12['f1'])} ({pct(HE12['fa'], 2)})", f"{f1s(HE12M['f1'])} ({pct(HE12M['fa'], 2)})",
                     f"{f1s(HE22['f1'])} ({pct(HE22['fa'], 2)})", f"{f1s(HJ['f1'])} ({pct(HJ['fa'], 2)})"])
e8_summary_rows = [
    ["Held-out F1, all packs (precision / recall)", f"{HJ['f1'] * 100:.1f}% ({HJ['p'] * 100:.1f} / {HJ['r'] * 100:.1f})",
     f"{HE22['f1'] * 100:.1f}% ({HE22['p'] * 100:.1f} / {HE22['r'] * 100:.1f})", f"{HE12M['f1'] * 100:.1f}% ({HE12M['p'] * 100:.1f} / {HE12M['r'] * 100:.1f})"],
    ["Clean held-out edits flagged", pct(HJ["fa"], 1), pct(HE22["fa"], 1), pct(HE12M["fa"], 1)],
    ["Median per check", "343 ms live; about 230 ms with a warm connection", f"{ms(E22[1])} ms", f"{ms(r3['r3-baseline'][1])} ms"],
    ["90th percentile per check", "not measured on this workload", f"{ms(E22[2])} ms", f"{ms(r3['r3-baseline'][2])} ms"],
    ["Cost per 10,000 edits", "about $2 (estimate)", "$0", "$0"],
    ["Memory on the Mac", "none", "about 20 GB, three model servers (estimate)", "about 8 GB, one server"],
    ["Works offline", "No", "Yes", "Yes"],
]

# ---------------------------------------------------------------- page

N = lambda x: f"{x:.2f}"
ctx = dict(
    FONT=font_css,
    CHART_HEADLINE=chart_headline, CHART_FA=chart_fa, CHART_LATENCY=chart_latency, CHART_V1V2=chart_v1v2,
    SWEEPS="".join(sweep_charts), SWEEP_LEGEND=sweep_legend, CHART_BANDS=chart_bands,
    CHART_FUNNEL=chart_funnel, CHART_EXTRA=chart_extra, CHART_HOOK_REVIEW=chart_hook_review, CHART_HOOK_OUT=chart_hook_out,
    CHART_R1=chart_r1,
    CHART_LOCAL_F1=chart_local_f1, CHART_LOCAL_LAT=chart_local_lat,
    CHART_GATE=chart_gate, GATE_TABLE=table(["Judge", "Pack · lang", "F1 (all → gated)", "Recall", "Clean edits flagged"], gate_rows),
    NEW_RULE_TABLE=table(["Rule (held-out, gated)", "Jev", "GPT-6-Luna"], new_rule_rows),
    CHART_KEV_GATE=chart_kev_gate, KEV_LAT_BEFORE=f"{kev_lat[0]:.1f}", KEV_LAT_AFTER=f"{kev_lat[1]:.1f}",
    BATCH_TABLE=table(["Edit", "Code tokens", "Rules", "Rules per pass (default)", "Batched", "One rule per pass"], batch_rows),
    CHART_E5=chart_e5_viol,
    JEVLIKE_TABLE=table(["JevLike variant", "Pack · lang", "F1 at p ≥ 0.5", "Best F1 at any threshold", "Jev (gated)"], jl_rows),
    JEVLIKE_MS=f"{JL['Frozen Qwen2.5-0.5B + head']['median_ms_per_rule']:.0f}",
    CHART_PIPE_COST=chart_pipe_cost, CHART_PIPE_VIOL=chart_pipe_viol,
    PIPE_TABLE=table(["Pipeline", "Review comments / task (rule-covered)", "Agent cost / task", "Cost vs no hook (95% CI)", "Agent time / task", "Violations: before → after fix", "Final violations vs no hook (95% CI)"], pipe_rows),
    E5_TABLE=table(["Condition", "Violations / task", "Change vs none (95% CI)", "Time / task", "Cost / task", "Findings shown (high / medium)", "Mean hook time", "Rule-covered review findings / task", "Builds"], e5_rows),
    CODEX_TABLE=table(["Codex condition", "Violations / task", "Change vs none (95% CI)", "Time / task", "Edits / task", "Findings shown", "Builds"], codex_rows),
    LOCAL_TABLE=table(["Model", "Pack · lang", "F1 (p ≥ 0.5)", "Clean edits flagged", "High tier P / R", "Best F1 (threshold)", "Median time"], local_rows),
    BENCH_TABLE=table(["Encoder backend", "Time for 21 rules × 512 tokens", "Core ML coverage"], bench_rows),
    KEV4_HIGH=f"{kev4_high_real} of {kev4_high_total}",
    PRACTICE_TABLE=table(["Judge", "Lang", "Precision", "Recall", "F1", "Clean edits flagged", "Median time"], practice_table_rows),
    PRACTICE_RULES_TS=table(["Rule", "Jev (p ≥ 0.5)", "GPT-6-Luna"], per_rule_rows("typescript")),
    PRACTICE_RULES_SW=table(["Rule", "Jev (p ≥ 0.5)", "GPT-6-Luna"], per_rule_rows("swift")),
    PRACTICE_RULE_LIST=table(["Rule", "What the agent is told", "Deterministic linter equivalent?"], practice_rule_table),
    R1_TABLE=table(["Judge", "Lang", "Precision", "Recall", "F1", "Clean edits flagged", "Median time"], r1_table_rows),
    AGREE_TABLE=table(["Rule", "Both flag", "Only Jev", "Only grader"], agree_rows),
    HOOK_TABLE=table(
        ["Condition", "Graded violations / task", "Reviewer findings a rule covers / task", "Reviewer findings / task", "Builds", "Agent cost / task", "Time / task", "Hook findings shown (high / medium)"],
        [["No hook", N(e_none["all"]), N(review_per_task(p_review, "none")["in"]), N(review_per_task(p_review, "none")["in"] + review_per_task(p_review, "none")["out"]),
          f"{e_none['build']}/{e_none['n']}", f"${e_none['cost']:.3f}", f"{e_none['dur']:.0f}s", "—"],
         ["Jev hook, both packs", N(e_jev["all"]), N(review_per_task(p_review, "jev")["in"]), N(review_per_task(p_review, "jev")["in"] + review_per_task(p_review, "jev")["out"]),
          f"{e_jev['build']}/{e_jev['n']}", f"${e_jev['cost']:.3f} (+{(e_jev['cost'] / e_none['cost'] - 1) * 100:.0f}%)", f"{e_jev['dur']:.0f}s (+{e_jev['dur'] - e_none['dur']:.0f}s)", f"{e_jev['high']} / {e_jev['med']}"]],
    ),
    FP_FINDINGS=str(fp_all["findings"]), FP_IN=str(fp_all["in"]), FP_OUT=str(fp_all["out"]), FP_C8=str(fp_all["c8"]), FP_C5=str(fp_all["c5"]),
    FP_CAUGHT=str(fp_all["c8"] + fp_all["c5"]), FP_MISS=str(fp_all["miss"]), FP_JO=str(fp_all["jo"]), FP_JO_OK=str(fp_all["jo_ok"]),
    FP_IN_PCT=pct(fp_all["in"] / fp_all["findings"]), FP_CAUGHT_PCT=pct((fp_all["c8"] + fp_all["c5"]) / fp_all["in"]),
    R1_FINDINGS=str(fr1["findings"]), R1_IN=str(fr1["in"]), R1_JO=str(fr1["jo"]), R1_JO_OK=str(fr1["jo_ok"]),
    PD_ALL=f"{pd_all[0]:+.2f} (95% CI {pd_all[1]:+.2f} to {pd_all[2]:+.2f}; {pd_all[3]} tasks better, {pd_all[4]} worse)",
    PD_P=f"{pd_p[0]:+.2f} (95% CI {pd_p[1]:+.2f} to {pd_p[2]:+.2f})",
    R1D_GPT=f"{r1d_gpt[0]:+.2f} (95% CI {r1d_gpt[1]:+.2f} to {r1d_gpt[2]:+.2f})",
    R1D_LUNA=f"{r1d_luna[0]:+.2f} (95% CI {r1d_luna[1]:+.2f} to {r1d_luna[2]:+.2f})",
    IN_NONE=N(review_per_task(p_review, "none")["in"]), IN_JEV=N(review_per_task(p_review, "jev")["in"]),
    HOOK_CALLS=str(e_jev["calls"]), HOOK_ERRS=str(e_jev["errs"]),
    CONS_MAX=f"{consistency.get('maxAbsDiff', 0):.2f}", CONS_P99=f"{consistency.get('p99AbsDiff', 0):.2f}",
    N_P_DEV=str(sum(v for k, v in summary["caseCounts"].items() if k.startswith("practices") and k.endswith("dev"))),
    N_P_HO=str(sum(v for k, v in summary["caseCounts"].items() if k.startswith("practices") and k.endswith("holdout"))),
    N_H_ALL=str(sum(v for k, v in summary["caseCounts"].items() if k.startswith("hygiene"))),
    # Entry 7
    CHART_BENCH=chart_bench,
    BENCH_TABLE7=table(["Rules asked", "Mode", "Target F1", "Median", "p90", "Input tokens / check", "Largest probability shift"], bench_rows),
    BENCH_OLD_TABLE=table(["Rules asked", "Mode", "First run, new connection per request (superseded)", "Rerun, pooled connection"], bench_old_rows),
    BENCH_OWN=f"{bench_own:.0f}", BENCH_N=str(BENCH["cases"]),
    BENCH_F1_RANGE=f"{BENCH_F1_MIN * 100:.0f}–{BENCH_F1_MAX * 100:.0f}%", BENCH_F1_OWN=pct(bench_targets["targetF1"]),
    BENCH_P50_OWN=f"{bench_targets['msP50']:.0f}", BENCH_P50_100=f"{b100['msP50']:.0f}", BENCH_P50_100P=f"{p100['msP50']:.0f}",
    BENCH_TOK_PAR=f"{(p100['tokensMean'] / b100['tokensMean'] - 1) * 100:+.0f}%", BENCH_DRIFT=f"{BENCH_DRIFT:.2f}",
    BENCH_OLD_OWN=f"{bench(BENCH_OLD, 'targets', 'targets-only')['msP50']:.0f}", BENCH_OLD_100=f"{bench(BENCH_OLD, 100, 'one-request')['msP50']:.0f}",
    N_CAND=str(len(NEW_CANDIDATES)), N_CAND_JEV=str(len(pass_jev)), N_CAND_LUNA=str(len(pass_luna)),
    N_SEC=str(len(NEW_SECURITY)), N_SEC_JEV=str(len(sec_jev)), N_SEC_LUNA=str(len(sec_luna)), N_MOVED=str(len(MOVED_SECURITY)),
    LIVE_H=str(live["hygiene"]), LIVE_P=str(live["practices"]), LIVE_S=str(live["security"]), LIVE_T=str(live["tests"]), LIVE_PF=str(live["performance"]),
    LIVE_ALL=str(sum(live.values())), N_CANDIDATES_NOW=str(len(cand_rows)),
    CHART_PACKS=chart_packs,
    PACK_TABLE=table(["Pack", "Rules evaluated", "Rules live", "Jev P / R", "Jev F1", "Luna P / R", "Luna F1"], pack_rows),
    CAND_TABLE=table(["Candidate rule", "Pack · language", "Held-out positives", "Precision (p ≥ 0.5)", "Recall (p ≥ 0.5)", "Why it's held back"], cand_rows),
    CM_P=pct(CM["precision"]), CM_PH=pct(CM["precisionAtHigh"]), CM_R=pct(CM["recall"]), CM_FP=str(CM["falsePositives"]),
    CM_B1_P=pct(CM_B1["precision"]), CM_B1_FP=str(CM_B1["fp"]),
    CHART_E7=chart_e7,
    E7_TABLE=table(["Measure", "No hook", "Jev async, all packs", "Change (95% CI)", "Better / worse / tie"], e7_rows),
    E7_V_NONE=N(E7["Graded rule violations / task, all tasks"][0]), E7_V_JEV=N(E7["Graded rule violations / task, all tasks"][1]),
    E7_V_PCT=f"{(E7['Graded rule violations / task, all tasks'][1] / E7['Graded rule violations / task, all tasks'][0] - 1) * 100:.0f}%".replace("-", "−"),
    E7_COST_NONE=f"${E7['Agent cost / task'][0]:.2f}", E7_COST_JEV=f"${E7['Agent cost / task'][1]:.2f}",
    E7_COST_PCT=f"{(E7['Agent cost / task'][1] / E7['Agent cost / task'][0] - 1) * 100:+.0f}%",
    E7_WALL_D=f"{E7['Wall time / task'][2][0]:+.0f}",
    E7_V_ABS=f"{abs(E7['Graded rule violations / task, all tasks'][1] / E7['Graded rule violations / task, all tasks'][0] - 1) * 100:.0f}%",
    E7_COST_ABS=f"{(E7['Agent cost / task'][1] / E7['Agent cost / task'][0] - 1) * 100:.0f}%", E7_WALL_ABS=f"{E7['Wall time / task'][2][0]:.0f}",
    BENCH_TOK_ABS=f"{(p100['tokensMean'] / b100['tokensMean'] - 1) * 100:.0f}%",
    E7_CALLS=str(E7_CALLS), E7_ERRS=str(E7_ERRS), E7_HIGH=str(E7_HIGH), E7_MED=str(E7_MED), E7_HOOK_MS=f"{E7_HOOK_MS:.0f}",
    E7_N=str(len(GP)), E5_NONE=N(E5_NONE),
    CHART_FT=chart_ft,
    FT_H=ft_range("ft", "hygiene"), FT_P=ft_range("ft", "practices"), FT_STOCK_H=ft_range("stock", "hygiene"), FT_STOCK_P=ft_range("stock", "practices"),
    FT_JEV_H=ft_range("jev", "hygiene"), FT_JEV_P=ft_range("jev", "practices"),
    FT_TESTS="–".join(f"{v * 100:.0f}" for v in sorted(FT_TESTS)) + "%", FT_P50=f"{min(FT_P50):.1f}–{max(FT_P50):.1f}",
    FT_FA="{:.0f}–{:.0f}%".format(*(f(res(KEV_FT, "local", g[0], g[1], "holdout", "high+medium")["cleanFalseAlarmRate"] * 100 for _, g in headline_groups) for f in (min, max))),
    SKILL_TABLE=table(["Measure (5 repos × 2 runs)", "v1 skill", "v2 skill"], skill_rows),
    # Entry 8
    CHART_R2=r2_chart(), CHART_R3=r3_chart(),
    E8_SUMMARY=table(["", "Cloud Jev", "Local chain (e22)", "Local e12 alone"], e8_summary_rows),
    E8_PACKS=table(["Pack", "Round-1 baseline", "e12 (Spark)", "e12 (Mac)", "e22 chain (Mac)", "Jev"], e8_pack_rows),
    E8_POS=str(HB["pos"]),
    E8_B_F1=f1s(HB["f1"]), E8_B_FA=pct(HB["fa"], 2), E8_E12_F1=f1s(HE12["f1"]), E8_E12_FA=pct(HE12["fa"], 2),
    E8_E12M_F1=f1s(HE12M["f1"]), E8_E12M_FA=pct(HE12M["fa"], 2),
    E8_E22_F1=f1s(HE22["f1"]), E8_E22_FA=pct(HE22["fa"], 2), E8_E22_P8=f"{HE22['p8']:.1f}", E8_E22_P=f"{HE22['p'] * 100:.1f}", E8_E22_R=f"{HE22['r'] * 100:.1f}",
    E8_JEV_F1=f"{HJ['f1'] * 100:.1f}", E8_E22_F1R=f"{HE22['f1'] * 100:.1f}", E8_E22_FAR=pct(HE22["fa"], 1), E8_JEV_R=f"{HJ['r'] * 100:.1f}", E8_JEV_FA=pct(HJ["fa"], 1),
    E8_N2=str(len(R2) - 1), E8_KEPT2=str(sum(1 for r in R2[1:] if r[2].startswith("keep"))), E8_SPREAD=f"{seed_spread:.1f}",
    E8_TB=f"{E8_TRAIN_H['r1-baseline']:.1f}", E8_TG=f"{E8_TRAIN_H['e04-gate-train']:.1f}", E8_TE12=f"{E8_TRAIN_H['e12-paths']:.1f}",
    E8_GATE_X=f"{E8_TRAIN_H['r1-baseline'] / E8_TRAIN_H['e04-gate-train']:.1f}",
    E8_R3_BASE=ms(r3["r3-baseline"][1]), E8_R3_BASE_P90=ms(r3["r3-baseline"][2]),
    E8_E22_MS=ms(E22[1]), E8_E22_P90=ms(E22[2]), E8_E16_PAIRED=ms(E16P),
    E8_N3=str(sum(1 for r in R3 if r[0] not in ("r3-baseline", "e04-kev08-rf"))),
)

page = (ROOT / "report/notebook.html").read_text()
for k, v in ctx.items():
    page = page.replace("{{" + k + "}}", v)
missing = [p for p in page.split("{{")[1:]]
if missing:
    raise SystemExit(f"unfilled placeholders: {[m.split('}}')[0] for m in missing]}")
(ROOT / "report/index.html").write_text(page)
print("wrote report/index.html", len(page), "bytes")
