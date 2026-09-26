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
import statistics as st
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "eval/results"
SNAP = RES / "snapshots"


def load(path):
    return json.loads(Path(path).read_text())


summary = load(RES / "summary.json")  # hygiene (Jev, Luna, regex) + practices v2 (Jev, Luna)
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
HYGIENE_IDS = {r["id"] for (l, p), rs in RULES.items() if p == "hygiene" for r in rs}
PRACTICE_IDS = {r["id"] for (l, p), rs in RULES.items() if p == "practices" for r in rs}

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
    w, left, right, row_h, top = 680, 150, 40, 30, 8
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
    pts = [p for p in summary["sweeps"] if p["pack"] == pack and p["lang"] == lang and p["split"] == split]
    pts.sort(key=lambda p: p["threshold"])
    return [p["threshold"] for p in pts], [p["precision"] for p in pts], [p["recall"] for p in pts]


sweep_charts = []
for pack, pname in [("hygiene", "Hygiene"), ("practices", "Practices")]:
    for lname, lang in LANGS:
        xs, P, R = sweep(pack, lang)
        sweep_charts.append(line_chart([("Precision", "s1", False, P), ("Recall", "s2", True, R)], f"{pname} · {lname}", xs))
sweep_legend = '<div class="legend"><span class="key"><i class="sw s1"></i>Precision</span><span class="key"><i class="sw s2 dash"></i>Recall</span><span class="key"><i class="sw marker"></i>0.5 and 0.8 cut-offs</span></div>'

def band(pack, lo):
    rows = [b for b in summary["bands"] if b["pack"] == pack and b["lo"] == lo]
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
    for rule in RULES[(lang, "practices")]:
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
    for rule in RULES[(lang, "practices")]:
        practice_rule_table.append([f"<code>{rule['id']}</code>", esc(rule["fix"]), DETERMINISTIC.get(rule["id"], "—")])

# ---------------------------------------------------------------- page

N = lambda x: f"{x:.2f}"
ctx = dict(
    FONT=font_css,
    CHART_HEADLINE=chart_headline, CHART_FA=chart_fa, CHART_LATENCY=chart_latency, CHART_V1V2=chart_v1v2,
    SWEEPS="".join(sweep_charts), SWEEP_LEGEND=sweep_legend, CHART_BANDS=chart_bands,
    CHART_FUNNEL=chart_funnel, CHART_EXTRA=chart_extra, CHART_HOOK_REVIEW=chart_hook_review, CHART_HOOK_OUT=chart_hook_out,
    CHART_R1=chart_r1,
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
)

page = (ROOT / "report/notebook.html").read_text()
for k, v in ctx.items():
    page = page.replace("{{" + k + "}}", v)
missing = [p for p in page.split("{{")[1:]]
if missing:
    raise SystemExit(f"unfilled placeholders: {[m.split('}}')[0] for m in missing]}")
(ROOT / "report/index.html").write_text(page)
print("wrote report/index.html", len(page), "bytes")
