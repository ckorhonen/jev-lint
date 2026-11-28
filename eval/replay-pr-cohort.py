"""Replay a pinned public PR cohort. Default to an offline receipt summary.
With --live, use GitHub to reconstruct the exact inputs and run one selected-provider hook
review per PR. Aggregate output contains no code, provider keys, or comments.
"""

import argparse
import hashlib
import json
import os
import select
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
RECEIPT = ROOT / "eval/results/pr-tail-2026-11-28.json"
ALLOWED = {"ckorhonen/jev-lint", "sindresorhus/ky", "sindresorhus/p-limit"}


class ReviewWorker:
    def __init__(self, command, cwd, env):
        self.command, self.cwd, self.env = command, cwd, env
        self.child = None

    def request(self, event, timeout=22):
        deadline = time.monotonic() + timeout
        if self.child is None:
            self.child = subprocess.Popen(
                self.command,
                cwd=self.cwd,
                env=self.env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
            )
            os.set_blocking(self.child.stdin.fileno(), False)
        try:
            pending = memoryview(json.dumps(event).encode() + b"\n")
            while pending:
                remaining = deadline - time.monotonic()
                if (
                    remaining <= 0
                    or not select.select([], [self.child.stdin], [], remaining)[1]
                ):
                    raise subprocess.TimeoutExpired(self.command, timeout)
                try:
                    count = os.write(self.child.stdin.fileno(), pending)
                except BlockingIOError:
                    continue
                pending = pending[count:]
            data = bytearray()
            while not data.endswith(b"\n"):
                remaining = deadline - time.monotonic()
                if (
                    remaining <= 0
                    or not select.select([self.child.stdout], [], [], remaining)[0]
                ):
                    raise subprocess.TimeoutExpired(self.command, timeout)
                chunk = os.read(self.child.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError("Review worker exited without a receipt")
                data.extend(chunk)
            result = json.loads(data)
            if "metrics" not in result:
                raise RuntimeError("Review worker returned an invalid receipt")
            return result
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.child is not None:
            self.child.kill()
            self.child.wait()
            self.child.stdin.close()
            self.child.stdout.close()
            self.child = None


def inputs(row):
    repo, base, head = row["repo"], row["base"], row["head"]
    if repo not in ALLOWED:
        raise ValueError("Unrecognized benchmark repository")
    data = json.loads(
        subprocess.check_output(
            ["gh", "api", f"repos/{repo}/compare/{base}...{head}"], timeout=60
        )
    )
    result = {}
    for file in data["files"]:
        if not file["filename"].endswith((".ts", ".tsx")) or not file["additions"]:
            continue
        added = [
            line[1:]
            for line in file.get("patch", "").splitlines()
            if line.startswith("+")
        ]
        if len(added) != file["additions"]:
            raise ValueError("Incomplete GitHub patch")
        result[file["filename"]] = "\n".join(added)
    digest = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    if digest != row["inputSha256"]:
        raise ValueError("Pinned input digest mismatch")
    return result


def run(args, manifest):
    with tempfile.TemporaryDirectory(prefix="jev-cohort-", dir="/tmp") as temp:
        work = Path(temp)
        env = dict(
            os.environ,
            XDG_STATE_HOME=temp,
            JEV_LINT_DAEMON="off" if args.cold else "on",
            JEV_LINT_PROVIDER=args.provider,
            TYPESAFE_BASE_URL="https://api.typesafe.ai",
            JEV_LINT_MODEL="jev-latest"
            if args.provider == "typesafe"
            else "gpt-6-luna",
            JEV_LINT_SCOPE="all",
            JEV_LINT_FINDINGS_LOG="off",
            JEV_LINT_TIMEOUT_MS="8000",
            JEV_LINT_MODE="context",
            JEV_LINT_PACKS="hygiene,practices,security,tests,performance,repo",
            JEV_LINT_GATE="on",
            JEV_LINT_TIERS="high,medium",
            JEV_LINT_HIGH="0.8",
            JEV_LINT_MEDIUM="0.5",
            JEV_LINT_CANDIDATES="off",
            JEV_REPLAY_USAGE=str(work / "usage"),
            JEV_REPLAY_PHASES=str(work / "phases"),
        )
        stream = args.provider == "typesafe" and not (args.cold or args.edit_hooks)
        worker = (
            ReviewWorker(
                [
                    "bun",
                    "--preload",
                    str(ROOT / "eval/replay-usage.ts"),
                    str(ROOT / "src/review.ts"),
                ],
                ROOT,
                env,
            )
            if stream
            else None
        )
        child = None
        try:
            if not args.cold and not stream:
                child = subprocess.Popen(
                    [
                        "bun",
                        "--preload",
                        str(ROOT / "eval/replay-usage.ts"),
                        str(ROOT / "src/daemon.ts"),
                    ],
                    cwd=ROOT,
                    env=env,
                )
                for _ in range(200):
                    if list((work / "jev-lint").glob("*.sock")):
                        break
                    if child.poll() is not None:
                        raise RuntimeError("Daemon startup failed")
                    time.sleep(0.05)
                else:
                    raise TimeoutError("Daemon startup timed out")
            for row in manifest["corpus"]:
                if args.only and args.only != f"{row['repo']}#{row['pr']}":
                    continue
                files = list(inputs(row).items())
                checked = 0
                found = set()
                watchdog = False
                issues = []
                usage_path = work / "usage"
                offset = usage_path.stat().st_size if usage_path.exists() else 0
                phase_path = work / "phases"
                phase_offset = phase_path.stat().st_size if phase_path.exists() else 0
                start = time.monotonic()
                batch_size = 16 if stream else 8
                for batch in range(0, len(files), batch_size):
                    eventlog = (
                        work
                        / f"event-{row['repo'].split('/')[-1]}-{row['pr']}-{batch}.jsonl"
                    )
                    patch = "\n".join(
                        "*** Update File: "
                        + f
                        + "\n"
                        + "\n".join("+" + line for line in c.split("\n"))
                        for f, c in files[batch : batch + batch_size]
                    )
                    event = {
                        "cwd": temp,
                        "tool_name": "apply_patch",
                        "tool_input": {"patch": patch},
                    }
                    try:
                        if worker:
                            record = worker.request(event)
                        else:
                            subprocess.run(
                                [
                                    "bun",
                                    "--preload",
                                    str(ROOT / "eval/replay-usage.ts"),
                                    str(ROOT / "src/hook.ts"),
                                ],
                                input=json.dumps(event),
                                text=True,
                                cwd=ROOT,
                                env=dict(env, JEV_LINT_LOG=str(eventlog)),
                                timeout=22,
                                stdout=subprocess.DEVNULL,
                                check=True,
                            )
                    except subprocess.TimeoutExpired:
                        watchdog = True
                        continue
                    except (BrokenPipeError, RuntimeError, ValueError):
                        if not worker:
                            raise
                        issues.append("worker_failed")
                        continue
                    if child is not None and child.poll() is not None:
                        raise RuntimeError("Benchmark daemon exited")
                    if not worker:
                        if not eventlog.exists():
                            issues.append("missing_hook_receipt")
                            continue
                        record = json.loads(eventlog.read_text())
                        eventlog.unlink()
                    checked += record["metrics"]["checkedFiles"]
                    issues.extend(
                        "timeout"
                        if "timeout" in e.lower() or "deadline" in e.lower()
                        else "check_failed"
                        for e in record["errors"]
                    )
                    found.update(
                        (f["filePath"], item["ruleId"])
                        for f in record["results"]
                        for item in f["findings"]
                    )
                elapsed = time.monotonic() - start
                dollars = 0.0
                if usage_path.exists():
                    with usage_path.open("rb") as stream:
                        stream.seek(offset)
                        for line in stream:
                            u = json.loads(line)
                            if args.provider == "typesafe":
                                dollars += 0.042 * u["input_tokens"] / 1e6
                                continue
                            details = u["input_tokens_details"]
                            dollars += (
                                0.10 * u["input_tokens"]
                                - 0.09 * details["cached_tokens"]
                                + 0.025 * details["cache_write_tokens"]
                            ) / 1e6
                phases = []
                if phase_path.exists():
                    with phase_path.open("rb") as stream:
                        stream.seek(phase_offset)
                        phases = [json.loads(line) for line in stream]
                gold = {tuple(label) for label in row["labels"]}
                print(
                    json.dumps(
                        dict(
                            provider=args.provider,
                            path="review_stream" if stream else "edit_hook",
                            repo=row["repo"],
                            pr=row["pr"],
                            seconds=elapsed,
                            complete=checked == len(files),
                            checked=checked,
                            files=len(files),
                            watchdog=watchdog,
                            errors=issues,
                            observedUsd=dollars,
                            tp=len(gold & found),
                            fp=len(found - gold),
                            fn=len(gold - found),
                            phases=phases,
                        )
                    ),
                    flush=True,
                )
        finally:
            if worker:
                worker.close()
            if child and child.poll() is None:
                child.terminate()
                child.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live",
        action="store_true",
        help="Send the 46 pinned public PR inputs to the selected provider",
    )
    parser.add_argument(
        "--cold",
        action="store_true",
        help="Start a fresh provider connection per hook invocation",
    )
    parser.add_argument(
        "--provider",
        choices=["openai", "typesafe"],
        default="openai",
        help="Provider for live replays (default: openai)",
    )
    parser.add_argument(
        "--edit-hooks",
        action="store_true",
        help="Use the ordinary one-shot edit hook for each eight-file batch",
    )
    parser.add_argument("--only", help="Limit live replay to one pinned owner/repo#PR")
    args = parser.parse_args()
    manifest = json.loads(RECEIPT.read_text())
    if args.only and args.only not in {
        f"{r['repo']}#{r['pr']}" for r in manifest["corpus"]
    }:
        parser.error("PR is outside the frozen corpus")
    if args.live:
        run(args, manifest)
    else:
        print(json.dumps(manifest["experiments"]["quiet"]["arms"], indent=2))
