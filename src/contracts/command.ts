import {
  IDEMPOTENCY_KEY_PATTERN,
  LOWERCASE_UUID_PATTERN,
} from "../constants.js"
import {
  hasExactKeys,
  isCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "./json.js"
import { isValidResourceId } from "./resource-input.js"

const COMMAND_KEYS = [
  "commandId",
  "idempotencyKey",
  "capabilityId",
  "status",
  "isFinal",
  "reason",
  "suggestedAction",
  "target",
  "beforeStatus",
  "afterStatus",
  "verificationBasis",
  "attemptCount",
  "createdAt",
  "startedAt",
  "completedAt",
  "recoverableUntil",
  "lastReconcileAt",
] as const

const COMMAND_STATUSES = new Set<PublicCommandDto["status"]>([
  "pending",
  "executing",
  "succeeded",
  "failed",
  "unknown",
])
const COMMAND_REASONS = new Set<Exclude<PublicCommandReason, null>>([
  "daily_quota_exceeded",
  "precondition_failed_before_write",
  "upstream_rejected",
  "upstream_invalid_response",
  "resource_not_found",
  "resource_state_incomplete",
  "resource_operation_unsupported",
  "expired_before_execution",
  "recovery_window_expired",
])
const OBSERVED_STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const DAY_MS = 86_400_000

export type PublicCommandReason =
  | "daily_quota_exceeded"
  | "precondition_failed_before_write"
  | "upstream_rejected"
  | "upstream_invalid_response"
  | "resource_not_found"
  | "resource_state_incomplete"
  | "resource_operation_unsupported"
  | "expired_before_execution"
  | "recovery_window_expired"
  | null

export interface PublicCommandDto {
  commandId: string
  idempotencyKey: string
  capabilityId: "ads.campaign.status.write"
  status: "pending" | "executing" | "succeeded" | "failed" | "unknown"
  isFinal: boolean
  reason: PublicCommandReason
  suggestedAction: "query_command" | "choose_auth" | null
  target: {
    advertiserId: string
    campaignId: string
    desiredStatus: "ENABLE" | "DISABLE"
  }
  beforeStatus: string | null
  afterStatus: string | null
  verificationBasis: "verified_no_op" | "observed_target_state" | null
  attemptCount: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  recoverableUntil: string | null
  lastReconcileAt: string | null
}

function nullableCanonicalIso(value: unknown): value is string | null {
  return value === null || isCanonicalUtcIso(value)
}

function nullableObservedStatus(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && OBSERVED_STATUS_PATTERN.test(value))
  )
}

function canonicalAddDays(value: string, days: number): string | null {
  try {
    return new Date(new Date(value).getTime() + days * DAY_MS).toISOString()
  } catch {
    return null
  }
}

/**
 * 严格消费 T08 的 PublicCommandDto。除字段 allowlist 外还复核状态、时间、
 * attempt 与恢复窗口的交叉不变量，避免把畸形 2xx 当成可安全重放证据。
 */
export function decodePublicCommandDto(
  value: unknown
): PublicCommandDto | null {
  if (!isPlainObject(value) || !hasExactKeys(value, COMMAND_KEYS)) return null
  if (!isPlainObject(value.target)) return null
  if (
    !hasExactKeys(value.target, [
      "advertiserId",
      "campaignId",
      "desiredStatus",
    ]) ||
    !isValidResourceId(value.target.advertiserId, "advId") ||
    !isValidResourceId(value.target.campaignId, "campaignId") ||
    (value.target.desiredStatus !== "ENABLE" &&
      value.target.desiredStatus !== "DISABLE")
  ) {
    return null
  }
  if (
    typeof value.commandId !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(value.commandId) ||
    typeof value.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    value.capabilityId !== "ads.campaign.status.write" ||
    typeof value.status !== "string" ||
    !COMMAND_STATUSES.has(value.status as PublicCommandDto["status"]) ||
    typeof value.isFinal !== "boolean" ||
    !(
      value.reason === null ||
      (typeof value.reason === "string" &&
        COMMAND_REASONS.has(value.reason as Exclude<PublicCommandReason, null>))
    ) ||
    !(
      value.suggestedAction === null ||
      value.suggestedAction === "query_command" ||
      value.suggestedAction === "choose_auth"
    ) ||
    !nullableObservedStatus(value.beforeStatus) ||
    !nullableObservedStatus(value.afterStatus) ||
    !(
      value.verificationBasis === null ||
      value.verificationBasis === "verified_no_op" ||
      value.verificationBasis === "observed_target_state"
    ) ||
    !isSafeIntegerInRange(value.attemptCount, 0) ||
    !isCanonicalUtcIso(value.createdAt) ||
    !nullableCanonicalIso(value.startedAt) ||
    !nullableCanonicalIso(value.completedAt) ||
    !nullableCanonicalIso(value.recoverableUntil) ||
    !nullableCanonicalIso(value.lastReconcileAt)
  ) {
    return null
  }

  const status = value.status as PublicCommandDto["status"]
  const reason = value.reason as PublicCommandReason
  const target = {
    advertiserId: value.target.advertiserId,
    campaignId: value.target.campaignId,
    desiredStatus: value.target.desiredStatus,
  } as const
  const attemptFactsAreConsistent =
    value.attemptCount === 0
      ? value.startedAt === null
      : value.startedAt !== null && value.beforeStatus !== null
  const pendingUntil = canonicalAddDays(value.createdAt, 1)
  const recoveryUntil = canonicalAddDays(value.createdAt, 7)
  const stateIsConsistent = (() => {
    switch (status) {
      case "pending":
        return (
          !value.isFinal &&
          reason === null &&
          value.suggestedAction === "query_command" &&
          value.verificationBasis === null &&
          value.afterStatus === null &&
          attemptFactsAreConsistent &&
          value.completedAt === null &&
          value.recoverableUntil === pendingUntil
        )
      case "executing":
        return (
          !value.isFinal &&
          reason === null &&
          value.suggestedAction === "query_command" &&
          value.verificationBasis === null &&
          value.beforeStatus !== null &&
          value.afterStatus === null &&
          value.attemptCount >= 1 &&
          attemptFactsAreConsistent &&
          value.completedAt === null &&
          value.recoverableUntil === recoveryUntil
        )
      case "succeeded":
        return (
          value.isFinal &&
          reason === null &&
          value.suggestedAction === null &&
          value.verificationBasis !== null &&
          (value.verificationBasis === "verified_no_op"
            ? value.beforeStatus === target.desiredStatus &&
              value.afterStatus === null
            : value.beforeStatus !== null &&
              value.afterStatus === target.desiredStatus &&
              value.attemptCount >= 1) &&
          attemptFactsAreConsistent &&
          value.completedAt !== null &&
          value.recoverableUntil === null
        )
      case "failed":
        return (
          value.isFinal &&
          reason !== null &&
          reason !== "recovery_window_expired" &&
          (value.suggestedAction === null ||
            value.suggestedAction === "choose_auth") &&
          value.verificationBasis === null &&
          attemptFactsAreConsistent &&
          value.completedAt !== null &&
          value.recoverableUntil === null
        )
      case "unknown":
        return (
          value.attemptCount >= 1 &&
          attemptFactsAreConsistent &&
          value.beforeStatus !== null &&
          (value.isFinal
            ? reason === "recovery_window_expired" &&
              value.suggestedAction === null &&
              value.verificationBasis === null &&
              value.completedAt !== null &&
              value.recoverableUntil === null
            : reason === null &&
              value.suggestedAction === "query_command" &&
              value.verificationBasis === null &&
              value.completedAt === null &&
              value.recoverableUntil === recoveryUntil)
        )
    }
  })()
  if (!stateIsConsistent) return null

  return Object.freeze({
    commandId: value.commandId,
    idempotencyKey: value.idempotencyKey,
    capabilityId: "ads.campaign.status.write",
    status,
    isFinal: value.isFinal,
    reason,
    suggestedAction: value.suggestedAction,
    target: Object.freeze(target),
    beforeStatus: value.beforeStatus,
    afterStatus: value.afterStatus,
    verificationBasis: value.verificationBasis,
    attemptCount: value.attemptCount,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    recoverableUntil: value.recoverableUntil,
    lastReconcileAt: value.lastReconcileAt,
  })
}

export function decodePublicCommandData(
  value: unknown
): { command: PublicCommandDto } | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["command"])) return null
  const command = decodePublicCommandDto(value.command)
  return command ? Object.freeze({ command }) : null
}
