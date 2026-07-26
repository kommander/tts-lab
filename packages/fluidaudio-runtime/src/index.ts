import { constants } from "node:fs"
import { access, readdir, stat } from "node:fs/promises"
import { release } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { commandExists, runProcess } from "tts-runtime-core"

export const FLUIDAUDIO_VERSION = "0.15.5"
export const FLUIDAUDIO_BUILD_VERSION = `${FLUIDAUDIO_VERSION}-v2`
export const FLUIDAUDIO_PRODUCT = "tts-lab-fluidaudio"

const SWIFT_PACKAGE_PATH = fileURLToPath(new URL("../swift", import.meta.url))

export type FluidAudioBackend = "kokoro" | "pocket"

export interface FluidAudioCapability {
  supported: boolean
  reason?: string
}

export interface FluidAudioBuildOptions {
  signal?: AbortSignal
  logPath?: string
  onStatus?: (detail: string) => void
}

export interface FluidAudioCommandOptions {
  binaryPath: string
  backend: FluidAudioBackend
  assetsPath: string
}

interface BuildJob {
  controller: AbortController
  listeners: Set<(detail: string) => void>
  promise: Promise<string>
  users: number
}

const builds = new Map<string, BuildJob>()

export function getFluidAudioCapability(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  kernelRelease: string = release(),
): FluidAudioCapability {
  if (platform !== "darwin") return { supported: false, reason: "FluidAudio CoreML requires macOS" }
  if (arch !== "arm64") return { supported: false, reason: "FluidAudio CoreML requires Apple Silicon" }
  const darwinMajor = Number.parseInt(kernelRelease.split(".")[0] ?? "", 10)
  if (!Number.isFinite(darwinMajor) || darwinMajor < 23) {
    return { supported: false, reason: "FluidAudio CoreML requires macOS 14 or newer" }
  }
  return { supported: true }
}

export function supportsFluidAudio(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  kernelRelease: string = release(),
): boolean {
  return getFluidAudioCapability(platform, arch, kernelRelease).supported
}

export function createFluidAudioBackendCommand(options: FluidAudioCommandOptions): string[] {
  return [
    options.binaryPath,
    "--backend",
    options.backend,
    "--assets",
    options.assetsPath,
  ]
}

export function createFluidAudioEnvironment(homeDir: string): Record<string, string> {
  return {
    CFFIXED_USER_HOME: homeDir,
    HOME: homeDir,
  }
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

async function waitForJob(job: BuildJob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (!signal) return job.promise
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    job.promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", abort))
  })
}

export class FluidAudioBuilder {
  readonly cacheDir: string

  constructor(readonly homeDir: string) {
    this.cacheDir = join(resolve(homeDir), "tools", `fluidaudio-${FLUIDAUDIO_BUILD_VERSION}`)
  }

  async findBinary(): Promise<string | undefined> {
    const conveniencePath = join(this.cacheDir, "release", FLUIDAUDIO_PRODUCT)
    if (await isExecutable(conveniencePath)) return conveniencePath
    try {
      const entries = await readdir(this.cacheDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const candidate = join(this.cacheDir, entry.name, "release", FLUIDAUDIO_PRODUCT)
        if (await isExecutable(candidate)) return candidate
      }
    } catch {}
    return undefined
  }

  async build(options: FluidAudioBuildOptions = {}): Promise<string> {
    options.signal?.throwIfAborted()
    let job = builds.get(this.cacheDir)
    while (job?.controller.signal.aborted) {
      await job.promise.catch(() => undefined)
      job = builds.get(this.cacheDir)
    }
    if (!job) {
      const cached = await this.findBinary()
      if (cached) return cached
      job = builds.get(this.cacheDir)
    }
    if (!job) {
      const controller = new AbortController()
      const listeners = new Set<(detail: string) => void>()
      job = {
        controller,
        listeners,
        users: 0,
        promise: this.performBuild(controller.signal, options.logPath, (detail) => {
          for (const listener of listeners) listener(detail)
        }).finally(() => {
          if (builds.get(this.cacheDir) === job) builds.delete(this.cacheDir)
        }),
      }
      builds.set(this.cacheDir, job)
    }

    job.users += 1
    if (options.onStatus) job.listeners.add(options.onStatus)
    try {
      return await waitForJob(job, options.signal)
    } finally {
      if (options.onStatus) job.listeners.delete(options.onStatus)
      job.users -= 1
      if (job.users === 0 && builds.get(this.cacheDir) === job) job.controller.abort()
    }
  }

  private async performBuild(
    signal: AbortSignal,
    logPath: string | undefined,
    onStatus: (detail: string) => void,
  ): Promise<string> {
    if (!(await commandExists("swift", ["--version"]))) {
      throw new Error("The CoreML ANE runtime requires Swift 6 and the Xcode command-line tools")
    }
    onStatus("Building pinned FluidAudio CoreML sidecar")
    const common = [
      "--package-path",
      SWIFT_PACKAGE_PATH,
      "--scratch-path",
      this.cacheDir,
      "-c",
      "release",
    ]
    await runProcess(["swift", "build", ...common, "--product", FLUIDAUDIO_PRODUCT], {
      signal,
      logPath,
      onLine: (line) => onStatus(line),
    })
    const binPath = (await runProcess(["swift", "build", ...common, "--show-bin-path"], {
      signal,
      logPath,
    })).trim()
    const binary = join(binPath, FLUIDAUDIO_PRODUCT)
    if (!(await isExecutable(binary))) throw new Error("Swift completed without producing the FluidAudio sidecar")
    return binary
  }
}
