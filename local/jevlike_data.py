"""Convert jev-lint labeled edits into JevLike training rows, and score a trained JevLike
checkpoint on the held-out edits with the same metrics as eval/run.ts.

    # 1. data (tuning split -> train/validation; held-out -> test, never trained on)
    python3 local/jevlike_data.py export --out local/models/jevlike-data
    # 2. train with JevLike's own CLI (see ~/Repos/jevlike)
    # 3. score
    ~/Repos/jevlike/.venv/bin/python local/jevlike_data.py score <checkpoint> --out eval/results/local/jevlike-<name>.json

One row per (case, rule in the case's label scope):
    context = "Rule: <question>\\nYes means: <true>\\nNo means: <false>\\n\\nFile: <path>\\nAdded code:\\n<code>"
    options = ["no", "yes"], label = 1 if the case is labeled with the rule.
The rule text comes first so context truncation can only cut code, never the rule.
Labels are the subagent-written labels in eval/cases, not Jev outputs (TypeSafe's terms
forbid training on Jev outputs).
"""

import argparse
import hashlib
import json
import random
import re
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACK_FILES = {("typescript", "hygiene"): "typescript.json", ("typescript", "practices"): "typescript.practices.json",
              ("swift", "hygiene"): "swift.json", ("swift", "practices"): "swift.practices.json"}


def rules():
    return {k: json.loads((ROOT / "rules" / f).read_text())["rules"] for k, f in PACK_FILES.items()}


def added_code(payload):
    ti = payload.get("tool_input", {})
    name = payload.get("tool_name")
    if name == "Write":
        return ti.get("content", "")
    if name == "Edit":
        return ti.get("new_string", "")
    if name == "MultiEdit":
        return "\n\n".join(e.get("new_string", "") for e in ti.get("edits", []))
    if name == "apply_patch":
        return "\n".join(line[1:] for line in re.split(r"\r?\n", ti.get("command", "")) if line.startswith("+") and not line.startswith("+++"))
    return ""


def file_path(payload):
    ti = payload.get("tool_input", {})
    if "file_path" in ti:
        return ti["file_path"]
    m = re.search(r"\*\*\* (?:Add|Update) File: (.+)", ti.get("command", ""))
    return m.group(1).strip() if m else ""


def load_cases():
    cases = []
    for f in sorted((ROOT / "eval/cases").glob("*.jsonl")):
        lang = f.name.split(".")[0]
        pack = "practices" if ".practices." in f.name else "hygiene"
        for line in f.read_text().splitlines():
            if line.strip():
                c = json.loads(line)
                c["lang"], c["pack"] = lang, pack
                cases.append(c)
    return cases


def gate_applies(rule, code):
    pats = rule.get("when") or []
    compiled = []
    for p in pats:
        try:
            compiled.append(re.compile(p, re.I | re.M))
        except re.error:
            pass
    return not compiled or any(p.search(code) for p in compiled)


def rows_for(case, rule_sets):
    code = added_code(case["payload"])
    if not code.strip():
        return []
    rs = rule_sets[(case["lang"], case["pack"])]
    scope = set(case.get("scope") or [r["id"] for r in rs])
    out = []
    for r in rs:
        if r["id"] not in scope:
            continue
        context = f"Rule: {r['question']}\nYes means: {r['true']}\nNo means: {r['false']}\n\nFile: {file_path(case['payload'])}\nAdded code:\n{code}"
        out.append({"case": case["id"], "lang": case["lang"], "pack": case["pack"], "rule": r["id"], "gated_in": gate_applies(r, code),
                    "context": context, "options": ["no", "yes"], "label": int(r["id"] in case["labels"])})
    return out


def export(out: Path):
    rule_sets = rules()
    cases = load_cases()
    out.mkdir(parents=True, exist_ok=True)
    dev = [c for c in cases if c["split"] == "dev"]
    held = [c for c in cases if c["split"] == "holdout"]
    # Validation = 10% of tuning cases, split by case so a case's rules stay together.
    val_ids = {c["id"] for c in dev if int(hashlib.sha256(c["id"].encode()).hexdigest(), 16) % 10 == 0}
    splits = {
        "train": [r for c in dev if c["id"] not in val_ids for r in rows_for(c, rule_sets)],
        "validation": [r for c in dev if c["id"] in val_ids for r in rows_for(c, rule_sets)],
        "test": [r for c in held for r in rows_for(c, rule_sets)],
    }
    random.Random(0).shuffle(splits["train"])
    for name, rows in splits.items():
        with open(out / f"{name}.jsonl", "w") as f:
            for r in rows:
                # JevLike's loader reads context/options/label; the rest is kept for scoring.
                f.write(json.dumps(r) + "\n")
        pos = sum(r["label"] for r in rows)
        print(f"{name}: {len(rows)} rows, {pos} positive ({pos / max(len(rows), 1):.1%})")


def score(checkpoint: str, out: Path, device: str):
    import torch
    sys.path.insert(0, str(Path.home() / "Repos/jevlike"))
    from jevlike.data import ChoiceExample
    from jevlike.model import load_checkpoint, select_device
    from jevlike.train import move

    dev = select_device(device)
    model, collator, _ = load_checkpoint(checkpoint, dev)
    model.eval()
    rows = [json.loads(line) for line in open(ROOT / "local/models/jevlike-data/test.jsonl")]
    probs, times = [], []
    with torch.no_grad():
        for i in range(0, len(rows), 16):
            chunk = rows[i:i + 16]
            t = time.perf_counter()
            batch = move(collator([ChoiceExample(r["context"], tuple(r["options"]), r["label"]) for r in chunk]), dev)
            p = model(batch).softmax(-1)[:, 1].float().cpu().tolist()
            times.append((time.perf_counter() - t) / len(chunk))
            probs.extend(p)
    for r, p in zip(rows, probs):
        r["p"] = p

    def metrics(subset, threshold, gated):
        tp = fp = fn = 0
        by_case = {}
        for r in subset:
            pred = r["p"] >= threshold and (r["gated_in"] or not gated)
            tp += pred and r["label"]
            fp += pred and not r["label"]
            fn += (not pred) and r["label"]
            c = by_case.setdefault(r["case"], {"labels": 0, "flags": 0})
            c["labels"] += r["label"]
            c["flags"] += pred
        precision = tp / (tp + fp) if tp + fp else 1.0
        recall = tp / (tp + fn) if tp + fn else 1.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        clean = [c for c in by_case.values() if c["labels"] == 0]
        return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn,
                "cleanFalseAlarmRate": sum(c["flags"] > 0 for c in clean) / max(len(clean), 1)}

    results = []
    for lang in ["typescript", "swift"]:
        for pack in ["hygiene", "practices"]:
            subset = [r for r in rows if r["lang"] == lang and r["pack"] == pack]
            for gated in [False, True]:
                for policy, t in [("high", 0.8), ("high+medium", 0.5)]:
                    results.append({"lang": lang, "pack": pack, "policy": ("gated " if gated else "") + policy, **metrics(subset, t, gated)})
            best = max((metrics(subset, t / 20, True) | {"threshold": t / 20} for t in range(1, 20)), key=lambda m: m["f1"])
            results.append({"lang": lang, "pack": pack, "policy": "gated best-threshold", **best})
    summary = {"checkpoint": checkpoint, "rows": len(rows), "median_ms_per_rule": statistics.median(times) * 1000, "results": results}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2))
    for r in results:
        print(f"{r['pack']:10s} {r['lang']:11s} {r['policy']:22s} P={r['precision']:.2f} R={r['recall']:.2f} F1={r['f1']:.2f} cleanFA={r['cleanFalseAlarmRate']:.2f}")
    print(f"median {summary['median_ms_per_rule']:.0f} ms per rule")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["export", "score"])
    ap.add_argument("checkpoint", nargs="?")
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="auto")
    a = ap.parse_args()
    export(Path(a.out)) if a.cmd == "export" else score(a.checkpoint, Path(a.out), a.device)
