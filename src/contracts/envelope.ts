import { API_VERSION } from "../constants.js"
import {
  cloneJsonObject,
  hasExactKeys,
  isCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "./json.js"
import type { JsonObject, JsonValue } from "./json.js"

export const PUBLIC_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "INVALID_CREDENTIAL",
  "CREDENTIAL_EXPIRED",
  "USER_DISABLED",
  "OWNER_REQUIRED",
  "CAPABILITY_DENIED",
  "RESOURCE_NOT_FOUND",
  "TIKTOK_AUTH_UNAVAILABLE",
  "TIKTOK_AUTH_ID_REQUIRED",
  "TIKTOK_AUTH_INVALID_FOR_ACCOUNT",
  "RESOURCE_BUSY",
  "IDEMPOTENCY_CONFLICT",
  "RESOURCE_OPERATION_UNSUPPORTED",
  "RESOURCE_STATE_INCOMPLETE",
  "RATE_LIMITED",
  "DAILY_QUOTA_EXCEEDED",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_ERROR",
  "DEPENDENCY_UNAVAILABLE",
] as const)

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number]
const PUBLIC_ERROR_CODE_SET = new Set<string>(PUBLIC_ERROR_CODES)

export const LOCAL_ERROR_CODES = Object.freeze([
  "LOCAL_STATE_UNSAFE",
  "LOCAL_CREDENTIAL_MISMATCH",
  "LOCAL_PRIOR_CREDENTIAL_PENDING",
  "LOCAL_PENDING_COMMAND_EXISTS",
  "LOCAL_RESOURCE_INTENT_CONFLICT",
  "LOCAL_IDEMPOTENCY_CONFLICT",
] as const)

export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number]
export type CliErrorCode = PublicErrorCode | LocalErrorCode

export interface PublicUsageBucket {
  limit: number | null
  remaining: number | null
  resetAt: string | null
}

export interface PublicMinuteUsageBucket extends PublicUsageBucket {
  burst: number | null
}

export interface PublicUsage {
  operationUnits: 0 | 1 | 2 | 3
  operationUnitsCharged: 0 | 1 | 2 | 3 | null
  minute: PublicMinuteUsageBucket
  writeMinute: PublicUsageBucket
  dailyTikTokUnits: PublicUsageBucket
}

export interface PublicMeta extends JsonObject {
  requestId: string
  apiVersion: typeof API_VERSION
  usage?: PublicUsage & JsonObject
  _notice?: JsonObject
  /**
   * 仅由 CLI 从可信 HTTP Retry-After Header 注入，不接受服务端 body 自报。
   */
  retryAfterSeconds?: number
}

export interface PublicSuccessEnvelope extends JsonObject {
  ok: true
  data: JsonObject
  meta: PublicMeta
}

export interface PublicErrorEnvelope extends JsonObject {
  ok: false
  error: {
    code: PublicErrorCode
    message: string
    retryable: boolean
    details: JsonObject
  } & JsonObject
  meta: PublicMeta
}

export type PublicEnvelope = PublicSuccessEnvelope | PublicErrorEnvelope

export interface LocalErrorEnvelope extends JsonObject {
  ok: false
  error: {
    code: LocalErrorCode
    message: string
    retryable: false
    details: JsonObject
  } & JsonObject
  meta: PublicMeta
}

export type CliErrorEnvelope = PublicErrorEnvelope | LocalErrorEnvelope
export type CliEnvelope = PublicSuccessEnvelope | CliErrorEnvelope

function parseBucket(value: unknown): PublicUsageBucket | null {
  if (!isPlainObject(value)) return null
  const { limit, remaining, resetAt } = value
  if (
    !(
      limit === null || isSafeIntegerInRange(limit, 0, Number.MAX_SAFE_INTEGER)
    ) ||
    !(
      remaining === null ||
      isSafeIntegerInRange(remaining, 0, Number.MAX_SAFE_INTEGER)
    ) ||
    !(resetAt === null || isCanonicalUtcIso(resetAt))
  ) {
    return null
  }
  return { limit, remaining, resetAt }
}

function parseUsage(value: unknown): PublicUsage | null {
  if (!isPlainObject(value)) return null
  const operationUnits = value.operationUnits
  const operationUnitsCharged = value.operationUnitsCharged
  if (
    !(
      operationUnits === 0 ||
      operationUnits === 1 ||
      operationUnits === 2 ||
      operationUnits === 3
    ) ||
    !(
      operationUnitsCharged === null ||
      operationUnitsCharged === 0 ||
      operationUnitsCharged === 1 ||
      operationUnitsCharged === 2 ||
      operationUnitsCharged === 3
    )
  ) {
    return null
  }
  const minuteBase = parseBucket(value.minute)
  const writeMinute = parseBucket(value.writeMinute)
  const dailyTikTokUnits = parseBucket(value.dailyTikTokUnits)
  if (
    !minuteBase ||
    !isPlainObject(value.minute) ||
    !(
      value.minute.burst === null ||
      isSafeIntegerInRange(value.minute.burst, 0, Number.MAX_SAFE_INTEGER)
    ) ||
    !writeMinute ||
    !dailyTikTokUnits
  ) {
    return null
  }
  return {
    operationUnits,
    operationUnitsCharged,
    minute: { ...minuteBase, burst: value.minute.burst },
    writeMinute,
    dailyTikTokUnits,
  }
}

function parseMeta(value: unknown): PublicMeta | null {
  if (
    !isPlainObject(value) ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.apiVersion !== API_VERSION
  ) {
    return null
  }
  if (value.usage !== undefined && !parseUsage(value.usage)) return null
  if (value._notice !== undefined && !isPlainObject(value._notice)) return null
  if (value.retryAfterSeconds !== undefined) return null
  const clone = cloneJsonObject(value)
  if (!clone) return null
  return clone as PublicMeta
}

export type EnvelopeDecodeResult =
  | { ok: true; envelope: PublicEnvelope }
  | { ok: false; reason: "invalid_json" | "invalid_envelope" }

export function decodePublicEnvelope(text: string): EnvelopeDecodeResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: "invalid_json" }
  }
  if (!isPlainObject(raw)) return { ok: false, reason: "invalid_envelope" }
  const meta = parseMeta(raw.meta)
  if (!meta) return { ok: false, reason: "invalid_envelope" }
  const clone = cloneJsonObject(raw)
  if (!clone) return { ok: false, reason: "invalid_envelope" }

  if (
    raw.ok === true &&
    hasExactKeys(raw, ["ok", "data", "meta"]) &&
    isPlainObject(raw.data)
  ) {
    return {
      ok: true,
      envelope: {
        ...clone,
        ok: true,
        data: clone.data as JsonObject,
        meta,
      },
    }
  }
  if (
    raw.ok === false &&
    hasExactKeys(raw, ["ok", "error", "meta"]) &&
    isPlainObject(raw.error) &&
    hasExactKeys(raw.error, ["code", "message", "retryable", "details"]) &&
    typeof raw.error.code === "string" &&
    PUBLIC_ERROR_CODE_SET.has(raw.error.code) &&
    typeof raw.error.message === "string" &&
    typeof raw.error.retryable === "boolean" &&
    isPlainObject(raw.error.details)
  ) {
    return {
      ok: true,
      envelope: {
        ...clone,
        ok: false,
        error: clone.error as PublicErrorEnvelope["error"],
        meta,
      },
    }
  }
  return { ok: false, reason: "invalid_envelope" }
}

export function createLocalMeta(requestId: string): PublicMeta {
  return {
    requestId,
    apiVersion: API_VERSION,
  }
}

export function createLocalSuccess(
  requestId: string,
  data: JsonObject,
  extraMeta: JsonObject = {}
): PublicSuccessEnvelope {
  return {
    ok: true,
    data,
    meta: {
      ...extraMeta,
      ...createLocalMeta(requestId),
    },
  }
}

export function createLocalError(
  requestId: string,
  code: PublicErrorCode,
  message: string,
  retryable: boolean,
  details?: JsonObject
): PublicErrorEnvelope
export function createLocalError(
  requestId: string,
  code: LocalErrorCode,
  message: string,
  retryable: false,
  details?: JsonObject
): LocalErrorEnvelope
export function createLocalError(
  requestId: string,
  code: CliErrorCode,
  message: string,
  retryable: boolean,
  details: JsonObject = {}
): CliErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      details: {
        suggestedAction: null,
        resolutionUrl: null,
        ...details,
      } as JsonObject,
    },
    meta: createLocalMeta(requestId),
  } as CliErrorEnvelope
}

export function findOperationUnitsCharged(
  envelope: PublicEnvelope
): JsonValue | undefined {
  return envelope.meta.usage?.operationUnitsCharged
}
