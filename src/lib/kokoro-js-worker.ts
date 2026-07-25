import type { ProgressInfo } from "@huggingface/transformers"
import type { KokoroTTS } from "kokoro-js"
import type { RuntimeResourceUsage, RuntimeWorker, WorkerResult, WorkerStatusEvent } from "./tts-worker.js"

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX"

interface KokoroJsWorkerOptions {
  dtype: "q8" | "fp32"
  cacheDir: string
  modelBytes: number
  signal?: AbortSignal
  onStatus(event: WorkerStatusEvent): void
}

export class KokoroJsWorker implements RuntimeWorker {
  static async start(options: KokoroJsWorkerOptions): Promise<{ worker: KokoroJsWorker; loadMs: number }> {
    options.signal?.throwIfAborted()
    const [{ env }, { KokoroTTS }] = await Promise.all([
      import("@huggingface/transformers"),
      import("kokoro-js"),
    ])
    env.cacheDir = options.cacheDir
    options.onStatus({ type: "status", detail: `Loading Kokoro ONNX ${options.dtype.toUpperCase()} on CPU` })
    const started = performance.now()
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: options.dtype,
      device: "cpu",
      progress_callback: (event: ProgressInfo) => {
        options.signal?.throwIfAborted()
        if (event.status !== "progress" || !event.file.includes("onnx/model")) return
        options.onStatus({
          type: "progress",
          progress: Math.max(0, Math.min(1, event.loaded / options.modelBytes)),
          downloadedBytes: event.loaded,
          totalBytes: options.modelBytes,
          detail: `Downloading ${event.file}`,
        })
      },
    })
    if (options.signal?.aborted) {
      const model = tts.model as unknown as { dispose?: () => void | Promise<void> }
      void model.dispose?.()
      throw new DOMException("The operation was aborted", "AbortError")
    }
    return { worker: new KokoroJsWorker(tts, options.onStatus), loadMs: performance.now() - started }
  }

  private disposed = false
  private disposal?: Promise<void>

  private constructor(
    private readonly tts: KokoroTTS,
    private readonly onStatus: (event: WorkerStatusEvent) => void,
  ) {}

  async generate(text: string, output: string, voice = "af_heart"): Promise<WorkerResult> {
    if (this.disposed) throw new Error("Kokoro JavaScript runtime is not running")
    this.onStatus({ type: "status", detail: `Synthesizing with Kokoro ${voice} on JavaScript ONNX` })
    const started = performance.now()
    const audio = await this.tts.generate(text, { voice: voice as "af_heart" })
    await audio.save(output)
    return { output, generationMs: performance.now() - started }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const model = this.tts.model as unknown as { dispose?: () => void | Promise<void> }
    this.disposal = Promise.resolve(model.dispose?.()).then(() => undefined)
  }

  async stop(): Promise<void> {
    this.dispose()
    await this.disposal
  }

  getResourceUsage(): RuntimeResourceUsage {
    // This runtime lives in the app process; ModelManager reports it as app RSS/heap.
    return {}
  }
}
