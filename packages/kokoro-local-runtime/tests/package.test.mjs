import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { test } from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"

const exec = promisify(execFile)
const workspace = fileURLToPath(new URL("../../..", import.meta.url))

test("declares the mixed package license accurately", async () => {
  const metadata = JSON.parse(await readFile(`${workspace}/packages/kokoro-local-runtime/package.json`, "utf8"))
  assert.equal(metadata.license, "MIT AND Apache-2.0")
})

test("exports parameter support through runtime-selected package entry points", async () => {
  const [root, core] = await Promise.all([
    import("kokoro-local-runtime"),
    import("kokoro-local-runtime/core"),
  ])
  assert.deepEqual(root.normalizeKokoroSynthesisParameters({ speed: 1.2 }), { speed: 1.2 })
  assert.deepEqual(core.normalizeSynthesisParameters(root.KOKORO_PARAMETER_DEFINITIONS), { speed: 1 })
})

test("the runtime tarball is self-contained and excludes generated caches", { timeout: 30_000 }, async () => {
  const { stdout } = await exec("npm", ["pack", "--dry-run", "--json", "--silent"], {
    cwd: `${workspace}/packages/kokoro-local-runtime`,
    maxBuffer: 4 * 1024 * 1024,
  })
  const [{ files }] = JSON.parse(stdout)
  const paths = files.map(({ path }) => path)
  for (const required of [
    "package.json",
    "LICENSE",
    "LICENSE-APACHE-2.0",
    "THIRD_PARTY_NOTICES",
    "README.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/core/index.js",
    "dist/core/index.d.ts",
    "dist/core/parameters.js",
    "dist/core/parameters.d.ts",
    "dist/fluidaudio/index.js",
    "dist/fluidaudio/index.d.ts",
    "src/index.ts",
    "src/core/index.ts",
    "src/core/parameters.ts",
    "src/fluidaudio/index.ts",
    "resources/kokoro_worker.py",
    "swift/Package.swift",
    "swift/Package.resolved",
    "swift/Sources/TtsLabFluidAudio/main.swift",
    "swift/Tests/TtsLabFluidAudioTests/ParameterDecodingTests.swift",
  ]) {
    assert.equal(paths.includes(required), true, `kokoro-local-runtime is missing ${required}`)
  }
  assert.deepEqual(paths.filter((path) => path.startsWith("resources/")), ["resources/kokoro_worker.py"])
  assert.equal(paths.filter((path) => path.startsWith("voices/") && path.endsWith(".bin")).length, 28)
  assert.equal(paths.some((path) => /(^|\/)(__pycache__|\.build|\.swiftpm|node_modules)(\/|$)|\.pyc$/.test(path)), false)
})
