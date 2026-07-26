import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  KOKORO_ASSETS,
  KOKORO_DEFAULT_PARAMETERS,
  KOKORO_MODEL,
  KOKORO_RUNTIME_IDS,
  KOKORO_SETUP_VERSION,
  KOKORO_VOICES,
  TRANSFORMERS_JS_COMPATIBILITY,
  createKokoro,
  getJavascriptLoadOptions,
  getKokoroCapability,
  normalizeKokoroSynthesisParameters,
} from "../dist/index.js"
import { KokoroJavascriptWorker } from "../dist/javascript-worker.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ""
})

test("owns the stable catalog and runtime IDs", () => {
  assert.equal(KOKORO_MODEL.setupVersion, "kokoro-0.9.4-v2")
  assert.equal(KOKORO_VOICES.length, 28)
  assert.deepEqual(KOKORO_RUNTIME_IDS, [
    "python-pytorch-fp32",
    "javascript-onnx-q8",
    "javascript-onnx-fp32",
    "javascript-webgpu-fp32",
    "native-coreml-ane",
  ])
  assert.equal(KOKORO_MODEL.runtimes.find(({ id }) => id === "javascript-onnx-fp32").lowMemory, true)
  assert.deepEqual(KOKORO_MODEL.runtimes.find(({ id }) => id === "native-coreml-ane").voiceIds, ["af_heart"])
  assert.deepEqual(KOKORO_DEFAULT_PARAMETERS, { speed: 1 })
  for (const runtime of KOKORO_MODEL.runtimes) {
    assert.deepEqual(runtime.parameters, [{
      id: "speed",
      label: "Speed",
      description: "Speech speed multiplier",
      type: "number",
      default: 1,
      min: 0.5,
      max: 2,
      step: 0.1,
    }])
  }
})

test("normalizes Kokoro speed and reports invalid parameters with a stable code", () => {
  assert.deepEqual(normalizeKokoroSynthesisParameters(), { speed: 1 })
  assert.deepEqual(normalizeKokoroSynthesisParameters({ speed: 1.4 }), { speed: 1.4 })
  for (const parameters of [{ speed: false }, { speed: 0.4 }, { speed: 1.05 }, { pitch: 1 }]) {
    assert.throws(
      () => normalizeKokoroSynthesisParameters(parameters, "javascript-onnx-q8"),
      (error) => error.code === "INVALID_PARAMETER" && error.runtimeId === "javascript-onnx-q8",
    )
  }
})

test("reports runtime capabilities", () => {
  assert.equal(getKokoroCapability("python-pytorch-fp32", "linux", "x64", "6.0.0").supported, true)
  assert.equal(getKokoroCapability("native-coreml-ane", "darwin", "arm64", "23.0.0").supported, true)
  assert.match(getKokoroCapability("native-coreml-ane", "darwin", "x64", "25.0.0").reason, /Apple Silicon/)
  assert.deepEqual(getKokoroCapability("native-coreml-ane", "darwin", "arm64", "23.0.0").voices, ["af_heart"])
  assert.equal(getKokoroCapability("javascript-onnx-q8", "linux", "arm64").supported, true)
  assert.equal(getKokoroCapability("javascript-webgpu-fp32", "linux", "arm64").supported, false)
  assert.equal(getKokoroCapability("javascript-webgpu-fp32", "freebsd", "x64").supported, false)
  assert.equal(getKokoroCapability("python-pytorch-fp32", "freebsd", "x64").supported, false)
})

test("constructing and importing perform no filesystem setup", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-no-effects-"))
  const home = join(directory, "absent-home")
  const runtime = createKokoro({ homeDir: home })
  assert.equal(runtime.paths.homeDir, home)
  await import(new URL(`../dist/index.js?side-effect=${Date.now()}`, import.meta.url))
  await assert.rejects(() => import("node:fs/promises").then(({ stat }) => stat(home)), { code: "ENOENT" })
  await runtime.dispose()
})

test("requires all JavaScript support files before reporting a fully cached model", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-cache-"))
  const runtime = createKokoro({ homeDir: directory })
  const modelRoot = join(runtime.paths.javascriptCacheDir, "onnx-community", "Kokoro-82M-v1.0-ONNX")
  const model = join(modelRoot, "onnx", "model_quantized.onnx")
  await mkdir(join(model, ".."), { recursive: true })
  await writeFile(model, "")
  await truncate(model, 92361116)

  const partial = await runtime.inspect("javascript-onnx-q8")
  assert.equal(partial.cached, false)
  assert.equal(partial.downloadedBytes, 92361116)
  assert.match(partial.detail, /support files/)

  for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json"]) {
    await writeFile(join(modelRoot, file), "{}")
  }
  const complete = await runtime.inspect("javascript-onnx-q8")
  assert.equal(complete.cached, true)
  assert.equal(complete.detail, "Ready")
  await runtime.dispose()
})

test("deduplicates prepare across instances and keeps work alive for remaining callers", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-shared-prepare-"))
  const first = createKokoro({ homeDir: directory })
  const second = createKokoro({ homeDir: directory })
  let ready = false
  let calls = 0
  let release
  let sharedSignal
  const gate = new Promise((resolve) => { release = resolve })
  const inspection = () => ({
    runtimeId: "python-pytorch-fp32",
    supported: true,
    voices: KOKORO_VOICES.map(({ id }) => id),
    ready,
    cached: ready,
    detail: ready ? "Ready" : "Not installed",
    downloadedBytes: 0,
    totalBytes: 0,
  })
  first.inspect = async () => inspection()
  second.inspect = async () => inspection()
  first.preparePython = async (_runtimeId, options) => {
    calls += 1
    sharedSignal = options.signal
    options.onEvent({ type: "status", phase: "setup", detail: "shared" })
    await gate
    options.signal.throwIfAborted()
    ready = true
  }
  second.preparePython = first.preparePython
  const firstEvents = []
  const secondEvents = []
  const firstController = new AbortController()
  const firstPrepare = first.prepare("python-pytorch-fp32", {
    signal: firstController.signal,
    onEvent: (event) => firstEvents.push(event.detail),
  })
  const secondPrepare = second.prepare("python-pytorch-fp32", {
    onEvent: (event) => secondEvents.push(event.detail),
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  firstController.abort()
  await assert.rejects(firstPrepare, { name: "AbortError" })
  assert.equal(sharedSignal.aborted, false)
  release()
  assert.equal((await secondPrepare).ready, true)
  assert.equal(calls, 1)
  assert.deepEqual(firstEvents, ["shared"])
  assert.deepEqual(secondEvents, ["shared", "Ready"])
  await Promise.all([first.dispose(), second.dispose()])
})

test("cancels and joins shared preparation when its last waiter leaves", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-shared-cancel-"))
  const runtime = createKokoro({ homeDir: directory })
  let cancelled = false
  runtime.inspect = async () => ({
    runtimeId: "python-pytorch-fp32",
    supported: true,
    voices: KOKORO_VOICES.map(({ id }) => id),
    ready: false,
    cached: false,
    detail: "Not installed",
    downloadedBytes: 0,
    totalBytes: 0,
  })
  runtime.preparePython = async (_runtimeId, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => {
      cancelled = true
      reject(options.signal.reason)
    }, { once: true })
  })
  const controller = new AbortController()
  const operation = runtime.prepare("python-pytorch-fp32", { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(operation, { name: "AbortError" })
  assert.equal(cancelled, true)
  await runtime.dispose()
})

test("deduplicates voice downloads across instances", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-shared-voice-"))
  const first = createKokoro({ homeDir: directory })
  const second = createKokoro({ homeDir: directory })
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  first.downloadVoice = async (_voice, options) => {
    calls += 1
    options.onEvent({ type: "status", phase: "download", detail: "shared voice" })
    await gate
  }
  second.downloadVoice = first.downloadVoice
  const firstEvents = []
  const secondEvents = []
  const operations = [
    first.ensureVoice("af_alloy", { onEvent: (event) => firstEvents.push(event.detail) }),
    second.ensureVoice("af_alloy", { onEvent: (event) => secondEvents.push(event.detail) }),
  ]
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  await Promise.all(operations)
  assert.equal(calls, 1)
  assert.deepEqual(firstEvents, ["shared voice"])
  assert.deepEqual(secondEvents, ["shared voice"])
  await Promise.all([first.dispose(), second.dispose()])
})

test("disposal cancels and joins an in-flight JavaScript load", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-dispose-load-"))
  const originalStart = KokoroJavascriptWorker.start
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let stops = 0
  try {
    KokoroJavascriptWorker.start = async (options) => {
      await gate
      const worker = {
        generate: async () => ({ output: "", generationMs: 0 }),
        dispose: () => undefined,
        stop: async () => {
          stops += 1
          options.onExit?.()
        },
        getResourceUsage: () => ({}),
      }
      return { worker, loadMs: 1 }
    }
    const runtime = createKokoro({ homeDir: directory })
    const loading = runtime.start("javascript-onnx-q8")
    const disposal = runtime.dispose()
    release()
    await assert.rejects(loading, { name: "AbortError" })
    await disposal
    assert.equal(stops, 1)
    await assert.rejects(() => runtime.start("javascript-onnx-q8"), /disposed/)
  } finally {
    KokoroJavascriptWorker.start = originalStart
  }
})

test("tracks and removes the wrapper returned from JavaScript start", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-worker-tracking-"))
  const originalStart = KokoroJavascriptWorker.start
  let generated
  try {
    KokoroJavascriptWorker.start = async (options) => {
      let stopped = false
      const worker = {
        generate: async (...args) => {
          generated = args
          return { output: args[1], generationMs: 0 }
        },
        dispose: () => undefined,
        stop: async () => {
          if (stopped) return
          stopped = true
          options.onExit?.()
        },
        getResourceUsage: () => ({}),
      }
      return { worker, loadMs: 1 }
    }
    const runtime = createKokoro({ homeDir: directory })
    const started = await runtime.start("javascript-onnx-q8")
    assert.equal(runtime.workers.has(started.worker), true)
    await started.worker.generate("hello", "output.wav", "af_heart", { speed: 1.3 })
    assert.deepEqual(generated, ["hello", "output.wav", "af_heart", { speed: 1.3 }])
    assert.throws(() => started.worker.generate("hello", "output.wav", "af_heart", { speed: 3 }), (error) => {
      return error.code === "INVALID_PARAMETER"
    })
    await started.worker.stop()
    assert.equal(runtime.workers.size, 0)
    await runtime.dispose()
  } finally {
    KokoroJavascriptWorker.start = originalStart
  }
})

test("rejects canceled synthesis promptly and joins worker cleanup on dispose", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-cancel-generation-"))
  const originalStart = KokoroJavascriptWorker.start
  let generationStarted
  const startedGate = new Promise((resolve) => { generationStarted = resolve })
  let releaseGeneration
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve })
  let exited = false
  try {
    KokoroJavascriptWorker.start = async (options) => {
      let disposed = false
      let stopping
      const worker = {
        generate: async (_text, output) => {
          generationStarted()
          await generationGate
          return { output, generationMs: 1 }
        },
        dispose: () => { disposed = true },
        stop: () => {
          stopping ??= generationGate.then(() => {
            assert.equal(disposed, true)
            exited = true
            options.onExit?.()
          })
          return stopping
        },
        getResourceUsage: () => ({}),
      }
      return { worker, loadMs: 1 }
    }
    const runtime = createKokoro({ homeDir: directory })
    const controller = new AbortController()
    const synthesis = runtime.synthesize({
      runtimeId: "javascript-onnx-q8",
      text: "hello",
      output: join(directory, "output.wav"),
      signal: controller.signal,
    })
    await startedGate
    controller.abort()
    await Promise.race([
      assert.rejects(synthesis, { name: "AbortError" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("cancellation was not prompt")), 100)),
    ])
    assert.equal(runtime.workers.size, 1)
    let disposed = false
    const disposal = runtime.dispose().then(() => { disposed = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(disposed, false)
    assert.equal(exited, false)
    releaseGeneration()
    await disposal
    assert.equal(exited, true)
    assert.equal(runtime.workers.size, 0)
  } finally {
    KokoroJavascriptWorker.start = originalStart
  }
})

test("detects an existing Python setup without changing it", async () => {
  directory = await mkdtemp(join(tmpdir(), "kokoro-existing-"))
  const runtime = createKokoro({ homeDir: directory })
  await mkdir(join(runtime.paths.envDir, "bin"), { recursive: true })
  await writeFile(join(runtime.paths.envDir, "bin", "python"), "#!/bin/sh\n")
  await chmod(join(runtime.paths.envDir, "bin", "python"), 0o755)
  await mkdir(runtime.paths.assetDir, { recursive: true })
  for (const asset of KOKORO_ASSETS) {
    const path = join(runtime.paths.assetDir, asset.path)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, "")
    await truncate(path, asset.size)
  }
  await writeFile(runtime.paths.markerPath, JSON.stringify({ version: KOKORO_SETUP_VERSION }))
  const result = await runtime.prepare("python-pytorch-fp32")
  assert.equal(result.ready, true)
  assert.equal(result.cached, true)
})

test("preserves FP32 low-memory options and documents direct v4 compatibility", () => {
  assert.deepEqual(getJavascriptLoadOptions({ dtype: "fp32", device: "cpu", lowMemory: true }), {
    dtype: "fp32",
    device: "cpu",
    session_options: { enableCpuMemArena: false, enableMemPattern: false },
  })
  assert.equal(getJavascriptLoadOptions({ dtype: "q8", device: "cpu" }).session_options, undefined)
  assert.equal(TRANSFORMERS_JS_COMPATIBILITY.transformersVersion, "4.2.0")
  assert.equal(TRANSFORMERS_JS_COMPATIBILITY.publicationReady, true)
  assert.match(TRANSFORMERS_JS_COMPATIBILITY.note, /664c76a704021239ba59c84dcbaa4d3dece01fe9/)
})
