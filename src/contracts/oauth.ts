import {
  BASE64URL_PATTERN,
  CLIENT_ID,
  LOWERCASE_UUID_PATTERN,
  M0_CAPABILITIES,
  OWNER_TOKEN_PREFIX,
} from "../constants.js"
import { validateBrowserUrl } from "../config/issuer.js"
import {
  hasExactKeys,
  isCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
  parseJsonObject,
} from "./json.js"

export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface DeviceTokenResponse {
  accessToken: string
  credentialId: string
  tokenType: "Bearer"
  expiresIn: number
  activationExpiresAt: string
  idleExpiresAt: null
  absoluteExpiresAt: string
  credentialKind: "adrate_sliding_session"
}

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "temporarily_unavailable"

const OAUTH_ERRORS = new Set<OAuthErrorCode>([
  "invalid_request",
  "invalid_client",
  "unsupported_grant_type",
  "invalid_scope",
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "temporarily_unavailable",
])

/**
 * 与 T02 Device Authorization 服务端一致的无歧义 user_code 字母表。
 *
 * CLI 不依赖主站私有源码，因此在协议 decoder 就地冻结该合同；
 * I/L/O/0/1 必须在远端响应和本地状态两个边界都被拒绝。
 */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

export function isValidUserCode(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 9 || value[4] !== "-") {
    return false
  }
  const compact = value.slice(0, 4) + value.slice(5)
  return (
    compact.length === 8 &&
    [...compact].every((character) => USER_CODE_ALPHABET.includes(character))
  )
}

export interface OAuthErrorResponse {
  error: OAuthErrorCode
  errorDescription?: string
}

export function isValidDeviceCode(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 43 ||
    value.length > 256 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return false
  }
  try {
    const bytes = Buffer.from(value, "base64url")
    return bytes.length >= 32 && bytes.toString("base64url") === value
  } catch {
    return false
  }
}

export function parseOwnerSessionToken(
  token: unknown
): { token: string; credentialId: string } | null {
  if (typeof token !== "string" || !token.startsWith(OWNER_TOKEN_PREFIX)) {
    return null
  }
  if (token.includes("\0") || token.includes("\n") || token.includes("\r")) {
    return null
  }
  const payload = token.slice(OWNER_TOKEN_PREFIX.length)
  const separator = payload.indexOf("_")
  if (separator < 0) return null
  const credentialId = payload.slice(0, separator)
  const secret = payload.slice(separator + 1)
  if (
    !LOWERCASE_UUID_PATTERN.test(credentialId) ||
    secret.length < 43 ||
    secret.length > 256 ||
    !BASE64URL_PATTERN.test(secret)
  ) {
    return null
  }
  try {
    const bytes = Buffer.from(secret, "base64url")
    if (bytes.length < 32 || bytes.toString("base64url") !== secret) {
      return null
    }
  } catch {
    return null
  }
  return { token, credentialId }
}

export function decodeDeviceCodeResponse(
  text: string,
  issuerOrigin: string
): DeviceCodeResponse | null {
  const raw = parseJsonObject(text)
  if (
    !raw ||
    !hasExactKeys(raw, [
      "device_code",
      "user_code",
      "verification_uri",
      "verification_uri_complete",
      "expires_in",
      "interval",
    ]) ||
    !isValidDeviceCode(raw.device_code) ||
    !isValidUserCode(raw.user_code) ||
    !isSafeIntegerInRange(raw.expires_in, 1, 3600) ||
    !isSafeIntegerInRange(raw.interval, 1, 30)
  ) {
    return null
  }
  let verificationUri: string
  let verificationUriComplete: string
  try {
    verificationUri = validateBrowserUrl(raw.verification_uri, issuerOrigin)
    verificationUriComplete = validateBrowserUrl(
      raw.verification_uri_complete,
      issuerOrigin
    )
  } catch {
    return null
  }
  const complete = new URL(verificationUriComplete)
  if (
    complete.searchParams.get("user_code") !== raw.user_code ||
    complete.pathname !== new URL(verificationUri).pathname
  ) {
    return null
  }
  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri,
    verificationUriComplete,
    expiresIn: raw.expires_in,
    interval: raw.interval,
  }
}

export function decodeDeviceTokenResponse(
  text: string
): DeviceTokenResponse | null {
  const raw = parseJsonObject(text)
  if (
    !raw ||
    !hasExactKeys(raw, [
      "access_token",
      "token_type",
      "expires_in",
      "activation_expires_at",
      "idle_expires_at",
      "absolute_expires_at",
      "credential_kind",
    ]) ||
    raw.token_type !== "Bearer" ||
    !isSafeIntegerInRange(raw.expires_in, 1, 3600) ||
    !isCanonicalUtcIso(raw.activation_expires_at) ||
    raw.idle_expires_at !== null ||
    !isCanonicalUtcIso(raw.absolute_expires_at) ||
    raw.credential_kind !== "adrate_sliding_session"
  ) {
    return null
  }
  const parsedToken = parseOwnerSessionToken(raw.access_token)
  if (!parsedToken) return null
  return {
    accessToken: parsedToken.token,
    credentialId: parsedToken.credentialId,
    tokenType: "Bearer",
    expiresIn: raw.expires_in,
    activationExpiresAt: raw.activation_expires_at,
    idleExpiresAt: null,
    absoluteExpiresAt: raw.absolute_expires_at,
    credentialKind: "adrate_sliding_session",
  }
}

export function decodeOAuthError(text: string): OAuthErrorResponse | null {
  const raw = parseJsonObject(text)
  if (
    !raw ||
    typeof raw.error !== "string" ||
    !OAUTH_ERRORS.has(raw.error as OAuthErrorCode) ||
    !Object.keys(raw).every(
      (key) => key === "error" || key === "error_description"
    ) ||
    !(
      raw.error_description === undefined ||
      typeof raw.error_description === "string"
    )
  ) {
    return null
  }
  return {
    error: raw.error as OAuthErrorCode,
    ...(typeof raw.error_description === "string"
      ? { errorDescription: raw.error_description }
      : {}),
  }
}

export function isExactM0Scope(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === M0_CAPABILITIES.length &&
    M0_CAPABILITIES.every((capability, index) => value[index] === capability)
  )
}

export { CLIENT_ID }
