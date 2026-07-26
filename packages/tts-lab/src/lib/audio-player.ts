import { Audio, type AudioSound } from "@opentui/core"
import FFT from "fft.js"

const SAMPLE_RATE = 48_000
const FFT_SIZE = 1024
const BAND_COUNT = 16
const MIN_FREQUENCY = 60
const MAX_FREQUENCY = 16_000
const DB_FLOOR = -72
const DB_CEILING = -6

export class AudioPlayer {
  private readonly audio = Audio.create({ autoStart: false, sampleRate: SAMPLE_RATE })
  private readonly fft = new FFT(FFT_SIZE)
  private readonly fftInput = new Float32Array(FFT_SIZE)
  private readonly fftOutput = this.fft.createComplexArray()
  private readonly fftWindow = new Float32Array(FFT_SIZE)
  private readonly spectrum = new Float32Array(BAND_COUNT)
  private readonly spectrumListeners = new Set<(levels: number[]) => void>()
  private sound: AudioSound | null = null
  private errorHandler?: (message: string) => void
  private analysisTimer?: ReturnType<typeof setInterval>
  private lastAnalyzedFrame = -1n
  private windowSum = 0

  constructor() {
    this.audio.on("error", (error, context) => this.errorHandler?.(`${context.action}: ${error.message}`))
    this.audio.enableTap(4096)
    for (let index = 0; index < FFT_SIZE; index += 1) {
      const value = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1)))
      this.fftWindow[index] = value
      this.windowSum += value
    }
  }

  onError(handler: (message: string) => void): void {
    this.errorHandler = handler
  }

  getSpectrum(): number[] {
    return Array.from(this.spectrum)
  }

  subscribeSpectrum(listener: (levels: number[]) => void): () => void {
    this.spectrumListeners.add(listener)
    listener(this.getSpectrum())
    if (!this.analysisTimer) {
      this.analysisTimer = setInterval(() => this.updateSpectrum(), 50)
      this.analysisTimer.unref?.()
    }
    return () => {
      this.spectrumListeners.delete(listener)
      if (this.spectrumListeners.size === 0 && this.analysisTimer) {
        clearInterval(this.analysisTimer)
        this.analysisTimer = undefined
      }
    }
  }

  async play(path: string): Promise<void> {
    if (this.sound !== null) {
      if (!this.audio.unloadSound(this.sound)) throw new Error("OpenTUI could not unload the previous sound")
      this.sound = null
    }
    const sound = await this.audio.loadSoundFile(path)
    if (sound === null) throw new Error("OpenTUI could not decode the generated WAV")
    this.sound = sound
    if (!this.audio.isStarted() && !this.audio.start()) throw new Error("OpenTUI could not start the audio device")
    if (this.audio.play(sound) === null) throw new Error("OpenTUI could not allocate a playback voice")
  }

  dispose(): void {
    if (this.analysisTimer) clearInterval(this.analysisTimer)
    this.analysisTimer = undefined
    this.spectrumListeners.clear()
    this.audio.dispose()
  }

  private updateSpectrum(): void {
    const stats = this.audio.getStats()
    let changed = false
    if (stats && stats.voicesActive > 0 && stats.framesMixed !== this.lastAnalyzedFrame) {
      this.lastAnalyzedFrame = stats.framesMixed
      const tap = this.audio.readTapFrames(FFT_SIZE, 2)
      if (tap && tap.framesRead >= FFT_SIZE) changed = this.computeSpectrum(tap.frames)
    } else {
      for (let index = 0; index < this.spectrum.length; index += 1) {
        const previous = this.spectrum[index] ?? 0
        const next = previous < 0.005 ? 0 : previous * 0.82
        if (Math.abs(previous - next) > 0.001) changed = true
        this.spectrum[index] = next
      }
    }
    if (!changed) return
    const snapshot = this.getSpectrum()
    for (const listener of this.spectrumListeners) listener(snapshot)
  }

  private computeSpectrum(frames: Float32Array): boolean {
    for (let index = 0; index < FFT_SIZE; index += 1) {
      const left = frames[index * 2] ?? 0
      const right = frames[index * 2 + 1] ?? left
      this.fftInput[index] = (left + right) * 0.5 * this.fftWindow[index]!
    }
    this.fft.realTransform(this.fftOutput, this.fftInput)

    let changed = false
    for (let band = 0; band < BAND_COUNT; band += 1) {
      const low = MIN_FREQUENCY * (MAX_FREQUENCY / MIN_FREQUENCY) ** (band / BAND_COUNT)
      const high = MIN_FREQUENCY * (MAX_FREQUENCY / MIN_FREQUENCY) ** ((band + 1) / BAND_COUNT)
      const firstBin = Math.max(1, Math.floor((low * FFT_SIZE) / SAMPLE_RATE))
      const lastBin = Math.min(FFT_SIZE / 2, Math.ceil((high * FFT_SIZE) / SAMPLE_RATE))
      let magnitude = 0
      for (let bin = firstBin; bin < lastBin; bin += 1) {
        const real = this.fftOutput[bin * 2] ?? 0
        const imaginary = this.fftOutput[bin * 2 + 1] ?? 0
        magnitude = Math.max(magnitude, (2 * Math.hypot(real, imaginary)) / this.windowSum)
      }
      const decibels = 20 * Math.log10(Math.max(magnitude, 1e-8))
      const incoming = Math.max(0, Math.min(1, (decibels - DB_FLOOR) / (DB_CEILING - DB_FLOOR)))
      const previous = this.spectrum[band] ?? 0
      const next = incoming > previous ? incoming : previous * 0.76 + incoming * 0.24
      if (Math.abs(previous - next) > 0.001) changed = true
      this.spectrum[band] = next
    }
    return changed
  }
}
