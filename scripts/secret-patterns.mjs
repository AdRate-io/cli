/**
 * 秘密扫描 pattern 合同 — public-mirror 与 release-gate 共享唯一真源。
 *
 * 新增 pattern 时两个 scanner 自动生效。Device code 无稳定前缀，
 * 不应用宽泛 base64 正则硬扫（误报率过高）。
 */

/**
 * AdRate Owner Session Token 精确正则。
 * 格式：adr_owner_<lowercase UUID>_<canonical base64url (43-256 chars)>
 * 真源：cli/src/constants.ts OWNER_TOKEN_PREFIX + oauth.ts parseOwnerSessionToken
 */
const ADRATE_OWNER_SESSION_TOKEN =
  /\badr_owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9_-]{43,256}\b/

export const SECRET_CONTENT_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{24,}\b/,
  ADRATE_OWNER_SESSION_TOKEN,
])

export const SECRET_FILE_PATTERN =
  /(^|\/)(?:\.env(?:\..*)?|\.npmrc|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$/i
