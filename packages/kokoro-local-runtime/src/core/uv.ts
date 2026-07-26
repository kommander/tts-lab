import { constants } from "node:fs"
import { access, mkdir, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { commandExists, runProcess } from "./process.js"

export interface UvBootstrapEvent {
  type: "status" | "line"
  stage: "create" | "install"
  detail: string
}

export interface UvBootstrapOptions {
  uvDir: string
  version: string
  signal?: AbortSignal
  logPath?: string
  onEvent?: (event: UvBootstrapEvent) => void
}

interface UvBootstrapJob {
  controller: AbortController
  listeners: Set<(event: UvBootstrapEvent) => void>
  promise: Promise<string>
  users: number
}

const jobs = new Map<string, UvBootstrapJob>()

function envPython(envDir: string): string {
  return process.platform === "win32" ? join(envDir, "Scripts", "python.exe") : join(envDir, "bin", "python")
}

function envUv(envDir: string): string {
  return process.platform === "win32" ? join(envDir, "Scripts", "uv.exe") : join(envDir, "bin", "uv")
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

function emit(job: UvBootstrapJob, event: UvBootstrapEvent): void {
  for (const listener of job.listeners) {
    try {
      listener(event)
    } catch {}
  }
}

function waitForJob<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return promise
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", abort))
  })
}

async function installUv(
  uvDir: string,
  version: string,
  signal: AbortSignal,
  logPath: string | undefined,
  notify: (event: UvBootstrapEvent) => void,
): Promise<string> {
  const uv = envUv(uvDir)
  if (await isExecutable(uv)) return uv
  const systemPython = await commandExists("python3") ? "python3" : await commandExists("python") ? "python" : undefined
  if (!systemPython) throw new Error("Python 3 is required once to bootstrap the local uv installer")
  await mkdir(dirname(uvDir), { recursive: true })
  notify({ type: "status", stage: "create", detail: "Creating local uv bootstrap" })
  await runProcess([systemPython, "-m", "venv", uvDir], { signal, logPath })
  notify({ type: "status", stage: "install", detail: `Installing uv ${version}` })
  await runProcess([envPython(uvDir), "-m", "pip", "install", `uv==${version}`], {
    signal,
    logPath,
    onLine: (line) => notify({ type: "line", stage: "install", detail: line }),
  })
  return uv
}

export async function bootstrapUv(options: UvBootstrapOptions): Promise<string> {
  options.signal?.throwIfAborted()
  const uvDir = resolve(options.uvDir)
  const key = `${uvDir}\0${options.version}`
  let job = jobs.get(key)
  while (job?.controller.signal.aborted) {
    await waitForJob(job.promise, options.signal).catch(() => undefined)
    options.signal?.throwIfAborted()
    job = jobs.get(key)
  }
  if (!job) {
    const controller = new AbortController()
    const created = {
      controller,
      listeners: new Set<(event: UvBootstrapEvent) => void>(),
      users: 0,
    } as UvBootstrapJob
    created.promise = installUv(uvDir, options.version, controller.signal, options.logPath, (event) => emit(created, event))
      .finally(() => {
        if (jobs.get(key) === created) jobs.delete(key)
      })
    job = created
    jobs.set(key, job)
  }

  job.users += 1
  if (options.onEvent) job.listeners.add(options.onEvent)
  try {
    return await waitForJob(job.promise, options.signal)
  } finally {
    if (options.onEvent) job.listeners.delete(options.onEvent)
    job.users -= 1
    if (job.users === 0 && jobs.get(key) === job) {
      job.controller.abort()
      await job.promise.catch(() => undefined)
    }
  }
}
