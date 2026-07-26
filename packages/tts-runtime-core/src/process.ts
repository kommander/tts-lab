import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { Readable } from "node:stream"
import { finished } from "node:stream/promises"

const TERMINATION_GRACE_MS = 1_000

export const processTreeSpawnOptions = {
  detached: process.platform !== "win32",
  windowsHide: true,
} as const

export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  stdin?: string
  onLine?: (line: string, stream: "stdout" | "stderr") => void
  logPath?: string
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function waitForProcessGroupExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + TERMINATION_GRACE_MS
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false
    await delay(20)
  }
  return true
}

async function terminatePosixGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    return
  }

  if (await waitForProcessGroupExit(pid)) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    return
  }
  await waitForProcessGroupExit(pid)
}

async function terminateWindowsTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("error", () => resolve())
    killer.once("close", () => resolve())
  })
}

export async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`Refusing to terminate invalid subprocess tree PID ${pid}`)
  }
  await (process.platform === "win32" ? terminateWindowsTree(pid) : terminatePosixGroup(pid))
}

async function consumeLines(
  stream: Readable,
  source: "stdout" | "stderr",
  onLine?: RunOptions["onLine"],
): Promise<string> {
  const decoder = new TextDecoder()
  let pending = ""
  let output = ""
  const maxOutput = 64 * 1024
  for await (const chunk of stream) {
    const decoded = decoder.decode(chunk as Uint8Array, { stream: true })
    output = (output + decoded).slice(-maxOutput)
    pending += decoded
    const lines = pending.split(/\r?\n|\r/g)
    pending = lines.pop() ?? ""
    for (const line of lines) if (line.trim()) onLine?.(line.trim(), source)
  }
  const final = decoder.decode()
  output = (output + final).slice(-maxOutput)
  pending += final
  if (pending.trim()) onLine?.(pending.trim(), source)
  return output
}

export async function runProcess(command: readonly string[], options: RunOptions = {}): Promise<string> {
  if (!command[0]) throw new Error("A subprocess command is required")
  options.signal?.throwIfAborted()
  if (options.logPath) await mkdir(dirname(options.logPath), { recursive: true })
  const log = options.logPath ? createWriteStream(options.logPath, { flags: "a" }) : undefined
  log?.write(`\n[${new Date().toISOString()}] $ ${command.map((part) => JSON.stringify(part)).join(" ")}\n`)
  const onLine = (line: string, stream: "stdout" | "stderr") => {
    log?.write(`[${stream}] ${line}\n`)
    options.onLine?.(line, stream)
  }
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    ...processTreeSpawnOptions,
  })
  let termination: Promise<void> | undefined
  const terminate = () => {
    if (termination) return termination
    termination = terminateProcessTree(child.pid)
    return termination
  }
  const abort = () => {
    void terminate().catch(() => child.kill("SIGKILL"))
  }
  options.signal?.addEventListener("abort", abort, { once: true })
  const stdinDone = new Promise<void>((resolve) => {
    child.stdin.once("error", () => resolve())
    child.stdin.end(options.stdin, () => resolve())
  })

  try {
    const exitCode = new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => {
        if (options.signal?.aborted) {
          reject(options.signal.reason)
        } else if (code === null) {
          reject(new Error(`${command[0]} terminated by signal ${signal ?? "unknown"}`))
        } else {
          resolve(code)
        }
      })
    })
    const [exit, stdoutResult, stderrResult] = await Promise.allSettled([
      exitCode,
      consumeLines(child.stdout, "stdout", onLine),
      consumeLines(child.stderr, "stderr", onLine),
    ])
    await stdinDone
    if (termination) await termination.catch(() => undefined)
    if (exit.status === "rejected") throw exit.reason
    if (stdoutResult.status === "rejected") throw stdoutResult.reason
    if (stderrResult.status === "rejected") throw stderrResult.reason
    const code = exit.value
    const stdout = stdoutResult.value
    const stderr = stderrResult.value
    log?.write(`[exit] code ${code}\n`)
    if (code !== 0) {
      const output = stderr.trim() || stdout.trim()
      const message = output
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-8)
        .join("\n")
      throw new Error(message || `${command[0]} exited with code ${code}`)
    }
    return stdout
  } finally {
    options.signal?.removeEventListener("abort", abort)
    if (termination) await termination.catch(() => undefined)
    log?.end()
    if (log) await finished(log).catch(() => undefined)
  }
}

export async function commandExists(command: string, versionArgs: string[] = ["--version"]): Promise<boolean> {
  try {
    await runProcess([command, ...versionArgs])
    return true
  } catch {
    return false
  }
}
