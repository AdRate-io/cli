import { createHash } from "node:crypto"
import {
  IDEMPOTENCY_KEY_PATTERN,
  LOWERCASE_UUID_PATTERN,
  PRODUCTION_MACHINE_ORIGIN,
  REQUEST_ID_PATTERN,
  TEST_MACHINE_ORIGIN,
} from "../constants.js"
import {
  hasKeys,
  isCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "../contracts/json.js"
import { isTransportableResourceId } from "../contracts/resource-input.js"
import {
  getCliCommandFamily,
  isPendingCommandCapability,
} from "./command-families.js"
import type {
  PendingCommandCapabilityId,
  PendingCommandIntent,
} from "./command-families.js"

export type { PendingCommandIntent }

export const PENDING_COMMAND_FORMAT_VERSION = 2 as const
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

export interface PendingCommandLastResponse {
  requestId: string | null
  httpStatus: number | null
  errorCode: string | null
}

export interface PendingCommandRecord {
  formatVersion: typeof PENDING_COMMAND_FORMAT_VERSION
  idempotencyKey: string
  capabilityId: PendingCommandCapabilityId
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
  capabilityId: PendingCommandCapabilityId
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
  const family = getCliCommandFamily(intent.capabilityId)
  if (!family) {
    throw new TypeError(`Unknown Command family: ${intent.capabilityId}`)
  }
  const base: Record<string, unknown> = {
    capabilityId: intent.capabilityId,
    advId: intent.advId,
    campaignId: intent.campaignId,
    authId: intent.authId,
  }
  for (const [key, value] of family.intentCanonicalFields(
    intent.familyPayload
  )) {
    base[key] = value
  }
  return JSON.stringify(base)
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
  if (input.capabilityId !== input.intent.capabilityId) {
    throw new TypeError(
      "Pending Command capabilityId must match intent.capabilityId."
    )
  }
  if (!Number.isFinite(input.now.getTime())) {
    throw new TypeError("Pending Command time must be valid.")
  }
  const timestamp = input.now.toISOString()
  const value: PendingCommandRecord = {
    formatVersion: PENDING_COMMAND_FORMAT_VERSION,
    idempotencyKey: input.idempotencyKey,
    capabilityId: input.capabilityId,
    credentialKind: "owner_cli_session",
    credentialId: input.credentialId,
    issuerOrigin: input.issuerOrigin,
    teamId: input.teamId,
    intent: {
      ...input.intent,
      familyPayload: { ...input.intent.familyPayload },
    },
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

/**
 * 从 v2 intent.familyPayload 严格解析家族特有字段。
 * 先由家族的 intentCanonicalFields 提取可序列化字段，
 * 再做家族级值域校验（status: enum 校验；budget: mode set + value > 0）。
 */
function parseFamilyPayload(
  capabilityId: PendingCommandCapabilityId,
  raw: unknown
): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null
  const family = getCliCommandFamily(capabilityId)
  if (!family) return null
  const obj = raw
  const fields = family.intentCanonicalFields(obj)
  const result: Record<string, unknown> = {}
  for (const [key, value] of fields) {
    if (value === undefined) return null
    result[key] = value
  }
  // 用归一化后的 result（而非原始 obj）做家族值域校验，
  // 避免 journal 不该出现的字段形态（如 targetBudget）绕过。
  if (!family.decodeTarget(result)) return null
  return result
}

function parseIntent(value: unknown): PendingCommandIntent | null {
  if (
    !isPlainObject(value) ||
    !hasKeys(value, [
      "capabilityId",
      "advId",
      "campaignId",
      "authId",
      "familyPayload",
    ]) ||
    typeof value.capabilityId !== "string" ||
    !isPendingCommandCapability(value.capabilityId) ||
    !isTransportableResourceId(value.advId, "advId") ||
    !isTransportableResourceId(value.campaignId, "campaignId") ||
    !(
      value.authId === null ||
      isSafeIntegerInRange(value.authId, 1, Number.MAX_SAFE_INTEGER)
    )
  ) {
    return null
  }
  const family = getCliCommandFamily(value.capabilityId)
  if (!family || (family.requiresAuthId && value.authId === null)) return null
  const payload = parseFamilyPayload(value.capabilityId, value.familyPayload)
  if (!payload) return null
  return {
    capabilityId: value.capabilityId,
    advId: value.advId,
    campaignId: value.campaignId,
    authId: value.authId,
    familyPayload: payload,
  }
}

/**
 * V1 旧格式 intent 兼容：自动识别为 status 家族。
 * 旧格式：{ advId, campaignId, desiredStatus, authId }（无 capabilityId / familyPayload）
 * 恢复窗 7 天后旧格式自然过期清空，不做迁移脚本。
 */
function parseLegacyV1Intent(value: unknown): PendingCommandIntent | null {
  if (
    !isPlainObject(value) ||
    !hasKeys(value, ["advId", "campaignId", "desiredStatus", "authId"]) ||
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
    capabilityId: "ads.campaign.status.write",
    advId: value.advId,
    campaignId: value.campaignId,
    authId: value.authId,
    familyPayload: { desiredStatus: value.desiredStatus },
  }
}

/**
 * 旧 v1 intent 的规范化序列——保持与旧版 intentHash 完全一致。
 * 旧版 canonicalPendingIntent：JSON.stringify({ advId, campaignId, desiredStatus, authId })
 */
function canonicalV1Intent(intent: PendingCommandIntent): string {
  return JSON.stringify({
    advId: intent.advId,
    campaignId: intent.campaignId,
    desiredStatus: intent.familyPayload.desiredStatus,
    authId: intent.authId,
  })
}

function parseLastResponse(
  value: unknown
): PendingCommandLastResponse | null | false {
  if (value === null) return null
  if (
    !isPlainObject(value) ||
    !hasKeys(value, ["requestId", "httpStatus", "errorCode"]) ||
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
  if (!isPlainObject(value)) return null
  const isV1 = value.formatVersion === 1
  const isV2 = value.formatVersion === PENDING_COMMAND_FORMAT_VERSION
  if (!isV1 && !isV2) return null

  const v = value
  if (
    !hasKeys(v, [
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
    typeof v.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(v.idempotencyKey) ||
    typeof v.capabilityId !== "string" ||
    v.credentialKind !== "owner_cli_session" ||
    typeof v.credentialId !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(v.credentialId) ||
    typeof v.issuerOrigin !== "string" ||
    !MACHINE_ORIGINS.has(v.issuerOrigin) ||
    !isSafeIntegerInRange(v.teamId, 1) ||
    typeof v.intentHash !== "string" ||
    !PENDING_COMMAND_RECORD_ID_PATTERN.test(v.intentHash) ||
    typeof v.localState !== "string" ||
    !LOCAL_STATES.has(v.localState as PendingCommandLocalState) ||
    !(
      v.commandId === null ||
      (typeof v.commandId === "string" &&
        LOWERCASE_UUID_PATTERN.test(v.commandId))
    ) ||
    !isCanonicalUtcIso(v.createdAt) ||
    !isCanonicalUtcIso(v.updatedAt) ||
    new Date(v.updatedAt).getTime() < new Date(v.createdAt).getTime()
  ) {
    return null
  }

  let intent: PendingCommandIntent | null
  let capabilityId: PendingCommandCapabilityId

  if (isV1) {
    // v1 旧格式：capabilityId 字面量为 "ads.campaign.status.write"，
    // intent 是扁平 { advId, campaignId, desiredStatus, authId }。
    // 用 v1 算法验证磁盘 hash，通过后升级为 v2 intent + v2 hash。
    if (v.capabilityId !== "ads.campaign.status.write") return null
    intent = parseLegacyV1Intent(v.intent)
    if (!intent) return null
    capabilityId = "ads.campaign.status.write"
    const v1Hash = sha256Hex(canonicalV1Intent(intent))
    if (v1Hash !== v.intentHash) return null
  } else {
    // v2 新格式：capabilityId 在 PENDING_COMMAND_CAPABILITIES 中，
    // intent 含 capabilityId + familyPayload
    if (!isPendingCommandCapability(v.capabilityId)) return null
    intent = parseIntent(v.intent)
    if (!intent) return null
    // 交叉校验：顶层 capabilityId 必须与 intent 内的一致
    if (intent.capabilityId !== v.capabilityId) return null
    capabilityId = v.capabilityId
    const v2Hash = pendingIntentHash(intent)
    if (v2Hash !== v.intentHash) return null
  }

  // v1 读入后统一升级为 v2 hash，后续 serialize 走 v2 分支时一致
  const normalizedHash = pendingIntentHash(intent)

  const lastResponse = parseLastResponse(v.lastResponse)
  if (
    lastResponse === false ||
    (v.localState === "prepared" && v.commandId !== null) ||
    (v.localState === "command_known" && v.commandId === null)
  ) {
    return null
  }

  return Object.freeze({
    formatVersion: PENDING_COMMAND_FORMAT_VERSION,
    idempotencyKey: v.idempotencyKey,
    capabilityId,
    credentialKind: "owner_cli_session",
    credentialId: v.credentialId,
    issuerOrigin: v.issuerOrigin,
    teamId: v.teamId,
    intent: Object.freeze(intent),
    intentHash: normalizedHash,
    localState: v.localState as PendingCommandLocalState,
    commandId: v.commandId,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
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
