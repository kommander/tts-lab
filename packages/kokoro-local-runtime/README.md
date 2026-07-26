# kokoro-local-runtime

Internal, reusable Node/Bun package containing the headless Kokoro runtime and its isolated support modules. It includes Python, ONNX CPU, WebGPU, and CoreML backends in one self-contained tarball.

## API

```js
import { createKokoro } from "kokoro-local-runtime"

const kokoro = createKokoro({ homeDir: "/absolute/cache/root" })

await kokoro.prepare("javascript-onnx-q8", {
  onEvent: console.log,
})

const started = await kokoro.start("javascript-onnx-q8")
await started.worker.generate(
  "Hello from Kokoro.",
  "/tmp/hello.wav",
  "af_heart",
  { speed: 1.2 },
)
await started.worker.stop()
await kokoro.dispose()
```

`homeDir` is required. The package never reads `TTS_LAB_HOME`, plays audio, or downloads/builds during import. `prepare()` is the explicit setup boundary and accepts an `AbortSignal`.

The optional fourth worker argument contains strictly validated request-scoped synthesis parameters. Every Kokoro profile currently exposes `speed` from `0.5` to `2.0` in `0.1` increments. Parameter changes do not reload the model.

Two deliberate subpaths expose facilities needed by other local TTS engines:

```js
import { downloadAssets, NdjsonRuntimeWorker } from "kokoro-local-runtime/core"
import { FluidAudioBuilder } from "kokoro-local-runtime/fluidaudio"
```

`core` contains resumable downloads, process-tree cancellation, shared uv bootstrap, and the concurrent NDJSON worker. `fluidaudio` contains the shared lazy builder and backend command helpers. Kokoro and Pocket use the same `FluidAudioBuilder`, pinned Swift package, cache path `<homeDir>/tools/fluidaudio-0.15.5-v3`, and `tts-lab-fluidaudio` product.

## Profiles

- `python-pytorch-fp32`
- `javascript-onnx-q8`
- `javascript-onnx-fp32`
- `javascript-webgpu-fp32`
- `native-coreml-ane`

The exported catalog contains the stable profile IDs, 28 English voices, pinned Python model assets, sizes, hashes, capability checks, and runtime restrictions. Existing TTS Lab cache paths remain compatible.

Bun resolves the package's `bun` export condition directly to TypeScript source, both in the workspace and from a packed install. Node resolves compiled `dist`. Both forms are included in the package and verified independently.

JavaScript profiles require Node 22+ or Bun 1.3+ and execute through Transformers.js 4.2.0 directly. The native profile requires macOS 14+, Apple Silicon, Swift 6, and Xcode Command Line Tools. Python setup is explicit and isolated under the supplied home directory.

The JavaScript runtimes depend directly on `@huggingface/transformers` 4.2.0
and `phonemizer` 1.2.1. Their non-streaming English adapter is derived from
kokoro-js 1.2.1 commit `664c76a704021239ba59c84dcbaa4d3dece01fe9` and
loads the 28 bundled voice tensors module-relatively in Node or Bun. Browser
support is not provided by this package.

Packed contents include built JavaScript and declarations for all three exports, the Python worker, 28 voices, the complete pinned Swift package including `Package.resolved`, and all license and notice files. Generated binaries, model data, and build caches are not included.

The package's SPDX license expression is `MIT AND Apache-2.0`: original package
code is MIT-licensed, while the adapted files and bundled Kokoro voice assets
identified in `THIRD_PARTY_NOTICES` are Apache-2.0-licensed.
