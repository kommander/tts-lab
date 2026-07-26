import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NdjsonRuntimeWorker } from "../dist/index.js"

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
