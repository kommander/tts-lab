import assert from "node:assert/strict"
import { test } from "node:test"
import {
  SynthesisParameterError,
  getDefaultSynthesisParameters,
  normalizeSynthesisParameters,
} from "../../dist/core/index.js"

const definitions = [
  { id: "speed", label: "Speed", type: "number", default: 1, min: 0.5, max: 2, step: 0.1 },
  { id: "enabled", label: "Enabled", type: "boolean", default: true },
  {
    id: "mode",
    label: "Mode",
    type: "enum",
    default: "balanced",
    options: [{ value: "balanced", label: "Balanced" }, { value: "fast", label: "Fast" }],
  },
]

test("fills defaults and strictly normalizes generic synthesis parameters", () => {
  assert.deepEqual(getDefaultSynthesisParameters(definitions), {
    speed: 1,
    enabled: true,
    mode: "balanced",
  })
  assert.deepEqual(normalizeSynthesisParameters(definitions, {
    speed: 1.2,
    enabled: false,
    mode: "fast",
  }), {
    speed: 1.2,
    enabled: false,
    mode: "fast",
  })
})

test("rejects unknown, mistyped, non-finite, out-of-policy, and unsupported values", () => {
  for (const parameters of [
    { unknown: true },
    { speed: "1" },
    { speed: Number.NaN },
    { speed: 2.1 },
    { speed: 1.15 },
    { enabled: 1 },
    { mode: "other" },
  ]) {
    assert.throws(() => normalizeSynthesisParameters(definitions, parameters), SynthesisParameterError)
  }
  assert.throws(() => normalizeSynthesisParameters(definitions, []), /must be an object/)
})

test("validates numeric schemas and canonicalizes scientific-notation steps", () => {
  const tiny = [{ id: "tiny", label: "Tiny", type: "number", default: 1e-7, min: 0, max: 1e-6, step: 1e-7 }]
  assert.deepEqual(normalizeSynthesisParameters(tiny, { tiny: 0.1e-6 + 0.2e-6 }), { tiny: 3e-7 })
  const offset = [{ id: "offset", label: "Offset", type: "number", default: 1.2e-7, min: 1e-7, max: 2e-7, step: 2e-8 }]
  assert.deepEqual(normalizeSynthesisParameters(offset, { offset: 1.5999999999999998e-7 }), { offset: 1.6e-7 })

  for (const definition of [
    { ...tiny[0], min: Number.NaN },
    { ...tiny[0], max: Number.POSITIVE_INFINITY },
    { ...tiny[0], default: Number.NaN },
    { ...tiny[0], min: 2, max: 1 },
    { ...tiny[0], step: 0 },
    { ...tiny[0], step: -1 },
    { ...tiny[0], step: Number.NaN },
    { ...tiny[0], default: -1e-7 },
    { ...tiny[0], default: 1.5e-7 },
  ]) {
    assert.throws(() => normalizeSynthesisParameters([definition]), SynthesisParameterError)
    assert.throws(() => getDefaultSynthesisParameters([definition]), SynthesisParameterError)
  }
})

test("validates enum schemas before returning defaults or normalizing values", () => {
  const valid = { id: "mode", label: "Mode", type: "enum", default: "a", options: [{ value: "a", label: "A" }] }
  for (const definition of [
    { ...valid, options: [] },
    { ...valid, options: [{ value: "a", label: "A" }, { value: "a", label: "Again" }] },
    { ...valid, default: "missing" },
  ]) {
    assert.throws(() => normalizeSynthesisParameters([definition]), SynthesisParameterError)
    assert.throws(() => getDefaultSynthesisParameters([definition]), SynthesisParameterError)
  }
})
