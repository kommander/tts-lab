from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path


def emit(event_type: str, **payload: object) -> None:
    print(json.dumps({"type": event_type, **payload}), flush=True)


def emit_request(request_id: str | None, event_type: str, **payload: object) -> None:
    if request_id is not None:
        payload["request_id"] = request_id
    emit(event_type, **payload)


def device_name(torch: object) -> str:
    if torch.cuda.is_available():
        return "cuda"
    if sys.platform == "darwin" and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def resource_snapshot() -> dict[str, int]:
    snapshot: dict[str, int] = {}
    try:
        import resource

        maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        snapshot["peakRssBytes"] = int(maximum if sys.platform == "darwin" else maximum * 1024)
    except (ImportError, OSError):
        pass
    if sys.platform.startswith("linux"):
        try:
            with open("/proc/self/statm", "r", encoding="utf-8") as statm:
                resident_pages = int(statm.read().split()[1])
            snapshot["rssBytes"] = resident_pages * int(os.sysconf("SC_PAGE_SIZE"))
        except (OSError, ValueError, IndexError):
            pass
    elif sys.platform == "darwin":
        try:
            result = subprocess.run(
                ["ps", "-o", "rss=", "-p", str(os.getpid())],
                check=True,
                capture_output=True,
                text=True,
            )
            snapshot["rssBytes"] = int(result.stdout.strip()) * 1024
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    return snapshot


def check() -> None:
    emit("status", detail="Importing Kokoro runtime")
    import kokoro  # noqa: F401
    emit("status", detail="Runtime import passed")


def load_kokoro(assets: Path):
    import numpy as np
    import soundfile as sf
    import torch
    from kokoro import KModel, KPipeline

    device = device_name(torch)
    emit("status", detail=f"Loading Kokoro on {device}")
    model = KModel(
        repo_id="hexgrad/Kokoro-82M",
        config=str(assets / "config.json"),
        model=str(assets / "kokoro-v1_0.pth"),
    ).to(device).eval()
    pipelines = {"a": KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=model)}
    pipelines["a"].load_voice(str(assets / "voices" / "af_heart.pt"))

    def synthesize(text: str, output: Path, request_id: str | None = None, voice_id: str | None = None) -> None:
        voice_id = voice_id or "af_heart"
        lang_code = "b" if voice_id.startswith("b") else "a"
        if lang_code not in pipelines:
            pipelines[lang_code] = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M", model=model)
        pipeline = pipelines[lang_code]
        voice = str(assets / "voices" / f"{voice_id}.pt")
        emit_request(request_id, "status", detail=f"Synthesizing with Kokoro {voice_id} on {device}")
        chunks = []
        for index, result in enumerate(pipeline(text, voice=voice), start=1):
            if result.audio is not None:
                chunks.append(result.audio.numpy())
            emit_request(request_id, "progress", progress=min(0.95, index / (index + 1)))
        if not chunks:
            raise RuntimeError("Kokoro produced no audio")
        sf.write(output, np.concatenate(chunks), 24000)

    return synthesize


def serve(assets: Path) -> None:
    load_started = time.perf_counter()
    try:
        synthesize = load_kokoro(assets)
    except Exception as error:
        emit("fatal", error=str(error))
        traceback.print_exc(file=sys.stderr)
        raise
    emit("ready", load_ms=round((time.perf_counter() - load_started) * 1000, 1), resource=resource_snapshot())

    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = str(request["id"])
            text = str(request["text"]).strip()
            output = Path(request["output"])
            voice_id = request.get("voice")
            if not text:
                raise ValueError("No text was provided")
            output.parent.mkdir(parents=True, exist_ok=True)
            started = time.perf_counter()
            synthesize(text, output, request_id, voice_id)
            emit_request(request_id, "progress", progress=1.0)
            emit_request(
                request_id,
                "result",
                output=str(output),
                generation_ms=round((time.perf_counter() - started) * 1000, 1),
                resource=resource_snapshot(),
            )
        except Exception as error:
            emit_request(request_id, "error", error=str(error))
            traceback.print_exc(file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.serve:
        parser.error("--serve is required")
    serve(Path(args.assets))


if __name__ == "__main__":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    main()
