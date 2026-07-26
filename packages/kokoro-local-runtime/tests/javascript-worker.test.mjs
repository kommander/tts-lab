import assert from "node:assert/strict"
import { test } from "node:test"
import { KokoroJavascriptWorker, withJavascriptLoadLock } from "../dist/javascript-worker.js"

test("serializes JavaScript model loads but not work after loading", async () => {
  let active = 0
  let maximum = 0
  const order = []
  const load = (home) => withJavascriptLoadLock(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    order.push(`start:${home}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    order.push(`end:${home}`)
    active -= 1
    return home
  })
  assert.deepEqual(await Promise.all([load("home-a"), load("home-b")]), ["home-a", "home-b"])
  assert.equal(maximum, 1)
  assert.deepEqual(order, ["start:home-a", "end:home-a", "start:home-b", "end:home-b"])

  let generated = 0
  let maximumGenerated = 0
  await Promise.all(["home-a", "home-b"].map(async () => {
    generated += 1
    maximumGenerated = Math.max(maximumGenerated, generated)
    await new Promise((resolve) => setTimeout(resolve, 5))
    generated -= 1
  }))
  assert.equal(maximumGenerated, 2)
})

test("removes an aborted JavaScript load waiter without blocking the queue", async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const order = []
  const first = withJavascriptLoadLock(async () => {
    order.push("first")
    await firstGate
  })
  const controller = new AbortController()
  const canceled = withJavascriptLoadLock(async () => {
    order.push("canceled")
  }, controller.signal)
  const third = withJavascriptLoadLock(async () => {
    order.push("third")
  })
  controller.abort()
  await assert.rejects(canceled, { name: "AbortError" })
  assert.deepEqual(order, ["first"])
  releaseFirst()
  await Promise.all([first, third])
  assert.deepEqual(order, ["first", "third"])
})

test("defers model disposal and exit until generation and save finish", async () => {
  let releaseGeneration
  let releaseSave
  const generationGate = new Promise((resolve) => { releaseGeneration = resolve })
  const saveGate = new Promise((resolve) => { releaseSave = resolve })
  let modelDisposed = false
  let exited = false
  const tts = {
    model: { dispose: async () => { modelDisposed = true } },
    generate: async () => {
      await generationGate
      return { save: async () => { await saveGate } }
    },
  }
  const worker = new KokoroJavascriptWorker(tts, "CPU", undefined, () => { exited = true })
  const generation = worker.generate("hello", "output.wav")
  worker.dispose()
  const stopping = worker.stop()
  await Promise.resolve()
  assert.equal(modelDisposed, false)
  assert.equal(exited, false)
  await assert.rejects(() => worker.generate("again", "other.wav"), /not running/)
  releaseGeneration()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(modelDisposed, false)
  releaseSave()
  await Promise.all([generation, stopping])
  assert.equal(modelDisposed, true)
  assert.equal(exited, true)
})
