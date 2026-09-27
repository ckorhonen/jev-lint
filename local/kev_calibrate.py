"""Fit a fine-tuned Kev checkpoint's temperature on jev-lint calibration records.

Run inside a Kev checkout (on the DGX Spark, CUDA):
    .venv/bin/python /path/to/kev_calibrate.py <checkpoint dir> <calibration.jsonl> --device cuda

Same method as Kev's kev-finetune recipe (skills/kev-finetune/scripts/kev_modal.py::score):
score the calibration records with raw logits (temperature 1.0), fit the min-NLL temperature
(micro aggregation), and write it into the checkpoint meta so serving uses it by default.
"""

import argparse
import json
from pathlib import Path

from kev.benchmark import evaluate_records
from kev.checkpoint import LoadOptions, read_meta, write_meta
from kev.data import load_records
from kev.metrics import fit_temperature
from kev.predictors import LocalPredictor

ap = argparse.ArgumentParser()
ap.add_argument("run")
ap.add_argument("calibration")
ap.add_argument("--device", default="cuda")
a = ap.parse_args()

records = load_records(Path(a.calibration))
predictor = LocalPredictor(a.run, a.device, LoadOptions(temperature=1.0))
report, rows = evaluate_records(records, predictor, Path(a.run).parent / "calibration-report")
T = fit_temperature(rows, aggregation="micro")
meta = read_meta(a.run)
meta.temperature = T
meta.extra["temperature_fit"] = {"rows": Path(a.calibration).name, "n": len(records), "method": "min NLL, micro, kev.metrics.fit_temperature", "value": T}
write_meta(a.run, meta)
print(json.dumps({"temperature": T, "calibration_records": len(records), "raw": report.get("clean")}, default=str))
