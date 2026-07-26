import {
  getDefaultSynthesisParameters,
  normalizeSynthesisParameters,
  type SynthesisParameterDefinition,
  type SynthesisNumberParameterDefinition,
  type SynthesisParameterValue,
  type SynthesisParameters,
} from "kokoro-local-runtime/core"
import { MODEL_BY_ID } from "../models.js"
import type { ModelId } from "../types.js"

export function getModelSynthesisParameterDefinitions(
  modelId: ModelId,
  runtimeId: string = MODEL_BY_ID[modelId].defaultRuntimeId,
): readonly SynthesisParameterDefinition[] {
  const model = MODEL_BY_ID[modelId]
  const runtime = model.runtimes.find((candidate) => candidate.id === runtimeId)
  if (!runtime) throw new Error(`Unknown ${model.name} runtime: ${runtimeId}`)
  return runtime.parameters
}

export function getDefaultModelSynthesisParameters(
  modelId: ModelId,
  runtimeId?: string,
): SynthesisParameters {
  return getDefaultSynthesisParameters(getModelSynthesisParameterDefinitions(modelId, runtimeId))
}

export function normalizeModelSynthesisParameters(
  modelId: ModelId,
  parameters?: SynthesisParameters,
  runtimeId?: string,
): SynthesisParameters {
  return normalizeSynthesisParameters(getModelSynthesisParameterDefinitions(modelId, runtimeId), parameters)
}

export function recoverModelSynthesisParameters(
  modelId: ModelId,
  parameters: unknown,
  runtimeId?: string,
): SynthesisParameters {
  const definitions = getModelSynthesisParameterDefinitions(modelId, runtimeId)
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    return getDefaultSynthesisParameters(definitions)
  }
  const supplied = parameters as Record<string, unknown>
  return Object.fromEntries(definitions.map((definition) => {
    if (!Object.hasOwn(supplied, definition.id)) return [definition.id, definition.default]
    try {
      const value = normalizeSynthesisParameters(
        [definition],
        { [definition.id]: supplied[definition.id] as SynthesisParameterValue },
      )[definition.id]
      return [definition.id, value]
    } catch {
      return [definition.id, definition.default]
    }
  }))
}

export function serializeModelSynthesisParameters(
  modelId: ModelId,
  parameters: SynthesisParameters,
  runtimeId?: string,
): string {
  const normalized = normalizeModelSynthesisParameters(modelId, parameters, runtimeId)
  const ordered = Object.fromEntries(
    getModelSynthesisParameterDefinitions(modelId, runtimeId).map(({ id }) => [id, normalized[id]]),
  )
  return JSON.stringify(ordered)
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase()
  if (!text.includes("e")) return (text.split(".")[1] ?? "").length
  const [coefficient, exponentText] = text.split("e")
  const exponent = Number(exponentText)
  return Math.max(0, (coefficient?.split(".")[1] ?? "").length - exponent)
}

export function stepSynthesisNumber(
  definition: SynthesisNumberParameterDefinition,
  value: number,
  direction: -1 | 1,
): number {
  const step = definition.step ?? 1
  const places = Math.max(
    decimalPlaces(definition.min),
    decimalPlaces(definition.max),
    decimalPlaces(step),
    decimalPlaces(value),
  )
  const scale = 10 ** places
  const next = Math.round(value * scale) + direction * Math.round(step * scale)
  const clamped = Math.max(Math.round(definition.min * scale), Math.min(Math.round(definition.max * scale), next))
  return clamped / scale
}

export function adjustSynthesisParameter(
  definition: SynthesisParameterDefinition,
  value: SynthesisParameterValue,
  direction: -1 | 1,
): SynthesisParameterValue {
  if (definition.type === "number") {
    return stepSynthesisNumber(definition, value as number, direction)
  }
  if (definition.type === "boolean") return !value

  const current = definition.options.findIndex((option) => option.value === value)
  const index = current < 0 ? 0 : (current + direction + definition.options.length) % definition.options.length
  return definition.options[index]?.value ?? definition.default
}

export function formatSynthesisParameterValue(
  definition: SynthesisParameterDefinition,
  value: SynthesisParameterValue,
): string {
  if (definition.type === "boolean") return value ? "On" : "Off"
  if (definition.type === "enum") {
    return definition.options.find((option) => option.value === value)?.label ?? String(value)
  }
  if (definition.step === undefined) return String(value)
  const places = Math.max(decimalPlaces(definition.min), decimalPlaces(definition.step))
  return (value as number).toFixed(places)
}

export function describeSynthesisParameter(definition: SynthesisParameterDefinition): string {
  if (definition.description) return definition.description
  if (definition.type === "boolean") return "Toggle on or off"
  if (definition.type === "enum") return definition.options.map((option) => option.label).join(" / ")
  const step = definition.step ?? 1
  return `${formatSynthesisParameterValue(definition, definition.min)} to ${formatSynthesisParameterValue(definition, definition.max)} · step ${step}`
}
