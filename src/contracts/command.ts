import {
  IDEMPOTENCY_KEY_PATTERN,
  LOWERCASE_UUID_PATTERN,
} from "../constants.js"
import { decodeCommandTarget } from "../commands/command-families.js"
import { hasKeys, isPlainObject } from "./json.js"

export interface PublicCommandDto {
  commandId: string
  idempotencyKey: string
  capabilityId: string
  status: string
  isFinal: boolean
  target: Record<string, unknown>
  beforeStatus: string | null
  afterStatus: string | null
  verificationBasis: string | null
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

/**
 * 只投影 CLI 用于身份匹配和成功判定的字段。
 * 服务端展示字段、新状态和附加字段不属于 CLI 的封闭合同。
 *
 * target 解码按 capabilityId 分派到家族注册表：
 * - status 家族：{ advertiserId, campaignId, desiredStatus }
 * - budget 家族：{ advertiserId, campaignId, mode, value, targetBudget? }
 * 未注册的 capabilityId → null（fail-closed）
 */
export function decodePublicCommandDto(
  value: unknown
): PublicCommandDto | null {
  if (
    !isPlainObject(value) ||
    !hasKeys(value, [
      "commandId",
      "idempotencyKey",
      "capabilityId",
      "status",
      "isFinal",
      "target",
      "beforeStatus",
      "afterStatus",
      "verificationBasis",
    ])
  ) {
    return null
  }
  if (
    typeof value.commandId !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(value.commandId) ||
    typeof value.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) ||
    typeof value.capabilityId !== "string" ||
    value.capabilityId.length === 0 ||
    typeof value.status !== "string" ||
    value.status.length === 0 ||
    typeof value.isFinal !== "boolean" ||
    !nullableString(value.beforeStatus) ||
    !nullableString(value.afterStatus) ||
    !nullableString(value.verificationBasis)
  ) {
    return null
  }

  const target = decodeCommandTarget(value.capabilityId, value.target)
  if (!target) return null

  return Object.freeze({
    commandId: value.commandId,
    idempotencyKey: value.idempotencyKey,
    capabilityId: value.capabilityId,
    status: value.status,
    isFinal: value.isFinal,
    target,
    beforeStatus: value.beforeStatus,
    afterStatus: value.afterStatus,
    verificationBasis: value.verificationBasis,
  })
}

export function decodePublicCommandData(
  value: unknown
): { command: PublicCommandDto } | null {
  if (!isPlainObject(value) || !hasKeys(value, ["command"])) return null
  const command = decodePublicCommandDto(value.command)
  return command ? Object.freeze({ command }) : null
}
