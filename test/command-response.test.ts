import { describe, expect, it } from "vitest"
import {
  decideCommandGetPendingCommand,
  decideStatusPendingCommand,
  decodeCommandGetResponse,
  decodeStatusCommandResponse,
} from "../src/commands/command-response.js"
import { decodePublicEnvelope } from "../src/contracts/envelope.js"
import type { PublicEnvelope } from "../src/contracts/envelope.js"

const CREATED_AT = "2026-07-31T08:00:00.000Z"
const PENDING_UNTIL = "2026-08-01T08:00:00.000Z"
const RECOVERY_UNTIL = "2026-08-07T08:00:00.000Z"
const EXPECTED = Object.freeze({
  idempotencyKey: "abc_DEF-9",
  capabilityId: "ads.campaign.status.write",
  intent: Object.freeze({
    advId: "70001",
    campaignId: "80001",
    desiredStatus: "ENABLE" as const,
    authId: 42,
  }),
})

function pendingCommand(overrides: Record<string, unknown> = {}) {
  return {
    commandId: "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
    idempotencyKey: EXPECTED.idempotencyKey,
    capabilityId: "ads.campaign.status.write",
    status: "pending",
    isFinal: false,
    reason: null,
    suggestedAction: "query_command",
    target: {
      advertiserId: EXPECTED.intent.advId,
      campaignId: EXPECTED.intent.campaignId,
      desiredStatus: EXPECTED.intent.desiredStatus,
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

function succeededCommand() {
  return pendingCommand({
    status: "succeeded",
    isFinal: true,
    suggestedAction: null,
    beforeStatus: "ENABLE",
    verificationBasis: "verified_no_op",
    completedAt: CREATED_AT,
    recoverableUntil: null,
  })
}

function failedCommand() {
  return pendingCommand({
    status: "failed",
    isFinal: true,
    reason: "upstream_rejected",
    suggestedAction: null,
    completedAt: CREATED_AT,
    recoverableUntil: null,
  })
}

function unknownCommand(final: boolean) {
  return pendingCommand({
    status: "unknown",
    isFinal: final,
    reason: final ? "recovery_window_expired" : null,
    suggestedAction: final ? null : "query_command",
    beforeStatus: "DISABLE",
    attemptCount: 1,
    startedAt: CREATED_AT,
    completedAt: final ? RECOVERY_UNTIL : null,
    recoverableUntil: final ? null : RECOVERY_UNTIL,
  })
}

function usage(operationUnitsCharged: number | null) {
  return {
    operationUnits: 3,
    operationUnitsCharged,
    minute: { limit: 60, remaining: 59, resetAt: PENDING_UNTIL, burst: 10 },
    writeMinute: { limit: 10, remaining: 9, resetAt: PENDING_UNTIL },
    dailyTikTokUnits: {
      limit: 3000,
      remaining: 2997,
      resetAt: PENDING_UNTIL,
    },
  }
}

function envelope(value: Record<string, unknown>): PublicEnvelope {
  const decoded = decodePublicEnvelope(JSON.stringify(value))
  if (!decoded.ok) throw new Error(`invalid test envelope: ${decoded.reason}`)
  return decoded.envelope
}

function success(
  command: Record<string, unknown>,
  operationUnitsCharged?: 0 | 1 | 2 | 3 | null
): PublicEnvelope {
  return envelope({
    ok: true,
    data: { command },
    meta: {
      requestId: "status_success",
      apiVersion: "v1",
      ...(operationUnitsCharged === undefined
        ? {}
        : { usage: usage(operationUnitsCharged) }),
    },
  })
}

function error(input: {
  retryable: boolean
  details: Record<string, unknown>
  code?: string
  operationUnitsCharged?: 0 | 1 | 2 | 3 | null
}): PublicEnvelope {
  return envelope({
    ok: false,
    error: {
      code: input.code ?? "UPSTREAM_ERROR",
      message: "The write did not complete.",
      retryable: input.retryable,
      details: input.details,
    },
    meta: {
      requestId: "status_error",
      apiVersion: "v1",
      ...(input.operationUnitsCharged === undefined
        ? {}
        : { usage: usage(input.operationUnitsCharged) }),
    },
  })
}

describe("Status Command response evidence", () => {
  it("extracts exact success data.command and retains a 202 non-final Command", () => {
    const response = success(pendingCommand())
    expect(decodeStatusCommandResponse(response, EXPECTED)).toMatchObject({
      kind: "command",
      source: "success",
      command: { status: "pending", isFinal: false },
    })
    expect(decideStatusPendingCommand(response, 202, EXPECTED)).toMatchObject({
      action: "retain_command",
      exitCode: 4,
      contractViolation: null,
    })
  })

  it("extracts compatible error details.command and retains pending with exit 4", () => {
    const response = error({
      retryable: true,
      details: { commandCreated: true, command: pendingCommand() },
    })
    expect(decodeStatusCommandResponse(response, EXPECTED)).toMatchObject({
      kind: "command",
      source: "error",
    })
    expect(decideStatusPendingCommand(response, 503, EXPECTED)).toMatchObject({
      action: "retain_command",
      exitCode: 4,
      command: { status: "pending" },
    })
  })

  it("removes final success/error evidence and detects 202 + final contract drift", () => {
    const finalSuccess = success(succeededCommand())
    expect(
      decideStatusPendingCommand(finalSuccess, 200, EXPECTED)
    ).toMatchObject({
      action: "remove",
      exitCode: 0,
      contractViolation: null,
    })
    expect(
      decideStatusPendingCommand(finalSuccess, 202, EXPECTED)
    ).toMatchObject({
      action: "remove",
      exitCode: 0,
      contractViolation: "unexpected_status_for_command",
    })

    const finalError = error({
      retryable: false,
      details: { commandCreated: true, command: failedCommand() },
    })
    expect(decideStatusPendingCommand(finalError, 502, EXPECTED)).toMatchObject(
      {
        action: "remove",
        exitCode: 1,
        command: { status: "failed", isFinal: true },
      }
    )
  })

  it("only commandCreated=false without Command proves safe removal", () => {
    const knownAbsent = error({
      retryable: false,
      code: "INVALID_REQUEST",
      details: { commandCreated: false },
    })
    expect(decodeStatusCommandResponse(knownAbsent, EXPECTED)).toEqual({
      kind: "not_created",
    })
    expect(
      decideStatusPendingCommand(knownAbsent, 400, EXPECTED)
    ).toMatchObject({ action: "remove", exitCode: 2, command: null })

    for (const details of [
      {},
      { commandCreated: true },
      { commandCreated: false, command: pendingCommand() },
    ]) {
      const ambiguous = error({ retryable: false, details })
      expect(
        decideStatusPendingCommand(ambiguous, 503, EXPECTED)
      ).toMatchObject({
        action: "retain_unknown",
        exitCode: 5,
        contractViolation: "invalid_command_response",
      })
    }
  })

  it("operationUnitsCharged=null does not override Command evidence", () => {
    const response = error({
      retryable: true,
      details: {},
      operationUnitsCharged: null,
    })
    expect(decideStatusPendingCommand(response, 503, EXPECTED)).toMatchObject({
      action: "retain_unknown",
      exitCode: 5,
      command: null,
    })

    const contradictoryNotCreated = error({
      retryable: true,
      details: { commandCreated: false },
      operationUnitsCharged: null,
    })
    expect(
      decideStatusPendingCommand(contradictoryNotCreated, 503, EXPECTED)
    ).toMatchObject({
      action: "remove",
      exitCode: 4,
      contractViolation: null,
    })

    const contradictoryFinal = error({
      retryable: false,
      details: { commandCreated: true, command: failedCommand() },
      operationUnitsCharged: null,
    })
    expect(
      decideStatusPendingCommand(contradictoryFinal, 503, EXPECTED)
    ).toMatchObject({
      action: "remove",
      exitCode: 1,
      command: { status: "failed", isFinal: true },
      contractViolation: null,
    })
  })

  it("does not apply the error-only charge-null rule to a success envelope", () => {
    const response = success(succeededCommand(), null)
    expect(decideStatusPendingCommand(response, 200, EXPECTED)).toMatchObject({
      action: "remove",
      exitCode: 0,
      command: { status: "succeeded", isFinal: true },
      contractViolation: null,
    })
  })

  it("rejects wrong identity and error/Command mismatch", () => {
    const cases = [
      success(
        pendingCommand({
          idempotencyKey: "different_key",
        })
      ),
      success(pendingCommand({ capabilityId: "future.write" })),
      error({
        retryable: false,
        details: { commandCreated: true, command: pendingCommand() },
      }),
    ]
    for (const response of cases) {
      expect(decideStatusPendingCommand(response, 200, EXPECTED)).toMatchObject(
        { action: "retain_unknown", exitCode: 5 }
      )
    }
  })

  it("tolerates extra fields on a valid Command DTO", () => {
    const result = decideStatusPendingCommand(
      success({ ...pendingCommand(), accessToken: "extra" }),
      200,
      EXPECTED
    )
    expect(result.exitCode).not.toBe(5)
  })

  it("never reports success without exact positive evidence", () => {
    for (const command of [
      { ...succeededCommand(), verificationBasis: null },
      { ...succeededCommand(), beforeStatus: "DISABLE" },
      {
        ...succeededCommand(),
        verificationBasis: "observed_target_state",
        afterStatus: "DISABLE",
      },
      { ...succeededCommand(), isFinal: false },
    ]) {
      const result = decideStatusPendingCommand(
        success(command),
        200,
        EXPECTED
      )
      expect(result.exitCode).toBe(5)
      expect(result.action).toBe("retain_unknown")
    }
  })

  it("maps final failed and unknown facts in success envelopes to nonzero", () => {
    expect(
      decideStatusPendingCommand(success(failedCommand()), 200, EXPECTED)
    ).toMatchObject({ action: "remove", exitCode: 1 })
    expect(
      decideStatusPendingCommand(success(unknownCommand(true)), 200, EXPECTED)
    ).toMatchObject({ action: "remove", exitCode: 5 })
  })
})

describe("Command GET response evidence", () => {
  it.each([
    [pendingCommand(), "retain_command", 4],
    [unknownCommand(false), "retain_command", 5],
    [succeededCommand(), "remove", 0],
    [failedCommand(), "remove", 1],
    [unknownCommand(true), "remove", 5],
  ] as const)(
    "maps every valid GET state without inventing HTTP 202",
    (command, action, exitCode) => {
      const response = success(command)
      expect(decideCommandGetPendingCommand(response, EXPECTED)).toMatchObject({
        action,
        exitCode,
      })
    }
  )

  it("keeps local evidence on GET error and rejects Status-only evidence", () => {
    const notFound = error({
      retryable: false,
      code: "RESOURCE_NOT_FOUND",
      details: { suggestedAction: null, resolutionUrl: null },
    })
    expect(decodeCommandGetResponse(notFound, EXPECTED)).toEqual({
      kind: "error_without_command",
    })
    expect(decideCommandGetPendingCommand(notFound, EXPECTED)).toMatchObject({
      action: "retain",
      exitCode: 1,
    })

    const illegal = error({
      retryable: false,
      details: { commandCreated: false },
    })
    expect(decideCommandGetPendingCommand(illegal, EXPECTED)).toMatchObject({
      action: "retain_unknown",
      exitCode: 5,
      contractViolation: "invalid_command_response",
    })
  })
})
