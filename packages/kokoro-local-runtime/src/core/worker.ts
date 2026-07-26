import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { processTreeSpawnOptions, terminateProcessTree } from "./process.js"

const TIMEOUT_MS = 15 * 60_000

export interface WorkerStatusEvent {
  type: "status" | "progress"
  detail?: string
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
}

export interface WorkerResult {
  output: string
  generationMs: number
}

export interface RuntimeResourceUsage {
  rssBytes?: number
  peakRssBytes?: number
  heapUsedBytes?: number
}

export interface RuntimeWorker {
  generate(text: string, output: string, voice?: string): Promise<WorkerResult>
  dispose(): void
  stop(): Promise<void>
  getResourceUsage(): RuntimeResourceUsage
}

export interface NdjsonRuntimeWorkerOptions {
  command: string[]
  env?: Record<string, string | undefined>
  logPath: string
  onStatus(event: WorkerStatusEvent): void
  onExit?(): void
}

interface ProtocolEvent {
  type?: "ready" | "fatal" | "status" | "progress" | "result" | "error"
  request_id?: string
  detail?: string
  progress?: number
  downloadedBytes?: number
  totalBytes?: number
  output?: string
  load_ms?: number
  generation_ms?: number
  error?: string
  resource?: RuntimeResourceUsage
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

interface PendingRequest extends Deferred<WorkerResult> {
  timer: ReturnType<typeof setTimeout>
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"]
  let reject!: Deferred<T>["reject"]
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function clean(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim()
}

export class NdjsonRuntimeWorker implements RuntimeWorker {
  readonly ready: Promise<number>
  private readonly process: ChildProcessWithoutNullStreams
  private readonly exited: Promise<void>
  private readonly readyResult = deferred<number>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly log: WriteStream
  private readonly stderrTail: string[] = []
  private latestResource: RuntimeResourceUsage = {}
  private readonly startupTimer: ReturnType<typeof setTimeout>
  private disposed = false
  private exitHandled = false
  private termination?: Promise<void>
  private stopping?: Promise<void>

  static async spawn(options: NdjsonRuntimeWorkerOptions): Promise<NdjsonRuntimeWorker> {
    await mkdir(dirname(options.logPath), { recursive: true })
    return new NdjsonRuntimeWorker(options)
  }

  static async start(
    options: NdjsonRuntimeWorkerOptions,
  ): Promise<{ worker: NdjsonRuntimeWorker; loadMs: number }> {
    const worker = await NdjsonRuntimeWorker.spawn(options)
    try {
      return { worker, loadMs: await worker.ready }
    } catch (error) {
      await worker.stop()
      throw error
    }
  }

  private constructor(private readonly options: NdjsonRuntimeWorkerOptions) {
    this.ready = this.readyResult.promise
    const log = this.log = createWriteStream(options.logPath, { flags: "a" })
    log.write(
      `\n[${new Date().toISOString()}] $ ${options.command.map((part) => JSON.stringify(part)).join(" ")}\n`,
    )
    this.process = spawn(options.command[0]!, options.command.slice(1), {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...processTreeSpawnOptions,
    })
    this.startupTimer = setTimeout(() => {
      this.readyResult.reject(new Error("TTS worker model load timed out"))
      this.dispose()
    }, TIMEOUT_MS)
    this.startupTimer.unref?.()
    const outputDone = Promise.allSettled([
      this.readLines(this.process.stdout, "stdout"),
      this.readLines(this.process.stderr, "stderr"),
    ])
    const closed = new Promise<{ code: number | null; cause?: Error }>((resolve) => {
      let processError: Error | undefined
      this.process.once("error", (error) => { processError = error })
      this.process.once("close", (code, signal) => {
        resolve({
          code,
          cause: processError
            ?? (code === null ? new Error(`TTS worker terminated by signal ${signal ?? "unknown"}`) : undefined),
        })
      })
    })
    this.exited = (async () => {
      const { code, cause } = await closed
      await outputDone
      try {
        this.handleExit(code, cause)
      } finally {
        log.end()
        await finished(log).catch(() => undefined)
      }
    })()
  }

  async generate(text: string, output: string, voice?: string): Promise<WorkerResult> {
    await this.ready
    if (this.disposed) throw new Error("TTS worker is not running")
    const id = randomUUID()
    const result = deferred<WorkerResult>()
    const timer = setTimeout(() => {
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      request.reject(new Error("TTS generation timed out"))
      this.dispose()
    }, TIMEOUT_MS)
    timer.unref?.()
    this.pending.set(id, { ...result, timer })
    const payload = `${JSON.stringify({ id, text, output, voice })}\n`
    try {
      await new Promise<void>((resolve, reject) => {
        this.process.stdin.write(payload, (error) => error ? reject(error) : resolve())
      })
    } catch (error) {
      this.pending.delete(id)
      clearTimeout(timer)
      throw error
    }
    return result.promise
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.startupTimer)
    const error = new Error("TTS worker stopped")
    this.readyResult.reject(error)
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    this.process.stdin.end()
    this.termination = terminateProcessTree(this.process.pid)
    void this.termination.catch(() => undefined)
  }

  async stop(): Promise<void> {
    this.dispose()
    this.stopping ??= (async () => {
      const [termination, exited] = await Promise.allSettled([this.termination, this.exited])
      if (termination.status === "rejected") throw termination.reason
      if (exited.status === "rejected") throw exited.reason
    })()
    await this.stopping
  }

  getResourceUsage(): RuntimeResourceUsage {
    return { ...this.latestResource }
  }

  private async readLines(stream: Readable, source: "stdout" | "stderr"): Promise<void> {
    const decoder = new TextDecoder()
    let pending = ""
    for await (const chunk of stream) {
      pending += decoder.decode(chunk as Uint8Array, { stream: true })
      const lines = pending.split(/\r?\n|\r/g)
      pending = lines.pop() ?? ""
      for (const line of lines) this.handleLine(line, source)
    }
    pending += decoder.decode()
    if (pending) this.handleLine(pending, source)
  }

  private handleLine(rawLine: string, source: "stdout" | "stderr"): void {
    const line = clean(rawLine)
    if (!line) return
    this.log.write(`[${source}] ${line}\n`)
    if (source === "stderr") {
      this.stderrTail.push(line)
      if (this.stderrTail.length > 12) this.stderrTail.shift()
      return
    }
    if (!line.startsWith("{")) return

    let event: ProtocolEvent
    try {
      event = JSON.parse(line) as ProtocolEvent
    } catch {
      return
    }
    if (event.type === "ready") {
      this.latestResource = event.resource ?? this.latestResource
      clearTimeout(this.startupTimer)
      this.readyResult.resolve(event.load_ms ?? 0)
      return
    }
    if (event.type === "fatal") {
      clearTimeout(this.startupTimer)
      this.readyResult.reject(new Error(event.error || "TTS worker failed to load"))
      return
    }
    if (!event.request_id) {
      if (event.type === "status" || event.type === "progress") this.options.onStatus(event as WorkerStatusEvent)
      return
    }

    const request = this.pending.get(event.request_id)
    if (!request) return
    if (event.type === "status" || event.type === "progress") {
      this.options.onStatus(event as WorkerStatusEvent)
    } else if (event.type === "result") {
      this.latestResource = event.resource ?? this.latestResource
      this.pending.delete(event.request_id)
      clearTimeout(request.timer)
      request.resolve({ output: event.output ?? "", generationMs: event.generation_ms ?? 0 })
    } else if (event.type === "error") {
      this.pending.delete(event.request_id)
      clearTimeout(request.timer)
      request.reject(new Error(event.error || "TTS generation failed"))
    }
  }

  private handleExit(code: number | null, cause?: Error): void {
    if (this.exitHandled) return
    this.exitHandled = true
    clearTimeout(this.startupTimer)
    this.log.write(`[exit] code ${code ?? "null"}\n`)
    const detail = this.stderrTail.slice(-8).join("\n")
    const error = cause ?? new Error(detail || `TTS worker exited with code ${code ?? "null"}`)
    if (!this.disposed) {
      this.readyResult.reject(error)
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      this.pending.clear()
    }
    this.options.onExit?.()
  }
}
