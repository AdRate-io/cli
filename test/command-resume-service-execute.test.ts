import { readdir } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandQueryService } from "../src/commands/command-query-service.js"
import { CommandResumeService } from "../src/commands/command-resume-service.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { serializePendingCommand } from "../src/commands/pending-command-contract.js"
import { StatusCommandDispatcher } from "../src/commands/status-command-dispatcher.js"
import { CliFailure, dependencyFailure } from "../src/errors.js"
import { HttpTransportError, PublicHttpClient } from "../src/http/client.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  statusIntent,
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

const DAY_MS = 86_400_000
const NOW = new Date("2026-08-02T08:00:00.000Z")
const CREATED_AT = "2026-08-02T07:59:00.000Z"
const COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e"
const KEY = "resume-execute-key"

type CommandStatus = "pending" | "executing" | "succeeded" | "unknown"
type TransportReply =
  | HttpResponse
  | Error
  | (() => HttpResponse | Promise<HttpResponse>)

class SequenceTransport implements HttpTransport {
  readonly requests: Array<HttpRequest> = []

  constructor(private readonly replies: Array<TransportReply>) {}

  async request(input: HttpRequest): Promise<HttpResponse> {
    this.requests.push(input)
    const reply = this.replies.shift()
    if (!reply) throw new Error("Unexpected HTTP request")
    if (reply instanceof Error) throw reply
    return typeof reply === "function" ? reply() : reply
  }
}

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

type CredentialFence = (expected: LocatedCredential) => Promise<string>

async function expectNoPendingCommandLock(): Promise<void> {
  expect(
    (await readdir(fixture.root)).filter(
      (name) => name.startsWith(".pending-command-") && name.endsWith(".lock")
    )
  ).toEqual([])
}

function localMock(fence?: CredentialFence) {
  const requireLocated = vi.fn(async () => {
    await expectNoPendingCommandLock()
    return locatedCredential()
  })
  const fenceAction =
    fence ?? ((expected: LocatedCredential) => Promise.resolve(expected.token))
  const fenceExpectedLocatedCredential = vi.fn(
    async (expected: LocatedCredential) => {
      await expectNoPendingCommandLock()
      return fenceAction(expected)
    }
  )
  return {
    requireLocated,
    local: {
      requireLocated,
      fenceExpectedLocatedCredential,
    } as unknown as LocalCredentialCoordinator,
  }
}

function command(input: {
  key?: string
  commandId?: string
  status: CommandStatus
  createdAt?: string
}) {
  const createdAt = input.createdAt ?? CREATED_AT
  const started = input.status === "executing" || input.status === "unknown"
  const succeeded = input.status === "succeeded"
  const windowDays = input.status === "pending" ? 1 : 7
  return {
    commandId: input.commandId ?? COMMAND_ID,
    idempotencyKey: input.key ?? KEY,
    capabilityId: "ads.campaign.status.write",
    status: input.status,
    isFinal: succeeded,
    reason: null,
    suggestedAction: succeeded ? null : "query_command",
    target: {
      advertiserId: "70001",
      campaignId: "80001",
      desiredStatus: "ENABLE",
    },
    beforeStatus: succeeded ? "ENABLE" : started ? "DISABLE" : null,
    afterStatus: null,
    verificationBasis: succeeded ? "verified_no_op" : null,
    attemptCount: started ? 1 : 0,
    createdAt,
    startedAt: started ? createdAt : null,
    completedAt: succeeded ? createdAt : null,
    recoverableUntil: succeeded
      ? null
      : new Date(Date.parse(createdAt) + windowDays * DAY_MS).toISOString(),
    lastReconcileAt: null,
  }
}

function response(
  status: number,
  body: Record<string, unknown>,
  requestId: string
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
  requestId = "resume_server_success"
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

function usage(operationUnitsCharged: 0 | 1 | 2 | 3 | null) {
  const bucket = { limit: 10, remaining: 9, resetAt: null }
  return {
    operationUnits: 3,
    operationUnitsCharged,
    minute: { ...bucket, burst: 10 },
    writeMinute: bucket,
    dailyTikTokUnits: bucket,
  }
}

function errorResponse(input: {
  code: "RESOURCE_NOT_FOUND" | "DEPENDENCY_UNAVAILABLE"
  status?: number
  requestId?: string
  charge?: 0 | 1 | 2 | 3 | null
  details?: Record<string, unknown>
  retryable?: boolean
}): HttpResponse {
  const requestId = input.requestId ?? "resume_server_error"
  return response(
    input.status ?? (input.code === "RESOURCE_NOT_FOUND" ? 404 : 503),
    {
      ok: false,
      error: {
        code: input.code,
        message: "Command request failed.",
        retryable: input.retryable ?? input.code === "DEPENDENCY_UNAVAILABLE",
        details: {
          suggestedAction: null,
          resolutionUrl: null,
          ...(input.details ?? {}),
        },
      },
      meta: {
        requestId,
        apiVersion: "v1",
        ...(input.charge === undefined ? {} : { usage: usage(input.charge) }),
      },
    },
    requestId
  )
}

interface SeedInput {
  createdAt?: string
  localState?: PendingCommandLocalState
  commandId?: string | null
  authId?: number | null
}

let fixture: TemporaryStateFixture
let repository: PendingCommandRepository
let attemptNow: () => Date

async function seed(input: SeedInput = {}) {
  const created = await repository.prepare({
    idempotencyKey: KEY,
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 42,
    capabilityId: "ads.campaign.status.write",
    intent: statusIntent({ authId: input.authId ?? null }),
    now: new Date(input.createdAt ?? CREATED_AT),
  })
  if (created.kind !== "created") throw new Error("Expected created record")
  const localState = input.localState ?? "prepared"
  const next: PendingCommandRecord = {
    ...created.record,
    localState,
    commandId:
      input.commandId === undefined
        ? localState === "command_known"
          ? COMMAND_ID
          : null
        : input.commandId,
  }
  if (
    serializePendingCommand(next) !== serializePendingCommand(created.record)
  ) {
    await repository.replaceExact(created.record, next)
  }
  return next
}

type GmvMaxWriteCapability =
  | "gmvmax.campaign.status.write"
  | "gmvmax.campaign.budget.write"
  | "gmvmax.campaign.roas.write"

interface GmvMaxResumeCase {
  label: string
  capabilityId: GmvMaxWriteCapability
  operation: "status" | "budget" | "roas"
  familyPayload: Record<string, unknown>
  body: Record<string, unknown>
  target: Record<string, unknown>
}

const GMV_MAX_RESUME_CASES: ReadonlyArray<GmvMaxResumeCase> = [
  {
    label: "status",
    capabilityId: "gmvmax.campaign.status.write",
    operation: "status",
    familyPayload: { desiredStatus: "DISABLE" },
    body: { status: "DISABLE", authId: 9 },
    target: { desiredStatus: "DISABLE" },
  },
  {
    label: "budget",
    capabilityId: "gmvmax.campaign.budget.write",
    operation: "budget",
    familyPayload: { mode: "increase_amount", value: 25.5 },
    body: { mode: "increase_amount", value: 25.5, authId: 9 },
    target: { mode: "increase_amount", value: 25.5 },
  },
  {
    label: "ROAS",
    capabilityId: "gmvmax.campaign.roas.write",
    operation: "roas",
    familyPayload: { mode: "set", value: 2.5 },
    body: { mode: "set", value: 2.5, authId: 9 },
    target: { mode: "set", value: 2.5 },
  },
]

async function seedGmvMax(testCase: GmvMaxResumeCase) {
  const created = await repository.prepare({
    idempotencyKey: KEY,
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 42,
    capabilityId: testCase.capabilityId,
    intent: {
      capabilityId: testCase.capabilityId,
      advId: "70001",
      campaignId: "80001",
      authId: 9,
      familyPayload: testCase.familyPayload,
    },
    now: new Date(CREATED_AT),
  })
  if (created.kind !== "created") throw new Error("Expected created record")
  await repository.replaceExact(created.record, {
    ...created.record,
    localState: "response_unknown",
  })
}

function gmvMaxCommand(testCase: GmvMaxResumeCase) {
  return {
    ...command({ status: "pending" }),
    capabilityId: testCase.capabilityId,
    target: {
      advertiserId: "70001",
      campaignId: "80001",
      ...testCase.target,
    },
  }
}

function serviceFor(
  transport: HttpTransport,
  now: Date | (() => Date) = NOW,
  fence?: CredentialFence
): {
  service: CommandResumeService
  requireLocated: ReturnType<typeof vi.fn>
} {
  const http = new PublicHttpClient(transport)
  const local = localMock(fence)
  const currentTime = typeof now === "function" ? now : () => now
  attemptNow = currentTime
  const query = new CommandQueryService(http, local.local, repository, {
    now: currentTime,
  })
  const dispatcher = new StatusCommandDispatcher(
    http,
    repository,
    local.local,
    {
      now: currentTime,
      environment: {},
    }
  )
  return {
    service: new CommandResumeService(local.local, repository, {
      now: currentTime,
      query,
      dispatcher,
    }),
    requireLocated: local.requireLocated,
  }
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
  throw new Error("Expected CommandResumeService.resume() to fail")
}

beforeEach(async () => {
  fixture = await createTemporaryStateFixture()
  attemptNow = () => new Date(NOW)
  repository = new PendingCommandRepository(fixture.fileSystem, fixture.paths, {
    now: () => attemptNow(),
  })
})

afterEach(async () => {
  await fixture.cleanup()
})

describe("CommandResumeService.resume", () => {
  it.each(GMV_MAX_RESUME_CASES)(
    "GMV Max $label response_unknown 的 404 恢复只用原 Key 和原 payload 重发一次",
    async (testCase) => {
      await seedGmvMax(testCase)
      const transport = new SequenceTransport([
        errorResponse({
          code: "RESOURCE_NOT_FOUND",
          requestId: "gmv_get_missing",
        }),
        successResponse(gmvMaxCommand(testCase), 202, "gmv_post_pending"),
      ])
      const { service } = serviceFor(transport)

      const outcome = await service.resume({ idempotencyKey: KEY })

      expect(outcome.exitCode).toBe(4)
      expect(transport.requests).toHaveLength(2)
      expect(transport.requests[1]).toMatchObject({
        method: "POST",
        path: `/public/v1/gmvmax/advertisers/70001/campaigns/80001/${testCase.operation}`,
        idempotencyKey: KEY,
        json: testCase.body,
      })
      expect(await repository.read(KEY)).toMatchObject({
        kind: "found",
        record: { localState: "command_known", commandId: COMMAND_ID },
      })
    }
  )

  it("queries by Key, propagates requestId, and omits a null authId from the one POST", async () => {
    await seed()
    const transport = new SequenceTransport([
      errorResponse({ code: "RESOURCE_NOT_FOUND", requestId: "get_missing" }),
      successResponse(command({ status: "pending" }), 202, "post_pending"),
    ])
    const { service } = serviceFor(transport)

    const outcome = await service.resume({
      idempotencyKey: KEY,
      requestId: "client_resume_1",
    })

    expect(outcome.exitCode).toBe(4)
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[0]).toMatchObject({
      method: "GET",
      path: `/public/v1/commands?idempotencyKey=${KEY}`,
      requestId: "client_resume_1",
      token: OWNER_SESSION_TOKEN,
    })
    expect(transport.requests[1]).toMatchObject({
      method: "POST",
      path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
      requestId: "client_resume_1",
      idempotencyKey: KEY,
      json: { desiredStatus: "ENABLE" },
    })
    expect(transport.requests[1]!.json).not.toHaveProperty("authId")
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "command_known", commandId: COMMAND_ID },
    })
  })

  it("queries a known Command by ID and lets a server pending fact POST even after local 24h", async () => {
    const oldCreatedAt = new Date(NOW.getTime() - 2 * DAY_MS).toISOString()
    await seed({
      createdAt: oldCreatedAt,
      localState: "command_known",
      commandId: COMMAND_ID,
      authId: 9,
    })
    const pending = command({ status: "pending", createdAt: oldCreatedAt })
    const transport = new SequenceTransport([
      successResponse(pending, 200, "get_pending"),
      successResponse(pending, 202, "post_pending"),
    ])
    const { service } = serviceFor(transport)

    const outcome = await service.resume({ idempotencyKey: KEY })

    expect(outcome.exitCode).toBe(4)
    expect(transport.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ])
    expect(transport.requests[0]!.path).toBe(
      `/public/v1/commands/${COMMAND_ID}`
    )
    expect(transport.requests[1]!.json).toEqual({
      desiredStatus: "ENABLE",
      authId: 9,
    })
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "command_known" },
    })
  })

  it("fails closed when GET proves a Command but POST claims commandCreated=false", async () => {
    await seed()
    const transport = new SequenceTransport([
      successResponse(command({ status: "pending" }), 200, "get_pending"),
      errorResponse({
        code: "DEPENDENCY_UNAVAILABLE",
        charge: 0,
        details: { commandCreated: false },
      }),
      successResponse(command({ status: "executing" }), 200, "get_after"),
    ])
    const { service } = serviceFor(transport)

    const failure = await failureFrom(service.resume({ idempotencyKey: KEY }))

    expect(failure.exitCode).toBe(5)
    expect(transport.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ])
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: {
        localState: "command_known",
        commandId: COMMAND_ID,
      },
    })

    await expect(
      service.resume({ idempotencyKey: KEY })
    ).resolves.toMatchObject({ exitCode: 4 })
    expect(transport.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ])
    expect(transport.requests[0]!.path).toBe(
      `/public/v1/commands?idempotencyKey=${KEY}`
    )
    expect(transport.requests[2]!.path).toBe(
      `/public/v1/commands/${COMMAND_ID}`
    )
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: {
        localState: "command_known",
        commandId: COMMAND_ID,
      },
    })
  })

  it.each(["executing", "unknown"] as const)(
    "returns a server %s fact after one GET and never POSTs",
    async (status) => {
      await seed()
      const transport = new SequenceTransport([
        successResponse(command({ status }), 200, `get_${status}`),
      ])
      const { service } = serviceFor(transport)

      const outcome = await service.resume({ idempotencyKey: KEY })

      expect(outcome.exitCode).toBe(status === "executing" ? 4 : 5)
      expect(transport.requests).toHaveLength(1)
      expect(transport.requests[0]!.method).toBe("GET")
      expect(await repository.read(KEY)).toMatchObject({
        kind: "found",
        record: { localState: "command_known", commandId: COMMAND_ID },
      })
    }
  )

  it("returns a final server fact after one GET and removes local evidence", async () => {
    await seed()
    const transport = new SequenceTransport([
      successResponse(command({ status: "succeeded" }), 200, "get_final"),
    ])
    const { service } = serviceFor(transport)

    const outcome = await service.resume({ idempotencyKey: KEY })

    expect(outcome.exitCode).toBe(0)
    expect(transport.requests).toHaveLength(1)
    expect(await repository.read(KEY)).toMatchObject({ kind: "missing" })
  })

  it.each([
    ["before", DAY_MS - 1, true],
    ["exactly", DAY_MS, false],
    ["after", DAY_MS + 1, false],
  ] as const)(
    "%s the 24h boundary only a strict-before record may POST",
    async (_label, age, shouldPost) => {
      const createdAt = new Date(NOW.getTime() - age).toISOString()
      await seed({ createdAt })
      const replies: Array<TransportReply> = [
        errorResponse({ code: "RESOURCE_NOT_FOUND", requestId: "get_missing" }),
      ]
      if (shouldPost) {
        replies.push(
          successResponse(
            command({ status: "pending", createdAt }),
            202,
            "post_pending"
          )
        )
      }
      const transport = new SequenceTransport(replies)
      const { service } = serviceFor(transport)

      if (shouldPost) {
        await expect(
          service.resume({ idempotencyKey: KEY })
        ).resolves.toMatchObject({ exitCode: 4 })
      } else {
        const failure = await failureFrom(
          service.resume({ idempotencyKey: KEY })
        )
        expect(failure.exitCode).toBe(1)
        expect(failure.envelope).toMatchObject({
          error: {
            code: "LOCAL_STATE_UNSAFE",
            details: { blockedReason: "expired_unsubmitted" },
          },
        })
      }

      expect(transport.requests).toHaveLength(shouldPost ? 2 : 1)
      expect(await repository.read(KEY)).toMatchObject({
        kind: "found",
        record: {
          localState: shouldPost ? "command_known" : "expired_unsubmitted",
        },
      })
    }
  )

  it("rechecks the clock inside the POST identity fence and expires an exact-boundary crossing", async () => {
    const createdAt = new Date(NOW.getTime() - DAY_MS).toISOString()
    await seed({ createdAt })
    let clockReads = 0
    const now = () => {
      clockReads += 1
      return new Date(NOW.getTime() - (clockReads < 3 ? 1 : 0))
    }
    const transport = new SequenceTransport([
      errorResponse({ code: "RESOURCE_NOT_FOUND" }),
    ])
    const { service } = serviceFor(transport, now)

    const failure = await failureFrom(service.resume({ idempotencyKey: KEY }))

    expect(clockReads).toBe(3)
    expect(failure).toMatchObject({
      exitCode: 1,
      envelope: {
        error: {
          code: "LOCAL_STATE_UNSAFE",
          details: { blockedReason: "expired_unsubmitted" },
        },
      },
    })
    expect(transport.requests).toHaveLength(1)
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: {
        localState: "expired_unsubmitted",
        updatedAt: NOW.toISOString(),
      },
    })
  })

  it.each([
    [400, false],
    [503, false],
    [404, true],
  ] as const)(
    "never POSTs for RESOURCE_NOT_FOUND with HTTP %i/retryable=%s",
    async (status, retryable) => {
      await seed()
      const before = await repository.read(KEY)
      const transport = new SequenceTransport([
        errorResponse({ code: "RESOURCE_NOT_FOUND", status, retryable }),
      ])
      const { service } = serviceFor(transport)

      const failure = await failureFrom(service.resume({ idempotencyKey: KEY }))

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
      expect(transport.requests).toHaveLength(1)
      expect(transport.requests[0]?.method).toBe("GET")
      expect(await repository.read(KEY)).toEqual(before)
    }
  )

  it("returns a non-404 GET error without entering the POST branch", async () => {
    await seed()
    const transport = new SequenceTransport([
      errorResponse({ code: "DEPENDENCY_UNAVAILABLE" }),
    ])
    const before = await repository.read(KEY)
    const { service } = serviceFor(transport)

    const outcome = await service.resume({ idempotencyKey: KEY })

    expect(outcome.exitCode).toBe(4)
    expect(transport.requests).toHaveLength(1)
    expect(await repository.read(KEY)).toEqual(before)
  })

  it.each(["not_found", "known_pending"] as const)(
    "applies the final credential fence to the %s Resume POST branch",
    async (branch) => {
      if (branch === "not_found") {
        await seed()
      } else {
        await seed({ localState: "command_known", commandId: COMMAND_ID })
      }
      const getReply =
        branch === "not_found"
          ? errorResponse({ code: "RESOURCE_NOT_FOUND" })
          : successResponse(command({ status: "pending" }))
      const transport = new SequenceTransport([getReply])
      const fence: CredentialFence = () =>
        Promise.reject(
          dependencyFailure(
            "Local authentication state changed before the remote write; no request was sent."
          )
        )
      const { service } = serviceFor(transport, NOW, fence)

      const failure = await failureFrom(service.resume({ idempotencyKey: KEY }))

      expect(failure).toMatchObject({
        exitCode: 4,
        envelope: {
          error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
        },
      })
      expect(transport.requests).toHaveLength(1)
      expect(transport.requests[0]?.method).toBe("GET")
    }
  )

  it("turns GET transport failure into a secret-free retryable failure with zero POST", async () => {
    await seed()
    const secret = "resume_transport_secret"
    const transport = new SequenceTransport([
      new HttpTransportError("network", `failed: ${secret}`),
    ])
    const { service } = serviceFor(transport)

    const failure = await failureFrom(service.resume({ idempotencyKey: KEY }))

    expect(failure.exitCode).toBe(4)
    expect(transport.requests).toHaveLength(1)
    expect(JSON.stringify(failure.envelope)).not.toContain(secret)
    expect(JSON.stringify(failure.envelope)).not.toContain(OWNER_SESSION_TOKEN)
  })

  it("retains response_unknown and exits 5 when the one recovery POST loses its response", async () => {
    await seed()
    const secret = "post_response_secret"
    const transport = new SequenceTransport([
      errorResponse({ code: "RESOURCE_NOT_FOUND" }),
      new HttpTransportError("network", secret),
    ])
    const { service } = serviceFor(transport)

    const failure = await failureFrom(service.resume({ idempotencyKey: KEY }))

    expect(failure.exitCode).toBe(5)
    expect(transport.requests).toHaveLength(2)
    expect(JSON.stringify(failure.envelope)).not.toContain(secret)
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "response_unknown", lastResponse: null },
    })
  })

  it("preserves unknown charge evidence and its warning after exactly one POST", async () => {
    await seed()
    const transport = new SequenceTransport([
      errorResponse({ code: "RESOURCE_NOT_FOUND" }),
      errorResponse({ code: "DEPENDENCY_UNAVAILABLE", charge: null }),
    ])
    const { service } = serviceFor(transport)

    const outcome = await service.resume({ idempotencyKey: KEY })

    expect(outcome.exitCode).toBe(5)
    expect(transport.requests).toHaveLength(2)
    expect(outcome.warnings.join(" ")).toContain(
      "operation-unit charging is unknown"
    )
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: {
        localState: "response_unknown",
        lastResponse: {
          httpStatus: 503,
          errorCode: "DEPENDENCY_UNAVAILABLE",
        },
      },
    })
  })

  it("preserves concurrent response_unknown when the expiration exact-CAS loses", async () => {
    const createdAt = new Date(NOW.getTime() - DAY_MS).toISOString()
    await seed({ createdAt })
    const replaceExact = repository.replaceExact.bind(repository)
    vi.spyOn(repository, "replaceExact").mockImplementationOnce(
      async (expected, next) => {
        await replaceExact(expected, {
          ...expected,
          localState: "response_unknown",
          updatedAt: NOW.toISOString(),
        })
        await replaceExact(expected, next)
      }
    )
    const transport = new SequenceTransport([
      errorResponse({ code: "RESOURCE_NOT_FOUND" }),
    ])
    const { service } = serviceFor(transport)

    const outcome = await service.resume({ idempotencyKey: KEY })

    expect(outcome).toMatchObject({
      exitCode: 1,
      envelope: {
        ok: false,
        error: { code: "RESOURCE_NOT_FOUND", retryable: false },
      },
    })
    expect(transport.requests).toHaveLength(1)
    expect(await repository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "response_unknown" },
    })
  })
})
