import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { finished } from "node:stream/promises"

export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  stdin?: string
  onLine?: (line: string, stream: "stdout" | "stderr") => void
  logPath?: string
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  source: "stdout" | "stderr",
  onLine?: RunOptions["onLine"],
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let output = ""
  const maxOutput = 64 * 1024
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const decoded = decoder.decode(value, { stream: true })
    output = (output + decoded).slice(-maxOutput)
    pending += decoded
    const lines = pending.split(/\r?\n|\r/g)
    pending = lines.pop() ?? ""
    for (const line of lines) if (line.trim()) onLine?.(line.trim(), source)
  }
  pending += decoder.decode()
  if (pending.trim()) onLine?.(pending.trim(), source)
  return output
}

export async function runProcess(command: string[], options: RunOptions = {}): Promise<string> {
  if (options.logPath) await mkdir(dirname(options.logPath), { recursive: true })
  const log = options.logPath ? createWriteStream(options.logPath, { flags: "a" }) : undefined
  log?.write(`\n[${new Date().toISOString()}] $ ${command.map((part) => JSON.stringify(part)).join(" ")}\n`)
  const onLine = (line: string, stream: "stdout" | "stderr") => {
    log?.write(`[${stream}] ${line}\n`)
    options.onLine?.(line, stream)
  }
  const process = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...Bun.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    consumeLines(process.stdout, "stdout", onLine),
    consumeLines(process.stderr, "stderr", onLine),
  ])
  log?.write(`[exit] code ${exitCode}\n`)
  log?.end()
  if (log) await finished(log)
  if (exitCode !== 0) {
    const output = stderr.trim() || stdout.trim()
    const message = output
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-8)
      .join("\n")
    throw new Error(message || `${command[0]} exited with code ${exitCode}`)
  }
  return stdout
}

export async function commandExists(command: string, versionArgs: string[] = ["--version"]): Promise<boolean> {
  try {
    await runProcess([command, ...versionArgs])
    return true
  } catch {
    return false
  }
}
