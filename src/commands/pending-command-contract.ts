import { createHash } from "node:crypto"
import {
  IDEMPOTENCY_KEY_PATTERN,
  LOWERCASE_UUID_PATTERN,
  PRODUCTION_MACHINE_ORIGIN,
  REQUEST_ID_PATTERN,
  TEST_MACHINE_ORIGIN,
} from "../constants.js"
import {
  hasExactKeys,
  isCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "../contracts/json.js"
import { isTransportableResourceId } from "../contracts/resource-input.js"

export const PENDING_COMMAND_FORMAT_VERSION = 1 as const
export const PENDING_COMMAND_CAPABILITY = "ads.campaign.status.write" as const
export const PENDING_COMMAND_RECORD_ID_PATTERN = /^[0-9a-f]{64}$/

const LOCAL_STATES = new Set<PendingCommandLocalState>([
  "prepared",
  "command_known",
  "response_unknown",
  "expired_unsubmitted",
  "orphaned_credential",
])
const MACHINE_ORIGINS = new Set([
  PRODUCTION_MACHINE_ORIGIN,
  TEST_MACHINE_ORIGIN,
])

export type PendingCommandLocalState =
  | "prepared"
  | "command_known"
  | "response_unknown"
  | "expired_unsubmitted"
  | "orphaned_credential"

export interface PendingCommandIntent {
  advId: string
  campaignId: string
  desiredStatus: "ENABLE" | "DISABLE"
  authId: number | null
}

export interface PendingCommandLastResponse {
  requestId: string | null
  httpStatus: number | null
  errorCode: string | null
}

export interface PendingCommandRecord {
  formatVersion: typeof PENDING_COMMAND_FORMAT_VERSION
  idempotencyKey: string
  capabilityId: typeof PENDING_COMMAND_CAPABILITY
  credentialKind: "owner_cli_session"
  credentialId: string
  issuerOrigin: string
  teamId: number
  intent: PendingCommandIntent
  intentHash: string
  localState: PendingCommandLocalState
  commandId: string | null
  createdAt: string
  updatedAt: string
  lastResponse: PendingCommandLastResponse | null
}

export interface PendingCredentialScope {
  credentialId: string
  issuerOrigin: string
  teamId: number
}

export interface NewPendingCommandRecord extends PendingCredentialScope {
  idempotencyKey: string
  intent: PendingCommandIntent
  now: Date
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function pendingRecordId(idempotencyKey: string): string {
  return sha256Hex(idempotencyKey)
}

export function canonicalPendingIntent(intent: PendingCommandIntent): string {
  return JSON.stringify({
    advId: intent.advId,
    campaignId: intent.campaignId,
    desiredStatus: intent.desiredStatus,
    authId: intent.authId,
  })
}

export function pendingIntentHash(intent: PendingCommandIntent): string {
  return sha256Hex(canonicalPendingIntent(intent))
}

export function pendingIntentsEqual(
  left: PendingCommandIntent,
  right: PendingCommandIntent
): boolean {
  return canonicalPendingIntent(left) === canonicalPendingIntent(right)
}

export function pendingCredentialScopeMatches(
  record: PendingCommandRecord,
  scope: PendingCredentialScope
): boolean {
  return (
    record.credentialId === scope.credentialId &&
    record.issuerOrigin === scope.issuerOrigin &&
    record.teamId === scope.teamId
  )
}

export function pendingRecordsHaveSameIdentity(
  left: PendingCommandRecord,
  right: PendingCommandRecord
): boolean {
  return (
    left.idempotencyKey === right.idempotencyKey &&
    left.credentialId === right.credentialId &&
    left.issuerOrigin === right.issuerOrigin &&
    left.teamId === right.teamId &&
    left.intentHash === right.intentHash &&
    pendingIntentsEqual(left.intent, right.intent) &&
    left.createdAt === right.createdAt
  )
}

export function createPreparedPendingCommand(
  input: NewPendingCommandRecord
): PendingCommandRecord {
  if (!Number.isFinite(input.now.getTime())) {
    throw new TypeError("Pending Command time must be valid.")
  }
  const timestamp = input.now.toISOString()
  const value: PendingCommandRecord = {
    formatVersion: PENDING_COMMAND_FORMAT_VERSION,
    idempotencyKey: input.idempotencyKey,
    capabilityId: PENDING_COMMAND_CAPABILITY,
    credentialKind: "owner_cli_session",
    credentialId: input.credentialId,
    issuerOrigin: input.issuerOrigin,
    teamId: input.teamId,
    intent: { ...input.intent },
    intentHash: pendingIntentHash(input.intent),
    localState: "prepared",
    commandId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastResponse: null,
  }
  const parsed = parsePendingCommandRecord(value)
  if (!parsed) throw new TypeError("Pending Command input is invalid.")
  return parsed
}

function parseIntent(value: unknown): PendingCommandIntent | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["advId", "campaignId", "desiredStatus", "authId"]) ||
    !isTransportableResourceId(value.advId, "advId") ||
    !isTransportableResourceId(value.campaignId, "campaignId") ||
    (value.desiredStatus !== "ENABLE" && value.desiredStatus !== "DISABLE") ||
    !(
      value.authId === null ||
      isSafeIntegerInRange(value.authId, 1, Number.MAX_SAFE_INTEGER)
    )
  ) {
    return null
  }
  return {
    advId: value.advId,
    campaignId: value.campaignId,
    desiredStatus: value.desiredStatus,
    authId: value.authId,
  }
}

function parseLastResponse(
  value: unknown
): PendingCommandLastResponse | null | false {
  if (value === null) return null
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["requestId", "httpStatus", "errorCode"]) ||
    !(
      value.requestId === null ||
      (typeof value.requestId === "string" &&
        REQUEST_ID_PATTERN.test(value.requestId))
    ) ||
    !(
      value.httpStatus === null ||
      isSafeIntegerInRange(value.httpStatus, 100, 599)
    ) ||
    !(
      value.errorCode === null ||
      (typeof value.errorCode === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode))
    )
  ) {
    return false
  }
  return {
    requestId: value.requestId,
    httpStatus: value.httpStatus,
    errorCode: value.errorCode,
  }
}

export function parsePendingCommandRecord(
  value: unknown
): PendingCommandRecord | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "formatVersion",
      "idempotencyKey",
      "capabilityId",
      "credentialKind",
      "credentialId",
      "issuerOrigin",
      "teamId",
      "intent",
      "intentHash",
      "localState",
      "commandId",
      "createdAt",
      "updatedAt",
      "lastResponse",
    ]) ||
    value.formatVersion !== PENDING_COMMAND_FORMAT_VERSION ||
    typeof value.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    value.capabilityId !== PENDING_COMMAND_CAPABILITY ||
    value.credentialKind !== "owner_cli_session" ||
    typeof value.credentialId !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(value.credentialId) ||
    typeof value.issuerOrigin !== "string" ||
    !MACHINE_ORIGINS.has(value.issuerOrigin) ||
    !isSafeIntegerInRange(value.teamId, 1) ||
    typeof value.intentHash !== "string" ||
    !PENDING_COMMAND_RECORD_ID_PATTERN.test(value.intentHash) ||
    typeof value.localState !== "string" ||
    !LOCAL_STATES.has(value.localState as PendingCommandLocalState) ||
    !(
      value.commandId === null ||
      (typeof value.commandId === "string" &&
        LOWERCASE_UUID_PATTERN.test(value.commandId))
    ) ||
    !isCanonicalUtcIso(value.createdAt) ||
    !isCanonicalUtcIso(value.updatedAt) ||
    new Date(value.updatedAt).getTime() < new Date(value.createdAt).getTime()
  ) {
    return null
  }
  const intent = parseIntent(value.intent)
  const lastResponse = parseLastResponse(value.lastResponse)
  if (
    !intent ||
    lastResponse === false ||
    pendingIntentHash(intent) !== value.intentHash ||
    (value.localState === "prepared" && value.commandId !== null) ||
    (value.localState === "command_known" && value.commandId === null)
  ) {
    return null
  }
  return Object.freeze({
    formatVersion: PENDING_COMMAND_FORMAT_VERSION,
    idempotencyKey: value.idempotencyKey,
    capabilityId: PENDING_COMMAND_CAPABILITY,
    credentialKind: "owner_cli_session",
    credentialId: value.credentialId,
    issuerOrigin: value.issuerOrigin,
    teamId: value.teamId,
    intent: Object.freeze(intent),
    intentHash: value.intentHash,
    localState: value.localState as PendingCommandLocalState,
    commandId: value.commandId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastResponse: lastResponse === null ? null : Object.freeze(lastResponse),
  })
}

export function parsePendingCommandJson(
  text: string
): PendingCommandRecord | null {
  try {
    return parsePendingCommandRecord(JSON.parse(text))
  } catch {
    return null
  }
}

export function serializePendingCommand(record: PendingCommandRecord): string {
  const parsed = parsePendingCommandRecord(record)
  if (!parsed) throw new TypeError("Pending Command record is invalid.")
  return `${JSON.stringify(parsed, null, 2)}\n`
}
