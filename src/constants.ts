export { CLI_VERSION } from "./version.js"
export const API_VERSION = "v1"
export const CLIENT_ID = "adrate-cli"
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

export const PRODUCTION_MACHINE_ORIGIN = "https://api.adrate.io"
export const PRODUCTION_BROWSER_ORIGIN = "https://app.adrate.io"
export const TEST_MACHINE_ORIGIN = "https://api.test.adrate.io"
export const TEST_BROWSER_ORIGIN = "https://test.adrate.io"

export const M0_CAPABILITIES = Object.freeze([
  "identity.read",
  "connections.read",
  "ads.campaign.read",
  "ads.report.read",
  "ads.campaign.status.write",
  "feedback.write",
] as const)

export const M0_SCOPE = M0_CAPABILITIES.join(" ")

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
export const LOWERCASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
export const OWNER_TOKEN_PREFIX = "adr_owner_"

export const DEADLINES_MS = Object.freeze({
  standard: 15_000,
  campaignRead: 45_000,
  statusWrite: 120_000,
  connect: 10_000,
})

export const EXIT_CODE = Object.freeze({
  success: 0,
  business: 1,
  usage: 2,
  authentication: 3,
  retryable: 4,
  outcomeUnknown: 5,
} as const)

export type CliExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE]
export type CliEnvironment = "production" | "test"

/**
 * 远端 DELETE /sessions/current 响应中表示凭据已不可用的错误码。
 * 归一化和 logout recovery 共用：拿到这些码可安全清理本地凭据。
 */
export const INACTIVE_CREDENTIAL_CODES = Object.freeze(
  new Set(["INVALID_CREDENTIAL", "CREDENTIAL_EXPIRED", "USER_DISABLED"])
)
