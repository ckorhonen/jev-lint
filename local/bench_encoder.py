"""Time Laya's ONNX encoder on this Mac under different ONNX Runtime providers.

    local/.venv-laya/bin/python local/bench_encoder.py local/models/laya-en-onnx --rows 21 --seq 512

For each configuration: session build time (includes the Core ML compile), warm
latency over N runs for a (rows, seq) batch, how many graph nodes Core ML accepted
(the rest fall back to CPU), and the max abs difference from the fp32 CPU output.
A PyTorch MPS timing of the same encoder is included as the GPU baseline.
"""

import argparse
import json
import os
import re
import statistics
import sys
import tempfile
import time

import numpy as np
import onnxruntime as ort

ap = argparse.ArgumentParser()
ap.add_argument("model_dir")
ap.add_argument("--rows", type=int, default=21)
ap.add_argument("--seq", type=int, default=512)
ap.add_argument("--runs", type=int, default=5)
ap.add_argument("--configs", default="cpu,coreml-ane,coreml-gpu,coreml-all,coreml-cpu,torch-mps")
args = ap.parse_args()

rng = np.random.default_rng(0)
ids = rng.integers(1000, 30000, size=(args.rows, args.seq), dtype=np.int64)
mask = np.ones((args.rows, args.seq), dtype=np.int64)
feed = {"input_ids": ids, "attention_mask": mask}
enc_path = os.path.join(args.model_dir, "encoder.onnx")

CONFIGS = {
    "cpu": [("CPUExecutionProvider", {})],
    "coreml-ane": [("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": "CPUAndNeuralEngine", "RequireStaticInputShapes": "1"}), "CPUExecutionProvider"],
    "coreml-gpu": [("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": "CPUAndGPU", "RequireStaticInputShapes": "1"}), "CPUExecutionProvider"],
    "coreml-all": [("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL", "RequireStaticInputShapes": "1"}), "CPUExecutionProvider"],
    "coreml-cpu": [("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": "CPUOnly", "RequireStaticInputShapes": "1"}), "CPUExecutionProvider"],
}


def coverage_from_log(path):
    text = open(path, errors="ignore").read()
    m = re.findall(r"number of nodes in the graph: (\d+) number of nodes supported by CoreML: (\d+)", text)
    parts = re.findall(r"number of partitions supported by CoreML: (\d+)", text)
    if not m:
        return None
    total, supported = map(int, m[-1])
    return {"nodes": total, "coreml_nodes": supported, "partitions": int(parts[-1]) if parts else None}


def time_ort(name):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 0 if name.startswith("coreml") else 3
    log = tempfile.NamedTemporaryFile(delete=False, suffix=".log")
    # ORT logs go to stderr; capture them to count Core ML node coverage.
    saved = os.dup(2)
    os.dup2(log.fileno(), 2)
    try:
        t0 = time.perf_counter()
        sess = ort.InferenceSession(enc_path, sess_options=so, providers=CONFIGS[name])
        build = time.perf_counter() - t0
        out = sess.run(None, feed)[0]  # first run (may compile further)
        times = []
        for _ in range(args.runs):
            t = time.perf_counter()
            out = sess.run(None, feed)[0]
            times.append(time.perf_counter() - t)
    finally:
        os.dup2(saved, 2)
        os.close(saved)
    return out, build, times, coverage_from_log(log.name)


def time_torch_mps():
    import torch
    from laya import Router

    agent = Router(device="mps").load("english")
    enc = agent.model.encoder.eval()
    t_ids, t_mask = torch.from_numpy(ids).to("mps"), torch.from_numpy(mask).to("mps")
    with torch.no_grad():
        enc(input_ids=t_ids, attention_mask=t_mask)
        torch.mps.synchronize()
        times = []
        for _ in range(args.runs):
            t = time.perf_counter()
            out = enc(input_ids=t_ids, attention_mask=t_mask).last_hidden_state
            torch.mps.synchronize()
            times.append(time.perf_counter() - t)
    return out.float().cpu().numpy(), None, times, None


results = {}
reference = None
for name in args.configs.split(","):
    try:
        out, build, times, cov = time_torch_mps() if name == "torch-mps" else time_ort(name)
    except Exception as e:  # a provider that can't build the graph is itself a result
        results[name] = {"error": str(e)[:300]}
        print(f"{name:12s} ERROR {str(e)[:160]}", flush=True)
        continue
    if reference is None and name == "cpu":
        reference = out
    diff = float(np.abs(out.astype(np.float32) - reference).max()) if reference is not None else None
    results[name] = {
        "build_s": round(build, 2) if build is not None else None,
        "median_ms": round(statistics.median(times) * 1000, 1),
        "min_ms": round(min(times) * 1000, 1),
        "max_abs_diff_vs_cpu": diff,
        "coverage": cov,
    }
    print(f"{name:12s} {json.dumps(results[name])}", flush=True)

json.dump({"rows": args.rows, "seq": args.seq, "runs": args.runs, "results": results}, sys.stdout if False else open(os.path.join(args.model_dir, f"bench-r{args.rows}-s{args.seq}.json"), "w"), indent=2)
