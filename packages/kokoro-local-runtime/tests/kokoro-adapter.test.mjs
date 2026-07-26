import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import { test } from "node:test"
import { Tensor } from "@huggingface/transformers"
import { KOKORO_VOICE_IDS, KOKORO_VOICES } from "../dist/catalog.js"
import {
  KokoroEnglishTTS,
  getVoicePath,
  normalizeText,
  selectVoiceStyle,
  validateVoice,
} from "../dist/kokoro-adapter.js"

test("maps every exposed English voice to a bundled module-relative tensor", async () => {
  assert.equal(KOKORO_VOICE_IDS.length, 28)
  assert.deepEqual(KOKORO_VOICE_IDS, KOKORO_VOICES.map(({ id }) => id))
  for (const voice of KOKORO_VOICE_IDS) {
    const path = getVoicePath(voice)
    assert.equal(path.pathname.endsWith(`/voices/${voice}.bin`), true)
    assert.equal((await stat(path)).size, 522_240)
  }
  assert.throws(() => validateVoice("../af_heart"), /not found/)
})

test("preserves upstream normalization and selects style by input length", () => {
  assert.equal(normalizeText("Dr. Smith paid $2.50 at 9:05 (yeah)."), "Doctor Smith paid 2 dollars and 50 cents at 9 oh 5 «ye'a». ".trim())
  const styles = new Float32Array(510 * 256)
  styles.fill(7, 3 * 256, 4 * 256)
  assert.deepEqual([...selectVoiceStyle(styles, 5)], new Array(256).fill(7))
  assert.deepEqual([...selectVoiceStyle(styles, 1)], new Array(256).fill(0))
})

test("passes token, style, and speed tensors to the model and returns 24 kHz audio", async () => {
  let inputs
  const model = async (value) => {
    inputs = value
    return { waveform: { data: new Float32Array([0.25, -0.25]) } }
  }
  const tts = new KokoroEnglishTTS(model, () => {
    throw new Error("generateFromIds should not tokenize")
  })
  const inputIds = new Tensor("int64", [0n, 1n, 2n, 3n, 4n], [1, 5])
  const audio = await tts.generateFromIds(inputIds, { voice: "af_heart", speed: 1.25 })
  assert.equal(inputs.input_ids, inputIds)
  assert.deepEqual(inputs.style.dims, [1, 256])
  assert.deepEqual([...inputs.speed.data], [1.25])
  assert.equal(audio.sampling_rate, 24_000)
  assert.deepEqual([...audio.data], [0.25, -0.25])
})
