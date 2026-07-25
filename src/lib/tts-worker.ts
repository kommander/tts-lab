import { randomUUID } from "node:crypto"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

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

interface WorkerOptions {
  command: string[]
  env: Record<string, string | undefined>
  logPath: string
  onStatus(event: WorkerStatusEvent): void
  onExit?(): void
}

interface ProtocolEvent {
  type?: "ready" | "fatal" | "status" | "progress" | "result" | "error"
  request_id?: string
  detail?: string
  progress?: number
  output?: string
  load_ms?: number
  generation_ms?: number
  error?: string
  resource?: RuntimeResourceUsage
}

interface PendingRequest {
  resolve(result: WorkerResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

function clean(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim()
}

export class TtsWorker implements RuntimeWorker {
  readonly ready: Promise<number>
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">
  private readonly readyResult = Promise.withResolvers<number>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly log: WriteStream
  private readonly stderrTail: string[] = []
  private latestResource: RuntimeResourceUsage = {}
  private readonly startupTimer: ReturnType<typeof setTimeout>
  private disposed = false

  static async spawn(options: WorkerOptions): Promise<TtsWorker> {
    await mkdir(dirname(options.logPath), { recursive: true })
    return new TtsWorker(options)
  }

  static async start(options: WorkerOptions): Promise<{ worker: TtsWorker; loadMs: number }> {
    const worker = await TtsWorker.spawn(options)
    return { worker, loadMs: await worker.ready }
  }

  private constructor(private readonly options: WorkerOptions) {
    this.ready = this.readyResult.promise
    this.log = createWriteStream(options.logPath, { flags: "a" })
    this.log.write(
      `\n[${new Date().toISOString()}] $ ${options.command.map((part) => JSON.stringify(part)).join(" ")}\n`,
    )
    this.process = Bun.spawn(options.command, {
      env: { ...Bun.env, ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.startupTimer = setTimeout(() => {
      this.readyResult.reject(new Error("TTS worker model load timed out"))
      this.dispose()
    }, 15 * 60_000)
    void this.readLines(this.process.stdout, "stdout")
    void this.readLines(this.process.stderr, "stderr")
    void this.process.exited.then((code) => this.handleExit(code))
  }

  async generate(text: string, output: string, voice?: string): Promise<WorkerResult> {
    await this.ready
    if (this.disposed) throw new Error("TTS worker is not running")
    const id = randomUUID()
    const deferred = Promise.withResolvers<WorkerResult>()
    const timer = setTimeout(() => {
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      request.reject(new Error("TTS generation timed out"))
      this.dispose()
    }, 15 * 60_000)
    this.pending.set(id, { ...deferred, timer })
    const payload = `${JSON.stringify({ id, text, output, voice })}\n`
    try {
      await this.process.stdin.write(payload)
      await this.process.stdin.flush()
    } catch (error) {
      this.pending.delete(id)
      clearTimeout(timer)
      throw error
    }
    return deferred.promise
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.startupTimer)
    const error = new Error("TTS worker stopped")
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    void this.process.stdin.end()
    this.process.kill()
  }

  async stop(): Promise<void> {
    this.dispose()
    await this.process.exited
  }

  getResourceUsage(): RuntimeResourceUsage {
    return { ...this.latestResource }
  }

  private async readLines(stream: ReadableStream<Uint8Array>, source: "stdout" | "stderr"): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
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

  private handleExit(code: number): void {
    clearTimeout(this.startupTimer)
    this.log.write(`[exit] code ${code}\n`)
    this.log.end()
    const detail = this.stderrTail.slice(-8).join("\n")
    const error = new Error(detail || `TTS worker exited with code ${code}`)
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
