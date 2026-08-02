import { LOWERCASE_UUID_PATTERN } from "../constants.js"
import {
  hasExactKeys,
  isCanonicalUtcIso,
  isNullableCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "./json.js"
import type { PublicSuccessEnvelope } from "./envelope.js"

const CAPABILITY_IDS = new Set([
  "identity.read",
  "connections.read",
  "ads.campaign.read",
  "ads.report.read",
  "ads.campaign.status.write",
])
const CAPABILITY_RISKS = new Set(["low", "medium", "high"])
const CAPABILITY_RATE_CLASSES = new Set([
  "public_read",
  "upstream_read",
  "public_write",
])
const CAPABILITY_UNAVAILABLE_REASONS = new Set([
  "credential_scope_missing",
  "principal_kind_not_allowed",
  "team_product_unavailable",
  "team_frozen_for_writes",
  "resource_state_unavailable",
  "channel_not_allowed",
])
const PLAN_TYPES = new Set(["free", "starter", "standard", "pro", "enterprise"])
const BENEFIT_STATUSES = new Set([
  "normal",
  "warning",
  "exceeded",
  "grace",
  "past_due",
  "frozen",
])

function hasAsciiControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code <= 0x1f || code === 0x7f)
  })
}

function isNullableNonNegativeInteger(value: unknown): boolean {
  return value === null || isSafeIntegerInRange(value, 0)
}

function isCapabilitySummary(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "capabilityId",
      "granted",
      "available",
      "unavailableReason",
      "risk",
      "rateClass",
      "operationUnits",
      "idempotencyRequired",
    ]) &&
    typeof value.capabilityId === "string" &&
    CAPABILITY_IDS.has(value.capabilityId) &&
    typeof value.granted === "boolean" &&
    typeof value.available === "boolean" &&
    (value.unavailableReason === null ||
      (typeof value.unavailableReason === "string" &&
        CAPABILITY_UNAVAILABLE_REASONS.has(value.unavailableReason))) &&
    typeof value.risk === "string" &&
    CAPABILITY_RISKS.has(value.risk) &&
    typeof value.rateClass === "string" &&
    CAPABILITY_RATE_CLASSES.has(value.rateClass) &&
    isSafeIntegerInRange(value.operationUnits, 0, 3) &&
    typeof value.idempotencyRequired === "boolean"
  )
}

function isCapabilities(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== CAPABILITY_IDS.size)
    return false
  if (!value.every(isCapabilitySummary)) return false
  return new Set(value.map((item) => item.capabilityId)).size === value.length
}

function isSubject(value: unknown): boolean {
  return (
    value === null ||
    (isPlainObject(value) &&
      hasExactKeys(value, ["userId", "nickname"]) &&
      isSafeIntegerInRange(value.userId, 1) &&
      (value.nickname === null ||
        (typeof value.nickname === "string" &&
          !hasAsciiControlCharacters(value.nickname))))
  )
}

function isPlan(value: unknown): boolean {
  return (
    value === null ||
    (isPlainObject(value) &&
      hasExactKeys(value, [
        "planType",
        "benefitStatus",
        "publicApiRequestsPerMinute",
        "publicApiRequestBurst",
        "publicApiWritesPerMinute",
        "publicApiTikTokUnitsPerDay",
      ]) &&
      typeof value.planType === "string" &&
      PLAN_TYPES.has(value.planType) &&
      typeof value.benefitStatus === "string" &&
      BENEFIT_STATUSES.has(value.benefitStatus) &&
      isNullableNonNegativeInteger(value.publicApiRequestsPerMinute) &&
      isNullableNonNegativeInteger(value.publicApiRequestBurst) &&
      isNullableNonNegativeInteger(value.publicApiWritesPerMinute) &&
      isNullableNonNegativeInteger(value.publicApiTikTokUnitsPerDay))
  )
}

export interface MeFacts {
  credentialId: string
  teamId: number
  teamName: string
  activationExpiresAt: string | null
  idleExpiresAt: string | null
  absoluteExpiresAt: string
}

export type MeFactsDecodeResult =
  | { kind: "valid"; facts: MeFacts }
  | { kind: "contract_invalid" }
  | { kind: "identity_mismatch"; actualCredentialId: string }

export function decodeMeFacts(
  envelope: PublicSuccessEnvelope,
  expectedCredentialId: string
): MeFactsDecodeResult {
  const data = envelope.data
  if (
    !hasExactKeys(data, [
      "principal",
      "subject",
      "team",
      "capabilities",
      "credential",
      "plan",
    ]) ||
    !isPlainObject(data.principal) ||
    !hasExactKeys(data.principal, ["kind", "credentialId"]) ||
    data.principal.kind !== "owner_cli_session" ||
    typeof data.principal.credentialId !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(data.principal.credentialId)
  ) {
    return { kind: "contract_invalid" }
  }
  const credentialId = data.principal.credentialId
  if (
    !isPlainObject(data.team) ||
    !hasExactKeys(data.team, ["teamId", "teamName"]) ||
    !isSafeIntegerInRange(data.team.teamId, 1) ||
    typeof data.team.teamName !== "string" ||
    data.team.teamName.length === 0 ||
    hasAsciiControlCharacters(data.team.teamName) ||
    !isPlainObject(data.credential) ||
    !hasExactKeys(data.credential, [
      "activationExpiresAt",
      "idleExpiresAt",
      "absoluteExpiresAt",
    ]) ||
    !isNullableCanonicalUtcIso(data.credential.activationExpiresAt) ||
    !isNullableCanonicalUtcIso(data.credential.idleExpiresAt) ||
    !isCanonicalUtcIso(data.credential.absoluteExpiresAt) ||
    !isSubject(data.subject) ||
    !isCapabilities(data.capabilities) ||
    !isPlan(data.plan)
  ) {
    return { kind: "contract_invalid" }
  }
  const activationExpiresAt = data.credential.activationExpiresAt
  const idleExpiresAt = data.credential.idleExpiresAt
  const absoluteExpiresAt = data.credential.absoluteExpiresAt
  // /me 成功发生在服务端激活 CAS 之后。OAuth Token 交付阶段的
  // activation 形态不能被当成 PublicMe 的合法成功合同。
  if (
    activationExpiresAt !== null ||
    idleExpiresAt === null ||
    Date.parse(idleExpiresAt) > Date.parse(absoluteExpiresAt)
  ) {
    return { kind: "contract_invalid" }
  }
  if (credentialId !== expectedCredentialId) {
    return {
      kind: "identity_mismatch",
      actualCredentialId: credentialId,
    }
  }
  return {
    kind: "valid",
    facts: {
      credentialId,
      teamId: data.team.teamId,
      teamName: data.team.teamName,
      activationExpiresAt,
      idleExpiresAt,
      absoluteExpiresAt,
    },
  }
}
