import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadAssets } from "../../dist/core/index.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("downloads an asset and reports aggregate progress", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-download-"))
  const content = "small model"
  const events = []
  await downloadAssets(
    [{ path: "nested/model.bin", url: `data:text/plain,${encodeURIComponent(content)}`, size: content.length }],
    directory,
    ({ completedBytes }) => events.push(completedBytes),
  )
  assert.equal(await readFile(join(directory, "nested/model.bin"), "utf8"), content)
  assert.equal(events.at(-1), content.length)
})

test("promotes a complete partial without fetching it again", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-download-"))
  await mkdir(join(directory, "nested"), { recursive: true })
  await writeFile(join(directory, "nested/model.bin.part"), "complete")
  await downloadAssets(
    [{ path: "nested/model.bin", url: "https://invalid.local/model", size: 8 }],
    directory,
    () => undefined,
  )
  assert.equal(await readFile(join(directory, "nested/model.bin"), "utf8"), "complete")
})
