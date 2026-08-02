import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StatusCommandDispatcher } from "../src/commands/status-command-dispatcher.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { PendingCommandAttemptBusyError } from "../src/commands/pending-command-attempt.js"
import { CliFailure } from "../src/errors.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  deferred,
  stableTestProcessIdentity,
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
      issueOwnerToken: null,
      pollOwnerToken: null,
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

function errorWithoutCommandResponse(
  operationUnitsCharged: 0 | null
): PublicResponse {
  const requestId = "dispatcher_server_error"
  const bucket = { limit: 10, remaining: 9, resetAt: null }
  return {
    response: {
      status: 503,
      requestId,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      text: "{}",
    },
    envelope: {
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Status request failed.",
        retryable: true,
        details: {
          commandCreated: false,
          suggestedAction: null,
          resolutionUrl: null,
        },
      },
      meta: {
        requestId,
        apiVersion: "v1",
        usage: {
          operationUnits: 3,
          operationUnitsCharged,
          minute: { ...bucket, burst: 10 },
          writeMinute: bucket,
          dailyTikTokUnits: bucket,
        },
      },
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

async function writeResponseUnknown(
  record: PendingCommandRecord
): Promise<void> {
  await repository.replaceExact(record, {
    ...record,
    localState: "response_unknown",
    updatedAt: NOW.toISOString(),
    lastResponse: null,
  })
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
    processIdentity: stableTestProcessIdentity("status-dispatcher"),
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

    expect(outcome.exitCode).toBe(0)
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

  it("lets a transferred query handle dispatch only once across serial reuse", async () => {
    const record = await preparedRecord()
    const handle = await repository.attempts.reserve({
      expected: record,
      phase: "query_intent",
      observedAt: NOW,
      allowReclaim: false,
    })
    const postPublicJson = vi.fn(() => Promise.resolve(successResponse()))
    const fence = localFence()
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      repository,
      fence.local,
      { now: () => NOW }
    )

    await expect(
      dispatcher.dispatch({
        record,
        expectedCredential: fence.located,
        attempt: handle,
      })
    ).resolves.toMatchObject({ exitCode: 0 })
    const replayFailure = await caughtFailure(
      dispatcher.dispatch({
        record,
        expectedCredential: fence.located,
        attempt: handle,
      })
    )

    expect(replayFailure.exitCode).toBe(1)
    expect(postPublicJson).toHaveBeenCalledTimes(1)
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "command_known", commandId: COMMAND_ID },
    })
  })

  it("lets a transferred query handle dispatch only once across concurrent reuse", async () => {
    const record = await preparedRecord()
    const handle = await repository.attempts.reserve({
      expected: record,
      phase: "query_intent",
      observedAt: NOW,
      allowReclaim: false,
    })
    const postStarted = deferred()
    const releasePost = deferred()
    const postPublicJson = vi.fn(async () => {
      postStarted.resolve()
      await releasePost.promise
      return successResponse()
    })
    const fence = localFence()
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      repository,
      fence.local,
      { now: () => NOW }
    )
    const winner = dispatcher.dispatch({
      record,
      expectedCredential: fence.located,
      attempt: handle,
    })
    await postStarted.promise

    const loser = await caughtFailure(
      dispatcher.dispatch({
        record,
        expectedCredential: fence.located,
        attempt: handle,
      })
    )

    expect(loser).toMatchObject({
      exitCode: 4,
      envelope: {
        error: { details: { reason: "command_attempt_in_progress" } },
      },
    })
    expect(postPublicJson).toHaveBeenCalledTimes(1)
    releasePost.resolve()
    await expect(winner).resolves.toMatchObject({ exitCode: 0 })
    expect(postPublicJson).toHaveBeenCalledTimes(1)
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "command_known", commandId: COMMAND_ID },
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

  it("blocks an unowned sibling mutation while the durable POST owner is active", async () => {
    const record = await preparedRecord()
    const postPublicJson = vi.fn(async () => {
      await expect(
        repository.replaceExact(record, {
          ...record,
          localState: "response_unknown",
          updatedAt: NOW.toISOString(),
          lastResponse: null,
        })
      ).rejects.toBeInstanceOf(PendingCommandAttemptBusyError)
      return successResponse()
    })
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

    expect(outcome.exitCode).toBe(0)
    expect(postPublicJson).toHaveBeenCalledTimes(1)
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "command_known", commandId: COMMAND_ID },
    })
  })

  it("releases a transferred attempt when the credential precondition fails", async () => {
    const record = await preparedRecord()
    const handle = await repository.attempts.reserve({
      expected: record,
      phase: "query_intent",
      observedAt: NOW,
      allowReclaim: false,
    })
    const fence = localFence()
    const mismatched: LocatedCredential = {
      ...fence.located,
      credentials: {
        ...fence.located.credentials!,
        teamId: fence.located.credentials!.teamId + 1,
      },
    }
    const postPublicJson = vi.fn()
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson } as unknown as PublicHttpClient,
      repository,
      fence.local,
      { now: () => NOW }
    )

    const failure = await caughtFailure(
      dispatcher.dispatch({
        record,
        expectedCredential: mismatched,
        attempt: handle,
      })
    )

    expect(failure).toMatchObject({
      exitCode: 4,
      envelope: { error: { details: { localStateChanged: true } } },
    })
    expect(postPublicJson).not.toHaveBeenCalled()
    expect(
      await fixture.fileSystem.readSecureFile(
        repository.attempts.path(handle.attempt.recordId)
      )
    ).toBeNull()
  })

  it("releases a transferred attempt when advance fails", async () => {
    const record = await preparedRecord()
    const handle = await repository.attempts.reserve({
      expected: record,
      phase: "query_intent",
      observedAt: NOW,
      allowReclaim: false,
    })
    const advance = vi
      .spyOn(repository.attempts, "advanceToPost")
      .mockRejectedValueOnce(new PendingCommandAttemptBusyError())
    const release = vi.spyOn(repository.attempts, "release")
    const fence = localFence()
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson: vi.fn() } as unknown as PublicHttpClient,
      repository,
      fence.local,
      { now: () => NOW }
    )

    const failure = await caughtFailure(
      dispatcher.dispatch({
        record,
        expectedCredential: fence.located,
        attempt: handle,
      })
    )

    expect(failure).toMatchObject({
      exitCode: 4,
      envelope: {
        error: { details: { reason: "command_attempt_in_progress" } },
      },
    })
    expect(advance).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith(handle)
    expect(
      await fixture.fileSystem.readSecureFile(
        repository.attempts.path(handle.attempt.recordId)
      )
    ).toBeNull()
  })

  it("does not let cleanup failure overwrite the primary precondition error", async () => {
    const record = await preparedRecord()
    const handle = await repository.attempts.reserve({
      expected: record,
      phase: "query_intent",
      observedAt: NOW,
      allowReclaim: false,
    })
    const fence = localFence()
    const mismatched: LocatedCredential = {
      ...fence.located,
      credentials: {
        ...fence.located.credentials!,
        teamId: fence.located.credentials!.teamId + 1,
      },
    }
    const release = vi
      .spyOn(repository.attempts, "release")
      .mockRejectedValueOnce(new Error("cleanup-only failure"))
    const dispatcher = new StatusCommandDispatcher(
      { postPublicJson: vi.fn() } as unknown as PublicHttpClient,
      repository,
      fence.local,
      { now: () => NOW }
    )

    const failure = await caughtFailure(
      dispatcher.dispatch({
        record,
        expectedCredential: mismatched,
        attempt: handle,
      })
    )

    expect(failure.message).toContain("no longer matches")
    expect(failure.message).not.toContain("cleanup-only")
    release.mockRestore()
    await repository.attempts.release(handle)
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
