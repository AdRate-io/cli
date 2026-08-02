import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandQueryService } from "../src/commands/command-query-service.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { StatusCommandDispatcher } from "../src/commands/status-command-dispatcher.js"
import { serializePendingCommand } from "../src/commands/pending-command-contract.js"
import { DEADLINES_MS } from "../src/constants.js"
import { CliFailure } from "../src/errors.js"
import { HttpTransportError, PublicHttpClient } from "../src/http/client.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  stableTestProcessIdentity,
  validCredentialMetadata,
  validTokenIndex,
} from "./helpers.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../src/auth/local-credentials.js"
import type { CliEnvelope } from "../src/contracts/envelope.js"
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/http/client.js"
import type {
  PendingCommandLocalState,
  PendingCommandRecord,
} from "../src/commands/pending-command-contract.js"
import type { TemporaryStateFixture } from "./helpers.js"

const NOW = new Date("2026-07-31T08:00:10.000Z")
const CREATED_AT = "2026-07-31T08:00:00.000Z"
const PENDING_UNTIL = "2026-08-01T08:00:00.000Z"
const COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e"
const SECOND_COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6f"
const OLD_CREDENTIAL_ID = "77777777-7777-4777-8777-777777777777"

type TransportReply = HttpResponse | Error

class SequenceTransport implements HttpTransport {
  readonly requests: Array<HttpRequest> = []

  constructor(private readonly replies: Array<TransportReply>) {}

  request(input: HttpRequest): Promise<HttpResponse> {
    this.requests.push(input)
    const reply = this.replies.shift()
    if (!reply) return Promise.reject(new Error("Unexpected HTTP request"))
    if (reply instanceof Error) return Promise.reject(reply)
    return Promise.resolve(reply)
  }
}

function locatedCredential(
  input: {
    credentialId?: string
    issuerOrigin?: "https://api.adrate.io" | "https://api.test.adrate.io"
    teamId?: number
    activated?: boolean
  } = {}
): LocatedCredential {
  const credentialId = input.credentialId ?? CREDENTIAL_ID
  const issuerOrigin = input.issuerOrigin ?? "https://api.adrate.io"
  const environment =
    issuerOrigin === "https://api.adrate.io" ? "production" : "test"
  return {
    index: validTokenIndex({ credentialId, issuerOrigin, environment }),
    token: OWNER_SESSION_TOKEN,
    credentials:
      input.activated === false
        ? null
        : validCredentialMetadata({
            credentialId,
            issuerOrigin,
            teamId: input.teamId ?? 42,
          }),
    device: null,
    identity: {
      environment,
      issuerOrigin,
      clientInstanceId: "22222222-2222-4222-8222-222222222222",
      tokenGeneration: "44444444-4444-4444-8444-444444444444",
      deviceGeneration: null,
      issueOwnerToken: null,
      pollOwnerToken: null,
    },
  }
}

function localMock(located = locatedCredential()) {
  const requireLocated = vi.fn(() => Promise.resolve(located))
  return {
    requireLocated,
    local: { requireLocated } as unknown as LocalCredentialCoordinator,
  }
}

function command(input: {
  key: string
  commandId?: string
  final?: boolean
  campaignId?: string
}) {
  const final = input.final ?? false
  return {
    commandId: input.commandId ?? COMMAND_ID,
    idempotencyKey: input.key,
    capabilityId: "ads.campaign.status.write",
    status: final ? "succeeded" : "pending",
    isFinal: final,
    reason: null,
    suggestedAction: final ? null : "query_command",
    target: {
      advertiserId: "70001",
      campaignId: input.campaignId ?? "80001",
      desiredStatus: "ENABLE",
    },
    beforeStatus: final ? "ENABLE" : null,
    afterStatus: null,
    verificationBasis: final ? "verified_no_op" : null,
    attemptCount: 0,
    createdAt: CREATED_AT,
    startedAt: null,
    completedAt: final ? CREATED_AT : null,
    recoverableUntil: final ? null : PENDING_UNTIL,
    lastReconcileAt: null,
  }
}

function response(
  status: number,
  body: Record<string, unknown>,
  requestId = "command_get_1"
): HttpResponse {
  return {
    status,
    requestId,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    },
    text: JSON.stringify(body),
  }
}

function successResponse(
  value: Record<string, unknown>,
  status = 200,
  requestId = "command_get_1"
): HttpResponse {
  return response(
    status,
    {
      ok: true,
      data: { command: value },
      meta: { requestId, apiVersion: "v1" },
    },
    requestId
  )
}

function errorResponse(
  code: "RESOURCE_NOT_FOUND" | "DEPENDENCY_UNAVAILABLE",
  status: number,
  details: Record<string, unknown> = {},
  requestId = "command_get_error_1",
  retryable = code === "DEPENDENCY_UNAVAILABLE"
): HttpResponse {
  return response(
    status,
    {
      ok: false,
      error: {
        code,
        message: "Command query failed.",
        retryable,
        details: {
          suggestedAction: null,
          resolutionUrl: null,
          ...details,
        },
      },
      meta: { requestId, apiVersion: "v1" },
    },
    requestId
  )
}

interface SeedInput {
  key: string
  campaignId?: string
  credentialId?: string
  issuerOrigin?: "https://api.adrate.io" | "https://api.test.adrate.io"
  teamId?: number
  localState?: PendingCommandLocalState
  commandId?: string | null
}

let fixture: TemporaryStateFixture
let repository: PendingCommandRepository

async function seed(input: SeedInput) {
  const created = await repository.prepare({
    idempotencyKey: input.key,
    credentialId: input.credentialId ?? CREDENTIAL_ID,
    issuerOrigin: input.issuerOrigin ?? "https://api.adrate.io",
    teamId: input.teamId ?? 42,
    intent: {
      advId: "70001",
      campaignId: input.campaignId ?? "80001",
      desiredStatus: "ENABLE",
      authId: null,
    },
    now: new Date(CREATED_AT),
  })
  if (created.kind !== "created") {
    throw new Error(`Unexpected prepare result: ${created.kind}`)
  }
  const next: PendingCommandRecord = {
    ...created.record,
    localState: input.localState ?? "prepared",
    commandId: input.commandId ?? null,
  }
  if (
    serializePendingCommand(next) !== serializePendingCommand(created.record)
  ) {
    await repository.replaceExact(created.record, next)
  }
  return { recordId: created.recordId, record: next }
}

async function failureFrom(
  promise: Promise<unknown>
): Promise<CliFailure<CliEnvelope>> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    return error as CliFailure<CliEnvelope>
  }
  throw new Error("Expected CommandQueryService.get() to fail")
}

beforeEach(async () => {
  fixture = await createTemporaryStateFixture()
  repository = new PendingCommandRepository(fixture.fileSystem, fixture.paths, {
    now: () => new Date(NOW),
    processIdentity: stableTestProcessIdentity("query-status-race"),
  })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("CommandQueryService.get", () => {
  it("validates before scan, credential access, or HTTP", async () => {
    const transport = new SequenceTransport([])
    const local = localMock()
    const scan = vi.spyOn(repository, "scan")
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository
    )

    const failure = await failureFrom(
      service.get({ commandId: COMMAND_ID, requestId: "bad request" })
    )

    expect(failure.exitCode).toBe(2)
    expect(scan).not.toHaveBeenCalled()
    expect(local.requireLocated).not.toHaveBeenCalled()
    expect(transport.requests).toEqual([])
  })

  it("queries by raw UUID or URLSearchParams key with exactly one GET each", async () => {
    const keyById = "server-key-by-id"
    const keyByKey = "abc_DEF-9"
    const transport = new SequenceTransport([
      successResponse(command({ key: keyById })),
      successResponse(
        command({ key: keyByKey, commandId: SECOND_COMMAND_ID }),
        200,
        "command_get_2"
      ),
    ])
    const local = localMock()
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository,
      { now: () => NOW }
    )

    expect(
      (
        await service.get({
          commandId: COMMAND_ID,
          requestId: "client_get_1",
        })
      ).exitCode
    ).toBe(0)
    expect((await service.get({ idempotencyKey: keyByKey })).exitCode).toBe(0)

    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[0]).toMatchObject({
      method: "GET",
      path: `/public/v1/commands/${COMMAND_ID}`,
      requestId: "client_get_1",
      deadlineMs: DEADLINES_MS.standard,
    })
    expect(transport.requests[1]).toMatchObject({
      method: "GET",
      path: `/public/v1/commands?${new URLSearchParams({ idempotencyKey: keyByKey }).toString()}`,
      deadlineMs: DEADLINES_MS.standard,
    })
    expect(
      transport.requests.every((request) => request.method === "GET")
    ).toBe(true)
  })

  it("fails on unsafe scan evidence before credential or HTTP without leaking a secret filename", async () => {
    await seed({ key: "valid-key" })
    const secretPath = join(
      fixture.paths.pendingCommands,
      `${OWNER_SESSION_TOKEN}.json`
    )
    await fixture.fileSystem.atomicWrite(secretPath, "{}")
    const transport = new SequenceTransport([])
    const local = localMock()
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository
    )

    const failure = await failureFrom(
      service.get({ idempotencyKey: "valid-key" })
    )
    const serialized = JSON.stringify(failure.envelope)

    expect(failure.exitCode).toBe(1)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: { code: "LOCAL_STATE_UNSAFE", retryable: false },
    })
    expect(local.requireLocated).not.toHaveBeenCalled()
    expect(transport.requests).toEqual([])
    expect(serialized).not.toContain(OWNER_SESSION_TOKEN)
    expect(serialized).not.toContain(fixture.root)
    expect(await fixture.fileSystem.exists(secretPath)).toBe(true)
  })

  it.each([
    ["expired_unsubmitted", 1, "LOCAL_STATE_UNSAFE"],
    ["orphaned_credential", 3, "LOCAL_CREDENTIAL_MISMATCH"],
  ] as const)(
    "blocks %s evidence before credential or HTTP",
    async (localState, exitCode, errorCode) => {
      const seeded = await seed({ key: "blocked-key", localState })
      const before = await repository.read("blocked-key")
      const transport = new SequenceTransport([])
      const local = localMock()
      const service = new CommandQueryService(
        new PublicHttpClient(transport),
        local.local,
        repository
      )

      const failure = await failureFrom(
        service.get({ idempotencyKey: "blocked-key" })
      )

      expect(failure.exitCode).toBe(exitCode)
      expect(failure.envelope).toMatchObject({
        ok: false,
        error: {
          code: errorCode,
          details: { recordId: seeded.recordId, blockedReason: localState },
        },
      })
      expect(local.requireLocated).not.toHaveBeenCalled()
      expect(transport.requests).toEqual([])
      expect(await repository.read("blocked-key")).toEqual(before)
    }
  )

  it.each([
    ["credential", { credentialId: OLD_CREDENTIAL_ID }],
    ["issuer", { issuerOrigin: "https://api.test.adrate.io" as const }],
    ["team", { teamId: 7 }],
  ])(
    "CAS-blocks a prior %s scope and remains idempotent",
    async (_label, scope) => {
      const seeded = await seed({ key: "old-scope-key", ...scope })
      const transport = new SequenceTransport([])
      const local = localMock()
      const service = new CommandQueryService(
        new PublicHttpClient(transport),
        local.local,
        repository,
        { now: () => NOW }
      )

      const first = await failureFrom(
        service.get({ idempotencyKey: "old-scope-key" })
      )
      const afterFirst = await repository.read("old-scope-key")
      const second = await failureFrom(
        service.get({ idempotencyKey: "old-scope-key" })
      )

      expect(first.exitCode).toBe(3)
      expect(second.exitCode).toBe(3)
      expect(first.envelope).toMatchObject({
        ok: false,
        error: { code: "LOCAL_CREDENTIAL_MISMATCH" },
      })
      expect(afterFirst).toMatchObject({
        kind: "found",
        recordId: seeded.recordId,
        record: {
          localState: "orphaned_credential",
          credentialId: seeded.record.credentialId,
          issuerOrigin: seeded.record.issuerOrigin,
          teamId: seeded.record.teamId,
        },
      })
      expect(await repository.read("old-scope-key")).toEqual(afterFirst)
      expect(local.requireLocated).toHaveBeenCalledTimes(1)
      expect(transport.requests).toEqual([])
    }
  )

  it("requires activated credential metadata before an unassociated GET", async () => {
    const transport = new SequenceTransport([])
    const local = localMock(locatedCredential({ activated: false }))
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository
    )

    const failure = await failureFrom(
      service.get({ idempotencyKey: "unassociated-key" })
    )

    expect(failure.exitCode).toBe(3)
    expect(transport.requests).toEqual([])
  })

  it("CAS-updates nonfinal evidence and removes final evidence", async () => {
    const pending = await seed({ key: "pending-key", campaignId: "81001" })
    const final = await seed({
      key: "final-key",
      campaignId: "81002",
      localState: "response_unknown",
    })
    const transport = new SequenceTransport([
      successResponse(command({ key: "pending-key", campaignId: "81001" })),
      successResponse(
        command({
          key: "final-key",
          commandId: SECOND_COMMAND_ID,
          final: true,
          campaignId: "81002",
        }),
        200,
        "command_get_2"
      ),
    ])
    const local = localMock()
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository,
      { now: () => NOW }
    )

    expect(
      (await service.get({ idempotencyKey: "pending-key" })).exitCode
    ).toBe(0)
    expect((await service.get({ idempotencyKey: "final-key" })).exitCode).toBe(
      0
    )

    expect(await repository.read("pending-key")).toMatchObject({
      kind: "found",
      recordId: pending.recordId,
      record: {
        localState: "command_known",
        commandId: COMMAND_ID,
        updatedAt: NOW.toISOString(),
        lastResponse: {
          requestId: "command_get_1",
          httpStatus: 200,
          errorCode: null,
        },
      },
    })
    expect(await repository.read("final-key")).toEqual({
      kind: "missing",
      recordId: final.recordId,
    })
    expect(
      transport.requests.every((request) => request.method === "GET")
    ).toBe(true)
  })

  it("lets a Status owner settle when an earlier direct GET response arrives during POST", async () => {
    const key = "query-status-race-key"
    const seeded = await seed({ key })
    let signalQueryStarted!: () => void
    const queryStarted = new Promise<void>((resolve) => {
      signalQueryStarted = resolve
    })
    let releaseQuery!: () => void
    const queryReleased = new Promise<void>((resolve) => {
      releaseQuery = resolve
    })
    let signalPostStarted!: () => void
    const postStarted = new Promise<void>((resolve) => {
      signalPostStarted = resolve
    })
    let releasePost!: () => void
    const postReleased = new Promise<void>((resolve) => {
      releasePost = resolve
    })
    const queryRequests: Array<HttpRequest> = []
    const statusRequests: Array<HttpRequest> = []
    const queryTransport: HttpTransport = {
      request: async (input) => {
        queryRequests.push(input)
        signalQueryStarted()
        await queryReleased
        return successResponse(command({ key }), 200, "racing_query")
      },
    }
    const statusTransport: HttpTransport = {
      request: async (input) => {
        statusRequests.push(input)
        signalPostStarted()
        await postReleased
        return successResponse(command({ key }), 202, "racing_status")
      },
    }
    const located = locatedCredential()
    const local = {
      requireLocated: vi.fn(() => Promise.resolve(located)),
      fenceExpectedLocatedCredential: vi.fn(() =>
        Promise.resolve(located.token)
      ),
    } as unknown as LocalCredentialCoordinator
    const query = new CommandQueryService(
      new PublicHttpClient(queryTransport),
      local,
      repository,
      { now: () => NOW }
    )
    const dispatcher = new StatusCommandDispatcher(
      new PublicHttpClient(statusTransport),
      repository,
      local,
      { now: () => NOW, environment: {} }
    )

    const directGet = query.get({ idempotencyKey: key })
    await queryStarted
    const status = dispatcher.dispatch({
      record: seeded.record,
      expectedCredential: located,
    })
    await postStarted
    releaseQuery()
    await expect(directGet).resolves.toMatchObject({ exitCode: 0 })
    releasePost()
    await expect(status).resolves.toMatchObject({ exitCode: 0 })

    expect(queryRequests.map((request) => request.method)).toEqual(["GET"])
    expect(statusRequests.map((request) => request.method)).toEqual(["POST"])
    expect(await repository.read(key)).toMatchObject({
      kind: "found",
      record: { localState: "command_known", commandId: COMMAND_ID },
    })
    expect(
      await fixture.fileSystem.readSecureFile(
        repository.attempts.path(seeded.recordId)
      )
    ).toBeNull()
  })

  it("returns RESOURCE_NOT_FOUND while retaining the exact journal", async () => {
    const seeded = await seed({ key: "missing-key" })
    const before = serializePendingCommand(seeded.record)
    const transport = new SequenceTransport([
      errorResponse("RESOURCE_NOT_FOUND", 404),
    ])
    const local = localMock()
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository
    )

    const outcome = await service.get({ idempotencyKey: "missing-key" })
    const after = await repository.read("missing-key")

    expect(outcome.exitCode).toBe(1)
    expect(outcome.envelope).toMatchObject({
      ok: false,
      error: { code: "RESOURCE_NOT_FOUND", retryable: false },
    })
    expect(outcome.exactNotFound).toEqual({
      kind: "exact_command_not_found",
      httpStatus: 404,
      errorCode: "RESOURCE_NOT_FOUND",
      retryable: false,
    })
    expect(after.kind).toBe("found")
    if (after.kind !== "found") throw new Error("Expected retained record")
    expect(serializePendingCommand(after.record)).toBe(before)
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]?.method).toBe("GET")
  })

  it.each([
    [400, false],
    [503, false],
    [404, true],
  ] as const)(
    "rejects RESOURCE_NOT_FOUND with HTTP %i/retryable=%s as contradictory proof",
    async (status, retryable) => {
      const seeded = await seed({ key: "invalid-not-found-key" })
      const before = serializePendingCommand(seeded.record)
      const transport = new SequenceTransport([
        errorResponse(
          "RESOURCE_NOT_FOUND",
          status,
          {},
          "invalid_not_found",
          retryable
        ),
      ])
      const local = localMock()
      const service = new CommandQueryService(
        new PublicHttpClient(transport),
        local.local,
        repository
      )

      const failure = await failureFrom(
        service.get({ idempotencyKey: "invalid-not-found-key" })
      )

      expect(failure).toMatchObject({
        exitCode: 4,
        envelope: {
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            retryable: true,
            details: {
              responseKind: "invalid_command_not_found_contract",
            },
          },
        },
      })
      const after = await repository.read("invalid-not-found-key")
      expect(after.kind).toBe("found")
      if (after.kind !== "found") throw new Error("Expected retained record")
      expect(serializePendingCommand(after.record)).toBe(before)
      expect(transport.requests).toHaveLength(1)
    }
  )

  it.each([
    [
      "malformed Command",
      () =>
        successResponse({ ...command({ key: "guarded-key" }), extra: true }),
    ],
    [
      "wrong response identity",
      () => successResponse(command({ key: "different-key" })),
    ],
    [
      "non-200 success",
      () => successResponse(command({ key: "guarded-key" }), 202),
    ],
    [
      "Status evidence on GET error",
      () => errorResponse("RESOURCE_NOT_FOUND", 404, { commandCreated: false }),
    ],
    ["invalid Public envelope", () => response(200, { ok: true, data: {} })],
  ])("retains the journal for %s", async (_label, reply) => {
    const seeded = await seed({ key: "guarded-key" })
    const before = serializePendingCommand(seeded.record)
    const transport = new SequenceTransport([reply()])
    const local = localMock()
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository,
      { now: () => NOW }
    )

    const failure = await failureFrom(
      service.get({ idempotencyKey: "guarded-key" })
    )
    const after = await repository.read("guarded-key")

    expect(failure.exitCode).toBe(4)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE" },
    })
    expect(after.kind).toBe("found")
    if (after.kind !== "found") throw new Error("Expected retained record")
    expect(serializePendingCommand(after.record)).toBe(before)
    expect(after.record.localState).toBe("prepared")
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]?.method).toBe("GET")
  })

  it("maps transport failure to retryable GET failure without changing state", async () => {
    const seeded = await seed({ key: "transport-key" })
    const before = serializePendingCommand(seeded.record)
    const transport = new SequenceTransport([
      new HttpTransportError("network", "connection failed"),
    ])
    const local = localMock()
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository
    )

    const failure = await failureFrom(
      service.get({ idempotencyKey: "transport-key" })
    )
    const after = await repository.read("transport-key")

    expect(failure.exitCode).toBe(4)
    expect(failure.envelope).toMatchObject({
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        details: { failureKind: "network" },
      },
    })
    expect(after.kind).toBe("found")
    if (after.kind !== "found") throw new Error("Expected retained record")
    expect(serializePendingCommand(after.record)).toBe(before)
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]?.method).toBe("GET")
  })

  it("CAS-upgrades a concurrent response_unknown when GET proves a Command", async () => {
    const seeded = await seed({ key: "cas-key" })
    const transport = new SequenceTransport([
      successResponse(command({ key: "cas-key" })),
    ])
    const local = localMock()
    const replaceExact = repository.replaceExact.bind(repository)
    vi.spyOn(repository, "replaceExact").mockImplementationOnce(
      async (expected, next) => {
        await replaceExact(expected, {
          ...expected,
          localState: "response_unknown",
          updatedAt: "2026-07-31T08:00:05.000Z",
        })
        await replaceExact(expected, next)
      }
    )
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository,
      { now: () => NOW }
    )

    const outcome = await service.get({ idempotencyKey: "cas-key" })
    const after = await repository.read("cas-key")

    expect(outcome.exitCode).toBe(0)
    expect(after).toMatchObject({
      kind: "found",
      recordId: seeded.recordId,
      record: {
        localState: "command_known",
        commandId: COMMAND_ID,
        updatedAt: NOW.toISOString(),
        lastResponse: {
          requestId: "command_get_1",
          httpStatus: 200,
          errorCode: null,
        },
      },
    })
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]?.method).toBe("GET")
  })

  it("fails loud and preserves a concurrent different commandId", async () => {
    const seeded = await seed({ key: "command-id-conflict-key" })
    const transport = new SequenceTransport([
      successResponse(command({ key: "command-id-conflict-key" })),
    ])
    const local = localMock()
    const replaceExact = repository.replaceExact.bind(repository)
    vi.spyOn(repository, "replaceExact").mockImplementationOnce(
      async (expected, next) => {
        await replaceExact(expected, {
          ...expected,
          localState: "command_known",
          commandId: SECOND_COMMAND_ID,
          updatedAt: "2026-07-31T08:00:05.000Z",
        })
        await replaceExact(expected, next)
      }
    )
    const service = new CommandQueryService(
      new PublicHttpClient(transport),
      local.local,
      repository,
      { now: () => NOW }
    )

    const failure = await failureFrom(
      service.get({ idempotencyKey: "command-id-conflict-key" })
    )

    expect(failure).toMatchObject({
      exitCode: 4,
      envelope: {
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          details: { recordId: seeded.recordId },
        },
      },
    })
    expect(await repository.read("command-id-conflict-key")).toMatchObject({
      kind: "found",
      record: {
        localState: "command_known",
        commandId: SECOND_COMMAND_ID,
      },
    })
  })
})
