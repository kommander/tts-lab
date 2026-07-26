import { constants } from "node:fs"
import { access, appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FluidAudioBuilder,
  createFluidAudioBackendCommand,
  createFluidAudioEnvironment,
  getFluidAudioCapability,
} from "./fluidaudio/index.js"
import {
  NdjsonRuntimeWorker,
  SynthesisParameterError,
  bootstrapUv,
  downloadAssets,
  normalizeSynthesisParameters,
  runProcess,
  type RuntimeWorker,
  type SynthesisParameters,
  type WorkerResult,
  type WorkerStatusEvent,
} from "./core/index.js"
import {
  KOKORO_ASSETS,
  KOKORO_PARAMETER_DEFINITIONS,
  KOKORO_DEFAULT_VOICE_ID,
  KOKORO_RUNTIMES,
  KOKORO_SETUP_VERSION,
  KOKORO_VOICES,
  type KokoroRuntimeDescriptor,
  type KokoroRuntimeId,
  type KokoroVoiceId,
} from "./catalog.js"
import { KokoroJavascriptWorker } from "./javascript-worker.js"

const UV_VERSION = "0.11.32"
const PYTHON_VERSION = "3.11"
const PYTHON_PACKAGES = ["kokoro==0.9.4", "soundfile"] as const
const PYTHON_WORKER = fileURLToPath(new URL("../resources/kokoro_worker.py", import.meta.url))
const JAVASCRIPT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX"

export type KokoroPhase = "bootstrap" | "setup" | "download" | "verify" | "ready"

export interface KokoroEvent extends WorkerStatusEvent {
  phase?: KokoroPhase
}

export interface KokoroOptions {
  homeDir: string
}

export interface KokoroOperationOptions {
  signal?: AbortSignal
  onEvent?: (event: KokoroEvent) => void
}

export interface KokoroStartOptions extends KokoroOperationOptions {
  onExit?: () => void
}

export interface KokoroJavascriptLoadOptions extends KokoroOperationOptions {
  dtype: "q8" | "fp32"
  device: "cpu" | "webgpu"
  lowMemory?: boolean
  cacheDir: string
  modelBytes: number
  onExit?: () => void
}

export interface KokoroPaths {
  homeDir: string
  modelDir: string
  envDir: string
  assetDir: string
  markerPath: string
  uvDir: string
  javascriptCacheDir: string
  nativeHomeDir: string
  hfCacheDir: string
  logPath: string
  pythonWorker: string
}

export interface KokoroCapability {
  runtimeId: KokoroRuntimeId
  supported: boolean
  reason?: string
  voices: readonly KokoroVoiceId[]
}

export interface KokoroInspection extends KokoroCapability {
  ready: boolean
  cached: boolean
  detail: string
  downloadedBytes: number
  totalBytes: number
}

export interface KokoroPrepareResult extends KokoroInspection {}

export interface KokoroStartedRuntime {
  runtimeId: KokoroRuntimeId
  worker: KokoroWorker
  loadMs: number
}

export interface KokoroWorker extends RuntimeWorker {
  generate(text: string, output: string, voice?: KokoroVoiceId, parameters?: SynthesisParameters): Promise<WorkerResult>
}

export interface KokoroSynthesizeOptions extends KokoroStartOptions {
  runtimeId: KokoroRuntimeId
  text: string
  output: string
  voice?: KokoroVoiceId
  parameters?: SynthesisParameters
}

export interface KokoroSynthesisResult extends WorkerResult {
  runtimeId: KokoroRuntimeId
  voice: KokoroVoiceId
  loadMs: number
}

export type KokoroErrorCode =
  | "INVALID_RUNTIME"
  | "INVALID_VOICE"
  | "INVALID_PARAMETER"
  | "UNSUPPORTED"
  | "NOT_PREPARED"
  | "SETUP_FAILED"

export class KokoroRuntimeError extends Error {
  override readonly name = "KokoroRuntimeError"

  constructor(
    readonly code: KokoroErrorCode,
    message: string,
    readonly runtimeId?: KokoroRuntimeId,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

function runtimeById(runtimeId: string): KokoroRuntimeDescriptor {
  const runtime = KOKORO_RUNTIMES.find((candidate) => candidate.id === runtimeId)
  if (!runtime) throw new KokoroRuntimeError("INVALID_RUNTIME", `Unknown Kokoro runtime: ${runtimeId}`)
  return runtime
}

export function normalizeKokoroSynthesisParameters(
  parameters?: SynthesisParameters,
  runtimeId?: KokoroRuntimeId,
): SynthesisParameters {
  try {
    return normalizeSynthesisParameters(KOKORO_PARAMETER_DEFINITIONS, parameters)
  } catch (error) {
    if (!(error instanceof SynthesisParameterError)) throw error
    throw new KokoroRuntimeError("INVALID_PARAMETER", error.message, runtimeId, { cause: error })
  }
}

function envPython(envDir: string): string {
  return process.platform === "win32" ? join(envDir, "Scripts", "python.exe") : join(envDir, "bin", "python")
}

async function fileHasSize(path: string, size: number): Promise<boolean> {
  return stat(path).then((entry) => entry.size === size).catch(() => false)
}

async function fileIsNonempty(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isFile() && entry.size > 0).catch(() => false)
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function allAssetsExist(root: string, assets: readonly { path: string; size: number }[]): Promise<boolean> {
  for (const asset of assets) if (!(await fileHasSize(join(root, asset.path), asset.size))) return false
  return true
}

function waitForReady(worker: NdjsonRuntimeWorker, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted()
  if (!signal) return worker.ready
  return new Promise((resolvePromise, rejectPromise) => {
    const abort = () => {
      worker.dispose()
      rejectPromise(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
    worker.ready.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", abort))
  })
}

interface SharedOperationJob<T> {
  controller: AbortController
  listeners: Set<(event: KokoroEvent) => void>
  promise: Promise<T>
  users: number
}

const prepareJobs = new Map<string, SharedOperationJob<KokoroPrepareResult>>()
const voiceJobs = new Map<string, SharedOperationJob<void>>()

function emitShared(job: SharedOperationJob<unknown>, event: KokoroEvent): void {
  for (const listener of job.listeners) {
    try {
      listener(event)
    } catch {}
  }
}

async function joinSharedOperation<T>(
  jobs: Map<string, SharedOperationJob<T>>,
  key: string,
  signal: AbortSignal,
  listener: ((event: KokoroEvent) => void) | undefined,
  perform: (signal: AbortSignal, emit: (event: KokoroEvent) => void) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  let job = jobs.get(key)
  while (job?.controller.signal.aborted) {
    await job.promise.catch(() => undefined)
    job = jobs.get(key)
  }
  if (!job) {
    const controller = new AbortController()
    const listeners = new Set<(event: KokoroEvent) => void>()
    const created = {} as SharedOperationJob<T>
    created.controller = controller
    created.listeners = listeners
    created.users = 0
    created.promise = perform(controller.signal, (event) => emitShared(created, event)).finally(() => {
      if (jobs.get(key) === created) jobs.delete(key)
    })
    job = created
    jobs.set(key, job)
  }
  job.users += 1
  const joinedListener = listener ? (event: KokoroEvent) => listener(event) : undefined
  if (joinedListener) job.listeners.add(joinedListener)
  try {
    return await new Promise<T>((resolvePromise, rejectPromise) => {
      const abort = () => rejectPromise(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
      signal.addEventListener("abort", abort, { once: true })
      job!.promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", abort))
    })
  } finally {
    if (joinedListener) job.listeners.delete(joinedListener)
    job.users -= 1
    if (job.users === 0 && jobs.get(key) === job) {
      job.controller.abort()
      await job.promise.catch(() => undefined)
    }
  }
}

class KokoroRuntimeWorker implements KokoroWorker {
  constructor(
    private readonly worker: RuntimeWorker,
    private readonly runtimeId: KokoroRuntimeId,
    private readonly voices: readonly KokoroVoiceId[],
  ) {}

  generate(
    text: string,
    output: string,
    voice: KokoroVoiceId = KOKORO_DEFAULT_VOICE_ID,
    parameters?: SynthesisParameters,
  ): Promise<WorkerResult> {
    if (!this.voices.includes(voice as KokoroVoiceId)) {
      throw new KokoroRuntimeError(
        "INVALID_VOICE",
        `${runtimeById(this.runtimeId).name} does not support ${voice}`,
        this.runtimeId,
      )
    }
    return this.worker.generate(text, output, voice, normalizeKokoroSynthesisParameters(parameters, this.runtimeId))
  }

  dispose(): void {
    this.worker.dispose()
  }

  stop(): Promise<void> {
    return this.worker.stop()
  }

  getResourceUsage() {
    return this.worker.getResourceUsage()
  }
}

class TopLevelKokoroWorker implements KokoroWorker {
  constructor(
    private readonly worker: RuntimeWorker,
    private readonly runtime: KokoroRuntime,
  ) {}

  generate(
    text: string,
    output: string,
    voice?: KokoroVoiceId,
    parameters?: SynthesisParameters,
  ): Promise<WorkerResult> {
    return this.worker.generate(text, output, voice, parameters)
  }

  dispose(): void {
    this.worker.dispose()
    void this.runtime.dispose()
  }

  async stop(): Promise<void> {
    await this.runtime.dispose()
  }

  getResourceUsage() {
    return this.worker.getResourceUsage()
  }
}

export function getKokoroCapability(
  runtimeId: KokoroRuntimeId,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  kernelRelease?: string,
): KokoroCapability {
  const runtime = runtimeById(runtimeId)
  const voices = runtime.voiceIds ?? KOKORO_VOICES.map((voice) => voice.id)
  if (runtime.kind === "python") {
    const supported = (platform === "darwin" && (arch === "x64" || arch === "arm64"))
      || (platform === "linux" && (arch === "x64" || arch === "arm64"))
      || (platform === "win32" && arch === "x64")
    return supported
      ? { runtimeId, supported: true, voices }
      : { runtimeId, supported: false, reason: `The Python runtime is not packaged for ${platform}/${arch}`, voices }
  }
  if (runtime.kind === "javascript") {
    const ortPlatform = (platform === "win32" || platform === "darwin") && (arch === "x64" || arch === "arm64")
      || platform === "linux" && (arch === "x64" || arch === "arm64")
    if (!ortPlatform) {
      return { runtimeId, supported: false, reason: `ONNX Runtime Node is not packaged for ${platform}/${arch}`, voices }
    }
    if (runtime.device === "webgpu" && platform === "linux" && arch === "arm64") {
      return { runtimeId, supported: false, reason: "ONNX Runtime WebGPU has no Linux arm64 prebuilt binary", voices }
    }
    return { runtimeId, supported: true, voices }
  }
  const capability = getFluidAudioCapability(platform, arch, kernelRelease)
  return { runtimeId, ...capability, voices }
}

export class KokoroRuntime {
  readonly paths: KokoroPaths
  private readonly fluidAudioBuilder: FluidAudioBuilder
  private readonly workers = new Set<RuntimeWorker>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly cleanups = new Set<Promise<unknown>>()
  private readonly lifecycle = new AbortController()
  private disposal?: Promise<void>
  private disposed = false

  constructor(options: KokoroOptions) {
    if (!options.homeDir.trim()) throw new TypeError("Kokoro requires an explicit homeDir")
    const homeDir = resolve(options.homeDir)
    const modelDir = join(homeDir, "models", "kokoro")
    this.paths = {
      homeDir,
      modelDir,
      envDir: join(modelDir, "venv"),
      assetDir: join(modelDir, "assets"),
      markerPath: join(modelDir, "installed.json"),
      uvDir: join(homeDir, "tools", "uv"),
      javascriptCacheDir: join(modelDir, "javascript-cache"),
      nativeHomeDir: join(homeDir, "native-home"),
      hfCacheDir: join(homeDir, "hf-cache", "kokoro"),
      logPath: join(homeDir, "logs", "kokoro.log"),
      pythonWorker: PYTHON_WORKER,
    }
    this.fluidAudioBuilder = new FluidAudioBuilder(homeDir)
  }

  capability(runtimeId: KokoroRuntimeId): KokoroCapability {
    return getKokoroCapability(runtimeId)
  }

  async inspect(runtimeId: KokoroRuntimeId): Promise<KokoroInspection> {
    const runtime = runtimeById(runtimeId)
    const capability = this.capability(runtimeId)
    const totalBytes = runtime.modelBytes ?? (runtime.kind === "python"
      ? KOKORO_ASSETS.reduce((sum, asset) => sum + asset.size, 0)
      : 0)
    if (!capability.supported) {
      return { ...capability, ready: false, cached: false, detail: capability.reason!, downloadedBytes: 0, totalBytes }
    }
    if (runtime.kind === "javascript") {
      const modelCached = await fileHasSize(
        join(this.paths.javascriptCacheDir, JAVASCRIPT_MODEL_ID, runtime.modelFile!),
        runtime.modelBytes!,
      )
      const supportCached = await Promise.all([
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
      ].map((file) => fileIsNonempty(join(this.paths.javascriptCacheDir, JAVASCRIPT_MODEL_ID, file))))
      const cached = modelCached && supportCached.every(Boolean)
      return {
        ...capability,
        ready: true,
        cached,
        detail: cached
          ? "Ready"
          : modelCached
            ? "Ready; model weights cached, support files download on first use"
            : "Ready; ONNX model downloads on first use",
        downloadedBytes: modelCached ? totalBytes : 0,
        totalBytes,
      }
    }
    if (runtime.kind === "native") {
      const binary = await this.fluidAudioBuilder.findBinary()
      return {
        ...capability,
        ready: Boolean(binary),
        cached: Boolean(binary),
        detail: binary ? "Ready; CoreML models download on first use" : "FluidAudio sidecar is not built",
        downloadedBytes: 0,
        totalBytes: 0,
      }
    }
    let markerVersion: string | undefined
    try {
      markerVersion = (JSON.parse(await readFile(this.paths.markerPath, "utf8")) as { version?: string }).version
    } catch {}
    const ready = markerVersion === KOKORO_SETUP_VERSION
      && await isExecutable(envPython(this.paths.envDir))
      && await allAssetsExist(this.paths.assetDir, KOKORO_ASSETS)
    return {
      ...capability,
      ready,
      cached: ready,
      detail: ready ? "Ready" : "Not installed",
      downloadedBytes: ready ? totalBytes : 0,
      totalBytes,
    }
  }

  async prepare(runtimeId: KokoroRuntimeId, options: KokoroOperationOptions = {}): Promise<KokoroPrepareResult> {
    this.assertUsable()
    const signal = this.operationSignal(options.signal)
    const operation = joinSharedOperation(
      prepareJobs,
      `${this.paths.homeDir}\0${runtimeId}`,
      signal,
      options.onEvent,
      async (sharedSignal, emit) => {
        const runtime = runtimeById(runtimeId)
        const inspected = await this.inspect(runtimeId)
        if (!inspected.supported) throw new KokoroRuntimeError("UNSUPPORTED", inspected.reason!, runtimeId)
        if (inspected.ready) return inspected
        try {
          const sharedOptions = { signal: sharedSignal, onEvent: emit }
          if (runtime.kind === "native") await this.prepareNative(runtimeId, sharedOptions)
          else if (runtime.kind === "python") await this.preparePython(runtimeId, sharedOptions)
          const result = await this.inspect(runtimeId)
          emit({ type: "status", phase: "ready", detail: result.detail })
          return result
        } catch (error) {
          if (sharedSignal.aborted) throw error
          if (error instanceof KokoroRuntimeError) throw error
          await this.log(`[runtime:error] ${error instanceof Error ? error.message : String(error)}`)
          throw new KokoroRuntimeError("SETUP_FAILED", error instanceof Error ? error.message : String(error), runtimeId, {
            cause: error,
          })
        }
      },
    )
    return this.track(operation)
  }

  async ensureVoice(voiceId: KokoroVoiceId, options: KokoroOperationOptions = {}): Promise<void> {
    this.assertUsable()
    const signal = this.operationSignal(options.signal)
    const voice = KOKORO_VOICES.find((candidate) => candidate.id === voiceId)
    if (!voice) throw new KokoroRuntimeError("INVALID_VOICE", `Unknown Kokoro voice: ${voiceId}`)
    if (!voice.assets?.length || await allAssetsExist(this.paths.assetDir, voice.assets)) return
    return this.track(joinSharedOperation(
      voiceJobs,
      `${this.paths.homeDir}\0${voiceId}`,
      signal,
      options.onEvent,
      async (sharedSignal, emit) => {
        if (await allAssetsExist(this.paths.assetDir, voice.assets!)) return
        await this.downloadVoice(voice, { signal: sharedSignal, onEvent: emit })
      },
    ))
  }

  private async downloadVoice(
    voice: (typeof KOKORO_VOICES)[number],
    options: KokoroOperationOptions,
  ): Promise<void> {
    options.onEvent?.({ type: "status", phase: "download", detail: `Downloading voice: ${voice.name}` })
    await this.log(`[runtime] Downloading voice ${voice.id}`)
    await downloadAssets(voice.assets!, this.paths.assetDir, (progress) => {
      options.onEvent?.({
        type: "progress",
        phase: "download",
        detail: `Downloading voice ${voice.name}: ${progress.asset.path}`,
        downloadedBytes: progress.completedBytes,
        totalBytes: progress.totalBytes,
      })
    }, options.signal)
    await this.log(`[runtime] Voice ready: ${voice.id}`)
  }

  async start(runtimeId: KokoroRuntimeId, options: KokoroStartOptions = {}): Promise<KokoroStartedRuntime> {
    this.assertUsable()
    const signal = this.operationSignal(options.signal)
    return this.track(this.startRuntime(runtimeId, { ...options, signal }))
  }

  private async startRuntime(runtimeId: KokoroRuntimeId, options: KokoroStartOptions): Promise<KokoroStartedRuntime> {
    const runtime = runtimeById(runtimeId)
    const capability = this.capability(runtimeId)
    if (!capability.supported) throw new KokoroRuntimeError("UNSUPPORTED", capability.reason!, runtimeId)
    if (runtime.kind === "javascript") {
      let worker: KokoroRuntimeWorker | undefined
      const started = await KokoroJavascriptWorker.start({
        dtype: runtime.dtype!,
        device: runtime.device!,
        lowMemory: runtime.lowMemory,
        cacheDir: this.paths.javascriptCacheDir,
        modelBytes: runtime.modelBytes!,
        ...options,
        onExit: () => {
          if (worker) this.workers.delete(worker)
          options.onExit?.()
        },
      })
      if (options.signal?.aborted) {
        await started.worker.stop()
        options.signal.throwIfAborted()
      }
      worker = new KokoroRuntimeWorker(started.worker, runtimeId, capability.voices)
      this.workers.add(worker)
      return {
        runtimeId,
        worker,
        loadMs: started.loadMs,
      }
    }
    const inspection = await this.inspect(runtimeId)
    if (!inspection.ready) throw new KokoroRuntimeError("NOT_PREPARED", `${runtime.name} is not prepared`, runtimeId)
    let command: string[]
    let env: Record<string, string | undefined>
    if (runtime.kind === "native") {
      const binaryPath = await this.fluidAudioBuilder.findBinary()
      if (!binaryPath) throw new KokoroRuntimeError("NOT_PREPARED", "FluidAudio sidecar is not built", runtimeId)
      await mkdir(this.paths.nativeHomeDir, { recursive: true })
      command = createFluidAudioBackendCommand({ binaryPath, backend: "kokoro", assetsPath: this.paths.assetDir })
      env = createFluidAudioEnvironment(this.paths.nativeHomeDir)
    } else {
      command = [envPython(this.paths.envDir), "-u", this.paths.pythonWorker, "--assets", this.paths.assetDir, "--serve"]
      env = {
        HF_HOME: this.paths.hfCacheDir,
        NLTK_DATA: join(this.paths.assetDir, "nltk"),
        PYTORCH_ENABLE_MPS_FALLBACK: "1",
        TOKENIZERS_PARALLELISM: "false",
      }
    }
    let worker: KokoroRuntimeWorker | undefined
    const underlying = await NdjsonRuntimeWorker.spawn({
      command,
      env,
      logPath: this.paths.logPath,
      onStatus: (event) => options.onEvent?.(event),
      onExit: () => {
        if (worker) this.workers.delete(worker)
        options.onExit?.()
      },
    })
    worker = new KokoroRuntimeWorker(underlying, runtimeId, capability.voices)
    this.workers.add(worker)
    try {
      const loadMs = await waitForReady(underlying, options.signal)
      return { runtimeId, worker, loadMs }
    } catch (error) {
      this.workers.delete(worker)
      await worker.stop()
      throw error
    }
  }

  async synthesize(options: KokoroSynthesizeOptions): Promise<KokoroSynthesisResult> {
    this.assertUsable()
    const signal = this.operationSignal(options.signal)
    return this.track(this.performSynthesis({ ...options, signal }))
  }

  private async performSynthesis(options: KokoroSynthesizeOptions): Promise<KokoroSynthesisResult> {
    const voice = options.voice ?? KOKORO_DEFAULT_VOICE_ID
    const parameters = normalizeKokoroSynthesisParameters(options.parameters, options.runtimeId)
    const capability = this.capability(options.runtimeId)
    if (!capability.voices.includes(voice)) {
      throw new KokoroRuntimeError("INVALID_VOICE", `${runtimeById(options.runtimeId).name} does not support ${voice}`, options.runtimeId)
    }
    await this.prepare(options.runtimeId, options)
    if (runtimeById(options.runtimeId).kind !== "javascript") await this.ensureVoice(voice, options)
    const started = await this.start(options.runtimeId, options)
    try {
      options.signal?.throwIfAborted()
      const generation = started.worker.generate(options.text, options.output, voice, parameters)
      const result = options.signal
        ? await new Promise<WorkerResult>((resolvePromise, rejectPromise) => {
            const abort = () => {
              started.worker.dispose()
              rejectPromise(options.signal!.reason ?? new DOMException("The operation was aborted", "AbortError"))
            }
            options.signal!.addEventListener("abort", abort, { once: true })
            generation.then(resolvePromise, rejectPromise).finally(() => options.signal!.removeEventListener("abort", abort))
          })
        : await generation
      return { ...result, runtimeId: options.runtimeId, voice, loadMs: started.loadMs }
    } finally {
      started.worker.dispose()
      this.trackCleanup(started.worker.stop())
    }
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.lifecycle.abort(new DOMException("Kokoro runtime was disposed", "AbortError"))
    const workers = new Set(this.workers)
    for (const worker of workers) worker.dispose()
    this.disposal = (async () => {
      await Promise.allSettled([...this.operations])
      for (const worker of this.workers) workers.add(worker)
      await Promise.allSettled([
        ...[...workers].map((worker) => worker.stop()),
        ...this.cleanups,
      ])
      this.workers.clear()
    })()
    return this.disposal
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Kokoro runtime has been disposed")
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifecycle.signal, signal]) : this.lifecycle.signal
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    operation.finally(() => this.operations.delete(operation)).catch(() => undefined)
    return operation
  }

  private trackCleanup(cleanup: Promise<unknown>): void {
    this.cleanups.add(cleanup)
    cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => undefined)
  }

  private async prepareNative(runtimeId: KokoroRuntimeId, options: KokoroOperationOptions): Promise<void> {
    options.onEvent?.({ type: "status", phase: "setup", detail: "Building pinned FluidAudio CoreML sidecar" })
    await this.fluidAudioBuilder.build({
      signal: options.signal,
      logPath: this.paths.logPath,
      onStatus: (detail) => options.onEvent?.({ type: "status", phase: "setup", detail }),
    })
    options.signal?.throwIfAborted()
    if (!(await this.inspect(runtimeId)).ready) throw new Error("FluidAudio build completed without a reusable binary")
  }

  private async preparePython(_runtimeId: KokoroRuntimeId, options: KokoroOperationOptions): Promise<void> {
    const signal = options.signal
    options.onEvent?.({ type: "status", phase: "bootstrap", detail: "Preparing isolated Python tooling", progress: 0.03 })
    const uv = await this.ensureUv(options)
    await mkdir(this.paths.modelDir, { recursive: true })
    await mkdir(this.paths.assetDir, { recursive: true })
    options.onEvent?.({ type: "status", phase: "setup", detail: `Installing Python ${PYTHON_VERSION}`, progress: 0.1 })
    await runProcess([uv, "python", "install", PYTHON_VERSION], {
      signal,
      logPath: this.paths.logPath,
      onLine: (line) => options.onEvent?.({ type: "status", phase: "setup", detail: line.slice(0, 120) }),
    })
    await rm(this.paths.envDir, { recursive: true, force: true })
    await runProcess([uv, "venv", "--python", PYTHON_VERSION, this.paths.envDir], {
      signal,
      logPath: this.paths.logPath,
      onLine: (line) => options.onEvent?.({ type: "status", phase: "setup", detail: line.slice(0, 120) }),
    })
    options.onEvent?.({ type: "status", phase: "setup", detail: "Installing Kokoro runtime", progress: 0.25 })
    await runProcess([uv, "pip", "install", "--python", envPython(this.paths.envDir), ...PYTHON_PACKAGES], {
      signal,
      logPath: this.paths.logPath,
      env: { UV_LINK_MODE: "copy", GIT_LFS_SKIP_SMUDGE: "1" },
      onLine: (line) => options.onEvent?.({ type: "status", phase: "setup", detail: line.slice(0, 120) }),
    })
    options.onEvent?.({ type: "status", phase: "setup", detail: "Installing language resources (1/1)", progress: 0.7 })
    await runProcess([envPython(this.paths.envDir), "-m", "spacy", "download", "en_core_web_sm"], {
      signal,
      logPath: this.paths.logPath,
      env: {
        PATH: [dirname(envPython(this.paths.envDir)), dirname(uv), process.env.PATH ?? ""].join(
          process.platform === "win32" ? ";" : ":",
        ),
        VIRTUAL_ENV: this.paths.envDir,
        NLTK_DATA: join(this.paths.assetDir, "nltk"),
      },
      onLine: (line) => options.onEvent?.({ type: "status", phase: "setup", detail: line.slice(0, 120) }),
    })
    options.onEvent?.({ type: "status", phase: "download", detail: "Downloading model files", progress: 0.75 })
    await this.log(`[runtime] Downloading ${KOKORO_ASSETS.length} pinned model assets`)
    await downloadAssets(KOKORO_ASSETS, this.paths.assetDir, (progress) => {
      options.onEvent?.({
        type: "progress",
        phase: "download",
        detail: `Downloading ${progress.asset.path}`,
        downloadedBytes: progress.completedBytes,
        totalBytes: progress.totalBytes,
      })
    }, signal)
    options.onEvent?.({ type: "status", phase: "verify", detail: "Checking runtime imports", progress: 0.95 })
    await runProcess([envPython(this.paths.envDir), "-u", this.paths.pythonWorker, "--assets", this.paths.assetDir, "--check"], {
      signal,
      logPath: this.paths.logPath,
      env: {
        HF_HOME: this.paths.hfCacheDir,
        NLTK_DATA: join(this.paths.assetDir, "nltk"),
        PYTORCH_ENABLE_MPS_FALLBACK: "1",
      },
      onLine: (line) => options.onEvent?.({ type: "status", phase: "verify", detail: line.slice(0, 120) }),
    })
    await writeFile(this.paths.markerPath, JSON.stringify({ version: KOKORO_SETUP_VERSION }, null, 2))
  }

  private async ensureUv(options: KokoroOperationOptions): Promise<string> {
    return bootstrapUv({
      uvDir: this.paths.uvDir,
      version: UV_VERSION,
      signal: options.signal,
      logPath: this.paths.logPath,
      onEvent: (event) => options.onEvent?.({
        type: "status",
        phase: "bootstrap",
        detail: event.detail.slice(0, 120),
        progress: event.stage === "create" ? 0.05 : 0.08,
      }),
    })
  }

  private async log(message: string): Promise<void> {
    try {
      await mkdir(dirname(this.paths.logPath), { recursive: true })
      await appendFile(this.paths.logPath, `[${new Date().toISOString()}] ${message}\n`)
    } catch {}
  }
}

export function createKokoro(options: KokoroOptions): KokoroRuntime {
  return new KokoroRuntime(options)
}

export async function prepare(
  runtimeId: KokoroRuntimeId,
  options: KokoroOptions & KokoroOperationOptions,
): Promise<KokoroPrepareResult> {
  const runtime = createKokoro(options)
  try {
    return await runtime.prepare(runtimeId, options)
  } finally {
    await runtime.dispose()
  }
}

export async function start(
  runtimeId: KokoroRuntimeId,
  options: KokoroOptions & KokoroStartOptions,
): Promise<KokoroStartedRuntime> {
  const runtime = createKokoro(options)
  try {
    const started = await runtime.start(runtimeId, {
      ...options,
      onExit: () => {
        options.onExit?.()
        void runtime.dispose()
      },
    })
    return { ...started, worker: new TopLevelKokoroWorker(started.worker, runtime) }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

export async function ensureVoice(
  voiceId: KokoroVoiceId,
  options: KokoroOptions & KokoroOperationOptions,
): Promise<void> {
  const runtime = createKokoro(options)
  try {
    await runtime.ensureVoice(voiceId, options)
  } finally {
    await runtime.dispose()
  }
}

export async function synthesize(
  options: KokoroOptions & KokoroSynthesizeOptions,
): Promise<KokoroSynthesisResult> {
  const runtime = createKokoro(options)
  try {
    return await runtime.synthesize(options)
  } finally {
    await runtime.dispose()
  }
}
