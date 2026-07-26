/*
 * Adapted and modified from kokoro-js 1.2.1 at commit
 * 664c76a704021239ba59c84dcbaa4d3dece01fe9 (src/kokoro.js and src/voices.js).
 * The original and this adapted file are licensed under Apache-2.0; see
 * LICENSE-APACHE-2.0 and THIRD_PARTY_NOTICES. Changes narrow the implementation
 * to non-streaming English synthesis, package-local voice files, and TypeScript.
 */

import { readFile } from "node:fs/promises"
import { RawAudio, Tensor } from "@huggingface/transformers"
import { KOKORO_VOICE_IDS, type KokoroVoiceId } from "./catalog.js"
import { phonemize } from "./phonemize.js"

export { normalizeText } from "./phonemize.js"

const STYLE_DIM = 256
const SAMPLE_RATE = 24_000
const voiceIds = new Set<string>(KOKORO_VOICE_IDS)
const voiceCache = new Map<KokoroVoiceId, Float32Array>()

export type KokoroModel = ((inputs: {
  input_ids: Tensor
  style: Tensor
  speed: Tensor
}) => Promise<{ waveform: { data: Float32Array } }>) & {
  dispose?: () => void | Promise<void>
}

export type KokoroTokenizer = (
  text: string,
  options: { truncation: true },
) => { input_ids: Tensor }

export function validateVoice(voice: string): KokoroVoiceId {
  if (!voiceIds.has(voice)) {
    throw new Error(`Voice "${voice}" not found. Should be one of: ${KOKORO_VOICE_IDS.join(", ")}.`)
  }
  return voice as KokoroVoiceId
}

export function getVoicePath(voice: string): URL {
  return new URL(`../voices/${validateVoice(voice)}.bin`, import.meta.url)
}

export async function getVoiceData(voice: string): Promise<Float32Array> {
  const id = validateVoice(voice)
  const cached = voiceCache.get(id)
  if (cached) return cached

  const bytes = await readFile(getVoicePath(id))
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`Invalid Kokoro voice tensor byte length for ${id}: ${bytes.byteLength}`)
  }
  const exactBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const data = new Float32Array(exactBuffer)
  voiceCache.set(id, data)
  return data
}

export function selectVoiceStyle(data: Float32Array, tokenCountWithSpecialTokens: number): Float32Array {
  const tokenCount = Math.min(Math.max(tokenCountWithSpecialTokens - 2, 0), 509)
  const offset = tokenCount * STYLE_DIM
  return data.slice(offset, offset + STYLE_DIM)
}

export class KokoroEnglishTTS {
  constructor(
    readonly model: KokoroModel,
    readonly tokenizer: KokoroTokenizer,
  ) {}

  async generate(text: string, { voice = "af_heart", speed = 1 }: { voice?: string; speed?: number } = {}): Promise<RawAudio> {
    const id = validateVoice(voice)
    const language = id.startsWith("a") ? "a" : "b"
    const phonemes = await phonemize(text, language)
    const { input_ids } = this.tokenizer(phonemes, { truncation: true })
    return this.generateFromIds(input_ids, { voice: id, speed })
  }

  async generateFromIds(
    inputIds: Tensor,
    { voice = "af_heart", speed = 1 }: { voice?: string; speed?: number } = {},
  ): Promise<RawAudio> {
    const data = await getVoiceData(voice)
    const style = selectVoiceStyle(data, inputIds.dims.at(-1) ?? 0)
    const { waveform } = await this.model({
      input_ids: inputIds,
      style: new Tensor("float32", style, [1, STYLE_DIM]),
      speed: new Tensor("float32", [speed], [1]),
    })
    return new RawAudio(waveform.data, SAMPLE_RATE)
  }
}
