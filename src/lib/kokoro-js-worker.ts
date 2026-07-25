import type { ProgressInfo } from "@huggingface/transformers"
import type { KokoroTTS } from "kokoro-js"
import type { RuntimeResourceUsage, RuntimeWorker, WorkerResult, WorkerStatusEvent } from "./tts-worker.js"

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX"

interface KokoroJsWorkerOptions {
  dtype: "q8" | "fp32"
  device: "cpu" | "webgpu"
  lowMemory?: boolean
  cacheDir: string
  modelBytes: number
  signal?: AbortSignal
  onStatus(event: WorkerStatusEvent): void
}

export class KokoroJsWorker implements RuntimeWorker {
  static async start(options: KokoroJsWorkerOptions): Promise<{ worker: KokoroJsWorker; loadMs: number }> {
    options.signal?.throwIfAborted()
    const [{ AutoTokenizer, StyleTextToSpeech2Model, env }, { KokoroTTS }] = await Promise.all([
      import("@huggingface/transformers"),
      import("kokoro-js"),
    ])
    env.cacheDir = options.cacheDir
    const deviceName = options.device === "webgpu" ? "WebGPU" : "CPU"
    options.onStatus({ type: "status", detail: `Loading Kokoro ONNX ${options.dtype.toUpperCase()} on ${deviceName}` })
    const started = performance.now()
    const progress_callback = (event: ProgressInfo) => {
      options.signal?.throwIfAborted()
      if (event.status !== "progress" || !event.file.includes("onnx/model")) return
      options.onStatus({
        type: "progress",
        progress: Math.max(0, Math.min(1, event.loaded / options.modelBytes)),
        downloadedBytes: event.loaded,
        totalBytes: options.modelBytes,
        detail: `Downloading ${event.file}`,
      })
    }
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(MODEL_ID, {
        dtype: options.dtype,
        device: options.device,
        progress_callback,
        session_options: options.lowMemory
          ? { enableCpuMemArena: false, enableMemPattern: false }
          : undefined,
      }),
      AutoTokenizer.from_pretrained(MODEL_ID, {
        progress_callback,
      }),
    ])
    const tts = new KokoroTTS(
      model as InstanceType<typeof StyleTextToSpeech2Model>,
      tokenizer,
    )
    if (options.signal?.aborted) {
      const model = tts.model as unknown as { dispose?: () => void | Promise<void> }
      void model.dispose?.()
      throw new DOMException("The operation was aborted", "AbortError")
    }
    return { worker: new KokoroJsWorker(tts, deviceName, options.onStatus), loadMs: performance.now() - started }
  }

  private disposed = false
  private disposal?: Promise<void>

  private constructor(
    private readonly tts: KokoroTTS,
    private readonly deviceName: string,
    private readonly onStatus: (event: WorkerStatusEvent) => void,
  ) {}

  async generate(text: string, output: string, voice = "af_heart"): Promise<WorkerResult> {
    if (this.disposed) throw new Error("Kokoro JavaScript runtime is not running")
    this.onStatus({ type: "status", detail: `Synthesizing with Kokoro ${voice} on ${this.deviceName}` })
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
