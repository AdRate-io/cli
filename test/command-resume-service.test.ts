import { describe, expect, it } from "vitest"
import {
  findResumePending,
  validateCommandResumeInput,
} from "../src/commands/command-resume-service.js"
import {
  createPreparedPendingCommand,
  pendingRecordId,
} from "../src/commands/pending-command-contract.js"
import { CliFailure } from "../src/errors.js"
import { CREDENTIAL_ID, statusIntent } from "./helpers.js"
import type { LocalErrorEnvelope } from "../src/contracts/envelope.js"
import type {
  PendingCommandRecordEntry,
  PendingCommandScanResult,
} from "../src/commands/pending-command-repository.js"

const CREATED_AT = new Date("2026-08-01T00:00:00.000Z")

function entry(input: {
  key: string
  campaignId?: string
  recordId?: string
}): PendingCommandRecordEntry {
  return {
    recordId: input.recordId ?? pendingRecordId(input.key),
    record: createPreparedPendingCommand({
      idempotencyKey: input.key,
      credentialId: CREDENTIAL_ID,
      issuerOrigin: "https://api.adrate.io",
      teamId: 42,
      capabilityId: "ads.campaign.status.write",
      intent: statusIntent({
        campaignId: input.campaignId ?? "80001",
      }),
      now: CREATED_AT,
    }),
  }
}

function scan(
  records: Array<PendingCommandRecordEntry>,
  invalidEntries: PendingCommandScanResult["invalidEntries"] = []
): PendingCommandScanResult {
  return { records, invalidEntries }
}

function failureFrom(action: () => unknown): CliFailure<LocalErrorEnvelope> {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    return error as CliFailure<LocalErrorEnvelope>
  }
  throw new Error("Expected action to fail")
}

describe("validateCommandResumeInput", () => {
  it("freezes a valid original key and optional request ID", () => {
    const validated = validateCommandResumeInput({
      idempotencyKey: "abc_DEF-9",
      requestId: "client_resume_1",
    })

    expect(validated).toEqual({
      idempotencyKey: "abc_DEF-9",
      requestId: "client_resume_1",
    })
    expect(Object.isFrozen(validated)).toBe(true)
  })

  it.each([
    ["missing key", {}],
    ["empty key", { idempotencyKey: "" }],
    ["unsafe key", { idempotencyKey: "../secret" }],
    ["oversized key", { idempotencyKey: "k".repeat(129) }],
    [
      "invalid request ID",
      { idempotencyKey: "valid-key", requestId: "bad request" },
    ],
  ])("rejects %s", (_label, input) => {
    const failure = failureFrom(() => validateCommandResumeInput(input))

    expect(failure.exitCode).toBe(2)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", retryable: false },
    })
  })
})

describe("findResumePending", () => {
  it("returns the one canonical frozen record bound to the original key", () => {
    const expected = entry({ key: "resume-key" })
    const other = entry({ key: "other-key", campaignId: "80002" })
    const validated = validateCommandResumeInput({
      idempotencyKey: "resume-key",
      requestId: "client_resume_1",
    })

    const found = findResumePending(scan([other, expected]), validated)

    expect(found).toEqual(expected)
    expect(found.record.idempotencyKey).toBe("resume-key")
    expect(found.record.intent).toEqual(expected.record.intent)
    expect(Object.isFrozen(found)).toBe(true)
    expect(Object.isFrozen(found.record)).toBe(true)
    expect(Object.isFrozen(found.record.intent)).toBe(true)
  })

  it("returns controlled INVALID_REQUEST when the key has no local record", () => {
    const missingKey = "missing-key-must-not-leak"
    const failure = failureFrom(() =>
      findResumePending(
        scan([entry({ key: "other-key" })]),
        validateCommandResumeInput({ idempotencyKey: missingKey })
      )
    )
    const serialized = JSON.stringify(failure.envelope)

    expect(failure.exitCode).toBe(2)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "pending_command_missing" },
      },
    })
    expect(serialized).not.toContain(missingKey)
  })

  it("fails loud for every damaged scan entry without leaking paths or token-like names", () => {
    const tokenLikeName = "adr_owner_secret_material"
    const absolutePath = "/Users/boss/.adrate/pending-commands/secret.json"
    const failure = failureFrom(() =>
      findResumePending(
        scan(
          [entry({ key: "resume-key" })],
          [
            { recordId: tokenLikeName, reason: "schema" },
            { recordId: absolutePath, reason: "permission" },
          ]
        ),
        validateCommandResumeInput({ idempotencyKey: "resume-key" })
      )
    )
    const serialized = JSON.stringify(failure.envelope)

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: {
        code: "LOCAL_STATE_UNSAFE",
        retryable: false,
        details: {
          invalidEntries: [
            { recordId: null, reason: "schema" },
            { recordId: null, reason: "permission" },
          ],
        },
      },
    })
    expect(serialized).not.toContain(tokenLikeName)
    expect(serialized).not.toContain(absolutePath)
  })

  it("rejects duplicate key association instead of selecting a record", () => {
    const failure = failureFrom(() =>
      findResumePending(
        scan([
          entry({ key: "same-key", recordId: "b".repeat(64) }),
          entry({
            key: "same-key",
            campaignId: "80002",
            recordId: "a".repeat(64),
          }),
        ]),
        validateCommandResumeInput({ idempotencyKey: "same-key" })
      )
    )

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope.error.details.invalidEntries).toEqual([
      { recordId: "a".repeat(64), reason: "duplicate_key" },
      { recordId: "b".repeat(64), reason: "duplicate_key" },
    ])
  })

  it.each([
    ["unsafe record ID", "secret-record-name"],
    ["hash mismatch", "f".repeat(64)],
  ])("rejects a supposedly safe scan with %s", (_label, recordId) => {
    const failure = failureFrom(() =>
      findResumePending(
        scan([entry({ key: "resume-key", recordId })]),
        validateCommandResumeInput({ idempotencyKey: "resume-key" })
      )
    )

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: { code: "LOCAL_STATE_UNSAFE", retryable: false },
    })
    expect(JSON.stringify(failure.envelope)).not.toContain("secret-record-name")
  })
})
