import {
  IDEMPOTENCY_KEY_PATTERN,
  LOWERCASE_UUID_PATTERN,
} from "../constants.js"
import { hasKeys, isPlainObject } from "./json.js"
import { isValidResourceId } from "./resource-input.js"

export interface PublicCommandDto {
  commandId: string
  idempotencyKey: string
  capabilityId: string
  status: string
  isFinal: boolean
  target: {
    advertiserId: string
    campaignId: string
    desiredStatus: "ENABLE" | "DISABLE"
  }
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
    ]) ||
    !isPlainObject(value.target)
  ) {
    return null
  }
  if (
    !hasKeys(value.target, ["advertiserId", "campaignId", "desiredStatus"]) ||
    !isValidResourceId(value.target.advertiserId, "advId") ||
    !isValidResourceId(value.target.campaignId, "campaignId") ||
    (value.target.desiredStatus !== "ENABLE" &&
      value.target.desiredStatus !== "DISABLE") ||
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

  return Object.freeze({
    commandId: value.commandId,
    idempotencyKey: value.idempotencyKey,
    capabilityId: value.capabilityId,
    status: value.status,
    isFinal: value.isFinal,
    target: Object.freeze({
      advertiserId: value.target.advertiserId,
      campaignId: value.target.campaignId,
      desiredStatus: value.target.desiredStatus,
    }),
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
