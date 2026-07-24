import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { render } from "@opentui/solid"
import { App, buildSpectrumRows, getLatencyItems, SPEAK_BINDING } from "./App.js"
import { MODEL_BY_ID, MODELS } from "./models.js"
import type { DemoController, ModelId, ModelState } from "./types.js"

let renderer: Awaited<ReturnType<typeof createTestRenderer>> | undefined

function state(id: ModelId): ModelState {
  return {
    id,
    voiceId: MODEL_BY_ID[id].defaultVoiceId,
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
  snapshot = () =>
    this.initial ?? (Object.fromEntries(MODELS.map(({ id }) => [id, state(id)])) as Record<ModelId, ModelState>)
  subscribe = () => () => undefined
  getSpectrum = () => Array(16).fill(0)
  subscribeSpectrum = (listener: (levels: number[]) => void) => {
    listener(this.getSpectrum())
    return () => undefined
  }
  ensure = async () => undefined
  setVoice = async (model: ModelId, voiceId: string) => {
    this.voiceSelections.push({ model, voiceId })
  }
  speak = async () => {
    this.speakCount += 1
  }
  retry = async () => undefined
  dispose = () => undefined
}

afterEach(() => renderer?.renderer.destroy())

async function renderApp(controller: DemoController, width = 120, height = 32) {
  renderer = await createTestRenderer({ width, height })
  const keymap = createDefaultOpenTuiKeymap(renderer.renderer)
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
  expect(frame).toContain("CTRL+G")
  expect(frame).toContain("SPECTRUM")
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
  expect(MODEL_BY_ID.piper.voices).toHaveLength(3)
  expect(MODEL_BY_ID.melo.voices).toHaveLength(5)
  expect(MODEL_BY_ID.parler.voices).toHaveLength(34)
  expect(MODEL_BY_ID.f5.voices).toHaveLength(1)
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
  expect(frame).not.toContain("five engines · private inference · native playback")
  expect(frame.match(/┌/g)?.length).toBeGreaterThanOrEqual(3)
  expect(frame.match(/└/g)?.length).toBeGreaterThanOrEqual(3)
})

test("builds compact spectrum rows from normalized levels", () => {
  expect(buildSpectrumRows([0, 0.5, 1, 0.25], 4, 4)).toEqual([
    "· · █ ·",
    "· · █ ·",
    "· █ █ ·",
    "· █ █ █",
  ])
})
