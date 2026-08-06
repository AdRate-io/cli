import { chmod, link, writeFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { StatusCommandService } from "../src/commands/status-command-service.js"
import { PendingCommandRepository } from "../src/commands/pending-command-repository.js"
import { pendingRecordId } from "../src/commands/pending-command-contract.js"
import { HttpTransportError, PublicHttpClient } from "../src/http/client.js"
import { CliFailure, dependencyFailure } from "../src/errors.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  deferred,
  validCredentialMetadata,
  validTokenIndex,
} from "./helpers.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../src/auth/local-credentials.js"
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/http/client.js"
import type { PendingCommandRecord } from "../src/commands/pending-command-contract.js"
import type { TemporaryStateFixture } from "./helpers.js"

const NOW = new Date("2026-07-31T08:00:00.000Z")
const PENDING_UNTIL = "2026-08-01T08:00:00.000Z"
const RECOVERY_UNTIL = "2026-08-07T08:00:00.000Z"
const COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e"
const DEFAULT_KEY = "abc_DEF-9"

type TransportReply =
  | HttpResponse
  | Error
  | ((input: HttpRequest) => HttpResponse | Promise<HttpResponse>)

class SequenceTransport implements HttpTransport {
  readonly requests: Array<HttpRequest> = []

  constructor(readonly replies: Array<TransportReply>) {}

  async request(input: HttpRequest): Promise<HttpResponse> {
    this.requests.push(input)
    const reply = this.replies.shift()
    if (!reply) throw new Error("Unexpected HTTP request")
    if (reply instanceof Error) throw reply
    return typeof reply === "function" ? reply(input) : reply
  }
}

function locatedCredential(
  input: {
    credentialId?: string
    issuerOrigin?: "https://api.adrate.io" | "https://api.test.adrate.io"
    teamId?: number
  } = {}
): LocatedCredential {
  const credentialId = input.credentialId ?? CREDENTIAL_ID
  const issuerOrigin = input.issuerOrigin ?? "https://api.adrate.io"
  const environment =
    issuerOrigin === "https://api.adrate.io" ? "production" : "test"
  return {
    index: validTokenIndex({
      credentialId,
      issuerOrigin,
      environment,
    }),
    token: OWNER_SESSION_TOKEN,
    credentials: validCredentialMetadata({
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
    },
  }
}

function command(key = DEFAULT_KEY, overrides: Record<string, unknown> = {}) {
  return {
    commandId: COMMAND_ID,
    idempotencyKey: key,
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
    createdAt: NOW.toISOString(),
    startedAt: null,
    completedAt: null,
    recoverableUntil: PENDING_UNTIL,
    lastReconcileAt: null,
    ...overrides,
  }
}

function succeededCommand(key = DEFAULT_KEY) {
  return command(key, {
    status: "succeeded",
    isFinal: true,
    suggestedAction: null,
    beforeStatus: "ENABLE",
    verificationBasis: "verified_no_op",
    completedAt: NOW.toISOString(),
    recoverableUntil: null,
  })
}

function failedCommand(key = DEFAULT_KEY) {
  return command(key, {
    status: "failed",
    isFinal: true,
    reason: "upstream_rejected",
    suggestedAction: null,
    completedAt: NOW.toISOString(),
    recoverableUntil: null,
  })
}

function usage(operationUnitsCharged: 0 | 1 | 2 | 3 | null) {
  return {
    operationUnits: 3,
    operationUnitsCharged,
    minute: {
      limit: 60,
      remaining: 59,
      resetAt: PENDING_UNTIL,
      burst: 10,
    },
    writeMinute: { limit: 10, remaining: 9, resetAt: PENDING_UNTIL },
    dailyTikTokUnits: {
      limit: 3000,
      remaining: 2997,
      resetAt: PENDING_UNTIL,
    },
  }
}

function response(
  status: number,
  body: Record<string, unknown>,
  requestId = "server_status_1",
  headers: Record<string, string> = {}
): HttpResponse {
  return {
    status,
    requestId,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      ...headers,
    },
    text: JSON.stringify(body),
  }
}

function successResponse(
  value: Record<string, unknown>,
  status = 202,
  meta: Record<string, unknown> = {}
): HttpResponse {
  const requestId = "server_status_1"
  return response(status, {
    ok: true,
    data: { command: value },
    meta: { ...meta, requestId, apiVersion: "v1" },
  })
}

function errorResponse(input: {
  code: string
  retryable: boolean
  details: Record<string, unknown>
  status?: number
  charge?: 0 | 1 | 2 | 3 | null
  retryAfter?: number
}): HttpResponse {
  const requestId = "server_status_1"
  return response(
    input.status ?? 503,
    {
      ok: false,
      error: {
        code: input.code,
        message: "Status request failed.",
        retryable: input.retryable,
        details: input.details,
      },
      meta: {
        requestId,
        apiVersion: "v1",
        ...(input.charge === undefined ? {} : { usage: usage(input.charge) }),
      },
    },
    requestId,
    input.retryAfter === undefined
      ? {}
      : { "retry-after": String(input.retryAfter) }
  )
}

interface Harness {
  fixture: TemporaryStateFixture
  repository: PendingCommandRepository
  transport: SequenceTransport
  requireLocated: ReturnType<typeof vi.fn>
  service: StatusCommandService
}

type CredentialFence = (expected: LocatedCredential) => Promise<string>

async function createHarness(
  replies: Array<TransportReply> = [],
  options: {
    located?: LocatedCredential
    generateIdempotencyKey?: () => string
    fence?: CredentialFence
  } = {}
): Promise<Harness> {
  const fixture = await createTemporaryStateFixture()
  const repository = new PendingCommandRepository(
    fixture.fileSystem,
    fixture.paths,
    {
      now: () => new Date(NOW),
    }
  )
  const transport = new SequenceTransport(replies)
  const requireLocated = vi.fn(() =>
    Promise.resolve(options.located ?? locatedCredential())
  )
  const fenceExpectedLocatedCredential = vi.fn(
    options.fence ??
      ((expected: LocatedCredential) => Promise.resolve(expected.token))
  )
  const local = {
    requireLocated,
    fenceExpectedLocatedCredential,
  } as unknown as LocalCredentialCoordinator
  return {
    fixture,
    repository,
    transport,
    requireLocated,
    service: new StatusCommandService(
      new PublicHttpClient(transport),
      local,
      repository,
      {
        now: () => new Date(NOW),
        generateIdempotencyKey:
          options.generateIdempotencyKey ??
          (() => "77777777-7777-4777-8777-777777777777"),
        environment: {},
      }
    ),
  }
}

async function caughtFailure(promise: Promise<unknown>): Promise<CliFailure> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    return error as CliFailure
  }
  throw new Error("Expected CliFailure")
}

async function readRecord(
  repository: PendingCommandRepository,
  key = DEFAULT_KEY
): Promise<PendingCommandRecord | null> {
  const result = await repository.read(key)
  return result.kind === "found" ? result.record : null
}

async function seed(
  repository: PendingCommandRepository,
  input: {
    key?: string
    credentialId?: string
    issuerOrigin?: "https://api.adrate.io" | "https://api.test.adrate.io"
    desiredStatus?: "ENABLE" | "DISABLE"
    campaignId?: string
  } = {}
): Promise<PendingCommandRecord> {
  const result = await repository.prepare({
    idempotencyKey: input.key ?? DEFAULT_KEY,
    credentialId: input.credentialId ?? CREDENTIAL_ID,
    issuerOrigin: input.issuerOrigin ?? "https://api.adrate.io",
    teamId: 42,
    intent: {
      advId: "70001",
      campaignId: input.campaignId ?? "80001",
      desiredStatus: input.desiredStatus ?? "ENABLE",
      authId: 42,
    },
    now: NOW,
  })
  if (result.kind !== "created") throw new Error("seed failed")
  return result.record
}

describe("StatusCommandService input and HTTP boundary", () => {
  it.each([
    [{ campaignId: "80001", desiredStatus: "enable" }, "--adv-id"],
    [{ advId: "70001", campaignId: "80001", desiredStatus: "ENABLE" }, "--set"],
    [
      { advId: "bad/id", campaignId: "80001", desiredStatus: "enable" },
      "raw-path",
    ],
    [
      { advId: "70001", campaignId: "bad id", desiredStatus: "enable" },
      "raw-path",
    ],
    [
      {
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        authId: "0",
      },
      "auth-id",
    ],
    [
      {
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        idempotencyKey: "../secret",
      },
      "idempotency-key",
    ],
    [
      {
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        requestId: "bad request",
      },
      "request-id",
    ],
  ] as const)(
    "rejects invalid input before local I/O: %j",
    async (input, _expectedMessage) => {
      const harness = await createHarness()
      try {
        const failure = await caughtFailure(harness.service.status(input))
        expect(failure.exitCode).toBe(2)
        expect(harness.requireLocated).not.toHaveBeenCalled()
        expect(harness.transport.requests).toHaveLength(0)
        expect(await harness.repository.scan()).toEqual({
          records: [],
          invalidEntries: [],
        })
      } finally {
        await harness.fixture.cleanup()
      }
    }
  )

  it("delegates the prepared record through one exact Dispatcher POST", async () => {
    const harness = await createHarness([successResponse(command())])
    try {
      const outcome = await harness.service.status({
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        authId: "42",
        idempotencyKey: DEFAULT_KEY,
        requestId: "client_status_1",
      })
      expect(outcome.exitCode).toBe(4)
      expect(harness.transport.requests).toEqual([
        {
          method: "POST",
          issuerOrigin: "https://api.adrate.io",
          path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
          token: OWNER_SESSION_TOKEN,
          idempotencyKey: DEFAULT_KEY,
          json: { desiredStatus: "ENABLE", authId: 42 },
          requestId: "client_status_1",
          deadlineMs: 120_000,
        },
      ])
      expect(
        harness.transport.requests.filter(({ method }) => method === "POST")
      ).toHaveLength(1)
      expect(await readRecord(harness.repository)).toMatchObject({
        localState: "command_known",
        commandId: COMMAND_ID,
        lastResponse: {
          requestId: "server_status_1",
          httpStatus: 202,
          errorCode: null,
        },
      })
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it("generates a UUIDv4 key and omits authId instead of sending null", async () => {
    const generated = "77777777-7777-4777-8777-777777777777"
    const harness = await createHarness([successResponse(command(generated))], {
      generateIdempotencyKey: () => generated,
    })
    try {
      await harness.service.status({
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
      })
      expect(harness.transport.requests).toHaveLength(1)
      expect(harness.transport.requests[0]).toMatchObject({
        idempotencyKey: generated,
        json: { desiredStatus: "ENABLE" },
      })
      expect(harness.transport.requests[0]?.json).not.toHaveProperty("authId")
      expect(await readRecord(harness.repository, generated)).toMatchObject({
        idempotencyKey: generated,
        intent: { authId: null },
      })
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it("requires activated credential metadata before creating local evidence", async () => {
    const unactivated = { ...locatedCredential(), credentials: null }
    const harness = await createHarness([], { located: unactivated })
    try {
      const failure = await caughtFailure(
        harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
      )
      expect(failure.exitCode).toBe(3)
      expect(harness.requireLocated).toHaveBeenCalledTimes(1)
      expect(harness.transport.requests).toHaveLength(0)
      expect((await harness.repository.scan()).records).toHaveLength(0)
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it("keeps the prepared journal and sends zero POST when auth identity drifts at the Dispatcher fence", async () => {
    const harness = await createHarness([], {
      fence: () =>
        Promise.reject(
          dependencyFailure(
            "Local authentication state changed before the remote write; no request was sent."
          )
        ),
    })
    try {
      const failure = await caughtFailure(
        harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
      )

      expect(failure).toMatchObject({
        exitCode: 4,
        envelope: {
          error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
        },
      })
      expect(harness.transport.requests).toHaveLength(0)
      expect(await readRecord(harness.repository)).toMatchObject({
        localState: "prepared",
      })
    } finally {
      await harness.fixture.cleanup()
    }
  })
})

describe("StatusCommandService prepare create-if-absent gate", () => {
  it("recovers a pre-link temp residue and still performs only one Status POST", async () => {
    const harness = await createHarness([successResponse(command())])
    try {
      await harness.fixture.fileSystem.ensureDirectory(
        harness.fixture.paths.pendingCommands
      )
      const temporary = `${harness.repository.recordPath(DEFAULT_KEY)}.tmp-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
      await writeFile(temporary, '{"incomplete":', { mode: 0o600 })

      const outcome = await harness.service.status({
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        idempotencyKey: DEFAULT_KEY,
      })

      expect(outcome.exitCode).toBe(4)
      expect(harness.transport.requests).toHaveLength(1)
      expect(await readRecord(harness.repository)).toMatchObject({
        localState: "command_known",
      })
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it("treats a post-link temp residue as noncanonical and never duplicates the existing POST", async () => {
    const harness = await createHarness()
    try {
      await seed(harness.repository)
      const canonical = harness.repository.recordPath(DEFAULT_KEY)
      await link(
        canonical,
        `${canonical}.tmp-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
      )

      const failure = await caughtFailure(
        harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
      )

      expect(failure).toMatchObject({
        exitCode: 2,
        envelope: { error: { code: "LOCAL_PENDING_COMMAND_EXISTS" } },
      })
      expect(harness.transport.requests).toHaveLength(0)
      expect((await harness.repository.scan()).invalidEntries).toEqual([])
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it.each([
    [
      "same key and intent",
      { key: DEFAULT_KEY },
      { idempotencyKey: DEFAULT_KEY, desiredStatus: "enable" },
      "LOCAL_PENDING_COMMAND_EXISTS",
      2,
    ],
    [
      "same resource and intent",
      { key: "existing_key" },
      { idempotencyKey: "different_key", desiredStatus: "enable" },
      "LOCAL_PENDING_COMMAND_EXISTS",
      2,
    ],
    [
      "same resource and different intent",
      { key: "existing_key" },
      { idempotencyKey: "different_key", desiredStatus: "disable" },
      "LOCAL_RESOURCE_INTENT_CONFLICT",
      2,
    ],
    [
      "same key and different intent",
      { key: DEFAULT_KEY },
      { idempotencyKey: DEFAULT_KEY, desiredStatus: "disable" },
      "LOCAL_IDEMPOTENCY_CONFLICT",
      2,
    ],
    [
      "prior credential",
      {
        key: "existing_key",
        credentialId: "99999999-9999-4999-8999-999999999999",
      },
      { idempotencyKey: "different_key", desiredStatus: "enable" },
      "LOCAL_PRIOR_CREDENTIAL_PENDING",
      3,
    ],
    [
      "same key from another credential",
      {
        key: DEFAULT_KEY,
        credentialId: "99999999-9999-4999-8999-999999999999",
      },
      { idempotencyKey: DEFAULT_KEY, desiredStatus: "enable" },
      "LOCAL_CREDENTIAL_MISMATCH",
      3,
    ],
  ] as const)(
    "%s returns the frozen local error with zero POST",
    async (_label, existing, request, expectedCode, expectedExit) => {
      const harness = await createHarness()
      try {
        await seed(harness.repository, existing)
        const failure = await caughtFailure(
          harness.service.status({
            advId: "70001",
            campaignId: "80001",
            desiredStatus: request.desiredStatus,
            authId: "42",
            idempotencyKey: request.idempotencyKey,
          })
        )
        expect(failure.exitCode).toBe(expectedExit)
        expect(failure.envelope.ok).toBe(false)
        if (!failure.envelope.ok) {
          expect(failure.envelope.error.code).toBe(expectedCode)
        }
        expect(harness.transport.requests).toHaveLength(0)
        expect((await harness.repository.scan()).records).toHaveLength(1)
      } finally {
        await harness.fixture.cleanup()
      }
    }
  )

  it("rejects the same key from another issuer/credential with zero POST", async () => {
    const harness = await createHarness()
    try {
      await seed(harness.repository, {
        issuerOrigin: "https://api.test.adrate.io",
      })
      const failure = await caughtFailure(
        harness.service.status({
          advId: "70001",
          campaignId: "90001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
      )
      expect(failure).toMatchObject({ exitCode: 3 })
      if (!failure.envelope.ok) {
        expect(failure.envelope.error.code).toBe("LOCAL_CREDENTIAL_MISMATCH")
      }
      expect(harness.transport.requests).toHaveLength(0)
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it("fails loud on unsafe evidence without echoing key or absolute path", async () => {
    const harness = await createHarness()
    try {
      await harness.fixture.fileSystem.ensureDirectory(
        harness.fixture.paths.pendingCommands
      )
      await harness.fixture.fileSystem.atomicWrite(
        harness.repository.recordPath("secret_key"),
        "{not-json\n"
      )
      const failure = await caughtFailure(
        harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
      )
      const rendered = JSON.stringify(failure.envelope)
      expect(failure).toMatchObject({ exitCode: 1 })
      expect(rendered).not.toContain("secret_key")
      expect(rendered).not.toContain(harness.fixture.root)
      expect(harness.transport.requests).toHaveLength(0)
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it("two concurrent Status calls for one resource create one record and one POST", async () => {
    const gate = deferred()
    const firstKey = "77777777-7777-4777-8777-777777777777"
    const generated = [firstKey, "88888888-8888-4888-8888-888888888888"]
    const harness = await createHarness(
      [
        async () => {
          await gate.promise
          return successResponse(command(firstKey))
        },
      ],
      { generateIdempotencyKey: () => generated.shift()! }
    )
    try {
      const first = harness.service.status({
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        authId: "42",
      })
      await vi.waitFor(() => expect(harness.transport.requests).toHaveLength(1))
      const secondFailure = await caughtFailure(
        harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
        })
      )
      expect(secondFailure).toMatchObject({ exitCode: 2 })
      gate.resolve()
      await expect(first).resolves.toMatchObject({ exitCode: 4 })
      expect(harness.transport.requests).toHaveLength(1)
      expect((await harness.repository.scan()).records).toHaveLength(1)
    } finally {
      gate.resolve()
      await harness.fixture.cleanup()
    }
  })
})

describe("StatusCommandService response and cleanup matrix", () => {
  it("removes final 200 and also removes 202 final with a contract warning", async () => {
    for (const status of [200, 202]) {
      const harness = await createHarness([
        successResponse(succeededCommand(), status),
      ])
      try {
        const outcome = await harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
        expect(outcome.exitCode).toBe(0)
        expect(await readRecord(harness.repository)).toBeNull()
        if (status === 202) {
          expect(outcome.warnings.join(" ")).toContain("unexpected HTTP status")
        }
      } finally {
        await harness.fixture.cleanup()
      }
    }
  })

  it("retains retryable pending Command, Retry-After, and sends no retry", async () => {
    const harness = await createHarness([
      errorResponse({
        code: "DEPENDENCY_UNAVAILABLE",
        retryable: true,
        details: { commandCreated: true, command: command() },
        retryAfter: 17,
      }),
    ])
    try {
      const outcome = await harness.service.status({
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        authId: "42",
        idempotencyKey: DEFAULT_KEY,
      })
      expect(outcome).toMatchObject({ exitCode: 4, retryAfterSeconds: 17 })
      expect(harness.transport.requests).toHaveLength(1)
      expect(await readRecord(harness.repository)).toMatchObject({
        localState: "command_known",
        commandId: COMMAND_ID,
        lastResponse: {
          httpStatus: 503,
          errorCode: "DEPENDENCY_UNAVAILABLE",
        },
      })
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it("removes a trustworthy final error Command and returns the server error", async () => {
    const harness = await createHarness([
      errorResponse({
        code: "UPSTREAM_ERROR",
        retryable: false,
        details: { commandCreated: true, command: failedCommand() },
        charge: 1,
      }),
    ])
    try {
      const outcome = await harness.service.status({
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        authId: "42",
        idempotencyKey: DEFAULT_KEY,
      })
      expect(outcome.exitCode).toBe(1)
      expect(outcome.envelope).toMatchObject({
        ok: false,
        error: { code: "UPSTREAM_ERROR" },
      })
      expect(await readRecord(harness.repository)).toBeNull()
      expect(harness.transport.requests).toHaveLength(1)
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it("charge=null only adds a warning and does not override Command state", async () => {
    for (const serverCommand of [command(), failedCommand()]) {
      const harness = await createHarness([
        errorResponse({
          code: "DEPENDENCY_UNAVAILABLE",
          retryable: serverCommand.status === "pending",
          details: { commandCreated: true, command: serverCommand },
          charge: null,
        }),
      ])
      try {
        const outcome = await harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
        expect(outcome.exitCode).toBe(
          serverCommand.status === "pending" ? 4 : 1
        )
        expect(outcome.envelope).toMatchObject({
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            retryable: serverCommand.status === "pending",
          },
        })
        expect(harness.transport.requests).toHaveLength(1)
        if (serverCommand.status === "pending") {
          expect(await readRecord(harness.repository)).toMatchObject({
            localState: "command_known",
          })
        } else {
          expect(await readRecord(harness.repository)).toBeNull()
        }
        expect(outcome.warnings.join(" ")).toContain(
          "operation-unit charging is unknown"
        )
      } finally {
        await harness.fixture.cleanup()
      }
    }
  })

  it("only commandCreated=false without charge uncertainty removes the record", async () => {
    const harness = await createHarness([
      errorResponse({
        code: "INVALID_REQUEST",
        retryable: false,
        status: 400,
        details: { commandCreated: false },
        charge: 0,
      }),
    ])
    try {
      const outcome = await harness.service.status({
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        authId: "42",
        idempotencyKey: DEFAULT_KEY,
      })
      expect(outcome.exitCode).toBe(2)
      expect(outcome.envelope.ok).toBe(false)
      expect(await readRecord(harness.repository)).toBeNull()
    } finally {
      await harness.fixture.cleanup()
    }
  })

  it.each([
    ["missing commandCreated", {}],
    [
      "wrong Command identity",
      { commandCreated: true, command: command("different_key") },
    ],
  ] as const)(
    "%s becomes response_unknown and exit 5",
    async (_label, details) => {
      const harness = await createHarness([
        errorResponse({
          code: "DEPENDENCY_UNAVAILABLE",
          retryable: true,
          details,
        }),
      ])
      try {
        const outcome = await harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
        expect(outcome.exitCode).toBe(5)
        expect(await readRecord(harness.repository)).toMatchObject({
          localState: "response_unknown",
        })
        expect(harness.transport.requests).toHaveLength(1)
      } finally {
        await harness.fixture.cleanup()
      }
    }
  )

  it.each([
    ["timeout", new HttpTransportError("timeout", "adr_owner_secret timeout")],
    ["network", new Error("adr_owner_secret transport failure")],
    [
      "invalid envelope",
      response(502, {
        ok: true,
        data: { rawBody: "adr_owner_secret" },
        meta: { requestId: "server_status_1", apiVersion: "v1" },
      }),
    ],
  ] as const)(
    "%s failure preserves a safe response_unknown record",
    async (_label, reply) => {
      const harness = await createHarness([reply])
      try {
        const failure = await caughtFailure(
          harness.service.status({
            advId: "70001",
            campaignId: "80001",
            desiredStatus: "enable",
            authId: "42",
            idempotencyKey: DEFAULT_KEY,
          })
        )
        expect(failure.exitCode).toBe(5)
        expect(JSON.stringify(failure.envelope)).not.toContain(
          "adr_owner_secret"
        )
        expect(harness.transport.requests).toHaveLength(1)
        expect(await readRecord(harness.repository)).toMatchObject({
          localState: "response_unknown",
          lastResponse: null,
        })
      } finally {
        await harness.fixture.cleanup()
      }
    }
  )

  it("a local permission/CAS failure preserves evidence and exits 5", async () => {
    if (process.platform === "win32") return
    const harness = await createHarness([successResponse(command())])
    try {
      const originalReplace = harness.repository.replaceExact.bind(
        harness.repository
      )
      vi.spyOn(harness.repository, "replaceExact")
        .mockRejectedValueOnce(new Error("local secret write failure"))
        .mockImplementationOnce(originalReplace)
      const failure = await caughtFailure(
        harness.service.status({
          advId: "70001",
          campaignId: "80001",
          desiredStatus: "enable",
          authId: "42",
          idempotencyKey: DEFAULT_KEY,
        })
      )
      expect(failure.exitCode).toBe(5)
      expect(await readRecord(harness.repository)).toMatchObject({
        localState: "response_unknown",
      })
      expect(harness.transport.requests).toHaveLength(1)
      await chmod(harness.fixture.root, 0o700)
    } finally {
      await harness.fixture.cleanup()
    }
  })
})

describe("StatusCommandService secret boundary", () => {
  it("stores only the key hash in filenames and never puts Token/raw body in evidence", async () => {
    const harness = await createHarness([
      errorResponse({
        code: "DEPENDENCY_UNAVAILABLE",
        retryable: false,
        details: {},
      }),
    ])
    try {
      await harness.service.status({
        advId: "70001",
        campaignId: "80001",
        desiredStatus: "enable",
        authId: "42",
        idempotencyKey: DEFAULT_KEY,
      })
      const scan = await harness.repository.scan()
      expect(scan.records[0]?.recordId).toBe(pendingRecordId(DEFAULT_KEY))
      const serialized = JSON.stringify(scan)
      expect(serialized).not.toContain(OWNER_SESSION_TOKEN)
      expect(serialized).not.toContain("rawBody")
    } finally {
      await harness.fixture.cleanup()
    }
  })
})
