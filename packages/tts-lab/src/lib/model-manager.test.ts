import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { supportsFluidAudio } from "fluidaudio-runtime"
import { runProcess } from "tts-runtime-core"
import {
  copyAudioExport,
  normalizeAudioExportPath,
  resolveResourcePollMs,
  supportsRuntimePlatform,
  summarizeGenerationTimes,
} from "./model-manager.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("normalizes export paths to the generated format", () => {
  expect(normalizeAudioExportPath("voice", "wav")).toEndWith("voice.wav")
  expect(normalizeAudioExportPath("voice.mp3", "wav")).toEndWith("voice.wav")
})

test("summarizes generation timing samples", () => {
  expect(summarizeGenerationTimes([])).toBeNull()
  expect(summarizeGenerationTimes([900, 300, 500, 700])).toEqual({
    sampleCount: 4,
    averageGenerationMs: 600,
    medianGenerationMs: 600,
    minGenerationMs: 300,
    maxGenerationMs: 900,
  })
  expect(summarizeGenerationTimes([100, 300, 200])?.medianGenerationMs).toBe(200)
  expect(summarizeGenerationTimes(Array.from({ length: 60 }, (_, index) => index + 1))?.sampleCount).toBe(60)
})

test("resolves the resource polling interval", () => {
  expect(resolveResourcePollMs(undefined)).toBe(4000)
  expect(resolveResourcePollMs("5000")).toBe(5000)
  expect(resolveResourcePollMs("100")).toBe(250)
  expect(resolveResourcePollMs("0")).toBe(0)
  expect(resolveResourcePollMs("invalid")).toBe(4000)
})

test("gates the CoreML ANE runtime to supported macOS systems", () => {
  expect(supportsFluidAudio("darwin", "arm64", "23.0.0")).toBe(true)
  expect(supportsFluidAudio("darwin", "arm64", "22.6.0")).toBe(false)
  expect(supportsFluidAudio("darwin", "x64", "25.0.0")).toBe(false)
  expect(supportsFluidAudio("linux", "arm64", "25.0.0")).toBe(false)
})

test("applies runtime-specific macOS requirements without blocking other platforms", () => {
  const runtime = { id: "test", name: "Test", description: "Test", kind: "python" as const, darwinArch: "arm64" as const, minimumDarwinMajor: 23 }
  expect(supportsRuntimePlatform(runtime, "darwin", "arm64", "23.0.0")).toBe(true)
  expect(supportsRuntimePlatform(runtime, "darwin", "x64", "25.0.0")).toBe(false)
  expect(supportsRuntimePlatform(runtime, "darwin", "arm64", "22.0.0")).toBe(false)
  expect(supportsRuntimePlatform(runtime, "linux", "x64", "6.0.0")).toBe(true)
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

test("persists and restores the selected runtime profile", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-lab-settings-"))
  const modulePath = join(import.meta.dir, "model-manager.ts")
  await runProcess(
    [
      process.execPath,
      "-e",
      `import { ModelManager } from ${JSON.stringify(modulePath)}; const manager = new ModelManager(); await manager.setRuntime("kokoro", "javascript-onnx-q8"); manager.dispose();`,
    ],
    { env: { TTS_LAB_HOME: directory } },
  )
  const output = await runProcess(
    [
      process.execPath,
      "-e",
      `import { ModelManager } from ${JSON.stringify(modulePath)}; const manager = new ModelManager(); console.log(manager.snapshot().kokoro.runtimeId); manager.dispose();`,
    ],
    { env: { TTS_LAB_HOME: directory } },
  )
  expect(output.trim()).toBe("javascript-onnx-q8")
})
