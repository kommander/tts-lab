# TTS Lab

A local workbench for installing, comparing, and actually using open text-to-speech models. Choose a model and voice, generate speech, compare cold and warm latency, watch the live spectrum, and save the result as WAV.

## What It Does

- Runs Kokoro, KittenTTS, Pocket TTS, Qwen3-TTS, Piper, MeloTTS, Parler-TTS, and F5-TTS through one workflow.
- Exposes model-specific voices, accents, and named speakers.
- Installs Python-backed engines in isolated environments.
- Downloads pinned model assets with resume support, progress reporting, and checksum verification.
- Keeps one model hot for meaningful warm-inference measurements without exhausting memory.
- Tracks per-configuration generation samples, average, median, range, and measurable process memory.
- Plays generated audio locally with a live FFT spectrum.
- Exports the latest generated audio through a simple path dialog.

## Requirements

- Bun 1.3+
- Python 3 is required once to bootstrap uv; model-specific Python versions are installed automatically
- Swift 6 and the Xcode command-line tools for native CoreML profiles
- KittenTTS on macOS requires macOS 14+ on Apple Silicon; its pinned ONNX Runtime has no Intel Mac wheel
- Qwen3-TTS requires macOS 14+ on Apple Silicon with at least 16 GB unified memory
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

## Workspace

This repository is a Bun monorepo with one lockfile and two packages:

| Package | Purpose |
|---|---|
| `packages/tts-lab` | Private OpenTUI application |
| `packages/kokoro-local-runtime` | Reusable, self-contained Node/Bun package with all five Kokoro profiles and shared runtime facilities |

`kokoro-local-runtime` is intentionally private while its API and packaging are exercised inside the workspace. Its root export is the Kokoro API; deliberate `kokoro-local-runtime/core` and `kokoro-local-runtime/fluidaudio` boundaries expose generic process/download/worker facilities and the shared FluidAudio builder. Kokoro imports those modules internally by relative path, while TTS Lab uses the public subpaths. The package performs no setup at import or package-install time.

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
| `F4` | Tune synthesis parameters for the selected runtime |
| `Ctrl+R` | Retry failed setup |
| `Escape` | Exit or close the active dialog |

## Synthesis Tuning

Press `F4` to open the selected runtime's tuning form. Use `Up`/`Down` to select a field, `Left`/`Right` to change it, `R` to reset the draft, `Enter` to apply, and `Escape` to discard. Applied values affect the next request without reloading a resident model and persist per model/runtime in `.tts-lab/settings.json`.

| Model | Exposed controls |
|---|---|
| Kokoro | Speed `0.5–2.0` on every runtime |
| KittenTTS | Speed `0.5–2.0` |
| Pocket TTS | Temperature preset (`0`, `0.3`, `0.7`); de-essing toggle |
| Qwen3-TTS | Language, 1.7B style instruction, temperature preset (`0.5`, `0.7`, `0.9`), top-p, top-k, repetition penalty, token budget (`256–4096`), deterministic seed |
| Piper | Slow/normal/fast presets (`0.5×`, `1×`, `2×`) mapped to each voice's native length scale |
| MeloTTS | Speed `0.1–10.0` |
| Parler-TTS | Speaking rate, pitch, and expression prompt choices |
| F5-TTS | Speed, NFE steps, seed, crossfade, and silence removal |

## Models

| Model | Profile | License notes |
|---|---|---|
| Kokoro-82M | 28 English voices; PyTorch, ONNX CPU/WebGPU, or CoreML ANE | Apache-2.0 weights |
| KittenTTS Nano | Eight English voices; 15M INT8 ONNX model on CPU | Apache-2.0 model/code; GPL-3.0+ phonemizer/eSpeak runtime |
| Pocket TTS | Eight English CC0/CC BY voices; CoreML ANE FP16 | Apache-2.0 runtime; CC BY 4.0 model; per-voice terms |
| Qwen3-TTS 1.7B | Nine preset voices; multilingual MLX 8-bit quality profile | MIT MLX runtime; Apache-2.0 model |
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
- Native / CoreML ANE: experimental FluidAudio 0.15.5 sidecar for macOS 14+ on Apple Silicon with all 28 bundled English voices.

JavaScript profiles run in-process through a package-internal, Apache-2.0 Kokoro adapter with Transformers.js 4.2.0 and phonemizer 1.2.1. ONNX weights download on first use and remain cached. The CoreML profile builds its pinned Swift sidecar on first selection; first synthesis uses about 193 MiB of model/G2P assets and generates about 184 MiB of CoreML cache. Runtime and tuning choices persist in `.tts-lab/settings.json`.

### KittenTTS

[KittenTTS](https://github.com/KittenML/KittenTTS) uses the pinned Nano 0.8 INT8 model and a version-locked Python/ONNX CPU environment. Its config, model, and shared eight-voice bank total 26.4 MiB. It is an English developer preview; upstream does not publish separate training-data or built-in voice provenance.

### Pocket TTS

[Pocket TTS](https://github.com/kyutai-labs/pocket-tts) uses FluidAudio 0.15.5 with a pinned 350.5 MiB English FP16 graph. Autoregressive inference targets ANE with CPU Mimi decoding; CoreML may schedule conditioning on GPU. Only the required graph and selected voice files are downloaded, and mutable upstream downloads are disabled. Alba is CC BY 4.0, while the other exposed voices are CC0. Voice cloning, multilingual packs, separate GPU/int8 profiles, and unstable ANE-state execution are intentionally not exposed. Pocket's model-card prohibited-use policy also applies.

### Qwen3-TTS

[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) uses MLX-Audio 0.4.6 and the immutable 1.7B CustomVoice 8-bit conversion. Seven verified model files total 2.87 GiB. This quality profile exposes all nine preset speakers, supported 1.7B style instructions, language selection, official sampling controls, deterministic fixed-seed sampling, single-pass generation, and an evaluation-aligned 2048-codec-token default budget. Output that reaches the selected ceiling without EOS is rejected rather than silently truncated. Voice cloning, voice design, and unseeded generation are intentionally not exposed.

The 1.7B 8-bit profile is the measured default rather than the smaller 0.6B 4-bit conversion: for the same 446-character English passage, 1.7B produced 33–34 seconds of audio and peaked below 9 GB of MLX allocation, while 0.6B drifted to 85–108 seconds and peaked at 12–15 GB because it generated far more codec tokens. Setup requires macOS 14+ on Apple Silicon with at least 16 GB unified memory. Qwen does not implement a native speed control, and no seed is universally best; the seed exists for repeatability within this pinned runtime. Very long single-pass generation remains an upstream autoregressive limitation, so token ceilings and output review are still required for multi-minute material.

Runtime statistics are session-local and separate per runtime, voice, and normalized tuning configuration. JavaScript ONNX memory is included in app RSS; Python and CoreML workers report available current and peak RSS. These are process-level values, not model-tensor estimates.

Model, dataset, and voice licenses remain separate from this repository's license. Review them before commercial use or voice replication.

## OpenTUI

TTS Lab uses `@opentui/core` for responsive terminal layout and native audio, `@opentui/keymap` for commands, and the audio tap API with `fft.js` for spectrum analysis. Setup and inference logs are written to `.tts-lab/logs/<model>.log`.

The implementation was guided by the official [OpenTUI skill](https://skills.sh/anomalyco/opentui/opentui).

## Development

```bash
bun run check
bun test
bun run check:python
```

Tests are headless and do not download model weights. Hardware-specific model setup remains an interactive smoke test.

## License

TTS Lab is MIT licensed. See `LICENSE`.
