"""Run Laya's encoder on Core ML (Apple Neural Engine / GPU / CPU) and keep its small
decision head in PyTorch.

    # convert once (writes local/models/laya-<ckpt>-encoder-b<B>-s<S>.mlpackage)
    local/.venv-laya/bin/python local/laya_coreml.py convert --ckpt english --batch 8 --seq 512

Core ML's Neural Engine wants static shapes, so the encoder is converted at a fixed
(batch, seq) bucket in fp16. Requests are padded up to the bucket and chunked by batch.
`CoreMLEncoder` is a drop-in for `DecisionModel.encoder`: same call signature, returns an
object with `last_hidden_state`.
"""

import argparse
import os
import time
from pathlib import Path
from types import SimpleNamespace

import coremltools as ct
import numpy as np
import torch

MODELS = Path(__file__).resolve().parent / "models"


def _register_missing_ops():
    """ModernBERT's mask code calls Tensor.new_ones, which coremltools 9 lacks.
    Same as its built-in new_zeros, filled with 1."""
    from coremltools.converters.mil import Builder as mb
    from coremltools.converters.mil.frontend.torch.ops import _get_inputs
    from coremltools.converters.mil.frontend.torch.torch_op_registry import _TORCH_OPS_REGISTRY, register_torch_op

    if "new_ones" in _TORCH_OPS_REGISTRY:
        return

    @register_torch_op
    def new_ones(context, node):
        inputs = _get_inputs(context, node)
        shape = inputs[1]
        # torch ScalarType codes: 11 bool, 3 int32, 4 int64; anything else is float.
        code = inputs[2].val if len(inputs) > 2 and inputs[2] is not None else None
        out_dtype = {11: "bool", 3: "int32", 4: "int32"}.get(code, "fp32")
        if isinstance(shape, list):
            shape = mb.concat(values=shape, axis=0)
        if shape.val is not None and np.size(shape.val) == 0:  # new_ones(()) -> scalar
            ones = mb.const(val=np.float32(1.0))
        else:
            ones = mb.fill(shape=mb.cast(x=shape, dtype="int32"), value=1.0)
        context.add(mb.cast(x=ones, dtype=out_dtype, name=node.name) if out_dtype != "fp32" else mb.identity(x=ones, name=node.name))
UNITS = {
    "ane": ct.ComputeUnit.CPU_AND_NE,
    "gpu": ct.ComputeUnit.CPU_AND_GPU,
    "cpu": ct.ComputeUnit.CPU_ONLY,
    "all": ct.ComputeUnit.ALL,
}


def package_path(ckpt: str, batch: int, seq: int) -> Path:
    return MODELS / f"laya-{ckpt}-encoder-b{batch}-s{seq}.mlpackage"


class _Traceable(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.encoder = encoder

    def forward(self, input_ids, attention_mask):
        return self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state


def load_agent(ckpt: str):
    from laya import Router

    router = Router(device="cpu")
    return router, router.load(ckpt)


def convert(ckpt: str, batch: int, seq: int) -> Path:
    _register_missing_ops()
    _, agent = load_agent(ckpt)
    encoder = agent.model.encoder.float().eval()
    if hasattr(encoder, "config"):
        encoder.config._attn_implementation = "eager"  # sdpa/unpadding paths don't trace
    example = (torch.ones(batch, seq, dtype=torch.long), torch.ones(batch, seq, dtype=torch.long))
    with torch.no_grad():
        traced = torch.jit.trace(_Traceable(encoder), example, strict=False)
    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(name="input_ids", shape=(batch, seq), dtype=np.int32),
            ct.TensorType(name="attention_mask", shape=(batch, seq), dtype=np.int32),
        ],
        outputs=[ct.TensorType(name="last_hidden_state", dtype=np.float16)],
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS14,
    )
    out = package_path(ckpt, batch, seq)
    MODELS.mkdir(parents=True, exist_ok=True)
    mlmodel.save(str(out))
    return out


class CoreMLEncoder(torch.nn.Module):
    def __init__(self, path: Path, batch: int, seq: int, units: str, pad_id: int):
        super().__init__()
        started = time.perf_counter()
        self.model = ct.models.MLModel(str(path), compute_units=UNITS[units])
        self.load_seconds = time.perf_counter() - started
        self.batch, self.seq, self.pad_id = batch, seq, pad_id

    def forward(self, input_ids, attention_mask, **_):
        rows, length = input_ids.shape
        if length > self.seq:
            input_ids, attention_mask, length = input_ids[:, : self.seq], attention_mask[:, : self.seq], self.seq
        ids = np.full((rows, self.seq), self.pad_id, dtype=np.int32)
        mask = np.zeros((rows, self.seq), dtype=np.int32)
        ids[:, :length] = input_ids.cpu().numpy()
        mask[:, :length] = attention_mask.cpu().numpy()
        chunks = []
        for start in range(0, rows, self.batch):
            b_ids, b_mask = ids[start : start + self.batch], mask[start : start + self.batch]
            real = b_ids.shape[0]
            if real < self.batch:  # pad the last chunk with empty rows
                b_ids = np.concatenate([b_ids, np.full((self.batch - real, self.seq), self.pad_id, np.int32)])
                b_mask = np.concatenate([b_mask, np.zeros((self.batch - real, self.seq), np.int32)])
                b_mask[real:, 0] = 1  # an all-zero mask row can produce NaNs; it's discarded anyway
            out = self.model.predict({"input_ids": b_ids, "attention_mask": b_mask})["last_hidden_state"]
            chunks.append(out[:real])
        hidden = np.concatenate(chunks)[:, :length].astype(np.float32)
        return SimpleNamespace(last_hidden_state=torch.from_numpy(hidden))


def attach(agent, ckpt: str, batch: int, seq: int, units: str) -> CoreMLEncoder:
    """Swap the agent's encoder for the Core ML one and keep inference on CPU."""
    enc = CoreMLEncoder(package_path(ckpt, batch, seq), batch, seq, units, agent.tok.pad_token_id)
    agent.model.encoder = enc
    return enc


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["convert"])
    ap.add_argument("--ckpt", default="english")
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--seq", type=int, default=512)
    a = ap.parse_args()
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    print(convert(a.ckpt, a.batch, a.seq))
