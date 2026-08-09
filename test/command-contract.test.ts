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

describe("PublicCommandDto decoder", () => {
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
    expect(decodePublicCommandDto(value)).toMatchObject({
      commandId: value.commandId,
      status: value.status,
      target: value.target,
    })
  })

  it("accepts extra fields on the Command DTO", () => {
    const result = decodePublicCommandDto({ ...pendingCommand(), extra: 1 })
    expect(result).not.toBeNull()
    expect(result!.commandId).toBe("018f15d1-7d8f-7ea1-a492-8b7f8271fc6e")
  })

  it("does not require or project unconsumed display fields", () => {
    const {
      reason: _reason,
      suggestedAction: _action,
      ...withoutDisplay
    } = pendingCommand({
      status: "failed",
      isFinal: true,
    })
    const result = decodePublicCommandDto(withoutDisplay)
    expect(result).not.toBeNull()
    expect(result).not.toHaveProperty("reason")
    expect(result).not.toHaveProperty("suggestedAction")
  })

  it("accepts a new server status without treating it as success", () => {
    expect(
      decodePublicCommandDto(pendingCommand({ status: "future_status" }))
    ).toMatchObject({ status: "future_status" })
  })

  it.each([
    ["non-UUID command", pendingCommand({ commandId: "command-1" })],
    ["unsafe idempotency key", pendingCommand({ idempotencyKey: "../key" })],
    ["empty status", pendingCommand({ status: "" })],
    [
      "invalid verificationBasis type",
      pendingCommand({ verificationBasis: 1 }),
    ],
    ["missing target", pendingCommand({ target: null })],
    [
      "invalid advertiser ID",
      pendingCommand({
        target: {
          advertiserId: "",
          campaignId: "80001",
          desiredStatus: "ENABLE",
        },
      }),
    ],
  ])("rejects %s", (_label, value) => {
    expect(decodePublicCommandDto(value)).toBeNull()
  })

  it("decodes the endpoint data wrapper with command key", () => {
    const command = pendingCommand()
    expect(decodePublicCommandData({ command })).toMatchObject({
      command: {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        status: command.status,
        target: command.target,
      },
    })
    expect(decodePublicCommandData(command)).toBeNull()
    expect(
      decodePublicCommandData({ command: { ...command, status: "future" } })
    ).toMatchObject({ command: { status: "future" } })
  })

  it("accepts additional keys in the data wrapper", () => {
    const command = pendingCommand()
    const result = decodePublicCommandData({ command, _notice: {} })
    expect(result).not.toBeNull()
  })

  it("decodes a locked Budget target with immutable value and targetBudget", () => {
    const value = pendingCommand({
      capabilityId: "ads.campaign.budget.write",
      target: {
        advertiserId: "70001",
        campaignId: "80001",
        mode: "increase_percent",
        value: 10,
        targetBudget: 220,
      },
    })

    expect(decodePublicCommandDto(value)).toMatchObject({
      target: {
        advertiserId: "70001",
        campaignId: "80001",
        mode: "increase_percent",
        value: 10,
        targetBudget: 220,
      },
    })
  })

  it("rejects a locked Budget target that omits the immutable input value", () => {
    const value = pendingCommand({
      capabilityId: "ads.campaign.budget.write",
      target: {
        advertiserId: "70001",
        campaignId: "80001",
        mode: "set",
        targetBudget: 300,
      },
    })

    expect(decodePublicCommandDto(value)).toBeNull()
  })

  it.each([
    ["gmvmax.campaign.status.write", { desiredStatus: "DISABLE" }],
    [
      "gmvmax.campaign.budget.write",
      { mode: "increase_percent", value: 10, targetBudget: 550 },
    ],
    [
      "gmvmax.campaign.roas.write",
      { mode: "set", value: 2.5, targetRoas: 2.5 },
    ],
  ] as const)(
    "解码 %s 的服务端 Command target",
    (capabilityId, familyTarget) => {
      expect(
        decodePublicCommandDto(
          pendingCommand({
            capabilityId,
            target: {
              advertiserId: "70001",
              campaignId: "80001",
              ...familyTarget,
            },
          })
        )
      ).toMatchObject({
        capabilityId,
        target: {
          advertiserId: "70001",
          campaignId: "80001",
          ...familyTarget,
        },
      })
    }
  )

  it("GMV Max 数值 target 缺原始 value 时 fail-closed", () => {
    expect(
      decodePublicCommandDto(
        pendingCommand({
          capabilityId: "gmvmax.campaign.roas.write",
          target: {
            advertiserId: "70001",
            campaignId: "80001",
            mode: "set",
            targetRoas: 2.5,
          },
        })
      )
    ).toBeNull()
  })
})
