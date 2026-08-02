import { describe, expect, it } from "vitest"
import { decodeMeFacts } from "../src/contracts/me.js"
import type { PublicSuccessEnvelope } from "../src/contracts/envelope.js"

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111"

function meEnvelope(): PublicSuccessEnvelope {
  const capabilityIds = [
    "identity.read",
    "connections.read",
    "ads.campaign.read",
    "ads.report.read",
    "ads.campaign.status.write",
  ]
  return {
    ok: true,
    data: {
      principal: {
        kind: "owner_cli_session",
        credentialId: CREDENTIAL_ID,
      },
      subject: { userId: 19, nickname: "Boss" },
      team: { teamId: 7, teamName: "AdRate" },
      capabilities: capabilityIds.map((capabilityId, index) => ({
        capabilityId,
        granted: true,
        available: true,
        unavailableReason: null,
        risk: index < 2 ? "low" : index < 4 ? "medium" : "high",
        rateClass:
          index < 2
            ? "public_read"
            : index < 4
              ? "upstream_read"
              : "public_write",
        operationUnits: index < 2 ? 0 : index < 4 ? index - 1 : 3,
        idempotencyRequired: index === 4,
      })),
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

describe("strict /me decoder", () => {
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
      "extra top-level key",
      (data: Record<string, unknown>) => (data.extra = 1),
    ],
    ["missing subject", (data: Record<string, unknown>) => delete data.subject],
    [
      "invalid subject integer",
      (data: Record<string, unknown>) => {
        ;(data.subject as Record<string, unknown>).userId = 1.5
      },
    ],
    [
      "unknown capability",
      (data: Record<string, unknown>) => {
        ;(
          data.capabilities as Array<Record<string, unknown>>
        )[0]!.capabilityId = "unknown.read"
      },
    ],
    [
      "invalid operation units",
      (data: Record<string, unknown>) => {
        ;(
          data.capabilities as Array<Record<string, unknown>>
        )[0]!.operationUnits = 1.5
      },
    ],
    [
      "unknown unavailable reason",
      (data: Record<string, unknown>) => {
        ;(
          data.capabilities as Array<Record<string, unknown>>
        )[0]!.unavailableReason = "unknown_reason"
      },
    ],
    [
      "duplicate capability",
      (data: Record<string, unknown>) => {
        const capabilities = data.capabilities as Array<Record<string, unknown>>
        capabilities[1]!.capabilityId = capabilities[0]!.capabilityId
      },
    ],
    [
      "unknown plan",
      (data: Record<string, unknown>) => {
        ;(data.plan as Record<string, unknown>).planType = "premium"
      },
    ],
    [
      "invalid plan integer",
      (data: Record<string, unknown>) => {
        ;(data.plan as Record<string, unknown>).publicApiRequestBurst = -1
      },
    ],
    [
      "unknown benefit status",
      (data: Record<string, unknown>) => {
        ;(data.plan as Record<string, unknown>).benefitStatus = "disabled"
      },
    ],
    [
      "extra credential key",
      (data: Record<string, unknown>) => {
        ;(data.credential as Record<string, unknown>).secret = "must-reject"
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
