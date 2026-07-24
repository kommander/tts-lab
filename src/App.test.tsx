import { afterEach, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { render } from "@opentui/solid"
import { App, getLatencyItems, SPEAK_BINDING } from "./App.js"
import { MODELS } from "./models.js"
import type { DemoController, ModelId, ModelState } from "./types.js"

let renderer: Awaited<ReturnType<typeof createTestRenderer>> | undefined

function state(id: ModelId): ModelState {
  return {
    id,
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
  snapshot = () =>
    this.initial ?? (Object.fromEntries(MODELS.map(({ id }) => [id, state(id)])) as Record<ModelId, ModelState>)
  subscribe = () => () => undefined
  ensure = async () => undefined
  speak = async () => {
    this.speakCount += 1
  }
  retry = async () => undefined
  dispose = () => undefined
}

afterEach(() => renderer?.renderer.destroy())

async function renderApp(controller: DemoController) {
  renderer = await createTestRenderer({ width: 120, height: 32 })
  const keymap = createDefaultOpenTuiKeymap(renderer.renderer)
  await render(() => <App controller={controller} keymap={keymap} />, renderer.renderer)
  return renderer
}

test("renders every model and the editor", async () => {
  renderer = await renderApp(new FakeController())
  await renderer.renderOnce()
  const frame = renderer.captureCharFrame()
  for (const model of MODELS) expect(frame).toContain(model.name)
  expect(frame).toContain("SPEAK WITH KOKORO")
  expect(frame).toContain("CTRL+G")
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
