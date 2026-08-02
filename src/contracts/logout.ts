import { hasExactKeys, isCanonicalUtcIso, isPlainObject } from "./json.js"
import type { PublicSuccessEnvelope } from "./envelope.js"

export interface CurrentSessionDeleteFacts {
  credentialId: string
  revokedAt: string
}

/**
 * DELETE /public/v1/sessions/current 的端点级成功合同。
 * 通用 Public Envelope 只证明 data 是 object，不能证明撤销已生效。
 */
export function decodeCurrentSessionDeleteSuccess(
  status: number,
  envelope: PublicSuccessEnvelope,
  expectedCredentialId: string
): CurrentSessionDeleteFacts | null {
  const data = envelope.data
  if (
    status !== 200 ||
    !isPlainObject(data) ||
    !hasExactKeys(data, ["revoked", "credentialId", "revokedAt"]) ||
    data.revoked !== true ||
    data.credentialId !== expectedCredentialId ||
    !isCanonicalUtcIso(data.revokedAt)
  ) {
    return null
  }
  return {
    credentialId: expectedCredentialId,
    revokedAt: data.revokedAt,
  }
}
