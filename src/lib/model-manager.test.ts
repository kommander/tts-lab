import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyAudioExport, normalizeAudioExportPath } from "./model-manager.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("normalizes export paths to the generated format", () => {
  expect(normalizeAudioExportPath("voice", "wav")).toEndWith("voice.wav")
  expect(normalizeAudioExportPath("voice.mp3", "wav")).toEndWith("voice.wav")
})

test("copies generated audio without overwriting an existing file", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-export-"))
  const source = join(directory, "source.wav")
  const requested = join(directory, "saved.mp3")
  await writeFile(source, "wave bytes")
  const destination = await copyAudioExport(source, requested, "wav")
  expect(destination).toBe(join(directory, "saved.wav"))
  expect(await readFile(destination, "utf8")).toBe("wave bytes")
  await expect(copyAudioExport(source, requested, "wav")).rejects.toThrow()
})
