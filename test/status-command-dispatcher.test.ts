import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StatusCommandDispatcher } from "../src/commands/status-command-dispatcher.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { CliFailure } from "../src/errors.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  validCredentialMetadata,
  validTokenIndex,
} from "./helpers.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../src/auth/local-credentials.js"
import type { CliEnvelope } from "../src/contracts/envelope.js"
import type { PublicHttpClient, PublicResponse } from "../src/http/client.js"
import type { PendingCommandRecord } from "../src/commands/pending-command-contract.js"
import type { TemporaryStateFixture } from "./helpers.js"

const CREATED_AT = new Date("2026-07-31T08:00:00.000Z")
const NOW = new Date("2026-07-31T08:00:01.000Z")
const COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e"
const SECOND_COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6f"
const KEY = "dispatcher-key"

let fixture: TemporaryStateFixture
let repository: PendingCommandRepository

function locatedCredential(): LocatedCredential {
  return {
    index: validTokenIndex(),
    token: OWNER_SESSION_TOKEN,
    credentials: validCredentialMetadata(),
    device: null,
    identity: {
      environment: "production",
      issuerOrigin: "https://api.adrate.io",
      clientInstanceId: "22222222-2222-4222-8222-222222222222",
      tokenGeneration: "44444444-4444-4444-8444-444444444444",
      deviceGeneration: null,
    },
  }
}

function localFence(): {
  local: LocalCredentialCoordinator
  located: LocatedCredential
} {
  const located = locatedCredential()
  return {
    located,
    local: {
      fenceExpectedLocatedCredential: (expected: LocatedCredential) =>
        Promise.resolve(expected.token),
    } as unknown as LocalCredentialCoordinator,
  }
}

async function preparedRecord() {
  const result = await repository.prepare({
    idempotencyKey: KEY,
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 42,
    intent: {
      advId: "70001",
      campaignId: "80001",
      desiredStatus: "ENABLE",
      authId: 9,
    },
    now: CREATED_AT,
  })
  if (result.kind !== "created") throw new Error("Expected prepared record")
  return result.record
}

function commandDto(final = false, commandId = COMMAND_ID) {
  return {
    commandId,
    idempotencyKey: KEY,
    capabilityId: "ads.campaign.status.write",
    status: final ? "succeeded" : "pending",
    isFinal: final,
    reason: null,
    suggestedAction: final ? null : "query_command",
    target: {
      advertiserId: "70001",
      campaignId: "80001",
      desiredStatus: "ENABLE",
    },
    beforeStatus: final ? "ENABLE" : null,
    afterStatus: null,
    verificationBasis: final ? "verified_no_op" : null,
    attemptCount: 0,
    createdAt: CREATED_AT.toISOString(),
    startedAt: null,
    completedAt: final ? NOW.toISOString() : null,
    recoverableUntil: final ? null : "2026-08-01T08:00:00.000Z",
    lastReconcileAt: null,
  }
}

function successResponse(
  final = false,
  commandId = COMMAND_ID
): PublicResponse {
  const requestId = "dispatcher_server_1"
  return {
    response: {
      status: final ? 200 : 202,
      requestId,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      text: "{}",
    },
    envelope: {
      ok: true,
      data: { command: commandDto(final, commandId) },
      meta: { requestId, apiVersion: "v1" },
    },
    retryAfterSeconds: null,
  }
}

async function writeCommandKnown(
  record: PendingCommandRecord
): Promise<PendingCommandRecord> {
  const next: PendingCommandRecord = {
    ...record,
    localState: "command_known",
    commandId: COMMAND_ID,
    updatedAt: NOW.toISOString(),
    lastResponse: {
      requestId: "sibling_pending",
      httpStatus: 202,
      errorCode: null,
    },
  }
  await repository.replaceExact(record, next)
  return next
}

async function caughtFailure(
  promise: Promise<unknown>
): Promise<CliFailure<CliEnvelope>> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    return error as CliFailure<CliEnvelope>
  }
  throw new Error("Expected Dispatcher failure")
}

beforeEach(async () => {
  fixture = await createTemporaryStateFixture()
  repository = new PendingCommandRepository(fixture.fileSystem, fixture.paths, {
    now: () => new Date(NOW),
  })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("StatusCommandDispatcher", () => {
  it("dispatches an existing record through exactly one POST and exact CAS", async () => {
    const record = await preparedRecord()
    const postPublicJson = vi.fn(() => Promise.resolve(successResponse()))
    const fence = localFence()
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      repository,
      fence.local,
      { now: () => NOW }
    )

    const outcome = await dispatcher.dispatch({
      record,
      expectedCredential: fence.located,
      requestId: "dispatcher_client_1",
    })

    expect(outcome.exitCode).toBe(4)
    expect(postPublicJson).toHaveBeenCalledTimes(1)
    expect(postPublicJson).toHaveBeenCalledWith({
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
      token: OWNER_SESSION_TOKEN,
      idempotencyKey: KEY,
      json: { desiredStatus: "ENABLE", authId: 9 },
      requestId: "dispatcher_client_1",
    })
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: {
        localState: "command_known",
        commandId: COMMAND_ID,
        updatedAt: NOW.toISOString(),
        lastResponse: {
          requestId: "dispatcher_server_1",
          httpStatus: 202,
          errorCode: null,
        },
      },
    })
  })

  it("sends no retry and hides transport secrets while retaining unknown evidence", async () => {
    const record = await preparedRecord()
    const secret = "adr_owner_transport_secret"
    const postPublicJson = vi.fn(() =>
      Promise.reject(new Error(`network failed: ${secret}`))
    )
    const fence = localFence()
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      repository,
      fence.local,
      { now: () => NOW }
    )

    const failure = await caughtFailure(
      dispatcher.dispatch({
        record,
        expectedCredential: fence.located,
      })
    )

    expect(failure.exitCode).toBe(5)
    expect(postPublicJson).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(failure.envelope)).not.toContain(secret)
    expect(JSON.stringify(failure.envelope)).not.toContain(OWNER_SESSION_TOKEN)
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "response_unknown", lastResponse: null },
    })
  })

  it("rejects a different commandId without downgrading the known Command", async () => {
    const prepared = await preparedRecord()
    const record = await writeCommandKnown(prepared)
    const postPublicJson = vi.fn(() =>
      Promise.resolve(successResponse(false, SECOND_COMMAND_ID))
    )
    const fence = localFence()
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      repository,
      fence.local,
      { now: () => NOW }
    )

    const outcome = await dispatcher.dispatch({
      record,
      expectedCredential: fence.located,
    })

    expect(outcome.exitCode).toBe(5)
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: {
        localState: "command_known",
        commandId: COMMAND_ID,
        lastResponse: { requestId: "sibling_pending" },
      },
    })
  })
})
