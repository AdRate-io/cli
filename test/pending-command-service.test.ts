import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PendingCommandService } from "../src/commands/pending-command-service.js"
import {
  pendingRecordId,
  serializePendingCommand,
} from "../src/commands/pending-command-contract.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { CLI_VERSION } from "../src/constants.js"
import { CliFailure } from "../src/errors.js"
import { CliStateStore } from "../src/storage/state-store.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  statusIntent,
  validCredentialMetadata,
  validTokenIndex,
} from "./helpers.js"
import type { LocalErrorEnvelope } from "../src/contracts/envelope.js"
import type {
  PendingCommandLocalState,
  PendingCommandRecord,
} from "../src/commands/pending-command-contract.js"
import type { TemporaryStateFixture } from "./helpers.js"

const NOW = new Date("2026-07-31T08:00:10.000Z")
const COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e"
const OLD_CREDENTIAL_ID = "77777777-7777-4777-8777-777777777777"

interface SeedInput {
  key: string
  campaignId: string
  createdAt: string
  credentialId?: string
  issuerOrigin?: "https://api.adrate.io" | "https://api.test.adrate.io"
  teamId?: number
  localState?: PendingCommandLocalState
  commandId?: string | null
  lastResponse?: PendingCommandRecord["lastResponse"]
}

let fixture: TemporaryStateFixture
let repository: PendingCommandRepository
let state: CliStateStore

async function installCurrentScope(): Promise<void> {
  const config = await state.ensureConfig("production")
  const index = validTokenIndex({ clientInstanceId: config.clientInstanceId })
  await state.writeTokenIndex(index)
  await state.writeCredentials(
    validCredentialMetadata({
      clientInstanceId: config.clientInstanceId,
      loggedInAt: index.tokenReceivedAt,
      deviceName: index.deviceName,
    })
  )
}

async function seed(input: SeedInput) {
  const created = await repository.prepare({
    idempotencyKey: input.key,
    credentialId: input.credentialId ?? CREDENTIAL_ID,
    issuerOrigin: input.issuerOrigin ?? "https://api.adrate.io",
    teamId: input.teamId ?? 42,
    capabilityId: "ads.campaign.status.write",
    intent: statusIntent({
      campaignId: input.campaignId,
    }),
    now: new Date(input.createdAt),
  })
  if (created.kind !== "created") {
    throw new Error(`Unexpected prepare result: ${created.kind}`)
  }
  const next: PendingCommandRecord = {
    ...created.record,
    localState: input.localState ?? "prepared",
    commandId: input.commandId ?? null,
    lastResponse: input.lastResponse ?? null,
  }
  if (
    serializePendingCommand(next) !== serializePendingCommand(created.record)
  ) {
    await repository.replaceExact(created.record, next)
  }
  return { recordId: created.recordId, record: next }
}

async function failureFrom(service: PendingCommandService) {
  try {
    await service.pending()
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    return error as CliFailure<LocalErrorEnvelope>
  }
  throw new Error("Expected PendingCommandService.pending() to fail")
}

beforeEach(async () => {
  fixture = await createTemporaryStateFixture()
  repository = new PendingCommandRepository(fixture.fileSystem, fixture.paths)
  state = new CliStateStore(fixture.fileSystem, fixture.paths)
  await installCurrentScope()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("PendingCommandService", () => {
  it("emits the exact DTO, stable order, ages, modes, and counts", async () => {
    const prepared = await seed({
      key: "prepared-key",
      campaignId: "80003",
      createdAt: "2026-07-31T08:00:03.000Z",
    })
    const known = await seed({
      key: "known-key",
      campaignId: "80001",
      createdAt: "2026-07-31T08:00:01.000Z",
      localState: "command_known",
      commandId: COMMAND_ID,
      lastResponse: {
        requestId: "status_request_1",
        httpStatus: 202,
        errorCode: null,
      },
    })
    const unknown = await seed({
      key: "unknown-key",
      campaignId: "80002",
      createdAt: "2026-07-31T08:00:02.000Z",
      localState: "response_unknown",
    })

    const outcome = await new PendingCommandService(repository, state, {
      now: () => NOW,
    }).pending()

    expect(outcome.exitCode).toBe(0)
    expect(outcome.warnings).toEqual([])
    expect(outcome.envelope).toEqual({
      ok: true,
      data: {
        records: [
          {
            recordId: known.recordId,
            idempotencyKey: "known-key",
            capabilityId: "ads.campaign.status.write",
            credentialKind: "owner_cli_session",
            credentialId: CREDENTIAL_ID,
            issuerOrigin: "https://api.adrate.io",
            teamId: 42,
            intent: {
              capabilityId: "ads.campaign.status.write",
              advId: "70001",
              campaignId: "80001",
              authId: null,
              desiredStatus: "ENABLE",
            },
            localState: "command_known",
            commandId: COMMAND_ID,
            createdAt: "2026-07-31T08:00:01.000Z",
            updatedAt: "2026-07-31T08:00:01.000Z",
            ageSeconds: 9,
            resumeMode: "query",
            blockedReason: null,
            lastResponse: {
              requestId: "status_request_1",
              httpStatus: 202,
              errorCode: null,
            },
          },
          expect.objectContaining({
            recordId: unknown.recordId,
            idempotencyKey: "unknown-key",
            localState: "response_unknown",
            ageSeconds: 8,
            resumeMode: "post_if_server_missing",
            blockedReason: null,
          }),
          expect.objectContaining({
            recordId: prepared.recordId,
            idempotencyKey: "prepared-key",
            localState: "prepared",
            ageSeconds: 7,
            resumeMode: "post_if_server_missing",
            blockedReason: null,
          }),
        ],
        counts: {
          total: 3,
          query: 1,
          postIfServerMissing: 2,
          blocked: 0,
        },
      },
      meta: {
        requestId: expect.stringMatching(/^local_/),
        apiVersion: "v1",
        cliVersion: CLI_VERSION,
      },
    })
    if (!outcome.envelope.ok) throw new Error("Expected success")
    const records = outcome.envelope.data.records as Array<
      Record<string, unknown>
    >
    const exactKeys = [
      "recordId",
      "idempotencyKey",
      "capabilityId",
      "credentialKind",
      "credentialId",
      "issuerOrigin",
      "teamId",
      "intent",
      "localState",
      "commandId",
      "createdAt",
      "updatedAt",
      "ageSeconds",
      "resumeMode",
      "blockedReason",
      "lastResponse",
    ].sort()
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(exactKeys)
    }
    expect(records[0]).not.toHaveProperty("formatVersion")
    expect(records[0]).not.toHaveProperty("intentHash")
  })

  it("uses recordId as the deterministic tie breaker", async () => {
    const left = await seed({
      key: "tie-left",
      campaignId: "81001",
      createdAt: "2026-07-31T08:00:00.000Z",
    })
    const right = await seed({
      key: "tie-right",
      campaignId: "81002",
      createdAt: "2026-07-31T08:00:00.000Z",
    })

    const outcome = await new PendingCommandService(repository, state, {
      now: () => NOW,
    }).pending()
    if (!outcome.envelope.ok) throw new Error("Expected success")
    const records = outcome.envelope.data.records as Array<{
      recordId: string
    }>

    expect(records.map((record) => record.recordId)).toEqual(
      [left.recordId, right.recordId].sort()
    )
  })

  it("returns age zero at the boundary and fails loud for future evidence", async () => {
    const boundary = await seed({
      key: "boundary-key",
      campaignId: "82001",
      createdAt: NOW.toISOString(),
    })
    const success = await new PendingCommandService(repository, state, {
      now: () => NOW,
    }).pending()
    if (!success.envelope.ok) throw new Error("Expected success")
    const records = success.envelope.data.records as Array<{
      ageSeconds: number
    }>
    expect(records[0]?.ageSeconds).toBe(0)

    const future = await seed({
      key: "future-key",
      campaignId: "82002",
      createdAt: "2026-07-31T08:00:10.001Z",
    })
    const before = await repository.scan()
    const failure = await failureFrom(
      new PendingCommandService(repository, state, { now: () => NOW })
    )

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: {
        code: "LOCAL_STATE_UNSAFE",
        retryable: false,
        details: {
          validRecords: [
            expect.objectContaining({
              recordId: boundary.recordId,
              ageSeconds: 0,
            }),
          ],
          invalidEntries: [{ recordId: future.recordId, reason: "schema" }],
        },
      },
    })
    expect(await repository.scan()).toEqual(before)
  })

  it("fails loud for an invalid clock without ever emitting a negative age", async () => {
    await seed({
      key: "clock-key",
      campaignId: "83001",
      createdAt: NOW.toISOString(),
    })

    const failure = await failureFrom(
      new PendingCommandService(repository, state, {
        now: () => new Date(Number.NaN),
      })
    )

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope.error.details).toMatchObject({
      validRecords: [],
      invalidEntries: [{ recordId: null, reason: "schema" }],
    })
    expect(JSON.stringify(failure.envelope)).not.toMatch(/"ageSeconds":-/)
  })

  it("keeps terminal states permanently blocked and blocks every scope mismatch", async () => {
    const expired = await seed({
      key: "expired-key",
      campaignId: "84001",
      createdAt: "2026-07-31T08:00:01.000Z",
      localState: "expired_unsubmitted",
    })
    const orphaned = await seed({
      key: "orphaned-key",
      campaignId: "84002",
      createdAt: "2026-07-31T08:00:02.000Z",
      localState: "orphaned_credential",
    })
    const credentialMismatch = await seed({
      key: "old-credential-key",
      campaignId: "84003",
      createdAt: "2026-07-31T08:00:03.000Z",
      credentialId: OLD_CREDENTIAL_ID,
    })
    const issuerMismatch = await seed({
      key: "old-issuer-key",
      campaignId: "84004",
      createdAt: "2026-07-31T08:00:04.000Z",
      issuerOrigin: "https://api.test.adrate.io",
    })
    const teamMismatch = await seed({
      key: "old-team-key",
      campaignId: "84005",
      createdAt: "2026-07-31T08:00:05.000Z",
      teamId: 7,
    })
    const before = await repository.scan()

    const outcome = await new PendingCommandService(repository, state, {
      now: () => NOW,
    }).pending()
    if (!outcome.envelope.ok) throw new Error("Expected success")
    const data = outcome.envelope.data as {
      records: Array<Record<string, unknown>>
      counts: Record<string, unknown>
    }
    const byId = new Map(
      data.records.map((record) => [record.recordId, record] as const)
    )

    expect(byId.get(expired.recordId)).toMatchObject({
      resumeMode: "blocked",
      blockedReason: "expired_unsubmitted",
    })
    expect(byId.get(orphaned.recordId)).toMatchObject({
      resumeMode: "blocked",
      blockedReason: "orphaned_credential",
    })
    for (const item of [credentialMismatch, issuerMismatch, teamMismatch]) {
      expect(byId.get(item.recordId)).toMatchObject({
        resumeMode: "blocked",
        blockedReason: "credential_mismatch",
      })
    }
    expect(data.counts).toEqual({
      total: 5,
      query: 0,
      postIfServerMissing: 0,
      blocked: 5,
    })
    expect(await repository.scan()).toEqual(before)
  })

  it("treats absent or incomplete auth metadata as a blocked scope", async () => {
    await fixture.fileSystem.removeSecureFile(fixture.paths.credentials)
    const record = await seed({
      key: "no-current-scope-key",
      campaignId: "85001",
      createdAt: "2026-07-31T08:00:00.000Z",
    })

    const outcome = await new PendingCommandService(repository, state, {
      now: () => NOW,
    }).pending()
    if (!outcome.envelope.ok) throw new Error("Expected success")
    expect(outcome.envelope.data.records).toEqual([
      expect.objectContaining({
        recordId: record.recordId,
        resumeMode: "blocked",
        blockedReason: "credential_mismatch",
      }),
    ])

    await fixture.fileSystem.atomicWrite(fixture.paths.credentials, "{}")
    const malformedOutcome = await new PendingCommandService(
      repository,
      state,
      { now: () => NOW }
    ).pending()
    if (!malformedOutcome.envelope.ok) throw new Error("Expected success")
    expect(malformedOutcome.envelope.data.records).toEqual([
      expect.objectContaining({
        recordId: record.recordId,
        resumeMode: "blocked",
        blockedReason: "credential_mismatch",
      }),
    ])
  })

  it("returns mapped valid records beside controlled corrupt evidence without disclosure", async () => {
    const valid = await seed({
      key: "valid-key",
      campaignId: "86001",
      createdAt: "2026-07-31T08:00:00.000Z",
    })
    const corruptRecordId = pendingRecordId("corrupt-key")
    await fixture.fileSystem.atomicWrite(
      repository.recordPath("corrupt-key"),
      "{not-json"
    )
    const secretFilename = `${OWNER_SESSION_TOKEN}.json`
    const secretPath = join(fixture.paths.pendingCommands, secretFilename)
    await fixture.fileSystem.atomicWrite(secretPath, "{}")

    const failure = await failureFrom(
      new PendingCommandService(repository, state, { now: () => NOW })
    )
    const serialized = JSON.stringify(failure.envelope)

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: {
        code: "LOCAL_STATE_UNSAFE",
        details: {
          validRecords: [expect.objectContaining({ recordId: valid.recordId })],
          invalidEntries: [
            { recordId: null, reason: "schema" },
            { recordId: corruptRecordId, reason: "invalid_json" },
          ],
        },
      },
    })
    expect(serialized).not.toContain(OWNER_SESSION_TOKEN)
    expect(serialized).not.toContain(fixture.root)
    expect(await fixture.fileSystem.exists(secretPath)).toBe(true)
    expect(
      await fixture.fileSystem.exists(repository.recordPath("corrupt-key"))
    ).toBe(true)
  })

  it("reads only local metadata under the auth lock and has no HTTP or secret dependency", async () => {
    await seed({
      key: "local-only-key",
      campaignId: "87001",
      createdAt: "2026-07-31T08:00:00.000Z",
    })
    const withAuthLock = vi.spyOn(state, "withAuthLock")
    const readSecureFile = vi.spyOn(fixture.fileSystem, "readSecureFile")

    await new PendingCommandService(repository, state, {
      now: () => NOW,
    }).pending()

    expect(withAuthLock).toHaveBeenCalledTimes(1)
    const readPaths = readSecureFile.mock.calls.map(([path]) => path)
    expect(readPaths).toEqual(
      expect.arrayContaining([
        fixture.paths.config,
        fixture.paths.tokenIndex,
        fixture.paths.credentials,
        repository.recordPath("local-only-key"),
      ])
    )
    expect(readPaths).not.toContain(fixture.paths.fallbackToken)
  })
})
