import { usageFailure } from "../errors.js"

export type ResourceKind = "advId" | "campaignId"

export const RESOURCE_ID_LIMITS: Readonly<Record<ResourceKind, number>> =
  Object.freeze({
    advId: 50,
    campaignId: 128,
  })

export const RAW_PATH_SEGMENT_PATTERN = "^(?!\\.{1,2}$)[A-Za-z0-9_!~*'().-]+$"
const RAW_PATH_SEGMENT_REGEX = new RegExp(RAW_PATH_SEGMENT_PATTERN)

function hasForbiddenControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

export function isValidResourceId(
  value: unknown,
  kind: ResourceKind
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !hasForbiddenControlCharacter(value) &&
    [...value].length <= RESOURCE_ID_LIMITS[kind]
  )
}

export function isTransportableResourceId(
  value: unknown,
  kind: ResourceKind
): value is string {
  if (!isValidResourceId(value, kind) || !RAW_PATH_SEGMENT_REGEX.test(value)) {
    return false
  }
  try {
    return encodeURIComponent(value) === value
  } catch {
    return false
  }
}

export function requireTransportableResourceId(
  value: unknown,
  kind: ResourceKind
): string {
  if (!isValidResourceId(value, kind)) {
    throw usageFailure(
      `--${kind === "advId" ? "adv-id" : "campaign-id"} is invalid.`
    )
  }
  if (!isTransportableResourceId(value, kind)) {
    throw usageFailure(
      `--${kind === "advId" ? "adv-id" : "campaign-id"} cannot be transported by the M0 raw-path contract.`
    )
  }
  return value
}

export function parsePositiveInteger(
  value: unknown,
  flag: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > maximum
  ) {
    throw usageFailure(`${flag} must be a positive integer.`)
  }
  return Number(value)
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function monthDays(year: number, month: number): number {
  return (
    [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      month - 1
    ] ?? 0
  )
}

export function parseDateOnly(
  value: unknown,
  flag: string
): {
  value: string
  ordinal: number
} {
  if (typeof value !== "string") {
    throw usageFailure(`${flag} must use YYYY-MM-DD.`)
  }
  const match = DATE_ONLY_PATTERN.exec(value)
  if (!match) throw usageFailure(`${flag} must use YYYY-MM-DD.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays(year, month)
  ) {
    throw usageFailure(`${flag} must be a real calendar date.`)
  }
  const previousYear = year - 1
  let ordinal =
    previousYear * 365 +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400)
  for (let current = 1; current < month; current += 1) {
    ordinal += monthDays(year, current)
  }
  ordinal += day
  return { value, ordinal }
}
