import { randomUUID } from "node:crypto"
import { constants, readFileSync } from "node:fs"
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { release, totalmem } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import {
  FluidAudioBuilder,
  createFluidAudioBackendCommand,
  createFluidAudioEnvironment,
  supportsFluidAudio,
} from "kokoro-local-runtime/fluidaudio"
import {
  createKokoro,
  type KokoroEvent,
  type KokoroRuntimeId,
  type KokoroVoiceId,
} from "kokoro-local-runtime"
import {
  NdjsonRuntimeWorker,
  bootstrapUv,
  commandExists,
  downloadAssets,
  runProcess,
  type RuntimeWorker,
  type SynthesisParameters,
  type WorkerStatusEvent,
} from "kokoro-local-runtime/core"
import { AudioPlayer } from "./audio-player.js"
import {
  getDefaultModelSynthesisParameters,
  normalizeModelSynthesisParameters,
  recoverModelSynthesisParameters,
  serializeModelSynthesisParameters,
} from "./synthesis-parameters.js"
import { MODEL_BY_ID, MODELS, type ModelDefinition, type RuntimeProfile } from "../models.js"
import type { DemoController, LatestAudio, ModelId, ModelState } from "../types.js"

const APP_ROOT = resolve(import.meta.dir, "../..")
const WORKSPACE_ROOT = resolve(APP_ROOT, "../..")
const APP_HOME = resolve(Bun.env.TTS_LAB_HOME ?? join(WORKSPACE_ROOT, ".tts-lab"))
const UV_VERSION = "0.11.32"
const DEFAULT_RESOURCE_POLL_MS = 4000
const PYTHON_INFERENCE_SCRIPT = join(APP_ROOT, "src", "python", "infer.py")

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

export function supportsRuntimePlatform(
  runtime: RuntimeProfile,
  platform: NodeJS.Platform,
  arch: string,
  kernelRelease: string,
  totalMemoryBytes: number = totalmem(),
): boolean {
  if (runtime.platforms && !runtime.platforms.includes(platform)) return false
  if (runtime.minimumMemoryBytes && totalMemoryBytes < runtime.minimumMemoryBytes) return false
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

export function getSynthesisConfigurationKey(
  id: ModelId,
  runtimeId: string,
  voiceId: string,
  parameters: SynthesisParameters,
): string {
  return JSON.stringify([id, runtimeId, voiceId, serializeModelSynthesisParameters(id, parameters, runtimeId)])
}

type PersistedSynthesisParameters = Record<string, Record<string, SynthesisParameters>>

interface SettingsV2 {
  version: 2
  runtimes: Record<string, string>
  synthesisParameters: PersistedSynthesisParameters
}

function defaultPersistedSynthesisParameters(): PersistedSynthesisParameters {
  return Object.fromEntries(MODELS.map((model) => [
    model.id,
    Object.fromEntries(model.runtimes.map((runtime) => [
      runtime.id,
      getDefaultModelSynthesisParameters(model.id, runtime.id),
    ])),
  ]))
}

const freshState = (id: ModelId): ModelState => {
  const model = MODEL_BY_ID[id]
  const runtime = model.runtimes.find((candidate) => candidate.id === model.defaultRuntimeId) ?? model.runtimes[0]!
  const assets = runtime.assets ?? model.assets
  return {
    id,
    voiceId: model.defaultVoiceId,
    runtimeId: model.defaultRuntimeId,
    synthesisParameters: getDefaultModelSynthesisParameters(id, model.defaultRuntimeId),
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
  private readonly fluidAudioBuilder = new FluidAudioBuilder(APP_HOME)
  private readonly kokoro = createKokoro({ homeDir: APP_HOME })
  private readonly installs = new Map<
    ModelId,
    { runtimeId: string; promise: Promise<void>; controller: AbortController }
  >()
  private readonly voiceDownloads = new Map<string, { promise: Promise<void>; controller: AbortController }>()
  private readonly audio = new AudioPlayer()
  private controller = new AbortController()
  private nativeBuild?: { promise: Promise<string>; controller: AbortController; users: Set<ModelId> }
  private synthesis?: Promise<void>
  private activeAudioModel?: ModelId
  private activeWorker?: { id: ModelId; runtimeId: string; worker: RuntimeWorker; loadMs: number }
  private startingWorker?: RuntimeWorker
  private latestAudio?: LatestAudio & { path: string }
  private readonly generationHistory = new Map<string, number[]>()
  private readonly persistedSynthesisParameters = defaultPersistedSynthesisParameters()
  private readonly runtimeChangeVersions = new Map<ModelId, number>()
  private readonly voiceChangeVersions = new Map<ModelId, number>()
  private readonly configurationTails = new Map<ModelId, Promise<void>>()
  private readonly resourceTimer?: ReturnType<typeof setInterval>
  private persistedMutationTail: Promise<void> = Promise.resolve()
  private settingsWrites: Promise<void> = Promise.resolve()
  private readonly refreshOperation: Promise<void>
  private disposed = false
  private disposal?: Promise<void>

  constructor() {
    this.audio.onError((message) => {
      if (this.activeAudioModel) {
        void this.appendLog(this.activeAudioModel, `[audio:error] ${message}`)
        this.patch(this.activeAudioModel, { phase: "error", detail: message, error: message })
      }
    })
    this.loadRuntimeSettings()
    this.refreshOperation = this.refresh().catch(() => undefined)
    const resourcePollMs = resolveResourcePollMs(Bun.env.TTS_LAB_RESOURCE_POLL_MS)
    if (resourcePollMs > 0) {
      this.resourceTimer = setInterval(() => this.refreshResourceUsage(), resourcePollMs)
      this.resourceTimer.unref?.()
    }
  }

  snapshot(): Record<ModelId, ModelState> {
    return Object.fromEntries(MODELS.map(({ id }) => [id, {
      ...this.states[id],
      synthesisParameters: { ...this.states[id].synthesisParameters },
    }])) as Record<ModelId, ModelState>
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
    this.throwIfDisposed()
    if (!this.latestAudio) throw new Error("Generate audio before saving it")
    return copyAudioExport(this.latestAudio.path, path, this.latestAudio.format)
  }

  async ensure(id: ModelId): Promise<void> {
    this.throwIfDisposed()
    const runtime = this.runtime(id)
    if (!supportsRuntimePlatform(runtime, process.platform, process.arch, release())) {
      const message = `${MODEL_BY_ID[id].name} requires ${runtime.platformDescription ?? "macOS 14 or newer on Apple Silicon"}`
      this.patch(id, { installed: false, phase: "error", detail: message, error: message })
      throw new Error(message)
    }
    if (runtime.kind === "javascript" && id !== "kokoro") throw new Error(`JavaScript runtime is not configured for ${MODEL_BY_ID[id].name}`)
    const active = this.installs.get(id)
    if (active?.runtimeId === runtime.id) return active.promise
    if (active) {
      active.controller.abort()
      await active.promise.catch(() => undefined)
      this.throwIfDisposed()
    }
    const controller = new AbortController()
    const unlink = this.linkController(controller)
    const promise = this.prepareRuntime(id, runtime, controller.signal).finally(() => {
      unlink()
      if (this.installs.get(id)?.promise === promise) this.installs.delete(id)
    })
    this.installs.set(id, { runtimeId: runtime.id, promise, controller })
    return promise
  }

  private async prepareRuntime(id: ModelId, runtime: RuntimeProfile, signal: AbortSignal): Promise<void> {
    if (id === "kokoro") {
      try {
        const result = await this.kokoro.prepare(runtime.id as KokoroRuntimeId, {
          signal,
          onEvent: (event) => this.handleKokoroEvent(event),
        })
        if (this.states.kokoro.runtimeId !== runtime.id) return
        this.patch("kokoro", {
          installed: result.ready,
          phase: result.ready ? "ready" : "idle",
          detail: result.detail,
          setupProgress: result.ready ? 1 : 0,
          downloadedBytes: result.downloadedBytes,
          totalBytes: result.totalBytes,
          error: undefined,
        })
      } catch (error) {
        if (signal.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (this.states.kokoro.runtimeId === runtime.id) {
          this.patch("kokoro", { installed: false, phase: "error", detail: message, error: message })
        }
        throw error
      }
      return
    }
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
    this.throwIfDisposed()
    if (this.states[id].phase !== "error") return
    this.patch(id, { phase: "idle", detail: "Retrying", error: undefined })
    await this.ensure(id)
  }

  setVoice(id: ModelId, voiceId: string): Promise<void> {
    const changeVersion = (this.voiceChangeVersions.get(id) ?? 0) + 1
    this.voiceChangeVersions.set(id, changeVersion)
    return this.enqueueConfigurationMutation(id, () => this.changeVoice(id, voiceId, changeVersion))
  }

  private async changeVoice(id: ModelId, voiceId: string, changeVersion: number): Promise<void> {
    const model = MODEL_BY_ID[id]
    const voice = model.voices.find((candidate) => candidate.id === voiceId)
    if (!voice) throw new Error(`Unknown ${model.name} voice: ${voiceId}`)
    const isCurrent = () => this.voiceChangeVersions.get(id) === changeVersion
    if (!isCurrent()) return
    const runtime = this.runtime(id)
    if (runtime.voiceIds && !runtime.voiceIds.includes(voiceId)) {
      throw new Error(`${runtime.name} does not support ${voice.name}`)
    }
    this.assertConfigurationMutable(id, "voices")
    const obsoleteDownloads = [...this.voiceDownloads.entries()].filter(
      ([key]) => key.startsWith(`${id}:`) && key !== `${id}:${voiceId}`,
    )
    for (const [, download] of obsoleteDownloads) download.controller.abort()
    await Promise.allSettled(obsoleteDownloads.map(([, download]) => download.promise))
    if (!isCurrent()) return
    this.assertConfigurationMutable(id, "voices")
    this.patch(id, { voiceId, lastLatency: undefined, runtimeStats: undefined, error: undefined })
    if (!isCurrent()) return
    this.restoreRuntimeStats(id)
    if (!isCurrent()) return
    try {
      await this.ensure(id)
      if (!isCurrent()) return
      this.assertConfigurationMutable(id, "voices")
      await this.ensureVoice(id, voiceId)
      if (!isCurrent()) return
      this.throwIfDisposed()
      if (this.states[id].voiceId === voiceId) {
        this.patch(id, { phase: "ready", detail: `Voice ready: ${voice.name}` })
      }
    } catch (error) {
      if (!isCurrent()) return
      if (this.disposed) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (this.states[id].voiceId === voiceId) {
        this.patch(id, { phase: "error", detail: message, error: message })
      }
      throw error
    }
  }

  setRuntime(id: ModelId, runtimeId: string): Promise<void> {
    const changeVersion = (this.runtimeChangeVersions.get(id) ?? 0) + 1
    this.runtimeChangeVersions.set(id, changeVersion)
    return this.enqueueConfigurationMutation(id, () => this.changeRuntime(id, runtimeId, changeVersion))
  }

  private async changeRuntime(id: ModelId, runtimeId: string, changeVersion: number): Promise<void> {
    const isCurrent = () => this.runtimeChangeVersions.get(id) === changeVersion
    const transition = await this.enqueuePersistedMutation(async () => {
      const model = MODEL_BY_ID[id]
      const runtime = model.runtimes.find((candidate) => candidate.id === runtimeId)
      if (!runtime) throw new Error(`Unknown ${model.name} runtime: ${runtimeId}`)
      if (!isCurrent()) return "stale" as const
      this.assertConfigurationMutable(id, "runtime")
      if (this.states[id].runtimeId === runtimeId) return "unchanged" as const
      const previousState = {
        ...this.states[id],
        synthesisParameters: { ...this.states[id].synthesisParameters },
      }
      let stoppedActiveWorker = false
      try {
        const activeInstall = this.installs.get(id)
        if (activeInstall) {
          activeInstall.controller.abort()
          await activeInstall.promise.catch(() => undefined)
          if (!isCurrent()) return "stale" as const
          this.assertConfigurationMutable(id, "runtime")
        }
        const activeVoiceDownloads = [...this.voiceDownloads.entries()].filter(([key]) => key.startsWith(`${id}:`))
        for (const [, download] of activeVoiceDownloads) download.controller.abort()
        await Promise.allSettled(activeVoiceDownloads.map(([, download]) => download.promise))
        if (!isCurrent()) return "stale" as const
        this.assertConfigurationMutable(id, "runtime")
        if (this.activeWorker?.id === id) {
          const active = this.activeWorker
          await active.worker.stop()
          stoppedActiveWorker = true
          if (this.activeWorker === active) {
            this.activeWorker = undefined
            this.clearWorkerRss(id)
          } else if (this.activeWorker?.id !== id) {
            this.clearWorkerRss(id)
          }
          if (!isCurrent()) return "stale" as const
          this.assertConfigurationMutable(id, "runtime")
        }
        const voiceId = runtime.voiceIds?.includes(this.states[id].voiceId)
          ? this.states[id].voiceId
          : runtime.voiceIds?.[0] ?? this.states[id].voiceId
        const synthesisParameters = {
          ...this.persistedSynthesisParameters[id]![runtimeId]!,
        }
        this.patch(id, {
          runtimeId,
          voiceId,
          synthesisParameters,
          installed: false,
          resident: false,
          phase: "idle",
          detail: `Runtime selected: ${runtime.name}`,
          lastLatency: undefined,
          runtimeStats: undefined,
          error: undefined,
        })
        this.restoreRuntimeStats(id)
        await this.saveSettings()
      } catch (error) {
        const previousWorkerRemains = this.activeWorker?.id === id
          && this.activeWorker.runtimeId === previousState.runtimeId
        this.patch(id, stoppedActiveWorker || (previousState.resident && !previousWorkerRemains) ? {
          ...previousState,
          resident: false,
          runtimeStats: previousState.runtimeStats
            ? { ...previousState.runtimeStats, workerRssBytes: undefined }
            : undefined,
        } : previousState)
        throw error
      }
      return "changed" as const
    })
    if (!isCurrent() || transition === "stale") return
    if (transition === "unchanged") {
      const interruptedSetup = this.installs.get(id)
      if (interruptedSetup?.controller.signal.aborted) {
        await interruptedSetup.promise.catch(() => undefined)
        if (!isCurrent()) return
        this.assertConfigurationMutable(id, "runtime")
        try {
          await this.ensure(id)
        } catch (error) {
          if (!isCurrent()) return
          throw error
        }
        if (!isCurrent()) return
      }
      return
    }
    this.assertConfigurationMutable(id, "runtime")
    try {
      await this.ensure(id)
    } catch (error) {
      if (!isCurrent()) return
      throw error
    }
    if (!isCurrent()) return
    if (this.states[id].runtimeId === runtimeId) this.restoreRuntimeStats(id)
  }

  setSynthesisParameters(
    id: ModelId,
    expectedRuntimeId: string,
    parameters: SynthesisParameters,
  ): Promise<void> {
    return this.enqueueConfigurationMutation(
      id,
      () => this.changeSynthesisParameters(id, expectedRuntimeId, parameters),
    )
  }

  private async changeSynthesisParameters(
    id: ModelId,
    expectedRuntimeId: string,
    parameters: SynthesisParameters,
  ): Promise<void> {
    await this.enqueuePersistedMutation(async () => {
      this.throwIfDisposed()
      const model = MODEL_BY_ID[id]
      if (this.states[id].runtimeId !== expectedRuntimeId) {
        throw new Error(`${model.name} runtime changed before synthesis parameters could be applied`)
      }
      if (this.synthesis || ["generating", "playing"].includes(this.states[id].phase)) {
        throw new Error(`Wait for the current ${model.name} synthesis to finish before changing parameters`)
      }
      const normalized = normalizeModelSynthesisParameters(id, parameters, expectedRuntimeId)
      const previousState = {
        ...this.states[id],
        synthesisParameters: { ...this.states[id].synthesisParameters },
      }
      const previousPersisted = { ...this.persistedSynthesisParameters[id]![expectedRuntimeId]! }
      this.persistedSynthesisParameters[id]![expectedRuntimeId] = { ...normalized }
      this.patch(id, {
        synthesisParameters: { ...normalized },
        lastLatency: undefined,
        runtimeStats: undefined,
        error: undefined,
      })
      this.restoreRuntimeStats(id)
      try {
        await this.saveSettings()
      } catch (error) {
        this.persistedSynthesisParameters[id]![expectedRuntimeId] = previousPersisted
        this.patch(id, previousState)
        throw error
      }
    })
  }

  async speak(id: ModelId, text: string): Promise<void> {
    this.throwIfDisposed()
    if (this.synthesis) throw new Error("Another synthesis is already running")
    if (this.configurationTails.has(id)) {
      throw new Error(`Wait for the current ${MODEL_BY_ID[id].name} configuration change to finish before synthesizing`)
    }
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
    while (true) {
      const { runtimeId, voiceId } = this.states[id]
      await this.ensureVoice(id, voiceId)
      if (this.states[id].runtimeId === runtimeId && this.states[id].voiceId === voiceId) break
    }
    const captured = this.states[id]
    const runtimeId = captured.runtimeId
    const voiceId = captured.voiceId
    const parameters = {
      ...normalizeModelSynthesisParameters(id, captured.synthesisParameters, runtimeId),
    }
    const outputDir = join(APP_HOME, "output")
    const output = join(outputDir, `${id}-${randomUUID()}.wav`)
    const warm = this.activeWorker?.id === id && this.activeWorker.runtimeId === runtimeId

    this.patch(id, {
      phase: "generating",
      detail: warm ? "Using resident model" : "Loading model (cold start)",
      generationProgress: null,
      error: undefined,
    })
    try {
      await mkdir(outputDir, { recursive: true })
      const runtime = MODEL_BY_ID[id].runtimes.find((candidate) => candidate.id === runtimeId)
      if (!runtime) throw new Error(`Unknown ${MODEL_BY_ID[id].name} runtime: ${runtimeId}`)
      const worker = await this.getWorker(id, runtime)
      const result = await worker.worker.generate(cleanText, output, voiceId, parameters)
      this.recordGeneration(id, runtimeId, voiceId, parameters, result.generationMs, worker.worker)
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

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.disposal = this.disposeInternal()
    return this.disposal
  }

  private async disposeInternal(): Promise<void> {
    this.controller.abort()
    if (this.resourceTimer) clearInterval(this.resourceTimer)
    for (const install of this.installs.values()) install.controller.abort()
    this.nativeBuild?.controller.abort()
    for (const download of this.voiceDownloads.values()) download.controller.abort()
    const pending = [
      ...[...this.installs.values()].map(({ promise }) => promise),
      ...[...this.voiceDownloads.values()].map(({ promise }) => promise),
      ...(this.nativeBuild ? [this.nativeBuild.promise] : []),
      ...(this.synthesis ? [this.synthesis] : []),
      ...this.configurationTails.values(),
      this.refreshOperation,
      this.persistedMutationTail,
      this.settingsWrites,
    ]
    const workers = new Set<RuntimeWorker>()
    if (this.startingWorker) workers.add(this.startingWorker)
    if (this.activeWorker) workers.add(this.activeWorker.worker)
    for (const worker of workers) worker.dispose()
    this.startingWorker = undefined
    this.activeWorker = undefined
    this.audio.dispose()
    await Promise.allSettled([
      ...pending,
      ...[...workers].map((worker) => worker.stop()),
      this.kokoro.dispose(),
    ])
    if (this.latestAudio) await rm(this.latestAudio.path, { force: true })
    this.latestAudio = undefined
    this.listeners.clear()
  }

  private async refresh(): Promise<void> {
    for (const model of MODELS) {
      if (this.disposed) return
      const runtime = this.runtime(model.id)
      if (model.id === "kokoro") {
        const result = await this.kokoro.inspect(runtime.id as KokoroRuntimeId)
        if (this.disposed) return
        if (this.states.kokoro.runtimeId !== runtime.id) continue
        this.patch("kokoro", {
          installed: result.ready,
          phase: result.ready ? "ready" : this.states.kokoro.phase,
          detail: result.ready ? result.detail : this.states.kokoro.detail,
          setupProgress: result.ready ? 1 : this.states.kokoro.setupProgress,
          downloadedBytes: result.downloadedBytes,
          totalBytes: result.totalBytes,
        })
      } else if (runtime.kind === "native") {
        const assets = runtime.assets ?? []
        const binary = await this.fluidAudioBuilder.findBinary()
        if (this.disposed) return
        const installed = Boolean(binary) && (assets.length === 0 || await this.assetsExist(model.id, assets))
        if (this.disposed) return
        if (installed && this.states[model.id].runtimeId === runtime.id) this.markReady(model.id)
      } else {
        const installed = await this.isPythonInstalled(model)
        if (this.disposed) return
        if (installed && this.states[model.id].runtimeId === runtime.id) this.markReady(model.id)
      }
    }
  }

  private runtime(id: ModelId): RuntimeProfile {
    const model = MODEL_BY_ID[id]
    return model.runtimes.find((runtime) => runtime.id === this.states[id].runtimeId) ?? model.runtimes[0]!
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new Error("Model manager is disposed")
  }

  private assertConfigurationMutable(id: ModelId, setting: "runtime" | "voices"): void {
    this.throwIfDisposed()
    if (this.synthesis || ["generating", "playing"].includes(this.states[id].phase)) {
      throw new Error(`Wait for the current ${MODEL_BY_ID[id].name} synthesis to finish before changing ${setting}`)
    }
  }

  private enqueueConfigurationMutation(id: ModelId, mutate: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Model manager is disposed"))
    const previous = this.configurationTails.get(id) ?? Promise.resolve()
    const operation = previous.then(() => {
      this.throwIfDisposed()
      return mutate()
    })
    let tail!: Promise<void>
    const result = operation.finally(() => {
      if (this.configurationTails.get(id) === tail) this.configurationTails.delete(id)
    })
    tail = result.catch(() => undefined)
    this.configurationTails.set(id, tail)
    return result
  }

  private enqueuePersistedMutation<T>(mutate: () => Promise<T>): Promise<T> {
    const operation = this.persistedMutationTail.then(() => {
      this.throwIfDisposed()
      return mutate()
    })
    this.persistedMutationTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private linkController(controller: AbortController): () => void {
    const signal = this.controller.signal
    const abort = () => controller.abort(signal.reason)
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener("abort", abort, { once: true })
    return () => signal.removeEventListener("abort", abort)
  }

  private loadRuntimeSettings(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.settingsPath(), "utf8"))
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return
      const settings = parsed as { version?: unknown; runtimes?: unknown; synthesisParameters?: unknown }
      const runtimes = settings.runtimes !== null && typeof settings.runtimes === "object" && !Array.isArray(settings.runtimes)
        ? settings.runtimes as Record<string, unknown>
        : {}
      const storedParameters = settings.version === 2
        && settings.synthesisParameters !== null
        && typeof settings.synthesisParameters === "object"
        && !Array.isArray(settings.synthesisParameters)
        ? settings.synthesisParameters as Record<string, unknown>
        : {}
      for (const model of MODELS) {
        const modelParameters = storedParameters[model.id] !== null
          && typeof storedParameters[model.id] === "object"
          && !Array.isArray(storedParameters[model.id])
          ? storedParameters[model.id] as Record<string, unknown>
          : {}
        for (const runtime of model.runtimes) {
          if (Object.hasOwn(modelParameters, runtime.id)) {
            this.persistedSynthesisParameters[model.id]![runtime.id] = recoverModelSynthesisParameters(
              model.id,
              modelParameters[runtime.id],
              runtime.id,
            )
          }
        }
        const storedRuntimeId = runtimes[model.id]
        const runtimeId = typeof storedRuntimeId === "string"
          && model.runtimes.some((runtime) => runtime.id === storedRuntimeId)
          ? storedRuntimeId
          : model.defaultRuntimeId
        const runtime = model.runtimes.find((candidate) => candidate.id === runtimeId) ?? model.runtimes[0]!
        const assets = runtime.assets ?? model.assets
        this.patch(model.id, {
          runtimeId,
          synthesisParameters: { ...this.persistedSynthesisParameters[model.id]![runtimeId]! },
          totalBytes: assets.reduce((sum, asset) => sum + asset.size, 0),
        })
      }
    } catch {}
  }

  private saveSettings(): Promise<void> {
    this.throwIfDisposed()
    const path = this.settingsPath()
    const operation = this.settingsWrites.then(async () => {
      this.throwIfDisposed()
      const settings: SettingsV2 = {
        version: 2,
        runtimes: Object.fromEntries(MODELS.map((model) => [model.id, this.states[model.id].runtimeId])),
        synthesisParameters: this.persistedSynthesisParameters,
      }
      const contents = JSON.stringify(settings, null, 2)
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(temporaryPath, contents)
        await rename(temporaryPath, path)
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    })
    this.settingsWrites = operation.catch(() => undefined)
    return operation
  }

  private async ensureNativeRuntime(id: ModelId, runtime: RuntimeProfile, signal: AbortSignal): Promise<void> {
    if (runtime.nativeBackend !== "pocket") {
      throw new Error(`Native runtime is not configured for ${MODEL_BY_ID[id].name}`)
    }
    if (!supportsFluidAudio(process.platform, process.arch, release())) {
      const message = `${MODEL_BY_ID[id].name} CoreML ANE requires macOS 14 or newer on Apple Silicon`
      if (this.states[id].runtimeId === runtime.id) {
        this.patch(id, { installed: false, phase: "error", detail: message, error: message })
      }
      throw new Error(message)
    }
    const assets = runtime.assets ?? []
    const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
    const [binary, assetsReady] = await Promise.all([
      this.fluidAudioBuilder.findBinary(),
      assets.length === 0 ? true : this.assetsExist(id, assets),
    ])
    const binaryReady = Boolean(binary)
    if (binaryReady && assetsReady) {
      if (this.states[id].runtimeId === runtime.id) {
        this.patch(id, {
          installed: true,
          phase: "ready",
          detail: "Ready",
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
      const unlink = this.linkController(controller)
      const users = new Set<ModelId>([id])
      const promise = this.buildNativeRuntime(id, controller.signal).finally(() => {
        unlink()
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
          detail: "Ready",
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
    return this.fluidAudioBuilder.build({
      signal,
      logPath: this.logPath(id),
      onStatus: (line) => {
        if (this.runtime(id).kind === "native") this.patch(id, { detail: line.slice(0, 120) })
      },
    })
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
      const uv = await this.ensureUv(model.id, signal)
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
          PYTHON_INFERENCE_SCRIPT,
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

  private ensureUv(id: ModelId, signal: AbortSignal): Promise<string> {
    const uvDir = join(APP_HOME, "tools", "uv")
    return bootstrapUv({
      uvDir,
      version: UV_VERSION,
      signal,
      logPath: this.logPath(id),
      onEvent: (event) => this.patch(id, {
        detail: event.detail.slice(0, 120),
        setupProgress: event.stage === "create" ? 0.05 : 0.08,
      }),
    })
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
    runtime: RuntimeProfile,
  ): Promise<{ id: ModelId; runtimeId: string; worker: RuntimeWorker; loadMs: number }> {
    this.throwIfDisposed()
    if (this.activeWorker?.id === id && this.activeWorker.runtimeId === runtime.id) return this.activeWorker
    if (this.activeWorker) {
      const previous = this.activeWorker
      this.activeWorker = undefined
      this.clearWorkerRss(previous.id)
      await previous.worker.stop()
      this.throwIfDisposed()
    }

    if (id === "kokoro") {
      let instance: RuntimeWorker | undefined
      const started = await this.kokoro.start(runtime.id as KokoroRuntimeId, {
        signal: this.controller.signal,
        onEvent: (event) => this.handleKokoroEvent(event),
        onExit: () => {
          if (instance && this.startingWorker === instance) this.startingWorker = undefined
          if (instance && this.activeWorker?.worker === instance) {
            this.activeWorker = undefined
            this.clearWorkerRss("kokoro")
          }
        },
      })
      if (this.controller.signal.aborted) {
        await started.worker.stop()
        this.throwIfDisposed()
      }
      instance = started.worker
      this.activeWorker = { id, runtimeId: runtime.id, worker: started.worker, loadMs: started.loadMs }
      this.patch("kokoro", {
        resident: true,
        downloadedBytes: runtime.modelBytes ?? this.states.kokoro.downloadedBytes,
        totalBytes: runtime.modelBytes ?? this.states.kokoro.totalBytes,
      })
      this.refreshResourceUsage()
      return this.activeWorker
    }

    if (runtime.kind === "javascript") throw new Error(`JavaScript runtime is not configured for ${MODEL_BY_ID[id].name}`)

    let command: string[]
    let env: Record<string, string | undefined>
    if (runtime.kind === "native") {
      if (runtime.nativeBackend !== "pocket") throw new Error(`Native runtime is not configured for ${MODEL_BY_ID[id].name}`)
      const nativeHome = join(APP_HOME, "native-home")
      await mkdir(nativeHome, { recursive: true })
      this.throwIfDisposed()
      const binaryPath = await this.fluidAudioBuilder.findBinary()
      this.throwIfDisposed()
      if (!binaryPath) throw new Error("FluidAudio sidecar is not built")
      command = createFluidAudioBackendCommand({
        binaryPath,
        backend: runtime.nativeBackend,
        assetsPath: this.assetDir(id),
      })
      env = createFluidAudioEnvironment(nativeHome)
    } else {
      command = [
        envPython(this.envDir(id)),
        "-u",
        PYTHON_INFERENCE_SCRIPT,
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

    let instance: NdjsonRuntimeWorker | undefined
    const worker = await NdjsonRuntimeWorker.spawn({
      command,
      signal: this.controller.signal,
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

  private handleKokoroEvent(event: KokoroEvent): void {
    if (event.phase) {
      this.patch("kokoro", {
        phase: event.phase,
        detail: event.detail ?? this.states.kokoro.detail,
        setupProgress: event.progress ?? this.states.kokoro.setupProgress,
        downloadedBytes: event.downloadedBytes ?? this.states.kokoro.downloadedBytes,
        totalBytes: event.totalBytes ?? this.states.kokoro.totalBytes,
      })
      return
    }
    this.handleWorkerEvent("kokoro", event)
  }

  private recordGeneration(
    id: ModelId,
    runtimeId: string,
    voiceId: string,
    parameters: SynthesisParameters,
    generationMs: number,
    worker: RuntimeWorker,
  ): void {
    const key = getSynthesisConfigurationKey(id, runtimeId, voiceId, parameters)
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
    if (this.disposed) return
    const active = this.activeWorker
    if (!active || this.states[active.id].runtimeId !== active.runtimeId) return
    const appMemory = process.memoryUsage()
    const workerMemory = active.worker.getResourceUsage()
    const current = this.states[active.id].runtimeStats
    const state = this.states[active.id]
    const key = getSynthesisConfigurationKey(
      active.id,
      active.runtimeId,
      state.voiceId,
      state.synthesisParameters,
    )
    const historySummary = summarizeGenerationTimes(this.generationHistory.get(key) ?? [])
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

  private restoreRuntimeStats(id: ModelId): void {
    const state = this.states[id]
    const key = getSynthesisConfigurationKey(
      id,
      state.runtimeId,
      state.voiceId,
      state.synthesisParameters,
    )
    const summary = summarizeGenerationTimes(this.generationHistory.get(key) ?? [])
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
    this.throwIfDisposed()
    const model = MODEL_BY_ID[id]
    const voice = model.voices.find((candidate) => candidate.id === voiceId)
    if (!voice) throw new Error(`Unknown ${model.name} voice: ${voiceId}`)
    const runtimeId = this.states[id].runtimeId
    if (["javascript", "native"].includes(this.runtime(id).kind)) return
    if (id === "kokoro" && !voice.assets?.length) {
      await this.kokoro.ensureVoice(voiceId as KokoroVoiceId, {
        signal: this.controller.signal,
        onEvent: (event) => this.handleKokoroEvent(event),
      })
      return
    }
    if (id !== "kokoro" && (!voice.assets?.length || (await this.assetsExist(id, voice.assets)))) return
    if (this.states[id].voiceId !== voiceId || this.states[id].runtimeId !== runtimeId) return

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
    const unlink = this.linkController(controller)
    const operation = (async () => {
      this.patch(id, {
        phase: "download",
        detail: `Downloading voice: ${voice.name}`,
        downloadedBytes: 0,
        totalBytes: voice.assets!.reduce((sum, asset) => sum + asset.size, 0),
      })
      if (id !== "kokoro") await this.appendLog(id, `[app] Downloading voice ${voice.id}`)
      if (id === "kokoro") {
        await this.kokoro.ensureVoice(voiceId as KokoroVoiceId, {
          signal: controller.signal,
          onEvent: (event) => this.handleKokoroEvent(event),
        })
      } else {
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
      }
      if (id !== "kokoro") await this.appendLog(id, `[app] Voice ready: ${voice.id}`)
      if (this.states[id].voiceId === voiceId && this.states[id].runtimeId === runtimeId) this.markReady(id)
    })().finally(() => {
      unlink()
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
    for (const listener of this.listeners) listener({
      ...this.states[id],
      synthesisParameters: { ...this.states[id].synthesisParameters },
    })
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
