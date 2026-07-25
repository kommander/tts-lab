import { randomUUID } from "node:crypto"
import { constants, readFileSync } from "node:fs"
import { appendFile, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"
import { AudioPlayer } from "./audio-player.js"
import { downloadAssets } from "./download.js"
import { KokoroJsWorker } from "./kokoro-js-worker.js"
import { commandExists, runProcess } from "./process.js"
import { TtsWorker, type RuntimeWorker, type WorkerStatusEvent } from "./tts-worker.js"
import { MODEL_BY_ID, MODELS, type ModelDefinition, type RuntimeProfile } from "../models.js"
import type { DemoController, LatestAudio, ModelId, ModelState } from "../types.js"

const PROJECT_ROOT = resolve(import.meta.dir, "../..")
const APP_HOME = resolve(Bun.env.TTS_LAB_HOME ?? join(PROJECT_ROOT, ".tts-lab"))
const UV_VERSION = "0.11.32"

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(2)}s`
}

export function normalizeAudioExportPath(path: string, format: "wav"): string {
  const requested = path.trim()
  if (!requested) throw new Error("Enter a destination path")
  const expectedExtension = `.${format}`
  const currentExtension = extname(requested)
  const normalized = currentExtension.toLowerCase() === expectedExtension
    ? requested
    : currentExtension
      ? `${requested.slice(0, -currentExtension.length)}${expectedExtension}`
      : `${requested}${expectedExtension}`
  return resolve(normalized)
}

export async function copyAudioExport(source: string, path: string, format: "wav"): Promise<string> {
  const destination = normalizeAudioExportPath(path, format)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  return destination
}

const freshState = (id: ModelId): ModelState => ({
  id,
  voiceId: MODEL_BY_ID[id].defaultVoiceId,
  runtimeId: MODEL_BY_ID[id].defaultRuntimeId,
  installed: false,
  phase: "idle",
  detail: "Not installed",
  setupProgress: 0,
  downloadedBytes: 0,
  totalBytes: MODEL_BY_ID[id].assets.reduce((sum, asset) => sum + asset.size, 0),
  generationProgress: 0,
  resident: false,
})

function envPython(envDir: string): string {
  return process.platform === "win32" ? join(envDir, "Scripts", "python.exe") : join(envDir, "bin", "python")
}

function envExecutable(envDir: string, name: string): string {
  const executable = process.platform === "win32" ? `${name}.exe` : name
  return process.platform === "win32" ? join(envDir, "Scripts", executable) : join(envDir, "bin", executable)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export class ModelManager implements DemoController {
  private readonly states = Object.fromEntries(MODELS.map((model) => [model.id, freshState(model.id)])) as Record<
    ModelId,
    ModelState
  >
  private readonly listeners = new Set<(state: ModelState) => void>()
  private readonly installs = new Map<ModelId, { promise: Promise<void>; controller: AbortController }>()
  private readonly voiceDownloads = new Map<string, { promise: Promise<void>; controller: AbortController }>()
  private readonly audio = new AudioPlayer()
  private controller = new AbortController()
  private uvInstall?: Promise<string>
  private synthesis?: Promise<void>
  private activeAudioModel?: ModelId
  private activeWorker?: { id: ModelId; runtimeId: string; worker: RuntimeWorker; loadMs: number }
  private startingWorker?: RuntimeWorker
  private latestAudio?: LatestAudio & { path: string }

  constructor() {
    this.audio.onError((message) => {
      if (this.activeAudioModel) {
        void this.appendLog(this.activeAudioModel, `[audio:error] ${message}`)
        this.patch(this.activeAudioModel, { phase: "error", detail: message, error: message })
      }
    })
    this.loadRuntimeSettings()
    void this.refresh()
  }

  snapshot(): Record<ModelId, ModelState> {
    return Object.fromEntries(MODELS.map(({ id }) => [id, { ...this.states[id] }])) as Record<ModelId, ModelState>
  }

  subscribe(listener: (state: ModelState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSpectrum(): number[] {
    return this.audio.getSpectrum()
  }

  subscribeSpectrum(listener: (levels: number[]) => void): () => void {
    return this.audio.subscribeSpectrum(listener)
  }

  getLatestAudio(): LatestAudio | null {
    if (!this.latestAudio) return null
    const { path: _path, ...latest } = this.latestAudio
    return latest
  }

  async saveLatestAudio(path: string): Promise<string> {
    if (!this.latestAudio) throw new Error("Generate audio before saving it")
    return copyAudioExport(this.latestAudio.path, path, this.latestAudio.format)
  }

  async ensure(id: ModelId): Promise<void> {
    const runtime = this.runtime(id)
    if (runtime.kind === "javascript") {
      await this.ensureJavascriptRuntime(id, runtime)
      return
    }
    if (await this.isPythonInstalled(MODEL_BY_ID[id])) {
      this.markReady(id)
      return
    }
    const active = this.installs.get(id)
    if (active) return active.promise
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.controller.signal.addEventListener("abort", abort, { once: true })
    const promise = this.install(MODEL_BY_ID[id], runtime.id, controller.signal).finally(() => {
      this.controller.signal.removeEventListener("abort", abort)
      this.installs.delete(id)
    })
    this.installs.set(id, { promise, controller })
    return promise
  }

  async retry(id: ModelId): Promise<void> {
    if (this.states[id].phase !== "error") return
    this.patch(id, { phase: "idle", detail: "Retrying", error: undefined })
    await this.ensure(id)
  }

  async setVoice(id: ModelId, voiceId: string): Promise<void> {
    const model = MODEL_BY_ID[id]
    const voice = model.voices.find((candidate) => candidate.id === voiceId)
    if (!voice) throw new Error(`Unknown ${model.name} voice: ${voiceId}`)
    if (["generating", "playing"].includes(this.states[id].phase)) {
      throw new Error(`Wait for the current ${model.name} synthesis to finish before changing voices`)
    }
    this.patch(id, { voiceId, lastLatency: undefined, error: undefined })
    try {
      await this.ensure(id)
      await this.ensureVoice(id, voiceId)
      if (this.states[id].voiceId === voiceId) {
        this.patch(id, { phase: "ready", detail: `Voice ready: ${voice.name}` })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.states[id].voiceId === voiceId) {
        this.patch(id, { phase: "error", detail: message, error: message })
      }
      throw error
    }
  }

  async setRuntime(id: ModelId, runtimeId: string): Promise<void> {
    const model = MODEL_BY_ID[id]
    const runtime = model.runtimes.find((candidate) => candidate.id === runtimeId)
    if (!runtime) throw new Error(`Unknown ${model.name} runtime: ${runtimeId}`)
    if (this.states[id].runtimeId === runtimeId) return
    if (["generating", "playing"].includes(this.states[id].phase)) {
      throw new Error(`Wait for the current ${model.name} synthesis to finish before changing runtime`)
    }
    const activeInstall = this.installs.get(id)
    if (activeInstall) {
      activeInstall.controller.abort()
      await activeInstall.promise.catch(() => undefined)
    }
    const activeVoiceDownloads = [...this.voiceDownloads.entries()].filter(([key]) => key.startsWith(`${id}:`))
    for (const [, download] of activeVoiceDownloads) download.controller.abort()
    await Promise.allSettled(activeVoiceDownloads.map(([, download]) => download.promise))
    if (this.activeWorker?.id === id) {
      const active = this.activeWorker
      this.activeWorker = undefined
      await active.worker.stop()
    }
    this.patch(id, {
      runtimeId,
      installed: false,
      resident: false,
      phase: "idle",
      detail: `Runtime selected: ${runtime.name}`,
      lastLatency: undefined,
      error: undefined,
    })
    await this.saveRuntimeSettings()
    await this.ensure(id)
  }

  async speak(id: ModelId, text: string): Promise<void> {
    if (this.synthesis) throw new Error("Another synthesis is already running")
    const operation = this.synthesize(id, text)
    this.synthesis = operation.finally(() => {
      this.synthesis = undefined
    })
    return this.synthesis
  }

  private async synthesize(id: ModelId, text: string): Promise<void> {
    const cleanText = text.trim()
    if (!cleanText) throw new Error("Enter some text first")
    await this.ensure(id)
    const voiceId = this.states[id].voiceId
    await this.ensureVoice(id, voiceId)
    const outputDir = join(APP_HOME, "output")
    await mkdir(outputDir, { recursive: true })
    const output = join(outputDir, `${id}-${randomUUID()}.wav`)
    const runtimeId = this.states[id].runtimeId
    const warm = this.activeWorker?.id === id && this.activeWorker.runtimeId === runtimeId

    this.patch(id, {
      phase: "generating",
      detail: warm ? "Using resident model" : "Loading model (cold start)",
      generationProgress: null,
      error: undefined,
    })
    try {
      const worker = await this.getWorker(id)
      const result = await worker.worker.generate(cleanText, output, voiceId)
      this.activeAudioModel = id
      this.patch(id, { phase: "playing", detail: "Starting OpenTUI audio", generationProgress: 1 })
      const playbackStarted = performance.now()
      await this.audio.play(output)
      const playbackMs = performance.now() - playbackStarted
      const previousOutput = this.latestAudio?.path
      this.latestAudio = { path: output, model: id, voiceId, format: "wav" }
      if (previousOutput && previousOutput !== output) await rm(previousOutput, { force: true })
      this.patch(id, {
        phase: "ready",
        detail: `${warm ? "Warm" : "Cold"} synth ${formatDuration(result.generationMs)}; playback ${formatDuration(playbackMs)}`,
        generationProgress: 1,
        lastLatency: {
          warm,
          loadMs: warm ? 0 : worker.loadMs,
          generationMs: result.generationMs,
          playbackMs,
        },
      })
    } catch (error) {
      await rm(output, { force: true })
      const message = error instanceof Error ? error.message : String(error)
      await this.appendLog(id, `[app:error] ${message}`)
      this.patch(id, { phase: "error", detail: message, error: message })
      throw error
    }
  }

  dispose(): void {
    this.controller.abort()
    for (const install of this.installs.values()) install.controller.abort()
    for (const download of this.voiceDownloads.values()) download.controller.abort()
    this.startingWorker?.dispose()
    this.startingWorker = undefined
    this.activeWorker?.worker.dispose()
    this.activeWorker = undefined
    this.audio.dispose()
    if (this.latestAudio) void rm(this.latestAudio.path, { force: true })
    this.latestAudio = undefined
    this.listeners.clear()
  }

  private async refresh(): Promise<void> {
    for (const model of MODELS) {
      const runtime = this.runtime(model.id)
      if (runtime.kind === "javascript") {
        await this.ensureJavascriptRuntime(model.id, runtime)
      } else if (await this.isPythonInstalled(model)) {
        this.markReady(model.id)
      }
    }
  }

  private runtime(id: ModelId): RuntimeProfile {
    const model = MODEL_BY_ID[id]
    return model.runtimes.find((runtime) => runtime.id === this.states[id].runtimeId) ?? model.runtimes[0]!
  }

  private loadRuntimeSettings(): void {
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath(), "utf8")) as { runtimes?: Record<string, string> }
      for (const model of MODELS) {
        const runtimeId = settings.runtimes?.[model.id]
        if (runtimeId && model.runtimes.some((runtime) => runtime.id === runtimeId)) {
          this.patch(model.id, { runtimeId })
        }
      }
    } catch {}
  }

  private async saveRuntimeSettings(): Promise<void> {
    await mkdir(APP_HOME, { recursive: true })
    const runtimes = Object.fromEntries(MODELS.map((model) => [model.id, this.states[model.id].runtimeId]))
    await Bun.write(this.settingsPath(), JSON.stringify({ runtimes }, null, 2))
  }

  private async ensureJavascriptRuntime(id: ModelId, runtime: RuntimeProfile): Promise<void> {
    if (id !== "kokoro" || !runtime.dtype || !runtime.modelBytes || !runtime.modelFile) {
      throw new Error(`JavaScript runtime is not configured for ${MODEL_BY_ID[id].name}`)
    }
    const cachedModel = join(this.javascriptCacheDir(id), "onnx-community", "Kokoro-82M-v1.0-ONNX", runtime.modelFile)
    const cached = await stat(cachedModel).then((entry) => entry.size === runtime.modelBytes).catch(() => false)
    if (this.states[id].runtimeId !== runtime.id) return
    this.patch(id, {
      installed: true,
      phase: "ready",
      detail: cached ? "Ready" : "Ready; ONNX model downloads on first use",
      setupProgress: 1,
      downloadedBytes: cached ? runtime.modelBytes : 0,
      totalBytes: runtime.modelBytes,
      error: undefined,
    })
  }

  private async install(model: ModelDefinition, runtimeId: string, signal: AbortSignal): Promise<void> {
    this.patch(model.id, {
      installed: false,
      phase: "bootstrap",
      detail: "Preparing isolated Python tooling",
      setupProgress: 0.03,
      error: undefined,
    })
    try {
      if (model.requiresFfmpeg && !(await commandExists("ffmpeg", ["-version"]))) {
        throw new Error("F5-TTS requires FFmpeg on PATH. Install FFmpeg, then press Ctrl+R to retry.")
      }
      const uv = await this.ensureUv(model.id)
      await mkdir(this.modelDir(model.id), { recursive: true })
      await mkdir(this.assetDir(model.id), { recursive: true })

      this.patch(model.id, { phase: "setup", detail: `Installing Python ${model.python}`, setupProgress: 0.1 })
      await runProcess([uv, "python", "install", model.python], {
        signal,
        logPath: this.logPath(model.id),
        onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
      })

      const envDir = this.envDir(model.id)
      await rm(envDir, { recursive: true, force: true })
      await runProcess([uv, "venv", "--python", model.python, envDir], {
        signal,
        logPath: this.logPath(model.id),
        onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
      })

      this.patch(model.id, { detail: `Installing ${model.name} runtime`, setupProgress: 0.25 })
      await runProcess([uv, "pip", "install", "--python", envPython(envDir), ...model.packages], {
        signal,
        logPath: this.logPath(model.id),
        env: { UV_LINK_MODE: "copy", GIT_LFS_SKIP_SMUDGE: "1" },
        onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
      })
      if (model.packagesNoDeps?.length) {
        await runProcess(
          [uv, "pip", "install", "--no-deps", "--python", envPython(envDir), ...model.packagesNoDeps],
          {
            signal,
            logPath: this.logPath(model.id),
            env: { UV_LINK_MODE: "copy", GIT_LFS_SKIP_SMUDGE: "1" },
            onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
          },
        )
      }

      let postStep = 0
      for (const command of model.postInstall ?? []) {
        postStep += 1
        this.patch(model.id, {
          detail: `Installing language resources (${postStep}/${model.postInstall!.length})`,
          setupProgress: 0.55 + (postStep / model.postInstall!.length) * 0.15,
        })
        await runProcess([envPython(envDir), ...command], {
          signal,
          logPath: this.logPath(model.id),
          env: {
            PATH: [dirname(envPython(envDir)), dirname(uv), Bun.env.PATH ?? ""].join(
              process.platform === "win32" ? ";" : ":",
            ),
            VIRTUAL_ENV: envDir,
            NLTK_DATA: join(this.assetDir(model.id), "nltk"),
          },
          onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
        })
      }

      this.patch(model.id, {
        phase: "download",
        detail: "Downloading model files",
        setupProgress: 0.75,
        downloadedBytes: 0,
      })
      await this.appendLog(model.id, `[app] Downloading ${model.assets.length} pinned model assets`)
      let lastDownloadUpdate = 0
      await downloadAssets(
        model.assets,
        this.assetDir(model.id),
        ({ asset, completedBytes, totalBytes }) => {
          const now = Date.now()
          if (completedBytes < totalBytes && now - lastDownloadUpdate < 50) return
          lastDownloadUpdate = now
          this.patch(model.id, {
            detail: `Downloading ${asset.path}`,
            downloadedBytes: completedBytes,
            totalBytes,
          })
        },
        signal,
      )
      await this.appendLog(model.id, "[app] Model asset download and verification complete")

      this.patch(model.id, { phase: "verify", detail: "Checking runtime imports", setupProgress: 0.95 })
      await runProcess(
        [
          envPython(envDir),
          "-u",
          join(PROJECT_ROOT, "src", "python", "infer.py"),
          "--model",
          model.id,
          "--assets",
          this.assetDir(model.id),
          "--check",
        ],
        {
          signal,
          logPath: this.logPath(model.id),
          env: {
            HF_HOME: join(APP_HOME, "hf-cache", model.id),
            NLTK_DATA: join(this.assetDir(model.id), "nltk"),
            PYTORCH_ENABLE_MPS_FALLBACK: "1",
          },
          onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
        },
      )

      if (this.states[model.id].runtimeId !== runtimeId) return

      await Bun.write(this.markerPath(model.id), JSON.stringify({ version: model.setupVersion }, null, 2))
      this.patch(model.id, {
        installed: true,
        phase: "ready",
        detail: "Ready",
        setupProgress: 1,
        downloadedBytes: model.assets.reduce((sum, asset) => sum + asset.size, 0),
      })
    } catch (error) {
      if (signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      await this.appendLog(model.id, `[app:error] ${message}`)
      this.patch(model.id, { phase: "error", detail: message, error: message })
      throw error
    }
  }

  private async ensureUv(id: ModelId): Promise<string> {
    if (this.uvInstall) return this.uvInstall
    this.uvInstall = this.installUv(id).catch((error) => {
      this.uvInstall = undefined
      throw error
    })
    return this.uvInstall
  }

  private async installUv(id: ModelId): Promise<string> {
    const uvDir = join(APP_HOME, "tools", "uv")
    const uv = envExecutable(uvDir, "uv")
    if (await exists(uv)) return uv
    await mkdir(dirname(uvDir), { recursive: true })
    const systemPython = (await commandExists("python3")) ? "python3" : (await commandExists("python")) ? "python" : null
    if (!systemPython) throw new Error("Python 3 is required once to bootstrap the local uv installer")
    this.patch(id, { detail: "Creating local uv bootstrap", setupProgress: 0.05 })
    await runProcess([systemPython, "-m", "venv", uvDir], {
      signal: this.controller.signal,
      logPath: this.logPath(id),
    })
    this.patch(id, { detail: `Installing uv ${UV_VERSION}`, setupProgress: 0.08 })
    await runProcess([envPython(uvDir), "-m", "pip", "install", `uv==${UV_VERSION}`], {
      signal: this.controller.signal,
      logPath: this.logPath(id),
      onLine: (line) => this.patch(id, { detail: line.slice(0, 120) }),
    })
    return uv
  }

  private markReady(id: ModelId): void {
    const totalBytes = MODEL_BY_ID[id].assets.reduce((sum, asset) => sum + asset.size, 0)
    this.patch(id, {
      installed: true,
      phase: "ready",
      detail: "Ready",
      setupProgress: 1,
      downloadedBytes: totalBytes,
      totalBytes,
    })
  }

  private async getWorker(
    id: ModelId,
  ): Promise<{ id: ModelId; runtimeId: string; worker: RuntimeWorker; loadMs: number }> {
    const runtime = this.runtime(id)
    if (this.activeWorker?.id === id && this.activeWorker.runtimeId === runtime.id) return this.activeWorker
    if (this.activeWorker) {
      const previous = this.activeWorker
      this.activeWorker = undefined
      this.patch(previous.id, { resident: false })
      await previous.worker.stop()
    }

    if (runtime.kind === "javascript") {
      if (id !== "kokoro" || !runtime.dtype || !runtime.modelBytes) {
        throw new Error(`JavaScript runtime is not configured for ${MODEL_BY_ID[id].name}`)
      }
      const started = await KokoroJsWorker.start({
        dtype: runtime.dtype,
        cacheDir: this.javascriptCacheDir(id),
        modelBytes: runtime.modelBytes,
        signal: this.controller.signal,
        onStatus: (event) => this.handleWorkerEvent(id, event),
      })
      this.activeWorker = { id, runtimeId: runtime.id, worker: started.worker, loadMs: started.loadMs }
      this.patch(id, {
        resident: true,
        downloadedBytes: runtime.modelBytes,
        totalBytes: runtime.modelBytes,
      })
      return this.activeWorker
    }

    let instance: TtsWorker | undefined
    const worker = await TtsWorker.spawn({
      command: [
        envPython(this.envDir(id)),
        "-u",
        join(PROJECT_ROOT, "src", "python", "infer.py"),
        "--model",
        id,
        "--assets",
        this.assetDir(id),
        "--serve",
      ],
      env: {
        HF_HOME: join(APP_HOME, "hf-cache", id),
        NLTK_DATA: join(this.assetDir(id), "nltk"),
        PYTORCH_ENABLE_MPS_FALLBACK: "1",
        TOKENIZERS_PARALLELISM: "false",
      },
      logPath: this.logPath(id),
      onStatus: (event) => this.handleWorkerEvent(id, event),
      onExit: () => {
        if (instance && this.startingWorker === instance) this.startingWorker = undefined
        if (instance && this.activeWorker?.worker === instance) {
          this.activeWorker = undefined
          this.patch(id, { resident: false })
        }
      },
    })
    instance = worker
    this.startingWorker = worker
    let loadMs: number
    try {
      loadMs = await worker.ready
    } catch (error) {
      await worker.stop()
      throw error
    } finally {
      if (this.startingWorker === worker) this.startingWorker = undefined
    }
    if (this.controller.signal.aborted) {
      await worker.stop()
      throw new DOMException("The operation was aborted", "AbortError")
    }
    this.activeWorker = { id, runtimeId: runtime.id, worker, loadMs }
    this.patch(id, { resident: true })
    return this.activeWorker
  }

  private handleWorkerEvent(id: ModelId, event: WorkerStatusEvent): void {
    if (event.type === "status" && event.detail) this.patch(id, { detail: event.detail })
    if (event.type === "progress") {
      this.patch(id, {
        detail: event.detail ?? this.states[id].detail,
        generationProgress: event.progress ?? null,
        downloadedBytes: event.downloadedBytes ?? this.states[id].downloadedBytes,
        totalBytes: event.totalBytes ?? this.states[id].totalBytes,
      })
    }
  }

  private async isPythonInstalled(model: ModelDefinition): Promise<boolean> {
    try {
      const marker = JSON.parse(await readFile(this.markerPath(model.id), "utf8")) as { version?: string }
      if (marker.version !== model.setupVersion || !(await exists(envPython(this.envDir(model.id))))) return false
      for (const asset of model.assets) {
        if ((await stat(join(this.assetDir(model.id), asset.path))).size !== asset.size) return false
      }
      return true
    } catch {
      return false
    }
  }

  private async ensureVoice(id: ModelId, voiceId: string): Promise<void> {
    const model = MODEL_BY_ID[id]
    const voice = model.voices.find((candidate) => candidate.id === voiceId)
    if (!voice) throw new Error(`Unknown ${model.name} voice: ${voiceId}`)
    if (this.runtime(id).kind === "javascript") return
    if (!voice.assets?.length || (await this.assetsExist(id, voice.assets))) return

    const key = `${id}:${voiceId}`
    const active = this.voiceDownloads.get(key)
    if (active) return active.promise
    const runtimeId = this.states[id].runtimeId
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.controller.signal.addEventListener("abort", abort, { once: true })
    const operation = (async () => {
      this.patch(id, {
        phase: "download",
        detail: `Downloading voice: ${voice.name}`,
        downloadedBytes: 0,
        totalBytes: voice.assets!.reduce((sum, asset) => sum + asset.size, 0),
      })
      await this.appendLog(id, `[app] Downloading voice ${voice.id}`)
      await downloadAssets(
        voice.assets!,
        this.assetDir(id),
        ({ asset, completedBytes, totalBytes }) => {
          if (this.states[id].voiceId !== voiceId || this.states[id].runtimeId !== runtimeId) return
          this.patch(id, {
            detail: `Downloading voice ${voice.name}: ${asset.path}`,
            downloadedBytes: completedBytes,
            totalBytes,
          })
        },
        controller.signal,
      )
      await this.appendLog(id, `[app] Voice ready: ${voice.id}`)
      if (this.states[id].voiceId === voiceId && this.states[id].runtimeId === runtimeId) this.markReady(id)
    })().finally(() => {
      this.controller.signal.removeEventListener("abort", abort)
      this.voiceDownloads.delete(key)
    })
    this.voiceDownloads.set(key, { promise: operation, controller })
    return operation
  }

  private async assetsExist(id: ModelId, assets: readonly { path: string; size: number }[]): Promise<boolean> {
    try {
      for (const asset of assets) {
        if ((await stat(join(this.assetDir(id), asset.path))).size !== asset.size) return false
      }
      return true
    } catch {
      return false
    }
  }

  private patch(id: ModelId, update: Partial<ModelState>): void {
    this.states[id] = { ...this.states[id], ...update }
    for (const listener of this.listeners) listener({ ...this.states[id] })
  }

  private modelDir(id: ModelId): string {
    return join(APP_HOME, "models", id)
  }

  private envDir(id: ModelId): string {
    return join(this.modelDir(id), "venv")
  }

  private assetDir(id: ModelId): string {
    return join(this.modelDir(id), "assets")
  }

  private markerPath(id: ModelId): string {
    return join(this.modelDir(id), "installed.json")
  }

  private javascriptCacheDir(id: ModelId): string {
    return join(this.modelDir(id), "javascript-cache")
  }

  private settingsPath(): string {
    return join(APP_HOME, "settings.json")
  }

  private logPath(id: ModelId): string {
    return join(APP_HOME, "logs", `${id}.log`)
  }

  private async appendLog(id: ModelId, message: string): Promise<void> {
    try {
      const path = this.logPath(id)
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `[${new Date().toISOString()}] ${message}\n`)
    } catch {
      // Logging must never hide the setup or inference error it is recording.
    }
  }
}
