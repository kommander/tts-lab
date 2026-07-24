import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandExists, runProcess } from "./process.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("logs subprocess output and uses stdout as an error fallback", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-process-"))
  const logPath = join(directory, "model.log")
  await expect(
    runProcess([process.execPath, "-e", 'console.log("useful failure"); process.exit(7)'], { logPath }),
  ).rejects.toThrow("useful failure")
  const log = await readFile(logPath, "utf8")
  expect(log).toContain("[stdout] useful failure")
  expect(log).toContain("[exit] code 7")
})

test("supports command-specific version arguments", async () => {
  expect(await commandExists(process.execPath, ["-e", "process.exit(0)"])).toBe(true)
})
