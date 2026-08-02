import { describe, expect, it } from "vitest"
import {
  decodePublicCommandData,
  decodePublicCommandDto,
} from "../src/contracts/command.js"

const CREATED_AT = "2026-07-31T08:00:00.000Z"
const PENDING_UNTIL = "2026-08-01T08:00:00.000Z"
const RECOVERY_UNTIL = "2026-08-07T08:00:00.000Z"

function pendingCommand(overrides: Record<string, unknown> = {}) {
  return {
    commandId: "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
    idempotencyKey: "abc_DEF-9",
    capabilityId: "ads.campaign.status.write",
    status: "pending",
    isFinal: false,
    reason: null,
    suggestedAction: "query_command",
    target: {
      advertiserId: "70001",
      campaignId: "80001",
      desiredStatus: "ENABLE",
    },
    beforeStatus: null,
    afterStatus: null,
    verificationBasis: null,
    attemptCount: 0,
    createdAt: CREATED_AT,
    startedAt: null,
    completedAt: null,
    recoverableUntil: PENDING_UNTIL,
    lastReconcileAt: null,
    ...overrides,
  }
}

describe("PublicCommandDto strict decoder", () => {
  it.each([
    ["pending", pendingCommand()],
    [
      "executing",
      pendingCommand({
        status: "executing",
        beforeStatus: "DISABLE",
        attemptCount: 1,
        startedAt: CREATED_AT,
        recoverableUntil: RECOVERY_UNTIL,
      }),
    ],
    [
      "succeeded no-op",
      pendingCommand({
        status: "succeeded",
        isFinal: true,
        suggestedAction: null,
        beforeStatus: "ENABLE",
        verificationBasis: "verified_no_op",
        completedAt: CREATED_AT,
        recoverableUntil: null,
      }),
    ],
    [
      "succeeded observed",
      pendingCommand({
        status: "succeeded",
        isFinal: true,
        suggestedAction: null,
        beforeStatus: "DISABLE",
        afterStatus: "ENABLE",
        verificationBasis: "observed_target_state",
        attemptCount: 1,
        startedAt: CREATED_AT,
        completedAt: CREATED_AT,
        recoverableUntil: null,
      }),
    ],
    [
      "failed",
      pendingCommand({
        status: "failed",
        isFinal: true,
        reason: "upstream_rejected",
        suggestedAction: null,
        completedAt: CREATED_AT,
        recoverableUntil: null,
      }),
    ],
    [
      "unknown recoverable",
      pendingCommand({
        status: "unknown",
        beforeStatus: "DISABLE",
        attemptCount: 1,
        startedAt: CREATED_AT,
        recoverableUntil: RECOVERY_UNTIL,
      }),
    ],
    [
      "unknown final",
      pendingCommand({
        status: "unknown",
        isFinal: true,
        reason: "recovery_window_expired",
        suggestedAction: null,
        beforeStatus: "DISABLE",
        attemptCount: 1,
        startedAt: CREATED_AT,
        completedAt: RECOVERY_UNTIL,
        recoverableUntil: null,
      }),
    ],
  ])("accepts the T08 %s state", (_label, value) => {
    expect(decodePublicCommandDto(value)).toEqual(value)
  })

  it.each([
    ["extra field", { ...pendingCommand(), raw: "secret" }],
    ["non-UUID command", pendingCommand({ commandId: "command-1" })],
    ["unsafe idempotency key", pendingCommand({ idempotencyKey: "../key" })],
    [
      "wrong pending window",
      pendingCommand({ recoverableUntil: RECOVERY_UNTIL }),
    ],
    ["pending marked final", pendingCommand({ isFinal: true })],
    [
      "executing without attempt",
      pendingCommand({
        status: "executing",
        beforeStatus: "DISABLE",
        recoverableUntil: RECOVERY_UNTIL,
      }),
    ],
    [
      "observed success without dispatch",
      pendingCommand({
        status: "succeeded",
        isFinal: true,
        suggestedAction: null,
        beforeStatus: "DISABLE",
        afterStatus: "ENABLE",
        verificationBasis: "observed_target_state",
        completedAt: CREATED_AT,
        recoverableUntil: null,
      }),
    ],
    [
      "final unknown with success verification",
      pendingCommand({
        status: "unknown",
        isFinal: true,
        reason: "recovery_window_expired",
        suggestedAction: null,
        beforeStatus: "DISABLE",
        verificationBasis: "observed_target_state",
        attemptCount: 1,
        startedAt: CREATED_AT,
        completedAt: RECOVERY_UNTIL,
        recoverableUntil: null,
      }),
    ],
    [
      "target extra field",
      pendingCommand({
        target: {
          advertiserId: "70001",
          campaignId: "80001",
          desiredStatus: "ENABLE",
          accessToken: "must-not-pass",
        },
      }),
    ],
    [
      "non-canonical time",
      pendingCommand({ createdAt: "2026-07-31T08:00:00Z" }),
    ],
  ])("rejects %s", (_label, value) => {
    expect(decodePublicCommandDto(value)).toBeNull()
  })

  it("requires the endpoint data wrapper to contain only command", () => {
    const command = pendingCommand()
    expect(decodePublicCommandData({ command })).toEqual({ command })
    expect(decodePublicCommandData(command)).toBeNull()
    expect(decodePublicCommandData({ command, raw: {} })).toBeNull()
    expect(
      decodePublicCommandData({ command: { ...command, status: "bad" } })
    ).toBeNull()
  })
})
