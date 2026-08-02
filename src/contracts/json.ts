export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | Array<JsonValue> | JsonObject

export interface JsonObject {
  [key: string]: JsonValue | undefined
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>
): boolean {
  const keys = Object.keys(value).sort()
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  )
}

export function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

export function isCanonicalUtcIso(value: unknown): value is string {
  if (typeof value !== "string") return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

export function isNullableCanonicalUtcIso(
  value: unknown
): value is string | null {
  return value === null || isCanonicalUtcIso(value)
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

export function cloneJsonObject(
  value: Record<string, unknown>
): JsonObject | null {
  try {
    const text = JSON.stringify(value)
    if (typeof text !== "string") return null
    const parsed: unknown = JSON.parse(text)
    return isPlainObject(parsed) ? (parsed as JsonObject) : null
  } catch {
    return null
  }
}
