"""Export jev-lint's labeled tuning edits as Kev fine-tuning records.

    python3 local/kev_finetune_data.py --out local/models/kev-ft-data

One Kev record per case: the same state the hook sends to Jev, and one Noul question per
rule in the case's label scope, each with its label:
    {"state": {"language", "file_path", "added_code"},
     "questions": {"<rule id>": {"type": "noul", "instructions", "criteria": {"true", "false"}, "label": true|false}}}

Partitions (by case, so a case never spans two):
    train.jsonl        85% of the tuning split
    calibration.jsonl  15% of the tuning split (temperature fit only)
The held-out split is not exported; it is scored through the served checkpoint with eval/run.ts.
Labels are the subagent-written labels in eval/cases, never Jev outputs (TypeSafe's terms
forbid training on Jev outputs).
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jevlike_data import added_code, file_path, load_cases, rules  # noqa: E402


def record(case, rule_sets):
    code = added_code(case["payload"])
    if not code.strip():
        return None
    rs = rule_sets[(case["lang"], case["pack"])]
    scope = set(case.get("scope") or [r["id"] for r in rs])
    questions = {
        r["id"]: {"type": "noul", "instructions": r["question"], "criteria": {"true": r["true"], "false": r["false"]}, "label": r["id"] in case["labels"]}
        for r in rs
        if r["id"] in scope
    }
    if not questions:
        return None
    return {"state": {"language": case["lang"], "file_path": file_path(case["payload"]), "added_code": code}, "questions": questions}


def main(out: Path):
    rule_sets = rules()
    out.mkdir(parents=True, exist_ok=True)
    parts = {"train": [], "calibration": []}
    for case in load_cases():
        if case["split"] != "dev":
            continue
        rec = record(case, rule_sets)
        if rec is None:
            continue
        bucket = int(hashlib.sha256(case["id"].encode()).hexdigest(), 16) % 100
        parts["calibration" if bucket < 15 else "train"].append(rec)
    for name, recs in parts.items():
        with open(out / f"{name}.jsonl", "w") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")
        qs = sum(len(r["questions"]) for r in recs)
        pos = sum(q["label"] for r in recs for q in r["questions"].values())
        chars = sorted(len(r["state"]["added_code"]) for r in recs)
        print(f"{name}: {len(recs)} records, {qs} questions, {pos} positive; code chars median {chars[len(chars) // 2]}, max {chars[-1]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    main(Path(ap.parse_args().out))
