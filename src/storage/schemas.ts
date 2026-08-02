import {
  CLI_VERSION,
  LOWERCASE_UUID_PATTERN,
  REQUEST_ID_PATTERN,
} from "../constants.js"
import {
  assertIssuerPair,
  environmentForMachineOrigin,
  validateBrowserUrl,
} from "../config/issuer.js"
import {
  hasExactKeys,
  isCanonicalUtcIso,
  isNullableCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "../contracts/json.js"
import { PUBLIC_ERROR_CODES } from "../contracts/envelope.js"
import {
  isExactM0Scope,
  isValidDeviceCode,
  isValidUserCode,
} from "../contracts/oauth.js"
import type { CliEnvironment, M0_CAPABILITIES } from "../constants.js"
import type { PublicErrorCode } from "../contracts/envelope.js"

export interface CliConfig {
  configFormatVersion: 1
  issuerOrigin: string
  clientInstanceId: string
  environment: CliEnvironment
}

export type TokenStorageKind = "keychain" | "fallback_file"

export interface TokenStorageCommit {
  transactionId: string
  ownerPid: number
  ownerProcessFingerprint: string
  leaseExpiresAt: string
}

export interface TokenIndex {
  tokenIndexFormatVersion: 1
  generation: string
  state: "staging" | "stored"
  environment: CliEnvironment
  issuerOrigin: string
  credentialKind: "owner_cli_session"
  credentialId: string
  clientInstanceId: string
  deviceGeneration: string
  pollAttemptOwnerToken: string
  deviceName: string | null
  tokenReceivedAt: string
  storageKind: TokenStorageKind
  storageCommit: TokenStorageCommit | null
}

export interface CredentialMetadata {
  credentialFormatVersion: 1
  credentialKind: "owner_cli_session"
  credentialId: string
  issuerOrigin: string
  teamId: number
  teamName: string
  deviceName: string | null
  clientInstanceId: string
  loggedInAt: string
  cliVersion: string
}

export type DeviceLocalState =
  | "issued"
  | "polling"
  | "delivery_unknown"
  | "token_received"
  | "terminal"

export interface DeviceTerminalEvidence {
  acknowledgedAt: string
  attempt: DevicePollAttempt
}

export interface DeviceAuthorizationState {
  formatVersion: 1
  generation: string
  localState: DeviceLocalState
  clientId: "adrate-cli"
  clientInstanceId: string
  deviceName: string | null
  requestedScopes: [...typeof M0_CAPABILITIES]
  environment: CliEnvironment
  issuerOrigin: string
  deviceCode: string | null
  userCode: string | null
  verificationUri: string
  verificationUriComplete: string
  expiresAt: string
  intervalSeconds: number
  createdAt: string
  nextPollAt: string
  deliveryVerificationAttemptedAt: string | null
  terminalEvidence: DeviceTerminalEvidence | null
}

export interface DeviceIssueReservation {
  formatVersion: 1
  ownerToken: string
  environment: CliEnvironment
  issuerOrigin: string
  clientInstanceId: string
  deviceName: string | null
  createdAt: string
}

export type DevicePollAttemptPhase =
  | "selecting_backend"
  | "ready"
  | "dispatch_intent"
  | "response_acknowledged"

export type DevicePollAcknowledgedResponseKind =
  | "authorization_pending"
  | "slow_down"
  | "temporarily_unavailable"
  | "oauth_error"

export interface DevicePollResponseAcknowledgement {
  responseKind: DevicePollAcknowledgedResponseKind
  responseReceivedAt: string
  previousProtocolIntervalSeconds: number
  protocolIntervalSeconds: number
  retryAfterSeconds: number | null
  nextPollAt: string
}

export interface DevicePollAttempt {
  formatVersion: 1
  ownerToken: string
  deviceGeneration: string
  environment: CliEnvironment
  issuerOrigin: string
  clientInstanceId: string
  phase: DevicePollAttemptPhase
  deliveryVerification: boolean
  storageKind: TokenStorageKind | null
  ownerPid: number
  ownerProcessFingerprint: string
  createdAt: string
  dispatchedAt: string | null
  verificationClaimedAt: string | null
  responseAcknowledgement: DevicePollResponseAcknowledgement | null
  leaseExpiresAt: string
}

export interface AuthCleanupCredentialLocator {
  issuerOrigin: string
  credentialKind: "owner_cli_session"
  credentialId: string
  storageKind: TokenStorageKind
}

export type AuthCleanupPhase = "prepared" | "secret_removed" | "pruning"

export interface AuthCleanupReservation {
  formatVersion: 1
  ownerToken: string
  phase: AuthCleanupPhase
  credentialLocator: AuthCleanupCredentialLocator | null
  expectedFallbackExists: boolean
  expectedEnvironment: CliEnvironment | null
  expectedIssuerOrigin: string | null
  expectedClientInstanceId: string | null
  expectedTokenGeneration: string | null
  expectedDeviceGeneration: string | null
  expectedIssueOwnerToken: string | null
  expectedPollOwnerToken: string | null
  expectedConfigDigest: string | null
  expectedTokenDigest: string | null
  expectedMetadataDigest: string | null
  expectedDeviceDigest: string | null
  expectedIssueDigest: string | null
  expectedPollDigest: string | null
  createdAt: string
}

export type LogoutDeliveryPhase =
  | "dispatch_intent"
  | "outcome_recorded"
  | "output_acknowledged"
export type LogoutRemoteOutcome =
  | "confirmed_inactive"
  | "confirmed_not_executed"
  | "unknown"
export type LogoutDeliveryReason =
  | "revoked"
  | "already_inactive"
  | "request_rejected"
  | "owner_required"
  | "transport_unknown"
  | "ambiguous_response"
  | "unlocatable"
  | "interrupted_cleanup"

export type LogoutCredentialNoticeReason = "absolute_expiring" | "idle_expiring"

/**
 * 凭证 notice 只冻结可验证的机器事实。message 和 URL 不落盘，
 * 重放时由枚举和已冻结环境重建固定文案与官方地址。
 */
export interface LogoutCredentialNoticeFact {
  level: "warning" | "critical"
  reasons: Array<LogoutCredentialNoticeReason>
  absoluteExpiresAt: string
  idleExpiresAt: string | null
  absoluteRemainingDays: number
  idleRemainingDays: number | null
  suggestedAction: "reauthorize_credential" | "keep_session_active"
  resolutionAvailable: boolean
}

/**
 * 已严格解码的 DELETE 响应事实。禁止加入 message、details、body
 * 或任意服务端文本。
 */
export interface LogoutDeliveryResponseFact {
  kind: "success" | "error"
  errorCode: PublicErrorCode | null
  retryAfterSeconds: number | null
  credentialNotice: LogoutCredentialNoticeFact | null
}

/**
 * 注销投递日志只冻结重放所需的 allowlist 事实。严禁写入 Token、HTTP body、
 * 服务端 error details 或任意未校验文本。
 */
export interface LogoutDeliveryJournal {
  formatVersion: 1
  ownerToken: string
  phase: LogoutDeliveryPhase
  remoteOutcome: LogoutRemoteOutcome | null
  reason: LogoutDeliveryReason
  responseFact: LogoutDeliveryResponseFact | null
  expectedEnvironment: CliEnvironment | null
  expectedIssuerOrigin: string | null
  expectedCredentialId: string | null
  expectedClientInstanceId: string | null
  expectedTokenGeneration: string | null
  expectedDeviceGeneration: string | null
  expectedIssueOwnerToken: string | null
  expectedPollOwnerToken: string | null
  resolutionEnvironment: CliEnvironment | null
  requestId: string
  createdAt: string
  recordedAt: string | null
}

function isSafeLocalText(
  value: unknown,
  maximumLength: number,
  nullable = false
): value is string | null {
  if (nullable && value === null) return true
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 0x1f || code === 0x7f)
    })
  )
}

export function parseConfig(value: unknown): CliConfig | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "configFormatVersion",
      "issuerOrigin",
      "clientInstanceId",
      "environment",
    ]) ||
    value.configFormatVersion !== 1 ||
    typeof value.issuerOrigin !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(String(value.clientInstanceId))
  ) {
    return null
  }
  try {
    assertIssuerPair(value.environment, value.issuerOrigin)
  } catch {
    return null
  }
  return value as unknown as CliConfig
}

export function parseTokenIndex(value: unknown): TokenIndex | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "tokenIndexFormatVersion",
      "generation",
      "state",
      "environment",
      "issuerOrigin",
      "credentialKind",
      "credentialId",
      "clientInstanceId",
      "deviceGeneration",
      "pollAttemptOwnerToken",
      "deviceName",
      "tokenReceivedAt",
      "storageKind",
      "storageCommit",
    ]) ||
    value.tokenIndexFormatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.generation)) ||
    (value.state !== "staging" && value.state !== "stored") ||
    typeof value.issuerOrigin !== "string" ||
    value.credentialKind !== "owner_cli_session" ||
    environmentForMachineOrigin(value.issuerOrigin) === null ||
    !LOWERCASE_UUID_PATTERN.test(String(value.credentialId)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.clientInstanceId)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.deviceGeneration)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.pollAttemptOwnerToken)) ||
    !isSafeLocalText(value.deviceName, 128, true) ||
    !isCanonicalUtcIso(value.tokenReceivedAt) ||
    (value.storageKind !== "keychain" &&
      value.storageKind !== "fallback_file") ||
    !isValidTokenStorageCommit(
      value.storageCommit,
      value.state,
      value.tokenReceivedAt
    )
  ) {
    return null
  }
  try {
    assertIssuerPair(value.environment, value.issuerOrigin)
  } catch {
    return null
  }
  return value as unknown as TokenIndex
}

function isValidTokenStorageCommit(
  value: unknown,
  state: unknown,
  tokenReceivedAt: unknown
): value is TokenStorageCommit | null {
  if (state === "stored") return value === null
  return (
    isPlainObject(value) &&
    hasExactKeys(value, [
      "transactionId",
      "ownerPid",
      "ownerProcessFingerprint",
      "leaseExpiresAt",
    ]) &&
    LOWERCASE_UUID_PATTERN.test(String(value.transactionId)) &&
    isSafeIntegerInRange(value.ownerPid, 1) &&
    isSafeLocalText(value.ownerProcessFingerprint, 256) &&
    isCanonicalUtcIso(value.leaseExpiresAt) &&
    isCanonicalUtcIso(tokenReceivedAt) &&
    new Date(value.leaseExpiresAt).getTime() >
      new Date(tokenReceivedAt).getTime()
  )
}

export function parseCredentialMetadata(
  value: unknown
): CredentialMetadata | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "credentialFormatVersion",
      "credentialKind",
      "credentialId",
      "issuerOrigin",
      "teamId",
      "teamName",
      "deviceName",
      "clientInstanceId",
      "loggedInAt",
      "cliVersion",
    ]) ||
    value.credentialFormatVersion !== 1 ||
    value.credentialKind !== "owner_cli_session" ||
    !LOWERCASE_UUID_PATTERN.test(String(value.credentialId)) ||
    environmentForMachineOrigin(value.issuerOrigin) === null ||
    !isSafeIntegerInRange(value.teamId, 1) ||
    !isSafeLocalText(value.teamName, 255) ||
    !isSafeLocalText(value.deviceName, 128, true) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.clientInstanceId)) ||
    !isCanonicalUtcIso(value.loggedInAt) ||
    !isSafeLocalText(value.cliVersion, 64)
  ) {
    return null
  }
  return value as unknown as CredentialMetadata
}

export function parseDeviceState(
  value: unknown
): DeviceAuthorizationState | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "formatVersion",
      "generation",
      "localState",
      "clientId",
      "clientInstanceId",
      "deviceName",
      "requestedScopes",
      "environment",
      "issuerOrigin",
      "deviceCode",
      "userCode",
      "verificationUri",
      "verificationUriComplete",
      "expiresAt",
      "intervalSeconds",
      "createdAt",
      "nextPollAt",
      "deliveryVerificationAttemptedAt",
      "terminalEvidence",
    ]) ||
    value.formatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.generation)) ||
    ![
      "issued",
      "polling",
      "delivery_unknown",
      "token_received",
      "terminal",
    ].includes(String(value.localState)) ||
    value.clientId !== "adrate-cli" ||
    !LOWERCASE_UUID_PATTERN.test(String(value.clientInstanceId)) ||
    !isSafeLocalText(value.deviceName, 128, true) ||
    !isExactM0Scope(value.requestedScopes) ||
    environmentForMachineOrigin(value.issuerOrigin) === null ||
    typeof value.verificationUri !== "string" ||
    typeof value.verificationUriComplete !== "string" ||
    !isCanonicalUtcIso(value.expiresAt) ||
    !isSafeIntegerInRange(value.intervalSeconds, 1, 30) ||
    !isCanonicalUtcIso(value.createdAt) ||
    !isCanonicalUtcIso(value.nextPollAt) ||
    !isNullableCanonicalUtcIso(value.deliveryVerificationAttemptedAt)
  ) {
    return null
  }
  try {
    assertIssuerPair(value.environment, value.issuerOrigin)
    validateBrowserUrl(value.verificationUri, String(value.issuerOrigin))
    validateBrowserUrl(
      value.verificationUriComplete,
      String(value.issuerOrigin)
    )
  } catch {
    return null
  }
  const tokenReceived = value.localState === "token_received"
  const terminal = value.localState === "terminal"
  const redacted = tokenReceived || terminal
  const terminalEvidence =
    value.terminalEvidence === null
      ? null
      : parseDeviceTerminalEvidence(value.terminalEvidence)
  if (
    (value.terminalEvidence !== null && terminalEvidence === null) ||
    redacted !== (value.deviceCode === null && value.userCode === null) ||
    (!redacted &&
      (!isValidDeviceCode(value.deviceCode) ||
        !isValidUserCode(value.userCode))) ||
    (value.localState !== "delivery_unknown" &&
      value.deliveryVerificationAttemptedAt !== null) ||
    terminal !== (terminalEvidence !== null)
  ) {
    return null
  }
  if (terminalEvidence) {
    const attempt = terminalEvidence.attempt
    if (
      attempt.phase !== "dispatch_intent" ||
      attempt.deviceGeneration !== value.generation ||
      attempt.environment !== value.environment ||
      attempt.issuerOrigin !== value.issuerOrigin ||
      attempt.clientInstanceId !== value.clientInstanceId ||
      attempt.dispatchedAt === null ||
      new Date(terminalEvidence.acknowledgedAt).getTime() <
        new Date(attempt.dispatchedAt).getTime()
    ) {
      return null
    }
  }
  if (!redacted) {
    const complete = new URL(String(value.verificationUriComplete))
    const base = new URL(String(value.verificationUri))
    if (
      complete.pathname !== base.pathname ||
      complete.searchParams.get("user_code") !== value.userCode
    ) {
      return null
    }
  }
  return value as unknown as DeviceAuthorizationState
}

function parseDeviceTerminalEvidence(
  value: unknown
): DeviceTerminalEvidence | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["acknowledgedAt", "attempt"]) ||
    !isCanonicalUtcIso(value.acknowledgedAt)
  ) {
    return null
  }
  const attempt = parseDevicePollAttempt(value.attempt)
  return attempt === null
    ? null
    : {
        acknowledgedAt: value.acknowledgedAt,
        attempt,
      }
}

export function parseDeviceIssueReservation(
  value: unknown
): DeviceIssueReservation | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "formatVersion",
      "ownerToken",
      "environment",
      "issuerOrigin",
      "clientInstanceId",
      "deviceName",
      "createdAt",
    ]) ||
    value.formatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.ownerToken)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.clientInstanceId)) ||
    !isSafeLocalText(value.deviceName, 128, true) ||
    !isCanonicalUtcIso(value.createdAt)
  ) {
    return null
  }
  try {
    assertIssuerPair(value.environment, value.issuerOrigin)
  } catch {
    return null
  }
  return value as unknown as DeviceIssueReservation
}

export function parseDevicePollAttempt(
  value: unknown
): DevicePollAttempt | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "formatVersion",
      "ownerToken",
      "deviceGeneration",
      "environment",
      "issuerOrigin",
      "clientInstanceId",
      "phase",
      "deliveryVerification",
      "storageKind",
      "ownerPid",
      "ownerProcessFingerprint",
      "createdAt",
      "dispatchedAt",
      "verificationClaimedAt",
      "responseAcknowledgement",
      "leaseExpiresAt",
    ]) ||
    value.formatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.ownerToken)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.deviceGeneration)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.clientInstanceId)) ||
    ![
      "selecting_backend",
      "ready",
      "dispatch_intent",
      "response_acknowledged",
    ].includes(String(value.phase)) ||
    typeof value.deliveryVerification !== "boolean" ||
    !isSafeIntegerInRange(value.ownerPid, 1) ||
    !isSafeLocalText(value.ownerProcessFingerprint, 256) ||
    !isCanonicalUtcIso(value.createdAt) ||
    !isNullableCanonicalUtcIso(value.dispatchedAt) ||
    !isNullableCanonicalUtcIso(value.verificationClaimedAt) ||
    !isCanonicalUtcIso(value.leaseExpiresAt)
  ) {
    return null
  }
  try {
    assertIssuerPair(value.environment, value.issuerOrigin)
  } catch {
    return null
  }
  if (
    (value.phase === "selecting_backend" && value.storageKind !== null) ||
    (value.phase !== "selecting_backend" &&
      value.storageKind !== "keychain" &&
      value.storageKind !== "fallback_file")
  ) {
    return null
  }
  const dispatchedPhase =
    value.phase === "dispatch_intent" || value.phase === "response_acknowledged"
  if (
    (!dispatchedPhase &&
      (value.dispatchedAt !== null || value.verificationClaimedAt !== null)) ||
    (dispatchedPhase && value.dispatchedAt === null) ||
    (dispatchedPhase &&
      value.deliveryVerification === true &&
      value.verificationClaimedAt !== value.dispatchedAt) ||
    (dispatchedPhase &&
      value.deliveryVerification === false &&
      value.verificationClaimedAt !== null) ||
    (value.phase !== "response_acknowledged" &&
      value.responseAcknowledgement !== null)
  ) {
    return null
  }
  const createdAtMs = new Date(value.createdAt).getTime()
  const leaseExpiresAtMs = new Date(value.leaseExpiresAt).getTime()
  const dispatchedAtMs =
    value.dispatchedAt === null ? null : new Date(value.dispatchedAt).getTime()
  if (
    leaseExpiresAtMs <= createdAtMs ||
    (dispatchedAtMs !== null &&
      (dispatchedAtMs < createdAtMs || leaseExpiresAtMs <= dispatchedAtMs))
  ) {
    return null
  }
  if (
    value.phase === "response_acknowledged" &&
    !isValidDevicePollResponseAcknowledgement(
      value.responseAcknowledgement,
      value.verificationClaimedAt ?? value.dispatchedAt,
      value.deliveryVerification
    )
  ) {
    return null
  }
  return value as unknown as DevicePollAttempt
}

function isValidDevicePollResponseAcknowledgement(
  value: unknown,
  dispatchBoundary: unknown,
  deliveryVerification: boolean
): value is DevicePollResponseAcknowledgement {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "responseKind",
      "responseReceivedAt",
      "previousProtocolIntervalSeconds",
      "protocolIntervalSeconds",
      "retryAfterSeconds",
      "nextPollAt",
    ]) ||
    ![
      "authorization_pending",
      "slow_down",
      "temporarily_unavailable",
      "oauth_error",
    ].includes(String(value.responseKind)) ||
    !isCanonicalUtcIso(value.responseReceivedAt) ||
    !isSafeIntegerInRange(value.previousProtocolIntervalSeconds, 1, 30) ||
    !isSafeIntegerInRange(value.protocolIntervalSeconds, 1, 30) ||
    !isCanonicalUtcIso(value.nextPollAt) ||
    !isCanonicalUtcIso(dispatchBoundary)
  ) {
    return false
  }
  const receivedAtMs = new Date(value.responseReceivedAt).getTime()
  const nextPollAtMs = new Date(value.nextPollAt).getTime()
  const delayMs = nextPollAtMs - receivedAtMs
  const protocolDelayMs = value.protocolIntervalSeconds * 1000
  if (
    receivedAtMs < new Date(dispatchBoundary).getTime() ||
    delayMs % 1000 !== 0
  ) {
    return false
  }
  if (value.responseKind === "slow_down") {
    if (
      value.retryAfterSeconds !== null
        ? !isSafeIntegerInRange(value.retryAfterSeconds, 1, 30)
        : !deliveryVerification
    ) {
      return false
    }
    const effectiveRetryAfterSeconds =
      value.retryAfterSeconds === null
        ? Math.min(30, value.previousProtocolIntervalSeconds + 5)
        : Number(value.retryAfterSeconds)
    const expectedProtocolIntervalSeconds = Math.min(
      30,
      Math.max(
        value.previousProtocolIntervalSeconds + 5,
        effectiveRetryAfterSeconds
      )
    )
    return (
      value.protocolIntervalSeconds === expectedProtocolIntervalSeconds &&
      delayMs === protocolDelayMs
    )
  }
  if (value.protocolIntervalSeconds !== value.previousProtocolIntervalSeconds) {
    return false
  }
  if (value.responseKind === "temporarily_unavailable") {
    if (
      value.retryAfterSeconds !== null &&
      !isSafeIntegerInRange(value.retryAfterSeconds, 1, 86_400)
    ) {
      return false
    }
    return (
      delayMs ===
      Math.max(
        value.protocolIntervalSeconds,
        value.retryAfterSeconds ?? value.protocolIntervalSeconds
      ) *
        1000
    )
  }
  return value.retryAfterSeconds === null && delayMs === protocolDelayMs
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || LOWERCASE_UUID_PATTERN.test(String(value))
}

function isNullableSha256(value: unknown): value is string | null {
  return value === null || /^[0-9a-f]{64}$/.test(String(value))
}

function parseCleanupCredentialLocator(
  value: unknown
): AuthCleanupCredentialLocator | null | undefined {
  if (value === null) return null
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "issuerOrigin",
      "credentialKind",
      "credentialId",
      "storageKind",
    ]) ||
    value.credentialKind !== "owner_cli_session" ||
    !LOWERCASE_UUID_PATTERN.test(String(value.credentialId)) ||
    (value.storageKind !== "keychain" &&
      value.storageKind !== "fallback_file") ||
    environmentForMachineOrigin(value.issuerOrigin) === null
  ) {
    return undefined
  }
  return value as unknown as AuthCleanupCredentialLocator
}

export function parseAuthCleanupReservation(
  value: unknown
): AuthCleanupReservation | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "formatVersion",
      "ownerToken",
      "phase",
      "credentialLocator",
      "expectedFallbackExists",
      "expectedEnvironment",
      "expectedIssuerOrigin",
      "expectedClientInstanceId",
      "expectedTokenGeneration",
      "expectedDeviceGeneration",
      "expectedIssueOwnerToken",
      "expectedPollOwnerToken",
      "expectedConfigDigest",
      "expectedTokenDigest",
      "expectedMetadataDigest",
      "expectedDeviceDigest",
      "expectedIssueDigest",
      "expectedPollDigest",
      "createdAt",
    ]) ||
    value.formatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.ownerToken)) ||
    !["prepared", "secret_removed", "pruning"].includes(String(value.phase)) ||
    typeof value.expectedFallbackExists !== "boolean" ||
    !isNullableUuid(value.expectedClientInstanceId) ||
    !isNullableUuid(value.expectedTokenGeneration) ||
    !isNullableUuid(value.expectedDeviceGeneration) ||
    !isNullableUuid(value.expectedIssueOwnerToken) ||
    !isNullableUuid(value.expectedPollOwnerToken) ||
    !isNullableSha256(value.expectedConfigDigest) ||
    !isNullableSha256(value.expectedTokenDigest) ||
    !isNullableSha256(value.expectedMetadataDigest) ||
    !isNullableSha256(value.expectedDeviceDigest) ||
    !isNullableSha256(value.expectedIssueDigest) ||
    !isNullableSha256(value.expectedPollDigest) ||
    !isCanonicalUtcIso(value.createdAt)
  ) {
    return null
  }
  const credentialLocator = parseCleanupCredentialLocator(
    value.credentialLocator
  )
  if (
    credentialLocator === undefined ||
    (credentialLocator === null) !== (value.expectedTokenGeneration === null) ||
    (credentialLocator === null) !== (value.expectedTokenDigest === null)
  ) {
    return null
  }
  if (
    credentialLocator !== null &&
    value.expectedIssuerOrigin !== null &&
    credentialLocator.issuerOrigin !== value.expectedIssuerOrigin
  ) {
    return null
  }
  const hasConfig = value.expectedIssuerOrigin !== null
  if (
    hasConfig !== (value.expectedEnvironment !== null) ||
    hasConfig !== (value.expectedClientInstanceId !== null)
  ) {
    return null
  }
  if (hasConfig) {
    try {
      assertIssuerPair(value.expectedEnvironment, value.expectedIssuerOrigin)
    } catch {
      return null
    }
  }
  return value as unknown as AuthCleanupReservation
}

const LOGOUT_PUBLIC_ERROR_CODE_SET = new Set<string>(PUBLIC_ERROR_CODES)

function isLogoutCredentialNoticeFact(
  value: unknown,
  expectedEnvironment: unknown
): value is LogoutCredentialNoticeFact {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "level",
      "reasons",
      "absoluteExpiresAt",
      "idleExpiresAt",
      "absoluteRemainingDays",
      "idleRemainingDays",
      "suggestedAction",
      "resolutionAvailable",
    ]) ||
    (value.level !== "warning" && value.level !== "critical") ||
    !Array.isArray(value.reasons) ||
    !isCanonicalUtcIso(value.absoluteExpiresAt) ||
    !isNullableCanonicalUtcIso(value.idleExpiresAt) ||
    !isSafeIntegerInRange(value.absoluteRemainingDays, 0) ||
    !(
      value.idleRemainingDays === null ||
      isSafeIntegerInRange(value.idleRemainingDays, 0)
    ) ||
    (value.suggestedAction !== "reauthorize_credential" &&
      value.suggestedAction !== "keep_session_active") ||
    typeof value.resolutionAvailable !== "boolean"
  ) {
    return false
  }

  const reasonKey = JSON.stringify(value.reasons)
  const hasAbsolute = value.reasons.includes("absolute_expiring")
  const hasIdle = value.reasons.includes("idle_expiring")
  return (
    [
      '["absolute_expiring"]',
      '["idle_expiring"]',
      '["absolute_expiring","idle_expiring"]',
    ].includes(reasonKey) &&
    (value.idleExpiresAt === null) === (value.idleRemainingDays === null) &&
    (!hasIdle || value.idleExpiresAt !== null) &&
    (hasAbsolute
      ? value.suggestedAction === "reauthorize_credential"
      : value.suggestedAction === "keep_session_active" &&
        value.level === "warning") &&
    (!value.resolutionAvailable ||
      expectedEnvironment === "production" ||
      expectedEnvironment === "test")
  )
}

function isLogoutDeliveryResponseFact(
  value: unknown,
  expectedEnvironment: unknown
): value is LogoutDeliveryResponseFact {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "kind",
      "errorCode",
      "retryAfterSeconds",
      "credentialNotice",
    ]) ||
    (value.kind !== "success" && value.kind !== "error") ||
    !(
      value.retryAfterSeconds === null ||
      isSafeIntegerInRange(value.retryAfterSeconds, 1, 86_400)
    ) ||
    !(
      value.credentialNotice === null ||
      isLogoutCredentialNoticeFact(value.credentialNotice, expectedEnvironment)
    )
  ) {
    return false
  }
  return value.kind === "success"
    ? value.errorCode === null && value.retryAfterSeconds === null
    : typeof value.errorCode === "string" &&
        LOGOUT_PUBLIC_ERROR_CODE_SET.has(value.errorCode)
}

export function parseLogoutDeliveryJournal(
  value: unknown
): LogoutDeliveryJournal | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "formatVersion",
      "ownerToken",
      "phase",
      "remoteOutcome",
      "reason",
      "responseFact",
      "expectedEnvironment",
      "expectedIssuerOrigin",
      "expectedCredentialId",
      "expectedClientInstanceId",
      "expectedTokenGeneration",
      "expectedDeviceGeneration",
      "expectedIssueOwnerToken",
      "expectedPollOwnerToken",
      "resolutionEnvironment",
      "requestId",
      "createdAt",
      "recordedAt",
    ]) ||
    value.formatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.ownerToken)) ||
    (value.phase !== "dispatch_intent" &&
      value.phase !== "outcome_recorded" &&
      value.phase !== "output_acknowledged") ||
    (value.remoteOutcome !== null &&
      value.remoteOutcome !== "confirmed_inactive" &&
      value.remoteOutcome !== "confirmed_not_executed" &&
      value.remoteOutcome !== "unknown") ||
    ![
      "revoked",
      "already_inactive",
      "request_rejected",
      "owner_required",
      "transport_unknown",
      "ambiguous_response",
      "unlocatable",
      "interrupted_cleanup",
    ].includes(String(value.reason)) ||
    !isNullableUuid(value.expectedCredentialId) ||
    !isNullableUuid(value.expectedClientInstanceId) ||
    !isNullableUuid(value.expectedTokenGeneration) ||
    !isNullableUuid(value.expectedDeviceGeneration) ||
    !isNullableUuid(value.expectedIssueOwnerToken) ||
    !isNullableUuid(value.expectedPollOwnerToken) ||
    !(
      value.responseFact === null ||
      isLogoutDeliveryResponseFact(
        value.responseFact,
        value.expectedEnvironment
      )
    ) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    !isCanonicalUtcIso(value.createdAt) ||
    !isNullableCanonicalUtcIso(value.recordedAt)
  ) {
    return null
  }

  const hasIssuer = value.expectedIssuerOrigin !== null
  if (
    hasIssuer !== (value.expectedEnvironment !== null) ||
    (value.expectedCredentialId === null) !==
      (value.expectedTokenGeneration === null)
  ) {
    return null
  }
  if (hasIssuer) {
    try {
      assertIssuerPair(value.expectedEnvironment, value.expectedIssuerOrigin)
    } catch {
      return null
    }
  }
  if (
    value.resolutionEnvironment !== null &&
    value.resolutionEnvironment !== "production" &&
    value.resolutionEnvironment !== "test"
  ) {
    return null
  }

  if (
    (value.phase === "dispatch_intent" &&
      (value.remoteOutcome !== null ||
        value.reason !== "transport_unknown" ||
        value.responseFact !== null ||
        value.recordedAt !== null)) ||
    (value.phase !== "dispatch_intent" &&
      (value.remoteOutcome === null || value.recordedAt === null)) ||
    (value.remoteOutcome === "confirmed_inactive" &&
      value.reason !== "revoked" &&
      value.reason !== "already_inactive") ||
    (value.remoteOutcome === "confirmed_not_executed" &&
      value.reason !== "request_rejected") ||
    (value.remoteOutcome === "unknown" &&
      ![
        "owner_required",
        "transport_unknown",
        "ambiguous_response",
        "unlocatable",
        "interrupted_cleanup",
      ].includes(String(value.reason)))
  ) {
    return null
  }

  const responseFact = value.responseFact
  const responseErrorCode = responseFact?.errorCode ?? null
  const inactiveError = [
    "INVALID_CREDENTIAL",
    "CREDENTIAL_EXPIRED",
    "USER_DISABLED",
  ].includes(String(responseErrorCode))
  const provenNotExecutedError = ["INVALID_REQUEST", "RATE_LIMITED"].includes(
    String(responseErrorCode)
  )
  if (
    (value.reason === "revoked" && responseFact?.kind !== "success") ||
    (value.reason === "already_inactive" &&
      responseFact !== null &&
      (responseFact.kind !== "error" || !inactiveError)) ||
    (value.reason === "request_rejected" &&
      (responseFact?.kind !== "error" || !provenNotExecutedError)) ||
    (value.reason === "owner_required" &&
      (responseFact?.kind !== "error" ||
        responseErrorCode !== "OWNER_REQUIRED")) ||
    (["transport_unknown", "unlocatable", "interrupted_cleanup"].includes(
      String(value.reason)
    ) &&
      responseFact !== null) ||
    (value.reason === "ambiguous_response" &&
      (responseFact === null ||
        (responseFact.kind === "error" &&
          (inactiveError ||
            provenNotExecutedError ||
            responseErrorCode === "OWNER_REQUIRED"))))
  ) {
    return null
  }
  if (
    value.recordedAt !== null &&
    new Date(value.recordedAt).getTime() < new Date(value.createdAt).getTime()
  ) {
    return null
  }
  return value as unknown as LogoutDeliveryJournal
}

export function newCredentialMetadata(input: {
  credentialId: string
  issuerOrigin: string
  teamId: number
  teamName: string
  deviceName: string | null
  clientInstanceId: string
  loggedInAt: string
}): CredentialMetadata {
  return {
    credentialFormatVersion: 1,
    credentialKind: "owner_cli_session",
    ...input,
    cliVersion: CLI_VERSION,
  }
}
