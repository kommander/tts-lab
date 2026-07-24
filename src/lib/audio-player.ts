import { Audio, type AudioSound } from "@opentui/core"

export class AudioPlayer {
  private readonly audio = Audio.create({ autoStart: false })
  private sound: AudioSound | null = null
  private errorHandler?: (message: string) => void

  constructor() {
    this.audio.on("error", (error, context) => this.errorHandler?.(`${context.action}: ${error.message}`))
  }

  onError(handler: (message: string) => void): void {
    this.errorHandler = handler
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
    this.audio.dispose()
  }
}
