import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NdjsonRuntimeWorker } from "../../dist/core/index.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("keeps one NDJSON worker alive for multiple generation requests", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-worker-"))
  const script = [
    'const readline = require("node:readline")',
    'console.log(JSON.stringify({type:"ready",load_ms:125,resource:{peakRssBytes:1000}}))',
    'readline.createInterface({input:process.stdin}).on("line", line => {',
    " const request=JSON.parse(line)",
    ' console.log(JSON.stringify({type:"status",request_id:request.id,detail:request.voice ?? "default"}))',
    ' console.log(JSON.stringify({type:"result",request_id:request.id,output:request.output,generation_ms:12.5,resource:{rssBytes:800,peakRssBytes:1200}}))',
    "})",
  ].join("\n")
  const statuses = []
  const { worker, loadMs } = await NdjsonRuntimeWorker.start({
    command: [process.execPath, "-e", script],
    logPath: join(directory, "worker.log"),
    onStatus: (event) => event.detail && statuses.push(event.detail),
  })

  assert.equal(loadMs, 125)
  assert.deepEqual(worker.getResourceUsage(), { peakRssBytes: 1000 })
  assert.equal((await worker.generate("one", "one.wav", "voice-a")).generationMs, 12.5)
  assert.deepEqual(worker.getResourceUsage(), { rssBytes: 800, peakRssBytes: 1200 })
  assert.equal((await worker.generate("two", "two.wav", "voice-b")).output, "two.wav")
  assert.deepEqual(statuses, ["voice-a", "voice-b"])
  await worker.stop()
  assert.match(await readFile(join(directory, "worker.log"), "utf8"), /\[stdout\].*"type":"ready"/)
})

test("sends exact backward-compatible and parameterized NDJSON payloads", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-payload-"))
  const script = [
    'const readline = require("node:readline")',
    'console.log(JSON.stringify({type:"ready"}))',
    'readline.createInterface({input:process.stdin}).on("line", line => {',
    " const request=JSON.parse(line)",
    ' console.log(JSON.stringify({type:"status",request_id:request.id,detail:line}))',
    ' console.log(JSON.stringify({type:"result",request_id:request.id,output:request.output}))',
    "})",
  ].join("\n")
  const payloads = []
  const { worker } = await NdjsonRuntimeWorker.start({
    command: [process.execPath, "-e", script],
    logPath: join(directory, "payload.log"),
    onStatus: (event) => payloads.push(event.detail),
  })

  await worker.generate("old", "old.wav")
  await worker.generate("new", "new.wav", "voice-a", {
    speed: 1.2,
    mode: "expressive",
    removeSilence: false,
  })
  await worker.stop()

  const [oldPayload, newPayload] = payloads.map(JSON.parse)
  assert.deepEqual(Object.keys(oldPayload), ["id", "text", "output"])
  assert.deepEqual({ ...oldPayload, id: "<id>" }, { id: "<id>", text: "old", output: "old.wav" })
  assert.deepEqual(Object.keys(newPayload), ["id", "text", "output", "voice", "parameters"])
  assert.deepEqual({ ...newPayload, id: "<id>" }, {
    id: "<id>",
    text: "new",
    output: "new.wav",
    voice: "voice-a",
    parameters: { speed: 1.2, mode: "expressive", removeSilence: false },
  })
})

test("rejects a correlated malformed-parameter response promptly", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-invalid-parameters-"))
  const script = [
    'const readline = require("node:readline")',
    'console.log(JSON.stringify({type:"ready"}))',
    'readline.createInterface({input:process.stdin}).on("line", line => {',
    " const request=JSON.parse(line)",
    ' console.log(JSON.stringify({type:"error",request_id:request.id,error:"Invalid request: non-scalar parameter"}))',
    "})",
  ].join("\n")
  const { worker } = await NdjsonRuntimeWorker.start({
    command: [process.execPath, "-e", script],
    logPath: join(directory, "invalid.log"),
    onStatus: () => undefined,
  })

  await assert.rejects(
    worker.generate("bad", "bad.wav", undefined, { speed: null }),
    /Invalid request: non-scalar parameter/,
  )
  await worker.stop()
})

test("does not spawn after an already-aborted manager signal", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-aborted-spawn-"))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(NdjsonRuntimeWorker.spawn({
    command: [process.execPath, "-e", "process.exit(99)"],
    signal: controller.signal,
    logPath: join(directory, "aborted.log"),
    onStatus: () => undefined,
  }), /abort/i)
  assert.equal(await stat(join(directory, "aborted.log")).then(() => true, () => false), false)
})

test("an abort after spawn promptly stops a worker that has not become ready", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-delayed-abort-"))
  const controller = new AbortController()
  let exits = 0
  const worker = await NdjsonRuntimeWorker.spawn({
    command: [process.execPath, "-e", 'setTimeout(() => console.log(JSON.stringify({type:"ready"})), 10_000)'],
    signal: controller.signal,
    logPath: join(directory, "delayed-abort.log"),
    onStatus: () => undefined,
    onExit: () => { exits += 1 },
  })

  const started = Date.now()
  controller.abort()
  await assert.rejects(worker.ready, /stopped/)
  await worker.stop()

  assert.equal(exits, 1)
  assert.ok(Date.now() - started < 5_000, "aborted worker did not stop promptly")
  assert.match(await readFile(join(directory, "delayed-abort.log"), "utf8"), /\[exit\]/)
})

test("start stops a still-alive worker after a fatal ready failure", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-fatal-worker-"))
  let exits = 0
  const script = 'process.on("SIGTERM", () => {}); console.log(JSON.stringify({type:"fatal",error:"load failed"})); setInterval(() => {}, 1000)'
  await assert.rejects(NdjsonRuntimeWorker.start({
    command: [process.execPath, "-e", script],
    logPath: join(directory, "fatal.log"),
    onStatus: () => undefined,
    onExit: () => { exits += 1 },
  }), /load failed/)
  assert.equal(exits, 1)
  assert.match(await readFile(join(directory, "fatal.log"), "utf8"), /\[exit\]/)
})

test("stop terminates the NDJSON worker's descendant tree", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-worker-tree-"))
  const marker = join(directory, "descendant-survived")
  const pidPath = join(directory, "descendant.pid")
  const markerDelay = process.platform === "win32" ? 700 : 1_300
  const descendantScript = `
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "alive"), ${markerDelay});
    setInterval(() => {}, 1000);
  `
  const workerScript = `
    const { writeFileSync } = require("node:fs");
    const { spawn } = require("node:child_process");
    process.on("SIGTERM", () => {});
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    console.log(JSON.stringify({ type: "ready" }));
    setInterval(() => {}, 1000);
  `
  const { worker } = await NdjsonRuntimeWorker.start({
    command: [process.execPath, "-e", workerScript],
    logPath: join(directory, "tree.log"),
    onStatus: () => undefined,
  })
  let descendantPid = Number(await readFile(pidPath, "utf8"))

  await worker.stop()
  await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 900 : 450))

  assert.equal(await stat(marker).then(() => true, () => false), false)
  if (process.platform !== "win32") {
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      try {
        process.kill(descendantPid, 0)
        await new Promise((resolve) => setTimeout(resolve, 20))
      } catch {
        descendantPid = 0
        break
      }
    }
    assert.equal(descendantPid, 0, "descendant process remained alive")
  }
  assert.match(await readFile(join(directory, "tree.log"), "utf8"), /\[exit\]/)
})
