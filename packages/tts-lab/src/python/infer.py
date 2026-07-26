from __future__ import annotations

import argparse
import atexit
import json
import math
import os
import subprocess
import shutil
import sys
import time
import traceback
import tempfile
import wave
from pathlib import Path
from types import ModuleType


_MISSING = object()

PARAMETER_DEFINITIONS = {
    "kitten": {
        "speed": ("number", 1.0, 0.5, 2.0, 0.05),
    },
    "qwen": {
        "temperature": ("enum", "stable", ("stable", "expressive")),
        "seed": ("number", 42, 0, 2147483647, 1),
    },
    "piper": {
        "speed": ("enum", "normal", ("slow", "normal", "fast")),
    },
    "melo": {
        "speed": ("number", 1.0, 0.1, 10.0, 0.1),
    },
    "parler": {
        "rate": ("enum", "moderate", ("slow", "moderate", "fast")),
        "pitch": ("enum", "natural", ("low", "natural", "high")),
        "expression": ("enum", "slight", ("neutral", "slight", "expressive")),
    },
    "f5": {
        "speed": ("number", 1.0, 0.3, 2.0, 0.1),
        "nfeSteps": ("number", 32, 4, 64, 2),
        "seed": ("number", 42, 0, 2147483647, 1),
        "crossFade": ("number", 0.15, 0.0, 1.0, 0.01),
        "removeSilence": ("boolean", False),
    },
}


def parse_synthesis_parameters(model: str, value: object = _MISSING) -> dict[str, object]:
    definitions = PARAMETER_DEFINITIONS[model]
    if value is _MISSING:
        supplied = {}
    elif type(value) is not dict:
        raise ValueError("Synthesis parameters must be an object")
    else:
        supplied = value

    unknown = sorted(set(supplied) - set(definitions))
    if unknown:
        raise ValueError(f"Unknown synthesis parameter: {unknown[0]}")

    normalized = {}
    for name, definition in definitions.items():
        kind, default, *constraints = definition
        parameter = supplied.get(name, default)
        if kind == "number":
            minimum, maximum, step = constraints
            if isinstance(parameter, bool) or not isinstance(parameter, (int, float)) or not math.isfinite(parameter):
                raise ValueError(f"{name} must be a finite number")
            if parameter < minimum or parameter > maximum:
                raise ValueError(f"{name} must be between {minimum:g} and {maximum:g}")
            steps = (parameter - minimum) / step
            if not math.isclose(steps, round(steps), rel_tol=0.0, abs_tol=1e-9):
                raise ValueError(f"{name} must use increments of {step:g}")
        elif kind == "boolean":
            if type(parameter) is not bool:
                raise ValueError(f"{name} must be a boolean")
        elif type(parameter) is not str or parameter not in constraints[0]:
            raise ValueError(f"{name} must be one of: {', '.join(constraints[0])}")
        normalized[name] = parameter
    return normalized


def parse_request_parameters(model: str, request: dict[str, object]) -> dict[str, object]:
    if "parameters" not in request:
        return parse_synthesis_parameters(model)
    return parse_synthesis_parameters(model, request["parameters"])


def build_parler_description(voice_id: str, parameters: dict[str, object]) -> str:
    expression = {
        "neutral": "neutral",
        "slight": "slightly expressive",
        "expressive": "expressive",
    }[parameters["expression"]]
    return (
        f"{voice_id}'s voice is clear and {expression}, with a {parameters['rate']} speaking rate "
        f"and {parameters['pitch']} pitch. The recording is of very high quality with very clear audio; "
        "the voice sounds close, with almost no reverberation or background noise."
    )


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
    if model == "kitten":
        emit("status", detail="Checking KittenTTS Nano INT8 model")
        create_kitten_model(assets)
    elif model == "qwen":
        emit("status", detail="Checking Qwen3-TTS MLX model")
        create_qwen_model(assets)
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


def create_kitten_model(assets: Path):
    import espeakng_loader
    from kittentts.onnx_model import KittenTTS_1_Onnx

    if os.name != "nt":
        # eSpeak's compiled data-path buffer can reject long virtualenv paths.
        # Point it at the same bundled data through a short process-local link.
        espeak_root = Path(tempfile.mkdtemp(prefix="tts-lab-espeak-"))
        espeak_link = espeak_root / "data"
        espeak_link.symlink_to(espeakng_loader.get_data_path(), target_is_directory=True)
        os.environ["ESPEAK_DATA_PATH"] = str(espeak_link)
        atexit.register(shutil.rmtree, espeak_root, ignore_errors=True)

    with open(assets / "config.json", "r", encoding="utf-8") as config_file:
        config = json.load(config_file)
    return KittenTTS_1_Onnx(
        model_path=str(assets / config["model_file"]),
        voices_path=str(assets / config["voices"]),
        speed_priors=config.get("speed_priors", {}),
        voice_aliases=config.get("voice_aliases", {}),
        backend="cpu",
    )


def load_kitten(assets: Path):
    import numpy as np
    import soundfile as sf

    emit("status", detail="Loading KittenTTS Nano INT8 on CPU")
    model = create_kitten_model(assets)

    def synthesize(
        text: str,
        output: Path,
        request_id: str | None = None,
        voice_id: str | None = None,
        parameters: dict[str, object] | None = None,
    ) -> None:
        parameters = parse_synthesis_parameters("kitten", parameters if parameters is not None else _MISSING)
        voice_id = voice_id or "Jasper"
        emit_request(request_id, "status", detail=f"Synthesizing with KittenTTS {voice_id} on CPU")
        audio = np.asarray(
            model.generate(text, voice=voice_id, speed=parameters["speed"], clean_text=True),
            dtype=np.float32,
        ).squeeze()
        if audio.ndim != 1 or audio.size == 0 or not np.isfinite(audio).all():
            raise RuntimeError("KittenTTS produced invalid audio")
        sf.write(output, audio, 24000, subtype="PCM_16")

    return synthesize


QWEN_SPEAKERS = {
    "serena", "vivian", "uncle_fu", "ryan", "aiden", "ono_anna", "sohee", "eric", "dylan"
}
QWEN_MAX_AUDIO_TOKENS = 256
QWEN_AUDIO_TOKENS_PER_TEXT_TOKEN = 6
QWEN_MAX_TEXT_TOKENS = QWEN_MAX_AUDIO_TOKENS // QWEN_AUDIO_TOKENS_PER_TEXT_TOKEN


def create_qwen_model(assets: Path):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from mlx_audio.tts.utils import load_model

    return load_model(assets)


def load_qwen(assets: Path):
    import mlx.core as mx
    import numpy as np

    emit("status", detail="Loading Qwen3-TTS 0.6B CustomVoice 4-bit on MLX")
    model = create_qwen_model(assets)

    def synthesize(
        text: str,
        output: Path,
        request_id: str | None = None,
        voice_id: str | None = None,
        parameters: dict[str, object] | None = None,
    ) -> None:
        parameters = parse_synthesis_parameters("qwen", parameters if parameters is not None else _MISSING)
        voice_id = (voice_id or "ryan").lower()
        if voice_id not in QWEN_SPEAKERS:
            raise ValueError(f"Unknown Qwen3-TTS speaker: {voice_id}")
        text_tokens = len(model.tokenizer.encode(text))
        if text_tokens > QWEN_MAX_TEXT_TOKENS:
            raise ValueError(
                f"Qwen3-TTS input is too long ({text_tokens} text tokens); "
                f"the deterministic profile allows at most {QWEN_MAX_TEXT_TOKENS}"
            )
        emit_request(request_id, "status", detail=f"Synthesizing with Qwen3-TTS {voice_id} on MLX")
        temperature = {"stable": 0.7, "expressive": 0.9}[parameters["temperature"]]
        mx.random.seed(int(parameters["seed"]))
        results = list(model.generate_custom_voice(
            text=text,
            speaker=voice_id,
            language="English",
            instruct=None,
            temperature=temperature,
            max_tokens=QWEN_MAX_AUDIO_TOKENS,
            top_k=50,
            top_p=1.0,
            repetition_penalty=1.05,
            verbose=False,
            stream=False,
        ))
        if not results:
            raise RuntimeError("Qwen3-TTS produced no audio")
        if any(int(result.token_count) >= QWEN_MAX_AUDIO_TOKENS for result in results):
            raise RuntimeError("Qwen3-TTS reached the 256-token safety ceiling before emitting EOS")
        sample_rates = {int(result.sample_rate) for result in results}
        if sample_rates != {24000}:
            raise RuntimeError(f"Qwen3-TTS returned unexpected sample rates: {sorted(sample_rates)}")
        audio = np.concatenate([np.asarray(result.audio, dtype=np.float32).reshape(-1) for result in results])
        if audio.size == 0 or not np.isfinite(audio).all():
            raise RuntimeError("Qwen3-TTS produced invalid audio")
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
        with wave.open(str(output), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(24000)
            wav_file.writeframes(pcm.tobytes())

    return synthesize


def load_piper(assets: Path):
    from piper import PiperVoice, SynthesisConfig

    emit("status", detail="Loading Piper ONNX voice on CPU")
    voices = {"en_US-lessac-medium": PiperVoice.load(str(assets / "en_US-lessac-medium.onnx"))}

    def synthesize(
        text: str,
        output: Path,
        request_id: str | None = None,
        voice_id: str | None = None,
        parameters: dict[str, object] | None = None,
    ) -> None:
        parameters = parse_synthesis_parameters("piper", parameters if parameters is not None else _MISSING)
        voice_id = voice_id or "en_US-lessac-medium"
        if voice_id not in voices:
            model_path = assets / "voices" / voice_id / f"{voice_id}.onnx"
            voices[voice_id] = PiperVoice.load(str(model_path))
        voice = voices[voice_id]
        speed_factor = {"slow": 0.5, "normal": 1.0, "fast": 2.0}[parameters["speed"]]
        synthesis_config = SynthesisConfig(length_scale=voice.config.length_scale / speed_factor)
        emit_request(request_id, "status", detail=f"Synthesizing with Piper {voice_id}")
        with wave.open(str(output), "wb") as wav_file:
            voice.synthesize_wav(text, wav_file, syn_config=synthesis_config)

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

    def synthesize(
        text: str,
        output: Path,
        request_id: str | None = None,
        voice_id: str | None = None,
        parameters: dict[str, object] | None = None,
    ) -> None:
        parameters = parse_synthesis_parameters("melo", parameters if parameters is not None else _MISSING)
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
            speed=parameters["speed"],
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
    def synthesize(
        text: str,
        output: Path,
        request_id: str | None = None,
        voice_id: str | None = None,
        parameters: dict[str, object] | None = None,
    ) -> None:
        parameters = parse_synthesis_parameters("parler", parameters if parameters is not None else _MISSING)
        voice_id = voice_id or "Jon"
        description = build_parler_description(voice_id, parameters)
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

    def synthesize(
        text: str,
        output: Path,
        request_id: str | None = None,
        voice_id: str | None = None,
        parameters: dict[str, object] | None = None,
    ) -> None:
        parameters = parse_synthesis_parameters("f5", parameters if parameters is not None else _MISSING)
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
            speed=parameters["speed"],
            nfe_step=int(parameters["nfeSteps"]),
            seed=int(parameters["seed"]),
            cross_fade_duration=parameters["crossFade"],
            remove_silence=parameters["removeSilence"],
        )

    return synthesize


LOADERS = {
    "kitten": load_kitten,
    "qwen": load_qwen,
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
            parameters = parse_request_parameters(model_name, request)
            if not text:
                raise ValueError("No text was provided")
            output.parent.mkdir(parents=True, exist_ok=True)
            started = time.perf_counter()
            synthesize(text, output, request_id, voice_id, parameters)
            generation_ms = round((time.perf_counter() - started) * 1000, 1)
            emit_request(request_id, "progress", progress=1.0)
            emit_request(
                request_id,
                "result",
                output=str(output),
                generation_ms=generation_ms,
                resource=resource_snapshot(),
            )
        except Exception as error:
            emit_request(request_id, "error", error=str(error))
            traceback.print_exc(file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, choices=["kitten", "qwen", "piper", "melo", "parler", "f5"])
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
