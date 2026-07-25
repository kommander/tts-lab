# TTS Lab

A local workbench for installing, comparing, and actually using open text-to-speech models. Choose a model and voice, generate speech, compare cold and warm latency, watch the live spectrum, and save the result as WAV.

## What It Does

- Runs Kokoro, Piper, MeloTTS, Parler-TTS, and F5-TTS through one consistent workflow.
- Exposes model-specific voices, accents, and named speakers.
- Installs Python-backed engines in isolated environments.
- Downloads pinned model assets with resume support, progress reporting, and checksum verification.
- Keeps one model hot for meaningful warm-inference measurements without exhausting memory.
- Tracks per-runtime generation samples, average, median, range, and measurable process memory.
- Plays generated audio locally with a live FFT spectrum.
- Exports the latest generated audio through a simple path dialog.

## Requirements

- Bun 1.3+
- Python 3.8+ for Python-backed runtimes; Kokoro's JavaScript profiles do not require it
- Swift 6 and the Xcode command-line tools to build Kokoro's optional native CoreML profile
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

Runtime memory is sampled immediately when a model becomes resident, then every four seconds. Configure the interval in milliseconds, or disable periodic polling with `0`:

```bash
TTS_LAB_RESOURCE_POLL_MS=5000 bun start
```

Installing every model can require more than 15 GB because each model has an isolated runtime.

## Controls

| Key | Action |
|---|---|
| `Left` / `Right` | Browse models |
| `Up` / `Down`, `Enter` | Choose a voice |
| `Tab` / `Shift+Tab` | Move focus |
| `Up` / `Down`, `Page Up` / `Page Down`, `Home` / `End` | Scroll runtime statistics when focused |
| `Ctrl+G` | Generate and play speech |
| `F2` | Save the latest WAV |
| `F3` | Choose the selected model runtime |
| `Ctrl+R` | Retry failed setup |
| `Escape` | Exit or close the save dialog |

## Models

| Model | Profile | License notes |
|---|---|---|
| Kokoro-82M | 28 English voices; PyTorch, ONNX CPU/WebGPU, or CoreML ANE | Apache-2.0 weights |
| Piper | Three US English medium voices; CPU-first | GPL-3.0+ runtime; selected voices have non-commercial or research terms |
| MeloTTS | Five English accents | MIT model and code |
| Parler-TTS Mini v1.1 | 34 named, prompt-directed speakers | Apache-2.0 |
| F5-TTS v1 Base | Packaged reference voice; CUDA, XPU, MPS, or CPU | MIT code; CC-BY-NC-4.0 weights |

F5-TTS is reference-conditioned rather than speaker-ID based. TTS Lab uses its packaged demo reference and transcript. All engines currently produce WAV output.

### Kokoro Runtimes

Kokoro defaults to the reference Python/PyTorch runtime. Press `F3` to switch between:

- Python / PyTorch FP32: 327 MB, closest to the reference implementation.
- JavaScript / ONNX Q8 Compact: 92 MB low-download model; smaller but slower than FP32 on the tested Apple Silicon system.
- JavaScript / ONNX FP32: 326 MB full-precision CPU model with lower-memory ONNX session settings.
- JavaScript / WebGPU FP32: experimental 326 MB profile using ONNX Runtime's native WebGPU provider; no Bun WebGPU flag required.
- Native / CoreML ANE: experimental FluidAudio 0.15.5 sidecar for macOS 14+ on Apple Silicon; currently limited to `af_heart`.

JavaScript profiles run in-process through `kokoro-js` 1.2.1 and Transformers.js 4.2.0. ONNX weights download on first use and remain cached. The CoreML profile builds its pinned Swift sidecar on first selection; first synthesis uses about 193 MiB of model/G2P assets and generates about 184 MiB of CoreML cache. Runtime choices persist in `.tts-lab/settings.json`.

Runtime statistics are session-local and separate per profile. JavaScript ONNX memory is included in app RSS; Python and CoreML workers report available current and peak RSS. These are process-level values, not model-tensor estimates.

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

## Future Models

- Evaluate KittenTTS as a very small CPU-first runtime.
- Evaluate Pocket TTS for lightweight local voice cloning once its model and redistribution constraints are suitable.

## License

TTS Lab is MIT licensed. See `LICENSE`.
