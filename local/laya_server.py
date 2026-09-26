"""Serve Laya behind the TypeSafe `POST /v1/systemone` protocol for jev-lint.

    LAYA_CKPT=english LAYA_MAX_LEN=512 LAYA_DEVICE=mps \
      local/.venv-laya/bin/python local/laya_server.py --port 8010

Unlike `laya-serve`, this pins one checkpoint and a token budget per process, so the
eval can compare configurations (checkpoint, max_len, device) one at a time.
Point the hook or the harness at it with TYPESAFE_BASE_URL / LOCAL_BASE_URL.
"""

import argparse
import os
import time

import uvicorn
from fastapi import FastAPI, Request
from laya import Router

CKPT = os.environ.get("LAYA_CKPT", "english")
MAX_LEN = int(os.environ.get("LAYA_MAX_LEN", "512"))
DEVICE = os.environ.get("LAYA_DEVICE") or None

router = Router(device=DEVICE)
router.preload([CKPT])
app = FastAPI()


@app.post("/v1/systemone")
async def system_one(request: Request):
    body = await request.json()
    started = time.perf_counter()
    result = router.predict(body["state"], body["questions"], model=CKPT, max_len=MAX_LEN)
    answers = {k: {"type": v["type"], "noul": v["noul"]} if v["type"] == "noul" else v for k, v in result["answers"].items()}
    return {
        "model": f"laya-{CKPT}-{MAX_LEN}-{DEVICE or 'auto'}",
        "answers": answers,
        "usage": result.get("usage", {"input_tokens": 0, "output_tokens": 0}),
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8010)
    uvicorn.run(app, host="127.0.0.1", port=ap.parse_args().port, log_level="warning")
