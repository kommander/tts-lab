import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootstrapUv, commandExists, runProcess } from "../dist/index.js"

let directory = ""

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("logs subprocess output and uses stdout as an error fallback", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-process-"))
  const logPath = join(directory, "model.log")
  await assert.rejects(
    runProcess([process.execPath, "-e", 'console.log("useful failure"); process.exit(7)'], { logPath }),
    /useful failure/,
  )
  const log = await readFile(logPath, "utf8")
  assert.match(log, /\[stdout\] useful failure/)
  assert.match(log, /\[exit\] code 7/)
})

test("supports command-specific version arguments", async () => {
  assert.equal(await commandExists(process.execPath, ["-e", "process.exit(0)"]), true)
})

test("supports stdin and mixed line endings", async () => {
  const lines = []
  const stdout = await runProcess(
    [process.execPath, "-e", "process.stdin.on('data', value => process.stdout.write(value));"],
    { stdin: "one\rtwo\n", onLine: (line) => lines.push(line) },
  )
  assert.equal(stdout, "one\rtwo\n")
  assert.deepEqual(lines, ["one", "two"])
})

test("aborting terminates the subprocess tree", async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-tree-"))
  const marker = join(directory, "descendant-survived")
  const markerDelay = process.platform === "win32" ? 700 : 1_300
  const descendantScript = `
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "alive"), ${markerDelay});
    setInterval(() => {}, 1000);
  `
  const parentScript = `
    const { spawn } = require("node:child_process");
    process.on("SIGTERM", () => {});
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });
    console.log("descendant:" + child.pid);
    setInterval(() => {}, 1000);
  `
  const controller = new AbortController()
  let descendantPid
  await assert.rejects(runProcess([process.execPath, "-e", parentScript], {
    signal: controller.signal,
    onLine: (line) => {
      if (!line.startsWith("descendant:")) return
      descendantPid = Number(line.slice("descendant:".length))
      controller.abort()
    },
  }), { name: "AbortError" })

  await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 900 : 450))
  assert.equal(await stat(marker).then(() => true, () => false), false)
  if (process.platform !== "win32") {
    const deadline = Date.now() + 500
    while (Date.now() < deadline && descendantPid) {
      try {
        process.kill(descendantPid, 0)
        await new Promise((resolve) => setTimeout(resolve, 20))
      } catch {
        descendantPid = undefined
      }
    }
    assert.equal(descendantPid, undefined, "descendant process remained alive")
  }
})

test("shares uv bootstrap work while callers cancel independently", { skip: process.platform === "win32" }, async () => {
  directory = await mkdtemp(join(tmpdir(), "tts-runtime-uv-"))
  const binDir = join(directory, "bin")
  const uvDir = join(directory, "tools", "uv")
  const calls = join(directory, "calls")
  await mkdir(binDir, { recursive: true })
  const fakePython = join(binDir, "python3")
  const script = `#!${process.execPath}
const { appendFileSync, chmodSync, copyFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "-m" && args[1] === "venv") {
  appendFileSync(${JSON.stringify(calls)}, "venv\\n");
  setTimeout(() => {
    const target = join(args[2], "bin", "python");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(process.argv[1], target);
    chmodSync(target, 0o755);
  }, 80);
  setTimeout(() => process.exit(0), 100);
} else if (args[0] === "-m" && args[1] === "pip") {
  appendFileSync(${JSON.stringify(calls)}, "pip\\n");
  const uv = join(dirname(process.argv[1]), "uv");
  writeFileSync(uv, ${JSON.stringify(`#!${process.execPath}\nconsole.log("uv 0.11.32")\n`)});
  chmodSync(uv, 0o755);
  console.log("installed");
}
`
  await writeFile(fakePython, script)
  await chmod(fakePython, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${binDir}:${previousPath ?? ""}`
  const controller = new AbortController()
  const firstEvents = []
  const secondEvents = []
  try {
    const first = bootstrapUv({
      uvDir,
      version: "0.11.32",
      signal: controller.signal,
      onEvent: (event) => {
        firstEvents.push(event.detail)
        if (event.stage === "create") controller.abort()
      },
    })
    const second = bootstrapUv({ uvDir, version: "0.11.32", onEvent: (event) => secondEvents.push(event.detail) })
    await assert.rejects(first, { name: "AbortError" })
    assert.equal(await second, join(uvDir, "bin", "uv"))
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["venv", "pip"])
    assert.match(firstEvents.join("\n"), /Creating local uv bootstrap/)
    assert.match(secondEvents.join("\n"), /Installing uv 0\.11\.32/)
    assert.match(secondEvents.join("\n"), /installed/)
  } finally {
    process.env.PATH = previousPath
  }
})
