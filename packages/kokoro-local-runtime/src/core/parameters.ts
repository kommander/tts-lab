export type SynthesisParameterValue = number | boolean | string

export type SynthesisParameters = Readonly<Record<string, SynthesisParameterValue>>

interface SynthesisParameterDefinitionBase {
  id: string
  label: string
  description?: string
}

export interface SynthesisNumberParameterDefinition extends SynthesisParameterDefinitionBase {
  type: "number"
  default: number
  min: number
  max: number
  step?: number
}

export interface SynthesisBooleanParameterDefinition extends SynthesisParameterDefinitionBase {
  type: "boolean"
  default: boolean
}

export interface SynthesisEnumParameterOption {
  value: string
  label: string
}

export interface SynthesisEnumParameterDefinition extends SynthesisParameterDefinitionBase {
  type: "enum"
  default: string
  options: readonly SynthesisEnumParameterOption[]
}

export type SynthesisParameterDefinition =
  | SynthesisNumberParameterDefinition
  | SynthesisBooleanParameterDefinition
  | SynthesisEnumParameterDefinition

export class SynthesisParameterError extends TypeError {
  override readonly name = "SynthesisParameterError"

  constructor(
    message: string,
    readonly parameterId?: string,
  ) {
    super(message)
  }
}

interface Decimal {
  coefficient: bigint
  exponent: number
}

function decimal(value: number): Decimal {
  const [mantissa = "0", exponentText] = String(value).toLowerCase().split("e")
  const negative = mantissa.startsWith("-")
  const unsigned = negative ? mantissa.slice(1) : mantissa
  const [whole = "0", fraction = ""] = unsigned.split(".")
  const coefficient = BigInt(`${negative ? "-" : ""}${whole}${fraction}`)
  return { coefficient, exponent: Number(exponentText ?? 0) - fraction.length }
}

function canonicalStepValue(min: number, step: number, steps: number): number {
  const minimum = decimal(min)
  const increment = decimal(step)
  const count = decimal(steps)
  const product = {
    coefficient: increment.coefficient * count.coefficient,
    exponent: increment.exponent + count.exponent,
  }
  const exponent = Math.min(minimum.exponent, product.exponent)
  const coefficient = minimum.coefficient * 10n ** BigInt(minimum.exponent - exponent)
    + product.coefficient * 10n ** BigInt(product.exponent - exponent)
  if (coefficient === 0n) return 0
  return Number(`${coefficient}e${exponent}`)
}

function alignedStepValue(value: number, min: number, step: number): number | undefined {
  const steps = (value - min) / step
  if (!Number.isFinite(steps)) return undefined
  const roundedSteps = Math.round(steps)
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(steps)) * 8
  if (Math.abs(steps - roundedSteps) > tolerance) return undefined
  return canonicalStepValue(min, step, roundedSteps)
}

function validateNumberDefinition(definition: SynthesisNumberParameterDefinition): void {
  if (![definition.min, definition.max, definition.default].every(Number.isFinite)) {
    throw new SynthesisParameterError(`${definition.id} numeric schema values must be finite`, definition.id)
  }
  if (definition.min > definition.max) {
    throw new SynthesisParameterError(`${definition.id} minimum must not exceed maximum`, definition.id)
  }
  if (definition.step !== undefined && (!Number.isFinite(definition.step) || definition.step <= 0)) {
    throw new SynthesisParameterError(`${definition.id} step must be a finite positive number`, definition.id)
  }
  if (definition.default < definition.min || definition.default > definition.max) {
    throw new SynthesisParameterError(
      `${definition.id} default must be between ${definition.min} and ${definition.max}`,
      definition.id,
    )
  }
  if (definition.step !== undefined
    && alignedStepValue(definition.default, definition.min, definition.step) === undefined) {
    throw new SynthesisParameterError(`${definition.id} default must use increments of ${definition.step}`, definition.id)
  }
}

function validateEnumDefinition(definition: SynthesisEnumParameterDefinition): void {
  if (definition.options.length === 0) {
    throw new SynthesisParameterError(`${definition.id} options must not be empty`, definition.id)
  }
  const values = definition.options.map((option) => option.value)
  if (new Set(values).size !== values.length) {
    throw new SynthesisParameterError(`${definition.id} options must be unique`, definition.id)
  }
  if (!values.includes(definition.default)) {
    throw new SynthesisParameterError(`${definition.id} default must be included in its options`, definition.id)
  }
}

function validateDefinitions(definitions: readonly SynthesisParameterDefinition[]): void {
  for (const definition of definitions) {
    if (definition.type === "number") validateNumberDefinition(definition)
    else if (definition.type === "enum") validateEnumDefinition(definition)
  }
}

export function getDefaultSynthesisParameters(
  definitions: readonly SynthesisParameterDefinition[],
): SynthesisParameters {
  validateDefinitions(definitions)
  return Object.fromEntries(definitions.map((definition) => [definition.id, definition.default]))
}

export function normalizeSynthesisParameters(
  definitions: readonly SynthesisParameterDefinition[],
  parameters?: SynthesisParameters,
): SynthesisParameters {
  validateDefinitions(definitions)
  if (parameters !== undefined && (parameters === null || typeof parameters !== "object" || Array.isArray(parameters))) {
    throw new SynthesisParameterError("Synthesis parameters must be an object")
  }

  const supplied = parameters ?? {}
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))
  for (const id of Object.keys(supplied)) {
    if (!byId.has(id)) throw new SynthesisParameterError(`Unknown synthesis parameter: ${id}`, id)
  }

  const normalized: Record<string, SynthesisParameterValue> = {}
  for (const definition of definitions) {
    const value = Object.hasOwn(supplied, definition.id) ? supplied[definition.id] : definition.default
    if (definition.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SynthesisParameterError(`${definition.id} must be a finite number`, definition.id)
      }
      if (value < definition.min || value > definition.max) {
        throw new SynthesisParameterError(
          `${definition.id} must be between ${definition.min} and ${definition.max}`,
          definition.id,
        )
      }
      if (definition.step !== undefined) {
        const canonical = alignedStepValue(value, definition.min, definition.step)
        if (canonical === undefined) {
          throw new SynthesisParameterError(`${definition.id} must use increments of ${definition.step}`, definition.id)
        }
        normalized[definition.id] = canonical
        continue
      }
    } else if (definition.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new SynthesisParameterError(`${definition.id} must be a boolean`, definition.id)
      }
    } else if (typeof value !== "string" || !definition.options.some((option) => option.value === value)) {
      throw new SynthesisParameterError(
        `${definition.id} must be one of: ${definition.options.map((option) => option.value).join(", ")}`,
        definition.id,
      )
    }
    normalized[definition.id] = value
  }
  return normalized
}
