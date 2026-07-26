import type { ProgressInfo } from "@huggingface/transformers"
import type { RuntimeResourceUsage, RuntimeWorker, WorkerResult } from "./core/index.js"
import { KokoroEnglishTTS, type KokoroModel, type KokoroTokenizer } from "./kokoro-adapter.js"
import type { KokoroEvent, KokoroJavascriptLoadOptions } from "./runtime.js"

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX"
let javascriptLoadLocked = false
const javascriptLoadWaiters: {
  resolve(release: () => void): void
  reject(reason?: unknown): void
  signal?: AbortSignal
  abort?: () => void
}[] = []

function releaseJavascriptLoadLock(): void {
  const waiter = javascriptLoadWaiters.shift()
  if (!waiter) {
    javascriptLoadLocked = false
    return
  }
  if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort)
  waiter.resolve(releaseJavascriptLoadLock)
}

async function acquireJavascriptLoadLock(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted()
  if (!javascriptLoadLocked) {
    javascriptLoadLocked = true
    return releaseJavascriptLoadLock
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal } as (typeof javascriptLoadWaiters)[number]
    waiter.abort = () => {
      const index = javascriptLoadWaiters.indexOf(waiter)
      if (index >= 0) javascriptLoadWaiters.splice(index, 1)
      reject(signal!.reason ?? new DOMException("The operation was aborted", "AbortError"))
    }
    javascriptLoadWaiters.push(waiter)
    signal?.addEventListener("abort", waiter.abort, { once: true })
  })
}

export async function withJavascriptLoadLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquireJavascriptLoadLock(signal)
  try {
    signal?.throwIfAborted()
    return await operation()
  } finally {
    release()
  }
}

export const TRANSFORMERS_JS_COMPATIBILITY = {
  transformersVersion: "4.2.0",
  publicationReady: true,
  note: "Uses a package-internal Apache-2.0 adapter derived from kokoro-js 1.2.1 commit 664c76a704021239ba59c84dcbaa4d3dece01fe9 with Transformers.js 4.2.0 directly.",
} as const

export function getJavascriptLoadOptions(options: Pick<KokoroJavascriptLoadOptions, "dtype" | "device" | "lowMemory">) {
  return {
    dtype: options.dtype,
    device: options.device,
    session_options: options.lowMemory
      ? { enableCpuMemArena: false, enableMemPattern: false }
      : undefined,
  }
}

export class KokoroJavascriptWorker implements RuntimeWorker {
  static async start(options: KokoroJavascriptLoadOptions): Promise<{ worker: KokoroJavascriptWorker; loadMs: number }> {
    options.signal?.throwIfAborted()
    const { AutoTokenizer, StyleTextToSpeech2Model, env } = await import("@huggingface/transformers")
    const deviceName = options.device === "webgpu" ? "WebGPU" : "CPU"
    options.onEvent?.({ type: "status", detail: `Loading Kokoro ONNX ${options.dtype.toUpperCase()} on ${deviceName}` })
    const started = performance.now()
    const progress_callback = (event: ProgressInfo) => {
      options.signal?.throwIfAborted()
      if (event.status !== "progress" || !event.file.includes("onnx/model")) return
      options.onEvent?.({
        type: "progress",
        progress: Math.max(0, Math.min(1, event.loaded / options.modelBytes)),
        downloadedBytes: event.loaded,
        totalBytes: options.modelBytes,
        detail: `Downloading ${event.file}`,
      })
    }
    const [model, tokenizer] = await withJavascriptLoadLock(async () => {
      options.signal?.throwIfAborted()
      env.cacheDir = options.cacheDir
      const loaded = await Promise.allSettled([
        StyleTextToSpeech2Model.from_pretrained(MODEL_ID, {
          ...getJavascriptLoadOptions(options),
          progress_callback,
        }),
        AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback }),
      ])
      const failed = loaded.find((result) => result.status === "rejected")
      if (failed) {
        const loadedModel = loaded[0].status === "fulfilled"
          ? loaded[0].value as unknown as { dispose?: () => void | Promise<void> }
          : undefined
        await loadedModel?.dispose?.()
        throw failed.reason
      }
      if (loaded[0].status !== "fulfilled" || loaded[1].status !== "fulfilled") {
        throw new Error("Kokoro model loading failed")
      }
      if (options.signal?.aborted) {
        const loadedModel = loaded[0].value as unknown as { dispose?: () => void | Promise<void> }
        await loadedModel.dispose?.()
        options.signal.throwIfAborted()
      }
      return [loaded[0].value, loaded[1].value] as const
    }, options.signal)
    const tts = new KokoroEnglishTTS(
      model as unknown as KokoroModel,
      tokenizer as unknown as KokoroTokenizer,
    )
    if (options.signal?.aborted) {
      const loadedModel = tts.model as unknown as { dispose?: () => void | Promise<void> }
      await loadedModel.dispose?.()
      options.signal.throwIfAborted()
    }
    return {
      worker: new KokoroJavascriptWorker(tts, deviceName, options.onEvent, options.onExit),
      loadMs: performance.now() - started,
    }
  }

  private disposed = false
  private disposal?: Promise<void>
  private readonly generations = new Set<Promise<WorkerResult>>()

  private constructor(
    private readonly tts: KokoroEnglishTTS,
    private readonly deviceName: string,
    private readonly onEvent?: (event: KokoroEvent) => void,
    private readonly onExit?: () => void,
  ) {}

  async generate(text: string, output: string, voice = "af_heart"): Promise<WorkerResult> {
    if (this.disposed) throw new Error("Kokoro JavaScript runtime is not running")
    const generation = (async () => {
      this.onEvent?.({ type: "status", detail: `Synthesizing with Kokoro ${voice} on ${this.deviceName}` })
      const started = performance.now()
      const audio = await this.tts.generate(text, { voice })
      await audio.save(output)
      return { output, generationMs: performance.now() - started }
    })()
    this.generations.add(generation)
    generation.finally(() => this.generations.delete(generation)).catch(() => undefined)
    return generation
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const model = this.tts.model as unknown as { dispose?: () => void | Promise<void> }
    this.disposal = (async () => {
      try {
        await Promise.allSettled([...this.generations])
        await model.dispose?.()
      } finally {
        this.onExit?.()
      }
    })()
    this.disposal.catch(() => undefined)
  }

  async stop(): Promise<void> {
    this.dispose()
    await this.disposal
  }

  getResourceUsage(): RuntimeResourceUsage {
    return {}
  }
}
