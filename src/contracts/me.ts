import { LOWERCASE_UUID_PATTERN } from "../constants.js"
import {
  hasKeys,
  isCanonicalUtcIso,
  isNullableCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "./json.js"
import type { PublicSuccessEnvelope } from "./envelope.js"

function hasAsciiControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code <= 0x1f || code === 0x7f)
  })
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
    !isPlainObject(data.principal) ||
    !hasKeys(data.principal, ["kind", "credentialId"]) ||
    data.principal.kind !== "owner_cli_session" ||
    typeof data.principal.credentialId !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(data.principal.credentialId)
  ) {
    return { kind: "contract_invalid" }
  }
  const credentialId = data.principal.credentialId
  if (
    !isPlainObject(data.team) ||
    !hasKeys(data.team, ["teamId", "teamName"]) ||
    !isSafeIntegerInRange(data.team.teamId, 1) ||
    typeof data.team.teamName !== "string" ||
    data.team.teamName.length === 0 ||
    hasAsciiControlCharacters(data.team.teamName) ||
    !isPlainObject(data.credential) ||
    !hasKeys(data.credential, [
      "activationExpiresAt",
      "idleExpiresAt",
      "absoluteExpiresAt",
    ]) ||
    !isNullableCanonicalUtcIso(data.credential.activationExpiresAt) ||
    !isNullableCanonicalUtcIso(data.credential.idleExpiresAt) ||
    !isCanonicalUtcIso(data.credential.absoluteExpiresAt)
  ) {
    return { kind: "contract_invalid" }
  }
  const activationExpiresAt = data.credential.activationExpiresAt
  const idleExpiresAt = data.credential.idleExpiresAt
  const absoluteExpiresAt = data.credential.absoluteExpiresAt
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
