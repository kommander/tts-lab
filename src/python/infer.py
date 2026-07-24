from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
import wave
from pathlib import Path
from types import ModuleType


def emit(event_type: str, **payload: object) -> None:
    print(json.dumps({"type": event_type, **payload}), flush=True)


def emit_request(request_id: str | None, event_type: str, **payload: object) -> None:
    if request_id is not None:
        payload["request_id"] = request_id
    emit(event_type, **payload)


def device_name(torch: object, allow_mps: bool = True) -> str:
    if torch.cuda.is_available():
        return "cuda"
    if allow_mps and sys.platform == "darwin" and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def prepare_melo(assets: Path):
    """Load only Melo's English frontend and redirect BERT to pinned local files."""
    from transformers import AutoModelForMaskedLM, AutoTokenizer

    bert_path = str(assets / "bert-base-uncased")
    original_tokenizer = AutoTokenizer.from_pretrained
    original_model = AutoModelForMaskedLM.from_pretrained

    def local_tokenizer(name, *args, **kwargs):
        target = bert_path if name == "bert-base-uncased" else name
        if target == bert_path:
            kwargs["local_files_only"] = True
        return original_tokenizer(target, *args, **kwargs)

    def local_model(name, *args, **kwargs):
        target = bert_path if name == "bert-base-uncased" else name
        if target == bert_path:
            kwargs["local_files_only"] = True
        return original_model(target, *args, **kwargs)

    AutoTokenizer.from_pretrained = staticmethod(local_tokenizer)
    AutoModelForMaskedLM.from_pretrained = staticmethod(local_model)

    # english.py imports only this helper from the otherwise eager Japanese frontend.
    japanese_stub = ModuleType("melo.text.japanese")

    def distribute_phone(phone_count, word_count):
        result = [0] * word_count
        for _ in range(phone_count):
            index = result.index(min(result))
            result[index] += 1
        return result

    japanese_stub.distribute_phone = distribute_phone
    sys.modules["melo.text.japanese"] = japanese_stub

    import melo.text as text_module
    from melo.text import english, english_bert

    cleaner_stub = ModuleType("melo.text.cleaner")

    def clean_text(value, language):
        if language != "EN":
            raise ValueError("This demo configures MeloTTS for English")
        normalized = english.text_normalize(value)
        phones, tones, word_to_phone = english.g2p(normalized)
        return normalized, phones, tones, word_to_phone

    cleaner_stub.clean_text = clean_text
    sys.modules["melo.text.cleaner"] = cleaner_stub
    text_module.get_bert = lambda value, word_to_phone, language, device: english_bert.get_bert_feature(
        value, word_to_phone, device=device
    )

    # Melo imports cached_path for an unused S3 fallback. Its pinned release
    # resolves an obsolete boto stack in 2026; local model paths never call it.
    cached_path_stub = ModuleType("cached_path")
    cached_path_stub.cached_path = lambda value, *args, **kwargs: value
    sys.modules["cached_path"] = cached_path_stub

    from melo.api import TTS

    return TTS


def check(model: str, assets: Path) -> None:
    emit("status", detail="Importing runtime")
    if model == "kokoro":
        import kokoro  # noqa: F401
    elif model == "piper":
        import piper  # noqa: F401
    elif model == "melo":
        TTS = prepare_melo(assets)
        emit("status", detail="Checking MeloTTS checkpoint")
        TTS(
            language="EN",
            device="cpu",
            config_path=str(assets / "config.json"),
            ckpt_path=str(assets / "checkpoint.pth"),
        )
    elif model == "parler":
        import parler_tts  # noqa: F401
    elif model == "f5":
        import f5_tts  # noqa: F401
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
    default_voice = str(assets / "voices" / "af_heart.pt")
    pipelines["a"].load_voice(default_voice)

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


def load_piper(assets: Path):
    from piper import PiperVoice

    emit("status", detail="Loading Piper ONNX voice on CPU")
    voices = {"en_US-lessac-medium": PiperVoice.load(str(assets / "en_US-lessac-medium.onnx"))}

    def synthesize(text: str, output: Path, request_id: str | None = None, voice_id: str | None = None) -> None:
        voice_id = voice_id or "en_US-lessac-medium"
        if voice_id not in voices:
            model_path = assets / "voices" / voice_id / f"{voice_id}.onnx"
            voices[voice_id] = PiperVoice.load(str(model_path))
        voice = voices[voice_id]
        emit_request(request_id, "status", detail=f"Synthesizing with Piper {voice_id}")
        with wave.open(str(output), "wb") as wav_file:
            voice.synthesize_wav(text, wav_file)

    return synthesize


def load_melo(assets: Path):
    TTS = prepare_melo(assets)

    emit("status", detail="Loading MeloTTS on CPU")
    model = TTS(
        language="EN",
        device="cpu",
        config_path=str(assets / "config.json"),
        ckpt_path=str(assets / "checkpoint.pth"),
    )

    # Melo lazily initializes English BERT on the first utterance. Include it in
    # the cold load so every request measured after "ready" is genuinely warm.
    import torch
    from transformers import AutoModelForMaskedLM
    from melo.text import english_bert

    bert_device = "mps" if sys.platform == "darwin" and torch.backends.mps.is_available() else "cpu"
    english_bert.model = AutoModelForMaskedLM.from_pretrained("bert-base-uncased").to(bert_device)

    def synthesize(text: str, output: Path, request_id: str | None = None, voice_id: str | None = None) -> None:
        class Progress:
            def __call__(self, items):
                items = list(items)
                total = max(1, len(items))
                for index, item in enumerate(items, start=1):
                    yield item
                    emit_request(request_id, "progress", progress=index / total)

        voice_id = voice_id or "EN-US"
        if voice_id not in model.hps.data.spk2id:
            raise ValueError(f"Unknown MeloTTS speaker: {voice_id}")
        emit_request(request_id, "status", detail=f"Synthesizing with MeloTTS {voice_id}")
        model.tts_to_file(
            text,
            model.hps.data.spk2id[voice_id],
            str(output),
            pbar=Progress(),
            quiet=True,
        )

    return synthesize


def load_parler(assets: Path):
    import soundfile as sf
    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer

    device = device_name(torch)
    dtype = torch.float32
    if device == "cuda":
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    attention = "eager" if device == "mps" else "sdpa"
    emit("status", detail=f"Loading Parler-TTS on {device}")
    model = ParlerTTSForConditionalGeneration.from_pretrained(
        str(assets / "model"),
        torch_dtype=dtype,
        attn_implementation=attention,
        local_files_only=True,
    ).to(device).eval()
    decode_device = device
    if device == "mps":
        # DAC's long Conv1d outputs exceed an MPS backend limit. PyTorch's
        # advertised fallback does not catch this path, so keep generation on
        # MPS and move only the comparatively small audio decoder to CPU.
        audio_encoder = model.audio_encoder.to("cpu")
        original_decode = audio_encoder.decode

        def decode_on_cpu(*args, **kwargs):
            if args:
                args = (args[0].to("cpu"), *args[1:])
            if "audio_codes" in kwargs:
                kwargs["audio_codes"] = kwargs["audio_codes"].to("cpu")
            return original_decode(*args, **kwargs)

        audio_encoder.decode = decode_on_cpu
        decode_device = "cpu"
    prompt_tokenizer = AutoTokenizer.from_pretrained(str(assets / "model"), local_files_only=True)
    description_tokenizer = AutoTokenizer.from_pretrained(
        str(assets / "description-tokenizer"), local_files_only=True
    )
    def synthesize(text: str, output: Path, request_id: str | None = None, voice_id: str | None = None) -> None:
        voice_id = voice_id or "Jon"
        description = (
            f"{voice_id}'s voice is clear and slightly expressive, with a moderate speaking rate and natural pitch. "
            "The recording is of very high quality with very clear audio; the voice sounds close, "
            "with almost no reverberation or background noise."
        )
        description_inputs = description_tokenizer(description, return_tensors="pt").to(device)
        prompt_inputs = prompt_tokenizer(text, return_tensors="pt").to(device)
        emit_request(
            request_id,
            "status",
            detail=f"Generating Parler-TTS {voice_id} on {device}; DAC decode on {decode_device}",
        )
        with torch.inference_mode():
            audio = model.generate(
                input_ids=description_inputs.input_ids,
                attention_mask=description_inputs.attention_mask,
                prompt_input_ids=prompt_inputs.input_ids,
                prompt_attention_mask=prompt_inputs.attention_mask,
            )
        sf.write(output, audio.float().cpu().numpy().squeeze(), model.audio_encoder.config.sampling_rate)

    return synthesize


def load_f5(assets: Path):
    from importlib.resources import files
    from f5_tts.api import F5TTS

    emit("status", detail="Loading F5-TTS and Vocos")
    tts = F5TTS(
        model="F5TTS_v1_Base",
        ckpt_file=str(assets / "F5TTS_v1_Base" / "model_1250000.safetensors"),
        vocoder_local_path=str(assets / "vocos"),
    )
    reference = files("f5_tts").joinpath("infer/examples/basic/basic_ref_en.wav")

    def synthesize(text: str, output: Path, request_id: str | None = None, voice_id: str | None = None) -> None:
        class Progress:
            def tqdm(self, items):
                items = list(items)
                total = max(1, len(items))
                for index, item in enumerate(items, start=1):
                    yield item
                    emit_request(request_id, "progress", progress=index / total)

        emit_request(request_id, "status", detail="Synthesizing with warm F5-TTS")
        tts.infer(
            ref_file=str(reference),
            ref_text="Some call me nature, others call me mother nature.",
            gen_text=text,
            file_wave=str(output),
            show_info=lambda message: emit_request(request_id, "status", detail=str(message)),
            progress=Progress(),
            seed=42,
        )

    return synthesize


LOADERS = {
    "kokoro": load_kokoro,
    "piper": load_piper,
    "melo": load_melo,
    "parler": load_parler,
    "f5": load_f5,
}


def serve(model_name: str, assets: Path) -> None:
    load_started = time.perf_counter()
    try:
        synthesize = LOADERS[model_name](assets)
    except Exception as error:
        emit("fatal", error=str(error))
        traceback.print_exc(file=sys.stderr)
        raise
    emit("ready", load_ms=round((time.perf_counter() - load_started) * 1000, 1))

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
            generation_ms = round((time.perf_counter() - started) * 1000, 1)
            emit_request(request_id, "progress", progress=1.0)
            emit_request(request_id, "result", output=str(output), generation_ms=generation_ms)
        except Exception as error:
            emit_request(request_id, "error", error=str(error))
            traceback.print_exc(file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, choices=["kokoro", "piper", "melo", "parler", "f5"])
    parser.add_argument("--assets", required=True)
    parser.add_argument("--output")
    parser.add_argument("--voice")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()

    if args.check:
        check(args.model, Path(args.assets))
        return
    assets = Path(args.assets)
    if args.serve:
        serve(args.model, assets)
        return
    if not args.output:
        parser.error("--output is required for synthesis")
    text = sys.stdin.read().strip()
    if not text:
        raise ValueError("No text was provided")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    emit("progress", progress=0.0)
    synthesize = LOADERS[args.model](assets)
    synthesize(text, output, voice_id=args.voice)
    emit("progress", progress=1.0)
    emit("status", detail="Audio generated")


if __name__ == "__main__":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    main()
