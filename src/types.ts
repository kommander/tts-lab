export type ModelId = "kokoro" | "piper" | "melo" | "parler" | "f5"

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
  error?: string
}

export interface DemoController {
  snapshot(): Record<ModelId, ModelState>
  subscribe(listener: (state: ModelState) => void): () => void
  ensure(model: ModelId): Promise<void>
  setVoice(model: ModelId, voiceId: string): Promise<void>
  speak(model: ModelId, text: string): Promise<void>
  retry(model: ModelId): Promise<void>
  dispose(): void
}
