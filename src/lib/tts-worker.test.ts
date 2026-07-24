import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TtsWorker } from "./tts-worker.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("keeps one worker alive for multiple generation requests", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-worker-"))
  const script = [
    "import json, sys",
    'print(json.dumps({"type":"ready","load_ms":125.0}), flush=True)',
    "for line in sys.stdin:",
    " request=json.loads(line)",
    ' print(json.dumps({"type":"status","request_id":request["id"],"detail":"warm"}), flush=True)',
    ' print(json.dumps({"type":"result","request_id":request["id"],"output":request["output"],"generation_ms":12.5}), flush=True)',
  ].join("\n")
  const statuses: string[] = []
  const { worker, loadMs } = await TtsWorker.start({
    command: ["python3", "-u", "-c", script],
    env: {},
    logPath: join(directory, "worker.log"),
    onStatus: (event) => event.detail && statuses.push(event.detail),
  })

  expect(loadMs).toBe(125)
  expect((await worker.generate("one", "one.wav")).generationMs).toBe(12.5)
  expect((await worker.generate("two", "two.wav")).output).toBe("two.wav")
  expect(statuses).toEqual(["warm", "warm"])
  worker.dispose()
  await Bun.sleep(10)
  expect(await readFile(join(directory, "worker.log"), "utf8")).toContain('[stdout] {"type": "ready"')
})
