import { describe, expect, it } from "vitest"
import {
  findAssociatedPending,
  validateCommandGetInput,
} from "../src/commands/command-query-service.js"
import {
  createPreparedPendingCommand,
  pendingRecordId,
} from "../src/commands/pending-command-contract.js"
import { CliFailure } from "../src/errors.js"
import { CREDENTIAL_ID, statusIntent } from "./helpers.js"
import type { LocalErrorEnvelope } from "../src/contracts/envelope.js"
import type { PendingCommandRecord } from "../src/commands/pending-command-contract.js"
import type {
  PendingCommandRecordEntry,
  PendingCommandScanResult,
} from "../src/commands/pending-command-repository.js"

const COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e"
const CREATED_AT = new Date("2026-07-31T08:00:00.000Z")

function entry(input: {
  key: string
  campaignId?: string
  commandId?: string | null
  recordId?: string
}): PendingCommandRecordEntry {
  const prepared = createPreparedPendingCommand({
    idempotencyKey: input.key,
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 42,
    capabilityId: "ads.campaign.status.write",
    intent: statusIntent({
      campaignId: input.campaignId ?? "80001",
    }),
    now: CREATED_AT,
  })
  const commandId = input.commandId ?? null
  const record: PendingCommandRecord =
    commandId === null
      ? prepared
      : { ...prepared, localState: "command_known", commandId }
  return {
    recordId: input.recordId ?? pendingRecordId(input.key),
    record,
  }
}

function scan(
  records: Array<PendingCommandRecordEntry>
): PendingCommandScanResult {
  return { records, invalidEntries: [] }
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

describe("validateCommandGetInput", () => {
  it("accepts a lowercase UUID and creates a raw safe path", () => {
    expect(validateCommandGetInput({ commandId: COMMAND_ID })).toEqual({
      kind: "command_id",
      commandId: COMMAND_ID,
      path: `/public/v1/commands/${COMMAND_ID}`,
    })
  })

  it("accepts the full T08 key grammar and builds the query with URLSearchParams", () => {
    const idempotencyKey = "abc_DEF-9"
    const requestId = "client_get_1"
    const expectedQuery = new URLSearchParams({ idempotencyKey }).toString()

    expect(validateCommandGetInput({ idempotencyKey, requestId })).toEqual({
      kind: "idempotency_key",
      idempotencyKey,
      path: `/public/v1/commands?${expectedQuery}`,
      requestId,
    })
  })

  it.each([
    ["neither selector", {}],
    ["both selectors", { commandId: COMMAND_ID, idempotencyKey: "valid-key" }],
    ["unsafe command path", { commandId: "../commands" }],
    ["uppercase UUID", { commandId: COMMAND_ID.toUpperCase() }],
    ["invalid key character", { idempotencyKey: "bad/key" }],
    ["oversized key", { idempotencyKey: "k".repeat(129) }],
    [
      "invalid request ID",
      { idempotencyKey: "valid-key", requestId: "bad request" },
    ],
  ])("rejects %s before downstream work", (_label, input) => {
    const failure = failureFrom(() => validateCommandGetInput(input))

    expect(failure.exitCode).toBe(2)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", retryable: false },
    })
  })
})

describe("findAssociatedPending", () => {
  it("associates exactly one record by idempotency key", () => {
    const expected = entry({ key: "target-key" })
    const other = entry({ key: "other-key", campaignId: "80002" })
    const query = validateCommandGetInput({ idempotencyKey: "target-key" })

    expect(findAssociatedPending(scan([other, expected]), query)).toBe(expected)
  })

  it("associates exactly one record by command ID", () => {
    const expected = entry({ key: "target-key", commandId: COMMAND_ID })
    const other = entry({ key: "other-key", campaignId: "80002" })
    const query = validateCommandGetInput({ commandId: COMMAND_ID })

    expect(findAssociatedPending(scan([other, expected]), query)).toBe(expected)
  })

  it("returns null when no local record is associated", () => {
    expect(
      findAssociatedPending(
        scan([entry({ key: "other-key" })]),
        validateCommandGetInput({ idempotencyKey: "missing-key" })
      )
    ).toBeNull()
  })

  it("fails loud on a damaged scan and controls every echoed record ID", () => {
    const tokenLikeName = "adr_owner_secret_material"
    const absolutePath = "/Users/boss/.adrate/pending-commands/secret.json"
    const failure = failureFrom(() =>
      findAssociatedPending(
        {
          records: [entry({ key: "valid-key" })],
          invalidEntries: [
            { recordId: tokenLikeName, reason: "schema" },
            { recordId: absolutePath, reason: "permission" },
          ],
        },
        validateCommandGetInput({ idempotencyKey: "valid-key" })
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

  it("rejects duplicate key association instead of guessing a record", () => {
    const query = validateCommandGetInput({ idempotencyKey: "same-key" })
    const failure = failureFrom(() =>
      findAssociatedPending(
        scan([
          entry({ key: "same-key", recordId: "a".repeat(64) }),
          entry({
            key: "same-key",
            campaignId: "80002",
            recordId: "b".repeat(64),
          }),
        ]),
        query
      )
    )

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope.error.details.invalidEntries).toEqual([
      { recordId: "a".repeat(64), reason: "duplicate_key" },
      { recordId: "b".repeat(64), reason: "duplicate_key" },
    ])
  })

  it("rejects duplicate command ID association instead of guessing a record", () => {
    const query = validateCommandGetInput({ commandId: COMMAND_ID })
    const failure = failureFrom(() =>
      findAssociatedPending(
        scan([
          entry({
            key: "first-key",
            commandId: COMMAND_ID,
            recordId: "c".repeat(64),
          }),
          entry({
            key: "second-key",
            campaignId: "80002",
            commandId: COMMAND_ID,
            recordId: "d".repeat(64),
          }),
        ]),
        query
      )
    )

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope.error.details.invalidEntries).toEqual([
      { recordId: "c".repeat(64), reason: "schema" },
      { recordId: "d".repeat(64), reason: "schema" },
    ])
  })
})
