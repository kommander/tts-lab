import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FLUIDAUDIO_BUILD_VERSION,
  FluidAudioBuilder,
  createFluidAudioBackendCommand,
  createFluidAudioEnvironment,
  getFluidAudioCapability,
  supportsFluidAudio,
} from "../../dist/fluidaudio/index.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("reports FluidAudio platform capabilities", () => {
  assert.equal(supportsFluidAudio("darwin", "arm64", "23.0.0"), true)
  assert.equal(supportsFluidAudio("darwin", "arm64", "22.6.0"), false)
  assert.equal(supportsFluidAudio("darwin", "x64", "25.0.0"), false)
  assert.equal(supportsFluidAudio("linux", "arm64", "25.0.0"), false)
  assert.match(getFluidAudioCapability("darwin", "x64", "25.0.0").reason, /Apple Silicon/)
})

test("constructs backend commands and isolated environment", () => {
  assert.deepEqual(createFluidAudioBackendCommand({
    binaryPath: "/bin/sidecar",
    backend: "pocket",
    assetsPath: "/models/pocket",
  }), ["/bin/sidecar", "--backend", "pocket", "--assets", "/models/pocket"])
  assert.deepEqual(createFluidAudioEnvironment("/runtime/home"), {
    CFFIXED_USER_HOME: "/runtime/home",
    HOME: "/runtime/home",
  })
})

test("resolves Swift resources module-relatively", async () => {
  const swiftPackage = fileURLToPath(new URL("../../swift", import.meta.url))
  assert.equal((await stat(join(swiftPackage, "Package.resolved"))).isFile(), true)
})

test("reuses an executable from the existing target-triple cache layout", async () => {
  directory = await mkdtemp(join(tmpdir(), "fluidaudio-builder-"))
  const binary = join(
    directory,
    "tools",
    `fluidaudio-${FLUIDAUDIO_BUILD_VERSION}`,
    "arm64-apple-macosx",
    "release",
    "tts-lab-fluidaudio",
  )
  await mkdir(join(binary, ".."), { recursive: true })
  await writeFile(binary, "binary")
  await chmod(binary, 0o755)
  assert.equal(await new FluidAudioBuilder(directory).findBinary(), binary)
})
