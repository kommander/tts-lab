import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { render } from "@opentui/solid"
import { App, buildSpectrumRows, getLatencyItems, SPEAK_BINDING } from "./App.js"
import { MODEL_BY_ID, MODELS } from "./models.js"
import type { DemoController, ModelId, ModelState } from "./types.js"

let renderer: Awaited<ReturnType<typeof createTestRenderer>> | undefined
let appKeymap: ReturnType<typeof createDefaultOpenTuiKeymap> | undefined

function state(id: ModelId): ModelState {
  return {
    id,
    voiceId: MODEL_BY_ID[id].defaultVoiceId,
    runtimeId: MODEL_BY_ID[id].defaultRuntimeId,
    installed: id === "kokoro",
    phase: id === "kokoro" ? "ready" : "idle",
    detail: id === "kokoro" ? "Ready" : "Not installed",
    setupProgress: id === "kokoro" ? 1 : 0,
    downloadedBytes: 0,
    totalBytes: 100,
    generationProgress: 0,
    resident: false,
  }
}

class FakeController implements DemoController {
  constructor(private readonly initial?: Record<ModelId, ModelState>) {}
  speakCount = 0
  voiceSelections: Array<{ model: ModelId; voiceId: string }> = []
  runtimeSelections: Array<{ model: ModelId; runtimeId: string }> = []
  savedPaths: string[] = []
  snapshot = () =>
    this.initial ?? (Object.fromEntries(MODELS.map(({ id }) => [id, state(id)])) as Record<ModelId, ModelState>)
  subscribe = () => () => undefined
  getSpectrum = () => Array(16).fill(0)
  subscribeSpectrum = (listener: (levels: number[]) => void) => {
    listener(this.getSpectrum())
    return () => undefined
  }
  getLatestAudio = () => ({ model: "kokoro" as const, voiceId: "af_heart", format: "wav" as const })
  saveLatestAudio = async (path: string) => {
    this.savedPaths.push(path)
    return path
  }
  ensure = async () => undefined
  setVoice = async (model: ModelId, voiceId: string) => {
    this.voiceSelections.push({ model, voiceId })
  }
  setRuntime = async (model: ModelId, runtimeId: string) => {
    this.runtimeSelections.push({ model, runtimeId })
  }
  speak = async () => {
    this.speakCount += 1
  }
  retry = async () => undefined
  dispose = async () => undefined
}

afterEach(() => renderer?.renderer.destroy())

test("resolves the Kokoro workspace from TypeScript source in Bun", () => {
  expect(import.meta.resolve("kokoro-local-runtime")).toContain("/src/index.ts")
})

async function renderApp(controller: DemoController, width = 120, height = 32) {
  renderer = await createTestRenderer({ width, height })
  const keymap = createDefaultOpenTuiKeymap(renderer.renderer)
  appKeymap = keymap
  await render(() => <App controller={controller} keymap={keymap} />, renderer.renderer)
  return renderer
}

test("renders every model and the editor", async () => {
  renderer = await renderApp(new FakeController())
  await renderer.renderOnce()
  const frame = renderer.captureCharFrame()
  for (const model of MODELS) expect(frame).toContain(model.name)
  expect(frame).toContain("MODELS")
  expect(frame).not.toContain("COMPOSE / KOKORO")
  expect(frame).toContain("VOICE BANK / Heart (US)")
  expect(frame).toContain("SCRIPT")
  expect(frame).toContain("RUNTIME SIGNAL / COLD")
  expect(frame).toContain("RUNTIME / Python / PyTorch FP32")
  expect(frame).toContain("CTRL+G")
  expect(frame).toContain("SPECTRUM")
  expect(frame).toContain("SCROLL · ↑↓ · PGUP/PGDN · HOME/END")
  expect(frame).not.toContain("five engines · private inference · native playback")
  expect(frame).not.toContain("The published package supports")
  expect(frame.match(/┌/g)?.length).toBeGreaterThanOrEqual(3)
  expect(frame.match(/└/g)?.length).toBeGreaterThanOrEqual(3)
  expect(frame).toContain("││")
  const editorLine = frame.split("\n").find((line) => line.includes("Local speech should be simple"))
  expect(editorLine).toContain("││")
  const lines = frame.split("\n")
  expect(lines[0]).toContain("TTS LAB / LOCAL VOICE CONSOLE")
  expect(lines[1]).toContain("MODELS")
  const runtimeLine = lines.findIndex((line) => line.includes("RUNTIME SIGNAL"))
  const spectrumLine = lines.findIndex((line) => line.includes("SPECTRUM"))
  expect(spectrumLine).toBeGreaterThan(runtimeLine)
  expect(lines[spectrumLine]!.indexOf("SPECTRUM")).toBeGreaterThan(60)
})

test("speaks through the Ctrl+G keymap binding", async () => {
  const controller = new FakeController()
  renderer = await renderApp(controller)
  expect(appKeymap?.getActiveKeys().map((key) => key.stroke.name)).toContain("f2")
  expect(SPEAK_BINDING).toBe("ctrl+g")
  renderer.mockInput.pressTab()
  await renderer.flush()
  renderer.mockInput.pressEnter()
  expect(controller.speakCount).toBe(0)
  renderer.mockInput.pressKey("g", { ctrl: true })
  expect(controller.speakCount).toBe(1)
})

test("renders latency only when the selected state contains it", () => {
  const ready = state("kokoro")
  expect(getLatencyItems(ready)).toEqual([])
  ready.lastLatency = { warm: true, loadMs: 0, generationMs: 700, playbackMs: 1 }
  expect(getLatencyItems(ready)).toEqual([ready.lastLatency!])
})

test("defines model-specific voice catalogs", () => {
  expect(MODEL_BY_ID.kokoro.voices).toHaveLength(28)
  expect(MODEL_BY_ID.kitten.voices).toHaveLength(8)
  expect(MODEL_BY_ID.pocket.voices).toHaveLength(8)
  expect(MODEL_BY_ID.qwen.voices).toHaveLength(9)
  expect(MODEL_BY_ID.piper.voices).toHaveLength(3)
  expect(MODEL_BY_ID.melo.voices).toHaveLength(5)
  expect(MODEL_BY_ID.parler.voices).toHaveLength(34)
  expect(MODEL_BY_ID.f5.voices).toHaveLength(1)
})

test("defines verified Kokoro runtime profiles with Python as default", () => {
  expect(MODEL_BY_ID.kokoro.defaultRuntimeId).toBe("python-pytorch-fp32")
  expect(MODEL_BY_ID.kokoro.runtimes.map((runtime) => runtime.id)).toEqual([
    "python-pytorch-fp32",
    "javascript-onnx-q8",
    "javascript-onnx-fp32",
    "javascript-webgpu-fp32",
    "native-coreml-ane",
  ])
  expect(MODEL_BY_ID.kokoro.runtimes.find((runtime) => runtime.id === "javascript-onnx-fp32")?.lowMemory).toBe(true)
  expect(MODEL_BY_ID.kokoro.runtimes.find((runtime) => runtime.id === "javascript-webgpu-fp32")?.device).toBe("webgpu")
  expect(MODEL_BY_ID.kokoro.runtimes.find((runtime) => runtime.id === "native-coreml-ane")?.voiceIds).toEqual(["af_heart"])
  expect(MODEL_BY_ID.kitten.defaultRuntimeId).toBe("python-onnx-int8")
  expect(MODEL_BY_ID.kitten.packages?.every((dependency) => dependency.includes("=="))).toBe(true)
  expect(MODEL_BY_ID.kitten.noBuildIsolation).toBe(true)
  const pocketRuntime = MODEL_BY_ID.pocket.runtimes[0]!
  expect(pocketRuntime.id).toBe("native-coreml-ane-fp16")
  expect(pocketRuntime.nativeBackend).toBe("pocket")
  expect(pocketRuntime.assets?.reduce((sum, asset) => sum + asset.size, 0)).toBe(367490063)
  expect(pocketRuntime.assets?.every((asset) => asset.sha256 && asset.url.includes("1bd207828251accf30f09a965c84856cd874e9f4"))).toBe(true)
  expect(MODEL_BY_ID.pocket.voices.slice(1).every((voice) => voice.assets?.every((asset) => asset.sha256))).toBe(true)
  const qwenRuntime = MODEL_BY_ID.qwen.runtimes[0]!
  expect(qwenRuntime.id).toBe("python-mlx-4bit")
  expect(qwenRuntime.platforms).toEqual(["darwin"])
  expect(qwenRuntime.minimumDarwinMajor).toBe(23)
  expect(qwenRuntime.minimumMemoryBytes).toBe(16 * 1024 ** 3)
  expect(MODEL_BY_ID.qwen.assets.reduce((sum, asset) => sum + asset.size, 0)).toBe(1693530022)
  expect(MODEL_BY_ID.qwen.assets.every((asset) => asset.sha256 && asset.url.includes("08c72cad5e2fd0f41730c8bd1f28149585e46361"))).toBe(true)
  for (const model of MODELS.slice(1)) expect(model.runtimes).toHaveLength(1)
})

test.each([
  [72, 40],
  [80, 24],
  [160, 45],
])("renders responsive dashboard at %ix%i", async (width, height) => {
  renderer = await renderApp(new FakeController(), width, height)
  await renderer.renderOnce()
  const frame = renderer.captureCharFrame()
  expect(frame).toContain("TTS LAB")
  expect(frame).toContain("SCRIPT")
  expect(frame).toContain("RUNTIME SIGNAL")
  expect(frame).toContain("CTRL+G")
  expect(frame).toContain("SPECTRUM")
  expect(frame).toContain("SCROLL")
  expect(frame).not.toContain("five engines · private inference · native playback")
  expect(frame.match(/┌/g)?.length).toBeGreaterThanOrEqual(3)
  expect(frame.match(/└/g)?.length).toBeGreaterThanOrEqual(3)
  const expectedSpectrumRows = width === 160 ? 7 : 5
  expect(frame.split("\n").filter((line) => line.includes("· · · ·")).length).toBeGreaterThanOrEqual(
    expectedSpectrumRows,
  )
})

test("builds compact spectrum rows from normalized levels", () => {
  expect(buildSpectrumRows([0, 0.5, 1, 0.25], 4, 4)).toEqual([
    "· · █ ·",
    "· · █ ·",
    "· █ █ ·",
    "· █ █ █",
  ])
})

test("opens the save dialog with a generated WAV path", async () => {
  const controller = new FakeController()
  renderer = await renderApp(controller)
  expect(appKeymap?.getActiveKeys().map((key) => key.stroke.name)).toContain("f2")
  const saveResult = await appKeymap?.runCommand("audio.save.open")
  expect(saveResult?.ok).toBe(true)
  const submitResult = await appKeymap?.runCommand("audio.save.submit")
  expect(submitResult?.ok).toBe(true)
  await Bun.sleep(0)
  expect(controller.savedPaths).toHaveLength(1)
  expect(controller.savedPaths[0]).toStartWith(process.cwd())
  expect(controller.savedPaths[0]).toEndWith(".wav")
})

test("registers an F3 runtime selector command", async () => {
  renderer = await renderApp(new FakeController())
  expect(appKeymap?.getActiveKeys().map((key) => key.stroke.name)).toContain("f3")
  const result = await appKeymap?.runCommand("runtime.select.open")
  expect(result?.ok).toBe(true)
})

test("renders technical runtime statistics", async () => {
  const states = Object.fromEntries(MODELS.map(({ id }) => [id, state(id)])) as Record<ModelId, ModelState>
  states.kokoro.runtimeStats = {
    sampleCount: 4,
    averageGenerationMs: 600,
    medianGenerationMs: 550,
    minGenerationMs: 300,
    maxGenerationMs: 900,
    appRssBytes: 256 * 1024 * 1024,
    appHeapUsedBytes: 32 * 1024 * 1024,
    workerPeakRssBytes: 512 * 1024 * 1024,
  }
  renderer = await renderApp(new FakeController(states), 160, 45)
  await renderer.renderOnce()
  const frame = renderer.captureCharFrame()
  expect(frame).toContain("PERFORMANCE")
  expect(frame).toContain("Samples 4")
  expect(frame).toContain("Generation avg 600ms · median 550ms")
  expect(frame).toContain("RESOURCES")
  expect(frame).toContain("App RSS 256.0 MB")
  expect(frame).toContain("Worker peak RSS 512.0 MB")
})

test("activates runtime scroll commands when the signal panel is focused", async () => {
  renderer = await renderApp(new FakeController())
  await appKeymap?.runCommand("app.focus-next")
  await appKeymap?.runCommand("app.focus-next")
  await appKeymap?.runCommand("app.focus-next")
  const activeKeys = appKeymap?.getActiveKeys().map((key) => key.stroke.name) ?? []
  expect(activeKeys).toContain("up")
  expect(activeKeys).toContain("down")
  expect(activeKeys).toContain("pageup")
  expect(activeKeys).toContain("pagedown")
  expect((await appKeymap?.runCommand("runtime.scroll.down"))?.ok).toBe(true)
})
