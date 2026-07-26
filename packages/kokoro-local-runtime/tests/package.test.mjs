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

test("runtime package tarballs contain only their explicit payloads", async () => {
  const expected = {
    "tts-runtime-core": [],
    "fluidaudio-runtime": ["swift/Package.swift"],
    "kokoro-local-runtime": ["resources/kokoro_worker.py", "LICENSE-APACHE-2.0", "THIRD_PARTY_NOTICES"],
  }
  for (const [name, extra] of Object.entries(expected)) {
    const { stdout } = await exec("npm", ["pack", "--dry-run", "--json", "--silent"], {
      cwd: `${workspace}/packages/${name}`,
      maxBuffer: 1024 * 1024,
    })
    const [{ files }] = JSON.parse(stdout)
    const paths = files.map(({ path }) => path)
    for (const required of ["package.json", "LICENSE", "README.md", "dist/index.js", "dist/index.d.ts", ...extra]) {
      assert.equal(paths.includes(required), true, `${name} is missing ${required}`)
    }
    assert.equal(paths.some((path) => path.includes("__pycache__") || path.endsWith(".pyc")), false)
    if (name === "kokoro-local-runtime") {
      assert.deepEqual(paths.filter((path) => path.startsWith("resources/")), ["resources/kokoro_worker.py"])
      assert.equal(paths.filter((path) => path.startsWith("voices/") && path.endsWith(".bin")).length, 28)
    }
  }
})
