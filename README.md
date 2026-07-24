# Local TTS Lab

A small SolidJS terminal application for installing and trying five local TTS engines. The interface is rendered by OpenTUI and generated WAV files are played with OpenTUI's native `Audio` API.

## Run

Requirements:

- Bun 1.3 or newer
- Python 3.8 or newer, used only to bootstrap the app-local `uv` executable
- Git, required by MeloTTS and Parler-TTS upstream packages
- FFmpeg on `PATH` for F5-TTS
- Internet access while setting up a model

```bash
bun install
bun start
```

No global Python packages are installed. The app installs `uv==0.11.32` under `.tts-lab/tools/`, then creates an isolated Python environment for each model. `uv` downloads Python 3.9, 3.11, or 3.12 when the requested interpreter is not already available.

Set `TTS_LAB_HOME` to store environments and weights somewhere other than `.tts-lab`:

```bash
TTS_LAB_HOME=/path/with/free/space bun start
```

## Controls

| Key | Action |
|---|---|
| `Left` / `Right` | Browse models while the model rack is focused |
| `Enter` | Confirm a model |
| `Tab` / `Shift+Tab` | Move focus among the model rack, voice list, and editor |
| `Up` / `Down`, then `Enter` | Choose a voice while the voice list is focused |
| `Ctrl+G` | Generate and play the editor text |
| `Ctrl+R` | Retry the selected model after a setup error |
| `Escape` | Exit and restore the terminal |

Selecting a model immediately starts its setup if needed. Model switching remains available while setup or synthesis is in progress. Setups are isolated, so more than one model can be downloading at once. Synthesis itself is serialized to avoid loading multiple large models into memory simultaneously.

Voice choices are model-aware. Kokoro exposes its 28 English voices, MeloTTS exposes five English accents, and Parler-TTS exposes all 34 named speakers from the official checkpoint. Piper includes Lessac plus HFC female and male medium voices; alternate Piper voices download their own 63 MB ONNX file when first selected. F5-TTS currently exposes its single packaged Nature reference profile because additional F5 voices require reference audio and an exact transcript rather than a speaker ID.

## Integrations

| Model | Runtime and checkpoint | Demo voice | Important note |
|---|---|---|---|
| Kokoro | `kokoro==0.9.4`, `hexgrad/Kokoro-82M` pinned at `f3ff357` | `af_heart`, American English | Apache-2.0 weights. Uses Python 3.11. |
| Piper | `piper-tts==1.6.0`, `en_US-lessac-medium` at voice revision `v1.0.0` | Lessac medium | Uses the current Open Home Foundation GPL successor. The selected Lessac voice links to research-only source-data terms. |
| MeloTTS | Source commit `2091453`, English v1 checkpoint pinned at `bb4fb73` | `EN-US` | Uses the officially documented Python 3.9 path. English BERT and NLTK data are provisioned during setup instead of on first speech. |
| Parler-TTS | Source commit `d108732`, Mini v1.1 pinned at `fbb2dd2` | Jon style prompt | 0.9B FP32 model. Both the prompt tokenizer and FLAN description tokenizer are downloaded locally. |
| F5-TTS | `f5-tts==1.1.22`, v1 Base pinned at `84e5a41` | Packaged Nature demo reference | F5 is reference-conditioned, not plain text-only TTS. The app uses the package's official reference WAV and exact transcript. Pretrained weights are CC-BY-NC-4.0. |

The displayed byte progress covers pinned model assets, with resumable HTTP range downloads and SHA-256 verification for large files. Python wheels, managed Python interpreters, spaCy, NLTK, and other package resources are shown by the separate environment setup bar because their installers do not expose a stable byte-level API.

Expect substantial disk use. Installing every model duplicates incompatible PyTorch stacks across environments and can require well over 15 GB in addition to the displayed model assets.

## Cold And Warm Latency

Model setup downloads files and creates the environment, but it does not allocate the model in RAM or VRAM. The first speech request starts a Python worker and loads the selected model. That worker remains alive, so later requests for the same model measure warm inference without reloading weights.

The Signal panel reports model-load, synthesis, and OpenTUI playback-start times and shows whether the worker is hot. Only one model worker is retained at a time to avoid exhausting memory. Selecting another model does not evict the worker, but speaking with another model stops the previous worker before loading the new one.

## Hardware

- Piper is CPU-only and is the lightest option.
- Kokoro runs on CUDA, MPS, or CPU according to the installed PyTorch capabilities.
- MeloTTS uses CPU for the acoustic model. Its pinned upstream English BERT helper may select MPS on macOS.
- Parler-TTS selects CUDA or MPS when available, otherwise CPU. On Apple Silicon, autoregressive generation stays on MPS while DAC audio decoding runs on CPU to avoid MPS convolution limits.
- F5-TTS uses its official automatic order: CUDA, Intel XPU, MPS, then CPU.

The default PyTorch packages come from PyPI. Systems needing a particular CUDA, ROCm, or Intel XPU build should install the matching official PyTorch build into that model's environment before running synthesis.

## Development

```bash
bun run check
bun test
python3 -m py_compile src/python/infer.py
```

Tests use OpenTUI's Solid `testRender` utility and do not download model weights. Full model setup is intentionally an interactive smoke test because the complete matrix is multi-gigabyte and hardware-specific.

## Troubleshooting

- F5-TTS setup stops immediately if `ffmpeg -version` is unavailable.
- An interrupted model file remains as `*.part` and resumes when the model is selected again.
- Press `Ctrl+R` after correcting a setup error.
- Setup and inference command logs are appended to `.tts-lab/logs/<model>.log`.
- Delete one model directory under `.tts-lab/models/` to force a clean reinstall of only that model.
- OpenTUI local playback supports WAV, MP3, and FLAC. This app writes WAV for every engine.

Model licenses do not grant rights to clone or deploy a person's voice. Review the selected checkpoint, dataset, and voice terms before any non-demo use.
