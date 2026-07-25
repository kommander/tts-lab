import { randomUUID } from "node:crypto"
import { constants, readFileSync } from "node:fs"
import { appendFile, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { release } from "node:os"
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
const DEFAULT_RESOURCE_POLL_MS = 4000
const FLUIDAUDIO_BUILD_VERSION = "0.15.5-v2"
const FLUIDAUDIO_PACKAGE = join(PROJECT_ROOT, "native", "fluidaudio-sidecar")

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(2)}s`
}

export function summarizeGenerationTimes(samples: readonly number[]) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
  return {
    sampleCount: samples.length,
    averageGenerationMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    medianGenerationMs: median,
    minGenerationMs: sorted[0]!,
    maxGenerationMs: sorted.at(-1)!,
  }
}

export function resolveResourcePollMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_RESOURCE_POLL_MS
  const milliseconds = Number(value)
  if (!Number.isFinite(milliseconds) || !Number.isInteger(milliseconds) || milliseconds < 0) {
    return DEFAULT_RESOURCE_POLL_MS
  }
  if (milliseconds === 0) return 0
  return Math.max(250, milliseconds)
}

export function supportsNativeCoreMl(platform: NodeJS.Platform, arch: string, kernelRelease: string): boolean {
  const darwinMajor = Number.parseInt(kernelRelease.split(".")[0] ?? "", 10)
  return platform === "darwin" && arch === "arm64" && Number.isFinite(darwinMajor) && darwinMajor >= 23
}

export function supportsRuntimePlatform(
  runtime: RuntimeProfile,
  platform: NodeJS.Platform,
  arch: string,
  kernelRelease: string,
): boolean {
  if (platform !== "darwin") return true
  const darwinMajor = Number.parseInt(kernelRelease.split(".")[0] ?? "", 10)
  return (!runtime.darwinArch || runtime.darwinArch === arch)
    && (!runtime.minimumDarwinMajor || darwinMajor >= runtime.minimumDarwinMajor)
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

const freshState = (id: ModelId): ModelState => {
  const model = MODEL_BY_ID[id]
  const runtime = model.runtimes.find((candidate) => candidate.id === model.defaultRuntimeId) ?? model.runtimes[0]!
  const assets = runtime.assets ?? model.assets
  return {
    id,
    voiceId: model.defaultVoiceId,
    runtimeId: model.defaultRuntimeId,
    installed: false,
    phase: "idle",
    detail: "Not installed",
    setupProgress: 0,
    downloadedBytes: 0,
    totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
    generationProgress: 0,
    resident: false,
  }
}

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
  private readonly installs = new Map<
    ModelId,
    { runtimeId: string; promise: Promise<void>; controller: AbortController }
  >()
  private readonly voiceDownloads = new Map<string, { promise: Promise<void>; controller: AbortController }>()
  private readonly audio = new AudioPlayer()
  private controller = new AbortController()
  private uvInstall?: Promise<string>
  private nativeBuild?: { promise: Promise<string>; controller: AbortController; users: Set<ModelId> }
  private synthesis?: Promise<void>
  private activeAudioModel?: ModelId
  private activeWorker?: { id: ModelId; runtimeId: string; worker: RuntimeWorker; loadMs: number }
  private startingWorker?: RuntimeWorker
  private latestAudio?: LatestAudio & { path: string }
  private readonly generationHistory = new Map<string, number[]>()
  private readonly runtimeChangeVersions = new Map<ModelId, number>()
  private readonly voiceChangeVersions = new Map<ModelId, number>()
  private readonly resourceTimer?: ReturnType<typeof setInterval>

  constructor() {
    this.audio.onError((message) => {
      if (this.activeAudioModel) {
        void this.appendLog(this.activeAudioModel, `[audio:error] ${message}`)
        this.patch(this.activeAudioModel, { phase: "error", detail: message, error: message })
      }
    })
    this.loadRuntimeSettings()
    void this.refresh().catch(() => undefined)
    const resourcePollMs = resolveResourcePollMs(Bun.env.TTS_LAB_RESOURCE_POLL_MS)
    if (resourcePollMs > 0) {
      this.resourceTimer = setInterval(() => this.refreshResourceUsage(), resourcePollMs)
      this.resourceTimer.unref?.()
    }
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
    if (!supportsRuntimePlatform(runtime, process.platform, process.arch, release())) {
      const message = `${MODEL_BY_ID[id].name} requires macOS 14 or newer on Apple Silicon`
      this.patch(id, { installed: false, phase: "error", detail: message, error: message })
      throw new Error(message)
    }
    if (runtime.kind === "javascript") {
      await this.ensureJavascriptRuntime(id, runtime)
      return
    }
    const active = this.installs.get(id)
    if (active?.runtimeId === runtime.id) return active.promise
    if (active) {
      active.controller.abort()
      await active.promise.catch(() => undefined)
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.controller.signal.addEventListener("abort", abort, { once: true })
    const promise = this.prepareRuntime(id, runtime, controller.signal).finally(() => {
      this.controller.signal.removeEventListener("abort", abort)
      if (this.installs.get(id)?.promise === promise) this.installs.delete(id)
    })
    this.installs.set(id, { runtimeId: runtime.id, promise, controller })
    return promise
  }

  private async prepareRuntime(id: ModelId, runtime: RuntimeProfile, signal: AbortSignal): Promise<void> {
    if (runtime.kind === "native") {
      await this.ensureNativeRuntime(id, runtime, signal)
      return
    }
    const model = MODEL_BY_ID[id]
    const installed = await this.isPythonInstalled(model)
    signal.throwIfAborted()
    if (installed) {
      if (this.states[id].runtimeId === runtime.id) this.markReady(id)
      return
    }
    await this.install(model, runtime.id, signal)
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
    const runtime = this.runtime(id)
    if (runtime.voiceIds && !runtime.voiceIds.includes(voiceId)) {
      throw new Error(`${runtime.name} does not support ${voice.name}`)
    }
    const changeVersion = (this.voiceChangeVersions.get(id) ?? 0) + 1
    this.voiceChangeVersions.set(id, changeVersion)
    const isCurrentChange = () => this.voiceChangeVersions.get(id) === changeVersion
    if (["generating", "playing"].includes(this.states[id].phase)) {
      throw new Error(`Wait for the current ${model.name} synthesis to finish before changing voices`)
    }
    const obsoleteDownloads = [...this.voiceDownloads.entries()].filter(
      ([key]) => key.startsWith(`${id}:`) && key !== `${id}:${voiceId}`,
    )
    for (const [, download] of obsoleteDownloads) download.controller.abort()
    await Promise.allSettled(obsoleteDownloads.map(([, download]) => download.promise))
    if (!isCurrentChange()) return
    this.patch(id, { voiceId, lastLatency: undefined, error: undefined })
    try {
      await this.ensure(id)
      if (!isCurrentChange()) return
      await this.ensureVoice(id, voiceId)
      if (isCurrentChange() && this.states[id].voiceId === voiceId) {
        this.patch(id, { phase: "ready", detail: `Voice ready: ${voice.name}` })
      }
    } catch (error) {
      if (!isCurrentChange()) return
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
    const changeVersion = (this.runtimeChangeVersions.get(id) ?? 0) + 1
    this.runtimeChangeVersions.set(id, changeVersion)
    const isCurrentChange = () => this.runtimeChangeVersions.get(id) === changeVersion
    if (this.states[id].runtimeId === runtimeId) {
      const interruptedSetup = this.installs.get(id)
      if (interruptedSetup?.controller.signal.aborted) {
        await interruptedSetup.promise.catch(() => undefined)
        if (isCurrentChange()) await this.ensure(id)
      }
      return
    }
    if (["generating", "playing"].includes(this.states[id].phase)) {
      throw new Error(`Wait for the current ${model.name} synthesis to finish before changing runtime`)
    }
    const activeInstall = this.installs.get(id)
    if (activeInstall) {
      activeInstall.controller.abort()
      await activeInstall.promise.catch(() => undefined)
      if (!isCurrentChange()) return
    }
    const activeVoiceDownloads = [...this.voiceDownloads.entries()].filter(([key]) => key.startsWith(`${id}:`))
    for (const [, download] of activeVoiceDownloads) download.controller.abort()
    await Promise.allSettled(activeVoiceDownloads.map(([, download]) => download.promise))
    if (!isCurrentChange()) return
    if (this.activeWorker?.id === id) {
      const active = this.activeWorker
      this.activeWorker = undefined
      await active.worker.stop()
      if (!isCurrentChange()) return
    }
    const voiceId = runtime.voiceIds?.includes(this.states[id].voiceId)
      ? this.states[id].voiceId
      : runtime.voiceIds?.[0] ?? this.states[id].voiceId
    this.patch(id, {
      runtimeId,
      voiceId,
      installed: false,
      resident: false,
      phase: "idle",
      detail: `Runtime selected: ${runtime.name}`,
      lastLatency: undefined,
      runtimeStats: undefined,
      error: undefined,
    })
    await this.saveRuntimeSettings()
    if (!isCurrentChange()) return
    await this.ensure(id)
    if (isCurrentChange() && this.states[id].runtimeId === runtimeId) this.restoreRuntimeStats(id, runtimeId)
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
      this.recordGeneration(id, runtimeId, result.generationMs, worker.worker)
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
    if (this.resourceTimer) clearInterval(this.resourceTimer)
    for (const install of this.installs.values()) install.controller.abort()
    this.nativeBuild?.controller.abort()
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
      } else if (runtime.kind === "native") {
        const assets = runtime.assets ?? []
        const installed = await exists(this.nativeBinaryPath())
          && (assets.length === 0 || await this.assetsExist(model.id, assets))
        if (installed && this.states[model.id].runtimeId === runtime.id) this.markReady(model.id)
      } else if (await this.isPythonInstalled(model) && this.states[model.id].runtimeId === runtime.id) {
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

  private async ensureNativeRuntime(id: ModelId, runtime: RuntimeProfile, signal: AbortSignal): Promise<void> {
    if (!runtime.nativeBackend) {
      throw new Error(`Native runtime is not configured for ${MODEL_BY_ID[id].name}`)
    }
    if (!supportsNativeCoreMl(process.platform, process.arch, release())) {
      const message = `${MODEL_BY_ID[id].name} CoreML ANE requires macOS 14 or newer on Apple Silicon`
      if (this.states[id].runtimeId === runtime.id) {
        this.patch(id, { installed: false, phase: "error", detail: message, error: message })
      }
      throw new Error(message)
    }
    const assets = runtime.assets ?? []
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
    const [binaryReady, assetsReady] = await Promise.all([
      exists(this.nativeBinaryPath()),
      assets.length === 0 ? true : this.assetsExist(id, assets),
    ])
    if (binaryReady && assetsReady) {
      if (this.states[id].runtimeId === runtime.id) {
        this.patch(id, {
          installed: true,
          phase: "ready",
          detail: runtime.nativeBackend === "pocket" ? "Ready" : "Ready; CoreML models download on first use",
          setupProgress: 1,
          downloadedBytes: totalBytes,
          totalBytes,
          error: undefined,
        })
      }
      return
    }

    this.patch(id, {
      installed: false,
      phase: assetsReady ? "setup" : "download",
      detail: binaryReady ? "Downloading pinned CoreML assets" : "Building pinned FluidAudio CoreML sidecar",
      setupProgress: null,
      downloadedBytes: 0,
      totalBytes,
      error: undefined,
    })
    let build = binaryReady ? undefined : this.nativeBuild
    while (build?.controller.signal.aborted) {
      await build.promise.catch(() => undefined)
      if (this.nativeBuild === build) this.nativeBuild = undefined
      build = this.nativeBuild
    }
    if (!binaryReady && !build) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      this.controller.signal.addEventListener("abort", abort, { once: true })
      const users = new Set<ModelId>([id])
      const promise = this.buildNativeRuntime(id, controller.signal).finally(() => {
        this.controller.signal.removeEventListener("abort", abort)
        if (this.nativeBuild?.promise === promise) this.nativeBuild = undefined
      })
      build = { promise, controller, users }
      this.nativeBuild = build
    } else {
      build?.users.add(id)
    }
    try {
      const download = assetsReady
        ? Promise.resolve()
        : downloadAssets(
            assets,
            this.assetDir(id),
            ({ asset, completedBytes, totalBytes: downloadTotal }) => {
              if (this.states[id].runtimeId !== runtime.id) return
              this.patch(id, {
                phase: "download",
                detail: `Downloading ${asset.path}`,
                downloadedBytes: completedBytes,
                totalBytes: downloadTotal,
              })
            },
            signal,
          )
      const setup = Promise.all([build?.promise, download])
      signal.throwIfAborted()
      let abortSetup: (() => void) | undefined
      const aborted = new Promise<never>((_, reject) => {
        abortSetup = () => reject(new DOMException("The operation was aborted", "AbortError"))
        signal.addEventListener("abort", abortSetup, { once: true })
      })
      try {
        await Promise.race([setup, aborted])
      } finally {
        if (abortSetup) signal.removeEventListener("abort", abortSetup)
      }
      if (this.states[id].runtimeId === runtime.id) {
        this.patch(id, {
          installed: true,
          phase: "ready",
          detail: runtime.nativeBackend === "pocket" ? "Ready" : "Ready; CoreML models download on first use",
          setupProgress: 1,
          downloadedBytes: totalBytes,
          totalBytes,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.states[id].runtimeId === runtime.id) {
        this.patch(id, { phase: "error", detail: message, error: message })
      }
      throw error
    } finally {
      if (build) {
        build.users.delete(id)
        if (build.users.size === 0 && this.nativeBuild === build) build.controller.abort()
      }
    }
  }

  private async buildNativeRuntime(id: ModelId, signal: AbortSignal): Promise<string> {
    if (!(await commandExists("swift", ["--version"]))) {
      throw new Error("The CoreML ANE runtime requires Swift 6 and the Xcode command-line tools")
    }
    const scratch = this.nativeBuildDir()
    await mkdir(scratch, { recursive: true })
    await runProcess(
      [
        "swift",
        "build",
        "--package-path",
        FLUIDAUDIO_PACKAGE,
        "--scratch-path",
        scratch,
        "-c",
        "release",
        "--product",
        "tts-lab-fluidaudio",
      ],
      {
        signal,
        logPath: this.logPath(id),
        onLine: (line) => {
          if (this.runtime(id).kind === "native") {
            this.patch(id, { detail: line.slice(0, 120) })
          }
        },
      },
    )
    const binary = this.nativeBinaryPath()
    if (!(await exists(binary))) throw new Error("Swift completed without producing the FluidAudio sidecar")
    return binary
  }

  private async install(model: ModelDefinition, runtimeId: string, signal: AbortSignal): Promise<void> {
    const python = model.python
    const packages = model.packages
    if (!python || !packages) throw new Error(`${model.name} does not define a Python runtime`)
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

      this.patch(model.id, { phase: "setup", detail: `Installing Python ${python}`, setupProgress: 0.1 })
      await runProcess([uv, "python", "install", python], {
        signal,
        logPath: this.logPath(model.id),
        onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
      })

      const envDir = this.envDir(model.id)
      await rm(envDir, { recursive: true, force: true })
      await runProcess([uv, "venv", "--python", python, envDir], {
        signal,
        logPath: this.logPath(model.id),
        onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
      })

      this.patch(model.id, { detail: `Installing ${model.name} runtime`, setupProgress: 0.25 })
      await runProcess([uv, "pip", "install", "--python", envPython(envDir), ...packages], {
        signal,
        logPath: this.logPath(model.id),
        env: { UV_LINK_MODE: "copy", GIT_LFS_SKIP_SMUDGE: "1" },
        onLine: (line) => this.patch(model.id, { detail: line.slice(0, 120) }),
      })
      if (model.packagesNoDeps?.length) {
        const buildFlags = model.noBuildIsolation ? ["--no-build-isolation"] : []
        await runProcess(
          [
            uv,
            "pip",
            "install",
            "--no-deps",
            ...buildFlags,
            "--python",
            envPython(envDir),
            ...model.packagesNoDeps,
          ],
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
    const model = MODEL_BY_ID[id]
    const runtime = this.runtime(id)
    const assets = runtime.kind === "native" ? runtime.assets ?? [] : model.assets
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
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
      this.clearWorkerRss(previous.id)
      await previous.worker.stop()
    }

    if (runtime.kind === "javascript") {
      if (id !== "kokoro" || !runtime.dtype || !runtime.device || !runtime.modelBytes) {
        throw new Error(`JavaScript runtime is not configured for ${MODEL_BY_ID[id].name}`)
      }
      const started = await KokoroJsWorker.start({
        dtype: runtime.dtype,
        device: runtime.device,
        lowMemory: runtime.lowMemory,
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
      this.refreshResourceUsage()
      return this.activeWorker
    }

    let command: string[]
    let env: Record<string, string | undefined>
    if (runtime.kind === "native") {
      if (!runtime.nativeBackend) throw new Error(`Native runtime is not configured for ${MODEL_BY_ID[id].name}`)
      const nativeHome = join(APP_HOME, "native-home")
      await mkdir(nativeHome, { recursive: true })
      command = [
        this.nativeBinaryPath(),
        "--backend",
        runtime.nativeBackend,
        "--assets",
        this.assetDir(id),
      ]
      env = {
        CFFIXED_USER_HOME: nativeHome,
        HOME: nativeHome,
      }
    } else {
      command = [
        envPython(this.envDir(id)),
        "-u",
        join(PROJECT_ROOT, "src", "python", "infer.py"),
        "--model",
        id,
        "--assets",
        this.assetDir(id),
        "--serve",
      ]
      env = {
        HF_HOME: join(APP_HOME, "hf-cache", id),
        NLTK_DATA: join(this.assetDir(id), "nltk"),
        PYTORCH_ENABLE_MPS_FALLBACK: "1",
        TOKENIZERS_PARALLELISM: "false",
      }
    }

    let instance: TtsWorker | undefined
    const worker = await TtsWorker.spawn({
      command,
      env,
      logPath: this.logPath(id),
      onStatus: (event) => this.handleWorkerEvent(id, event),
      onExit: () => {
        if (instance && this.startingWorker === instance) this.startingWorker = undefined
        if (instance && this.activeWorker?.worker === instance) {
          this.activeWorker = undefined
          this.clearWorkerRss(id)
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
    this.refreshResourceUsage()
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

  private recordGeneration(id: ModelId, runtimeId: string, generationMs: number, worker: RuntimeWorker): void {
    const key = `${id}:${runtimeId}`
    const history = this.generationHistory.get(key) ?? []
    history.push(generationMs)
    this.generationHistory.set(key, history)
    const summary = summarizeGenerationTimes(history)
    if (!summary) return
    const appMemory = process.memoryUsage()
    const workerMemory = worker.getResourceUsage()
    this.patch(id, {
      runtimeStats: {
        ...summary,
        appRssBytes: appMemory.rss,
        appHeapUsedBytes: appMemory.heapUsed,
        workerRssBytes: workerMemory.rssBytes,
        workerPeakRssBytes: workerMemory.peakRssBytes,
      },
    })
  }

  private refreshResourceUsage(): void {
    const active = this.activeWorker
    if (!active || this.states[active.id].runtimeId !== active.runtimeId) return
    const appMemory = process.memoryUsage()
    const workerMemory = active.worker.getResourceUsage()
    const current = this.states[active.id].runtimeStats
    const historySummary = summarizeGenerationTimes(this.generationHistory.get(`${active.id}:${active.runtimeId}`) ?? [])
    this.patch(active.id, {
      runtimeStats: {
        sampleCount: historySummary?.sampleCount ?? current?.sampleCount ?? 0,
        averageGenerationMs: historySummary?.averageGenerationMs ?? current?.averageGenerationMs ?? 0,
        medianGenerationMs: historySummary?.medianGenerationMs ?? current?.medianGenerationMs ?? 0,
        minGenerationMs: historySummary?.minGenerationMs ?? current?.minGenerationMs ?? 0,
        maxGenerationMs: historySummary?.maxGenerationMs ?? current?.maxGenerationMs ?? 0,
        appRssBytes: appMemory.rss,
        appHeapUsedBytes: appMemory.heapUsed,
        workerRssBytes: workerMemory.rssBytes,
        workerPeakRssBytes: workerMemory.peakRssBytes,
      },
    })
  }

  private restoreRuntimeStats(id: ModelId, runtimeId: string): void {
    const summary = summarizeGenerationTimes(this.generationHistory.get(`${id}:${runtimeId}`) ?? [])
    if (!summary) return
    const appMemory = process.memoryUsage()
    this.patch(id, {
      runtimeStats: {
        ...summary,
        appRssBytes: appMemory.rss,
        appHeapUsedBytes: appMemory.heapUsed,
      },
    })
  }

  private clearWorkerRss(id: ModelId): void {
    const current = this.states[id].runtimeStats
    this.patch(id, {
      resident: false,
      runtimeStats: current ? { ...current, workerRssBytes: undefined } : undefined,
    })
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
    const runtimeId = this.states[id].runtimeId
    if (this.runtime(id).kind === "javascript") return
    if (!voice.assets?.length || (await this.assetsExist(id, voice.assets))) return
    if (this.states[id].voiceId !== voiceId || this.states[id].runtimeId !== runtimeId) return
    if (this.runtime(id).kind === "javascript") return

    const key = `${id}:${voiceId}`
    const active = this.voiceDownloads.get(key)
    if (active && !active.controller.signal.aborted) return active.promise
    if (active) {
      await active.promise.catch(() => undefined)
      const replacement = this.voiceDownloads.get(key)
      if (replacement) return replacement.promise
      if (this.states[id].voiceId !== voiceId || this.states[id].runtimeId !== runtimeId) return
    }
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
      if (this.voiceDownloads.get(key)?.promise === operation) this.voiceDownloads.delete(key)
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

  private nativeBuildDir(): string {
    return join(APP_HOME, "tools", `fluidaudio-${FLUIDAUDIO_BUILD_VERSION}`)
  }

  private nativeBinaryPath(): string {
    return join(this.nativeBuildDir(), "release", "tts-lab-fluidaudio")
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
