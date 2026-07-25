export type ModelId = "kokoro" | "kitten" | "pocket" | "piper" | "melo" | "parler" | "f5"

export type ModelPhase =
  | "idle"
  | "bootstrap"
  | "setup"
  | "download"
  | "verify"
  | "ready"
  | "generating"
  | "playing"
  | "error"

export interface ModelState {
  id: ModelId
  voiceId: string
  runtimeId: string
  installed: boolean
  phase: ModelPhase
  detail: string
  setupProgress: number | null
  downloadedBytes: number
  totalBytes: number
  generationProgress: number | null
  resident: boolean
  lastLatency?: {
    warm: boolean
    loadMs: number
    generationMs: number
    playbackMs: number
  }
  runtimeStats?: {
    sampleCount: number
    averageGenerationMs: number
    medianGenerationMs: number
    minGenerationMs: number
    maxGenerationMs: number
    appRssBytes: number
    appHeapUsedBytes: number
    workerRssBytes?: number
    workerPeakRssBytes?: number
  }
  error?: string
}

export interface LatestAudio {
  model: ModelId
  voiceId: string
  format: "wav"
}

export interface DemoController {
  snapshot(): Record<ModelId, ModelState>
  subscribe(listener: (state: ModelState) => void): () => void
  getSpectrum(): number[]
  subscribeSpectrum(listener: (levels: number[]) => void): () => void
  getLatestAudio(): LatestAudio | null
  saveLatestAudio(path: string): Promise<string>
  ensure(model: ModelId): Promise<void>
  setVoice(model: ModelId, voiceId: string): Promise<void>
  setRuntime(model: ModelId, runtimeId: string): Promise<void>
  speak(model: ModelId, text: string): Promise<void>
  retry(model: ModelId): Promise<void>
  dispose(): void
}
