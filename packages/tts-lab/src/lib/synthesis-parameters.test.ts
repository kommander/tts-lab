import { expect, test } from "bun:test"
import { SynthesisParameterError } from "kokoro-local-runtime/core"
import {
  adjustSynthesisParameter,
  describeSynthesisParameter,
  formatSynthesisParameterValue,
  getDefaultModelSynthesisParameters,
  getModelSynthesisParameterDefinitions,
  normalizeModelSynthesisParameters,
  recoverModelSynthesisParameters,
  serializeModelSynthesisParameters,
  stepSynthesisNumber,
} from "./synthesis-parameters.js"

test("exposes runtime-specific synthesis schemas and defaults", () => {
  expect(getDefaultModelSynthesisParameters("kokoro")).toEqual({ speed: 1 })
  expect(getModelSynthesisParameterDefinitions("kokoro", "javascript-onnx-q8")[0]?.id).toBe("speed")
  expect(getDefaultModelSynthesisParameters("kitten")).toEqual({ speed: 1 })
  expect(getDefaultModelSynthesisParameters("pocket")).toEqual({ temperature: "stable", deEss: true })
  expect(getDefaultModelSynthesisParameters("qwen")).toEqual({ temperature: "stable", seed: 42 })
  expect(getDefaultModelSynthesisParameters("piper")).toEqual({ speed: "normal" })
  expect(getDefaultModelSynthesisParameters("melo")).toEqual({ speed: 1 })
  expect(getDefaultModelSynthesisParameters("parler")).toEqual({
    rate: "moderate",
    pitch: "natural",
    expression: "slight",
  })
  expect(getDefaultModelSynthesisParameters("f5")).toEqual({
    speed: 1,
    nfeSteps: 32,
    seed: 42,
    crossFade: 0.15,
    removeSilence: false,
  })
})

test("recovers invalid persisted values independently and ignores unknown values", () => {
  expect(recoverModelSynthesisParameters("qwen", {
    temperature: "expressive",
    seed: -1,
    removedSetting: true,
  })).toEqual({ temperature: "expressive", seed: 42 })
  expect(recoverModelSynthesisParameters("pocket", "invalid")).toEqual({
    temperature: "stable",
    deEss: true,
  })
})

test("serializes normalized parameters in schema order", () => {
  expect(serializeModelSynthesisParameters("f5", {
    removeSilence: false,
    crossFade: 0.1 + 0.05,
    seed: 42,
    nfeSteps: 32,
    speed: 1,
  })).toBe('{"speed":1,"nfeSteps":32,"seed":42,"crossFade":0.15,"removeSilence":false}')
  expect(normalizeModelSynthesisParameters("kokoro", { speed: 1.1 + 0.1 })).toEqual({ speed: 1.2 })
})

test("normalizes model parameters with generic validation and preserves enum strings", () => {
  expect(normalizeModelSynthesisParameters("qwen", { temperature: "expressive", seed: 7 })).toEqual({
    temperature: "expressive",
    seed: 7,
  })
  expect(normalizeModelSynthesisParameters("f5", { nfeSteps: 16 })).toEqual({
    speed: 1,
    nfeSteps: 16,
    seed: 42,
    crossFade: 0.15,
    removeSilence: false,
  })
  expect(() => normalizeModelSynthesisParameters("pocket", { temperature: 0.3 })).toThrow(
    SynthesisParameterError,
  )
  expect(() => normalizeModelSynthesisParameters("f5", { nfeSteps: 15 })).toThrow(
    SynthesisParameterError,
  )
  expect(() => normalizeModelSynthesisParameters("melo", { internal: 1 })).toThrow(
    SynthesisParameterError,
  )
  expect(() => getModelSynthesisParameterDefinitions("qwen", "missing")).toThrow("Unknown Qwen3-TTS runtime")
})

test("steps decimal numbers exactly and clamps at both bounds", () => {
  const speed = getModelSynthesisParameterDefinitions("f5")[0]!
  const crossFade = getModelSynthesisParameterDefinitions("f5")[3]!
  if (speed.type !== "number" || crossFade.type !== "number") throw new Error("Expected number definitions")

  expect(stepSynthesisNumber(speed, 1, 1)).toBe(1.1)
  expect(stepSynthesisNumber(speed, 1.1, 1)).toBe(1.2)
  expect(stepSynthesisNumber(speed, 2, 1)).toBe(2)
  expect(stepSynthesisNumber(speed, 0.3, -1)).toBe(0.3)
  expect(stepSynthesisNumber(crossFade, 0.15, 1)).toBe(0.16)
  expect(stepSynthesisNumber(crossFade, 0.15, -1)).toBe(0.14)
})

test("toggles booleans and cycles enums in both directions", () => {
  const deEss = getModelSynthesisParameterDefinitions("pocket")[1]!
  const temperature = getModelSynthesisParameterDefinitions("pocket")[0]!

  expect(adjustSynthesisParameter(deEss, true, 1)).toBe(false)
  expect(adjustSynthesisParameter(deEss, false, -1)).toBe(true)
  expect(adjustSynthesisParameter(temperature, "stable", 1)).toBe("upstream")
  expect(adjustSynthesisParameter(temperature, "deterministic", -1)).toBe("upstream")
})

test("formats schema values and fallback descriptions for display", () => {
  const definitions = getModelSynthesisParameterDefinitions("f5")
  expect(formatSynthesisParameterValue(definitions[0]!, 1)).toBe("1.0")
  expect(formatSynthesisParameterValue(definitions[1]!, 32)).toBe("32")
  expect(formatSynthesisParameterValue(definitions[3]!, 0.15)).toBe("0.15")
  expect(formatSynthesisParameterValue(definitions[4]!, false)).toBe("Off")
  expect(describeSynthesisParameter(definitions[3]!)).toBe("0.00 to 1.00 · step 0.01")
})
