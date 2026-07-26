# kokoro-local-runtime

Internal, headless Node/Bun Kokoro runtime with Python, ONNX CPU, WebGPU, and CoreML backends.

## API

```js
import { createKokoro } from "kokoro-local-runtime"

const kokoro = createKokoro({ homeDir: "/absolute/cache/root" })

await kokoro.prepare("javascript-onnx-q8", {
  onEvent: console.log,
})

const started = await kokoro.start("javascript-onnx-q8")
await started.worker.generate("Hello from Kokoro.", "/tmp/hello.wav", "af_heart")
await started.worker.stop()
await kokoro.dispose()
```

`homeDir` is required. The package never reads `TTS_LAB_HOME`, plays audio, or downloads/builds during import. `prepare()` is the explicit setup boundary and accepts an `AbortSignal`.

## Profiles

- `python-pytorch-fp32`
- `javascript-onnx-q8`
- `javascript-onnx-fp32`
- `javascript-webgpu-fp32`
- `native-coreml-ane`

The exported catalog contains the stable profile IDs, 28 English voices, pinned Python model assets, sizes, hashes, capability checks, and runtime restrictions. Existing TTS Lab cache paths remain compatible.

JavaScript profiles require Node 22+ or Bun 1.3+ and execute through Transformers.js 4.2.0 directly. The native profile requires macOS 14+, Apple Silicon, Swift 6, and Xcode Command Line Tools. Python setup is explicit and isolated under the supplied home directory.

The JavaScript runtimes depend directly on `@huggingface/transformers` 4.2.0
and `phonemizer` 1.2.1. Their non-streaming English adapter is derived from
kokoro-js 1.2.1 commit `664c76a704021239ba59c84dcbaa4d3dece01fe9` and
loads the 28 bundled voice tensors module-relatively in Node or Bun. Browser
support is not provided by this package.

The package's SPDX license expression is `MIT AND Apache-2.0`: original package
code is MIT-licensed, while the adapted files and bundled Kokoro voice assets
identified in `THIRD_PARTY_NOTICES` are Apache-2.0-licensed.
