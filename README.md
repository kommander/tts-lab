# TTS Lab

A local workbench for installing, comparing, and actually using open text-to-speech models. Choose a model and voice, generate speech, compare cold and warm latency, watch the live spectrum, and save the result as WAV.

## What It Does

- Runs Kokoro, Piper, MeloTTS, Parler-TTS, and F5-TTS through one consistent workflow.
- Exposes model-specific voices, accents, and named speakers.
- Installs Python-backed engines in isolated environments.
- Downloads pinned model assets with resume support, progress reporting, and checksum verification.
- Keeps one model hot for meaningful warm-inference measurements without exhausting memory.
- Plays generated audio locally with a live FFT spectrum.
- Exports the latest generated audio through a simple path dialog.

## Requirements

- Bun 1.3+
- Python 3.8+ for Python-backed runtimes; Kokoro's JavaScript profiles do not require it
- Git for MeloTTS and Parler-TTS packages
- FFmpeg on `PATH` for F5-TTS
- Internet access during model setup

## Run

```bash
bun install
bun start
```

Everything is stored under `.tts-lab/`; no global Python packages are installed. To use another location:

```bash
TTS_LAB_HOME=/path/with/free/space bun start
```

Installing every model can require more than 15 GB because each model has an isolated runtime.

## Controls

| Key | Action |
|---|---|
| `Left` / `Right` | Browse models |
| `Up` / `Down`, `Enter` | Choose a voice |
| `Tab` / `Shift+Tab` | Move focus |
| `Ctrl+G` | Generate and play speech |
| `F2` | Save the latest WAV |
| `F3` | Choose the selected model runtime |
| `Ctrl+R` | Retry failed setup |
| `Escape` | Exit or close the save dialog |

## Models

| Model | Profile | License notes |
|---|---|---|
| Kokoro-82M | 28 English voices; CPU, CUDA, or MPS | Apache-2.0 weights |
| Piper | Three US English medium voices; CPU-first | GPL-3.0+ runtime; selected voices have non-commercial or research terms |
| MeloTTS | Five English accents | MIT model and code |
| Parler-TTS Mini v1.1 | 34 named, prompt-directed speakers | Apache-2.0 |
| F5-TTS v1 Base | Packaged reference voice; CUDA, XPU, MPS, or CPU | MIT code; CC-BY-NC-4.0 weights |

F5-TTS is reference-conditioned rather than speaker-ID based. TTS Lab uses its packaged demo reference and transcript. All engines currently produce WAV output.

### Kokoro Runtimes

Kokoro defaults to the reference Python/PyTorch runtime. Press `F3` to switch between:

- Python / PyTorch FP32: 327 MB, closest to the reference implementation.
- JavaScript / ONNX Q8: 92 MB quantized model, no Python runtime.
- JavaScript / ONNX FP32: 326 MB full-precision model, no Python runtime.

JavaScript profiles run in-process through `kokoro-js` and Transformers.js. ONNX weights download on first use and remain cached. Runtime choices persist in `.tts-lab/settings.json`.

Model, dataset, and voice licenses remain separate from this repository's license. Review them before commercial use or voice replication.

## OpenTUI

TTS Lab uses `@opentui/core` for responsive terminal layout and native audio, `@opentui/keymap` for commands, and the audio tap API with `fft.js` for spectrum analysis. Setup and inference logs are written to `.tts-lab/logs/<model>.log`.

The implementation was guided by the official [OpenTUI skill](https://skills.sh/anomalyco/opentui/opentui).

## Development

```bash
bun run check
bun test
python3 -m py_compile src/python/infer.py
```

Tests are headless and do not download model weights. Hardware-specific model setup remains an interactive smoke test.

## License

TTS Lab is MIT licensed. See `LICENSE`.
