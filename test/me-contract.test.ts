import { describe, expect, it } from "vitest"
import { decodeMeFacts } from "../src/contracts/me.js"
import type { PublicSuccessEnvelope } from "../src/contracts/envelope.js"

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111"

function meEnvelope(): PublicSuccessEnvelope {
  return {
    ok: true,
    data: {
      principal: {
        kind: "owner_cli_session",
        credentialId: CREDENTIAL_ID,
      },
      subject: { userId: 19, nickname: "Boss" },
      team: { teamId: 7, teamName: "AdRate" },
      capabilities: [
        {
          capabilityId: "identity.read",
          granted: true,
          available: true,
          unavailableReason: null,
          risk: "low",
          rateClass: "public_read",
          operationUnits: 0,
          idempotencyRequired: false,
        },
      ],
      credential: {
        activationExpiresAt: null,
        idleExpiresAt: "2026-07-31T03:00:00.000Z",
        absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
      },
      plan: {
        planType: "enterprise",
        benefitStatus: "warning",
        publicApiRequestsPerMinute: null,
        publicApiRequestBurst: 10,
        publicApiWritesPerMinute: 10,
        publicApiTikTokUnitsPerDay: null,
      },
    },
    meta: { requestId: "me-contract-1", apiVersion: "v1" },
  }
}

describe("/me decoder", () => {
  it("accepts the complete real PublicMe DTO", () => {
    expect(decodeMeFacts(meEnvelope(), CREDENTIAL_ID)).toEqual({
      kind: "valid",
      facts: {
        credentialId: CREDENTIAL_ID,
        teamId: 7,
        teamName: "AdRate",
        activationExpiresAt: null,
        idleExpiresAt: "2026-07-31T03:00:00.000Z",
        absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
      },
    })
  })

  it("accepts additional top-level keys without rejecting", () => {
    const envelope = meEnvelope()
    ;(envelope.data as Record<string, unknown>).extraField = "future"
    expect(decodeMeFacts(envelope, CREDENTIAL_ID)).toMatchObject({
      kind: "valid",
    })
  })

  it("accepts unknown capabilities without rejecting", () => {
    const envelope = meEnvelope()
    ;(envelope.data as Record<string, unknown>).capabilities = [
      { capabilityId: "future.read", granted: true, available: true },
    ]
    expect(decodeMeFacts(envelope, CREDENTIAL_ID)).toMatchObject({
      kind: "valid",
    })
  })

  it("accepts unknown plan types without rejecting", () => {
    const envelope = meEnvelope()
    ;(envelope.data as Record<string, unknown>).plan = {
      planType: "premium",
      benefitStatus: "disabled",
    }
    expect(decodeMeFacts(envelope, CREDENTIAL_ID)).toMatchObject({
      kind: "valid",
    })
  })

  it("reports a different valid UUID only after the complete active lifecycle is valid", () => {
    const envelope = meEnvelope()
    ;(envelope.data.principal as Record<string, unknown>).credentialId =
      "99999999-9999-4999-8999-999999999999"
    expect(decodeMeFacts(envelope, CREDENTIAL_ID)).toEqual({
      kind: "identity_mismatch",
      actualCredentialId: "99999999-9999-4999-8999-999999999999",
    })
  })

  it("accepts an active idle expiry exactly capped by the absolute expiry", () => {
    const envelope = meEnvelope()
    envelope.data.credential = {
      activationExpiresAt: null,
      idleExpiresAt: "2026-08-30T02:00:00.000Z",
      absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
    }

    expect(decodeMeFacts(envelope, CREDENTIAL_ID)).toMatchObject({
      kind: "valid",
    })
  })

  it("rejects a malformed DTO before reporting a valid credential mismatch", () => {
    const envelope = meEnvelope()
    ;(envelope.data.principal as Record<string, unknown>).credentialId =
      "99999999-9999-4999-8999-999999999999"
    ;(envelope.data.team as Record<string, unknown>).teamId = 1.5

    expect(decodeMeFacts(envelope, CREDENTIAL_ID)).toEqual({
      kind: "contract_invalid",
    })
  })

  it.each([
    {
      label: "unactivated lifecycle",
      activationExpiresAt: "2026-07-31T02:10:00.000Z",
      idleExpiresAt: null,
      absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
    },
    {
      label: "activation and idle overlap",
      activationExpiresAt: "2026-07-31T02:10:00.000Z",
      idleExpiresAt: "2026-07-31T03:00:00.000Z",
      absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
    },
    {
      label: "active lifecycle without idle expiry",
      activationExpiresAt: null,
      idleExpiresAt: null,
      absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
    },
    {
      label: "idle expiry beyond the absolute boundary",
      activationExpiresAt: null,
      idleExpiresAt: "2026-08-30T02:00:00.001Z",
      absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
    },
  ])("rejects $label before credential mismatch", (lifecycle) => {
    const envelope = meEnvelope()
    ;(envelope.data.principal as Record<string, unknown>).credentialId =
      "99999999-9999-4999-8999-999999999999"
    envelope.data.credential = {
      activationExpiresAt: lifecycle.activationExpiresAt,
      idleExpiresAt: lifecycle.idleExpiresAt,
      absoluteExpiresAt: lifecycle.absoluteExpiresAt,
    }

    expect(decodeMeFacts(envelope, CREDENTIAL_ID)).toEqual({
      kind: "contract_invalid",
    })
  })

  it.each([
    [
      "missing principal",
      (data: Record<string, unknown>) => delete data.principal,
    ],
    [
      "non-UUID credentialId",
      (data: Record<string, unknown>) => {
        ;(data.principal as Record<string, unknown>).credentialId = "not-uuid"
      },
    ],
    [
      "missing team",
      (data: Record<string, unknown>) => delete data.team,
    ],
    [
      "empty team name",
      (data: Record<string, unknown>) => {
        ;(data.team as Record<string, unknown>).teamName = ""
      },
    ],
    [
      "non-integer teamId",
      (data: Record<string, unknown>) => {
        ;(data.team as Record<string, unknown>).teamId = 1.5
      },
    ],
    [
      "missing credential",
      (data: Record<string, unknown>) => delete data.credential,
    ],
    [
      "control characters in team name",
      (data: Record<string, unknown>) => {
        ;(data.team as Record<string, unknown>).teamName = "team\x00"
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const envelope = meEnvelope()
    mutate(envelope.data as Record<string, unknown>)
    expect(decodeMeFacts(envelope, CREDENTIAL_ID)).toEqual({
      kind: "contract_invalid",
    })
  })
})
