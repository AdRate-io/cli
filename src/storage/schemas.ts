import {
  CLI_VERSION,
  LOWERCASE_UUID_PATTERN,
} from "../constants.js"
import {
  assertIssuerPair,
  environmentForMachineOrigin,
  validateBrowserUrl,
} from "../config/issuer.js"
import {
  hasKeys,
  isCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "../contracts/json.js"
import {
  isExactM0Scope,
  isValidDeviceCode,
  isValidUserCode,
} from "../contracts/oauth.js"
import type { CliEnvironment, M0_CAPABILITIES } from "../constants.js"

export interface CliConfig {
  configFormatVersion: 1
  issuerOrigin: string
  clientInstanceId: string
  environment: CliEnvironment
}

export type TokenStorageKind = "keychain" | "fallback_file"

export interface TokenIndex {
  tokenIndexFormatVersion: 1
  generation: string
  state: "stored"
  environment: CliEnvironment
  issuerOrigin: string
  credentialKind: "owner_cli_session"
  credentialId: string
  clientInstanceId: string
  deviceGeneration: string
  deviceName: string | null
  tokenReceivedAt: string
  storageKind: TokenStorageKind
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
  /**
   * 新版凭据在 /me 激活后持久化绝对过期时间。
   * 旧 beta 文件不含该字段，因此保持可选以便向后兼容读取。
   */
  absoluteExpiresAt?: string
}

export type DeviceLocalState = "issued" | "polling" | "token_received"

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
}

export interface DeviceIssueReservation {
  formatVersion: 1
  generation: string
  environment: CliEnvironment
  issuerOrigin: string
  clientInstanceId: string
  deviceName: string | null
}

export interface DevicePollAttempt {
  formatVersion: 1
  deviceGeneration: string
  storageKind: TokenStorageKind | null
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
    !hasKeys(value, [
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
    !hasKeys(value, [
      "tokenIndexFormatVersion",
      "generation",
      "state",
      "environment",
      "issuerOrigin",
      "credentialKind",
      "credentialId",
      "clientInstanceId",
      "deviceGeneration",
      "deviceName",
      "tokenReceivedAt",
      "storageKind",
    ]) ||
    value.tokenIndexFormatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.generation)) ||
    value.state !== "stored" ||
    typeof value.issuerOrigin !== "string" ||
    value.credentialKind !== "owner_cli_session" ||
    environmentForMachineOrigin(value.issuerOrigin) === null ||
    !LOWERCASE_UUID_PATTERN.test(String(value.credentialId)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.clientInstanceId)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.deviceGeneration)) ||
    !isSafeLocalText(value.deviceName, 128, true) ||
    !isCanonicalUtcIso(value.tokenReceivedAt) ||
    (value.storageKind !== "keychain" &&
      value.storageKind !== "fallback_file")
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

export function parseCredentialMetadata(
  value: unknown
): CredentialMetadata | null {
  if (
    !isPlainObject(value) ||
    !hasKeys(value, [
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
    !isSafeLocalText(value.cliVersion, 64) ||
    (Object.hasOwn(value, "absoluteExpiresAt") &&
      !isCanonicalUtcIso(value.absoluteExpiresAt))
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
    !hasKeys(value, [
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
    ]) ||
    value.formatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.generation)) ||
    !["issued", "polling", "token_received"].includes(
      String(value.localState)
    ) ||
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
    !isCanonicalUtcIso(value.nextPollAt)
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
  const redacted = tokenReceived
  if (
    redacted !== (value.deviceCode === null && value.userCode === null) ||
    (!redacted &&
      (!isValidDeviceCode(value.deviceCode) ||
        !isValidUserCode(value.userCode)))
  ) {
    return null
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

export function parseDeviceIssueReservation(
  value: unknown
): DeviceIssueReservation | null {
  if (
    !isPlainObject(value) ||
    !hasKeys(value, [
      "formatVersion",
      "generation",
      "environment",
      "issuerOrigin",
      "clientInstanceId",
      "deviceName",
    ]) ||
    value.formatVersion !== 1
  ) {
    return null
  }
  if (
    !LOWERCASE_UUID_PATTERN.test(String(value.generation)) ||
    !LOWERCASE_UUID_PATTERN.test(String(value.clientInstanceId)) ||
    !isSafeLocalText(value.deviceName, 128, true)
  ) {
    return null
  }
  try {
    assertIssuerPair(value.environment, value.issuerOrigin)
  } catch {
    return null
  }
  return {
    formatVersion: 1,
    generation: String(value.generation),
    environment: value.environment as CliEnvironment,
    issuerOrigin: String(value.issuerOrigin),
    clientInstanceId: String(value.clientInstanceId),
    deviceName: value.deviceName,
  }
}

export function parseDevicePollAttempt(
  value: unknown
): DevicePollAttempt | null {
  if (
    !isPlainObject(value) ||
    !hasKeys(value, [
      "formatVersion",
      "deviceGeneration",
      "storageKind",
    ]) ||
    value.formatVersion !== 1 ||
    !LOWERCASE_UUID_PATTERN.test(String(value.deviceGeneration))
  ) {
    return null
  }
  if (
    value.storageKind !== null &&
    value.storageKind !== "keychain" &&
    value.storageKind !== "fallback_file"
  ) {
    return null
  }
  return value as unknown as DevicePollAttempt
}

export function newCredentialMetadata(input: {
  credentialId: string
  issuerOrigin: string
  teamId: number
  teamName: string
  deviceName: string | null
  clientInstanceId: string
  loggedInAt: string
  absoluteExpiresAt: string
}): CredentialMetadata {
  return {
    credentialFormatVersion: 1,
    credentialKind: "owner_cli_session",
    ...input,
    cliVersion: CLI_VERSION,
  }
}
