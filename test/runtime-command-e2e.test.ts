import { isDeepStrictEqual } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { PRODUCTION_MACHINE_ORIGIN } from "../src/constants.js"
import { runCli } from "../src/runner.js"
import { createCliRuntime } from "../src/runtime.js"
import { HttpTransportError } from "../src/http/client.js"
import { CredentialStore } from "../src/storage/credential-backend.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  deferred,
  stableTestProcessIdentity,
  validCredentialMetadata,
  validTokenIndex,
} from "./helpers.js"
import type { CliRuntime } from "../src/runtime.js"
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/http/client.js"
import type {
  CredentialAddress,
  CredentialBackend,
} from "../src/storage/credential-backend.js"
import type { PublicCommandDto } from "../src/contracts/command.js"
import type { TokenIndex, TokenStorageKind } from "../src/storage/schemas.js"
import type { AcknowledgedOutputStream } from "../src/output.js"
import type { TemporaryStateFixture } from "./helpers.js"

const NOW = new Date("2026-07-31T08:00:00.000Z")
const COMMAND_ID = "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e"
const KEY = "runtime_status_key"
const STATUS_PATH = "/public/v1/ads/advertisers/70001/campaigns/80001/status"

function addressKey(address: CredentialAddress): string {
  return `${address.issuerOrigin}|${address.credentialKind}|${address.credentialId}`
}

class MemoryCredentialBackend implements CredentialBackend {
  readonly values = new Map<string, string>()
  readCount = 0
  beforeRead: ((count: number) => Promise<void>) | null = null

  constructor(readonly kind: TokenStorageKind) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }

  async read(address: CredentialAddress): Promise<string | null> {
    this.readCount += 1
    await this.beforeRead?.(this.readCount)
    return this.values.get(addressKey(address)) ?? null
  }

  write(address: CredentialAddress, token: string): Promise<void> {
    this.values.set(addressKey(address), token)
    return Promise.resolve()
  }

  remove(address: CredentialAddress): Promise<void> {
    this.values.delete(addressKey(address))
    return Promise.resolve()
  }
}

type TransportHandler = (input: HttpRequest) => Promise<HttpResponse>

class ControlledTransport implements HttpTransport {
  readonly requests: Array<HttpRequest> = []

  constructor(public handler: TransportHandler) {}

  request(input: HttpRequest): Promise<HttpResponse> {
    this.requests.push(input)
    return this.handler(input)
  }
}

class CaptureStream implements AcknowledgedOutputStream {
  readonly values: Array<string> = []

  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.values.push(value)
    queueMicrotask(() => callback())
    return true
  }
}

interface RuntimeHarness {
  runtime: CliRuntime
  transport: ControlledTransport
  keychain: MemoryCredentialBackend
  index: TokenIndex
}

interface RunResult {
  exitCode: number
  stdout: CaptureStream
  stderr: CaptureStream
  envelope: Record<string, unknown>
}

const fixtures: Array<TemporaryStateFixture> = []
let generatedResponseRequestId = 0

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

function command(status: "pending" | "succeeded", key = KEY): PublicCommandDto {
  const pending = status === "pending"
  return {
    commandId: COMMAND_ID,
    idempotencyKey: key,
    capabilityId: "ads.campaign.status.write",
    status,
    isFinal: !pending,
    reason: null,
    suggestedAction: pending ? "query_command" : null,
    target: {
      advertiserId: "70001",
      campaignId: "80001",
      desiredStatus: "ENABLE",
    },
    beforeStatus: pending ? null : "ENABLE",
    afterStatus: null,
    verificationBasis: pending ? null : "verified_no_op",
    attemptCount: 0,
    createdAt: NOW.toISOString(),
    startedAt: null,
    completedAt: pending ? null : "2026-07-31T08:00:01.000Z",
    recoverableUntil: pending ? "2026-08-01T08:00:00.000Z" : null,
    lastReconcileAt: null,
  }
}

function requestId(input: HttpRequest): string {
  generatedResponseRequestId += 1
  return input.requestId ?? `runtime_server_${generatedResponseRequestId}`
}

function expectedStatusRequest(
  options: {
    requestId?: string
    authId?: number
  } = {}
): HttpRequest {
  return {
    method: "POST",
    issuerOrigin: PRODUCTION_MACHINE_ORIGIN,
    path: STATUS_PATH,
    deadlineMs: 120_000,
    token: OWNER_SESSION_TOKEN,
    idempotencyKey: KEY,
    json:
      options.authId === undefined
        ? { desiredStatus: "ENABLE" }
        : { desiredStatus: "ENABLE", authId: options.authId },
    ...(options.requestId === undefined
      ? {}
      : { requestId: options.requestId }),
  }
}

function expectedCommandGetRequest(
  path: string,
  requestIdValue?: string
): HttpRequest {
  return {
    method: "GET",
    issuerOrigin: PRODUCTION_MACHINE_ORIGIN,
    path,
    deadlineMs: 15_000,
    token: OWNER_SESSION_TOKEN,
    ...(requestIdValue === undefined ? {} : { requestId: requestIdValue }),
  }
}

function requireExactTransportRequest(
  actual: HttpRequest,
  expected: HttpRequest,
  callIndex: number
): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Unexpected transport request at call ${callIndex}.`)
  }
}

function successResponse(
  input: HttpRequest,
  status: 200 | 202,
  value: PublicCommandDto
): Promise<HttpResponse> {
  const id = requestId(input)
  return Promise.resolve({
    status,
    requestId: id,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": id,
    },
    text: JSON.stringify({
      ok: true,
      data: { command: value },
      meta: { requestId: id, apiVersion: "v1" },
    }),
  })
}

function notFoundResponse(input: HttpRequest): Promise<HttpResponse> {
  const id = requestId(input)
  return Promise.resolve({
    status: 404,
    requestId: id,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": id,
    },
    text: JSON.stringify({
      ok: false,
      error: {
        code: "RESOURCE_NOT_FOUND",
        message: "The Command was not found.",
        retryable: false,
        details: {},
      },
      meta: { requestId: id, apiVersion: "v1" },
    }),
  })
}

async function createHarness(
  handler: TransportHandler,
  options: { key?: string } = {}
): Promise<RuntimeHarness> {
  const fixture = await createTemporaryStateFixture()
  fixtures.push(fixture)
  const keychain = new MemoryCredentialBackend("keychain")
  const credentialStore = new CredentialStore(
    keychain,
    new MemoryCredentialBackend("fallback_file")
  )
  const transport = new ControlledTransport(handler)
  const runtime = createCliRuntime({
    root: fixture.root,
    transport,
    credentialStore,
    processIdentity: stableTestProcessIdentity("runtime-command-e2e"),
    now: () => new Date(NOW),
    environment: {
      ADRATE_NO_CREDENTIAL_NOTIFIER: "1",
      ADRATE_NO_SKILLS_NOTIFIER: "1",
      ADRATE_NO_UPDATE_NOTIFIER: "1",
    },
    generateIdempotencyKey: () => options.key ?? KEY,
    progress: () => undefined,
  })
  let index!: TokenIndex
  await runtime.state.withAuthLock(async () => {
    const config = await runtime.state.ensureConfig("production")
    index = validTokenIndex({ clientInstanceId: config.clientInstanceId })
    const metadata = validCredentialMetadata({
      clientInstanceId: config.clientInstanceId,
    })
    await runtime.state.writeTokenIndex(index)
    await runtime.state.writeCredentials(metadata)
  })
  await credentialStore.write(index, OWNER_SESSION_TOKEN)
  keychain.readCount = 0
  return {
    runtime,
    transport,
    keychain,
    index,
  }
}

async function runJson(
  runtime: CliRuntime,
  argv: ReadonlyArray<string>
): Promise<RunResult> {
  const stdout = new CaptureStream()
  const stderr = new CaptureStream()
  const exitCode = await runCli(runtime.application, [...argv, "--json"], {
    stdout,
    stderr,
  })
  expect(stdout.values).toHaveLength(1)
  const text = stdout.values[0]!
  expect(text.trim().split("\n")).toHaveLength(1)
  return {
    exitCode,
    stdout,
    stderr,
    envelope: JSON.parse(text) as Record<string, unknown>,
  }
}

async function runHuman(
  runtime: CliRuntime,
  argv: ReadonlyArray<string>
): Promise<Omit<RunResult, "envelope">> {
  const stdout = new CaptureStream()
  const stderr = new CaptureStream()
  const exitCode = await runCli(runtime.application, argv, { stdout, stderr })
  return { exitCode, stdout, stderr }
}

describe("production runtime Command entry E2E", () => {
  it("wires status, pending, both GET selectors, pending resume, and final cleanup through runCli", async () => {
    let serverStatus: "pending" | "succeeded" = "pending"
    const harness = await createHarness((input) => {
      if (input.method === "POST") {
        return successResponse(input, 202, command("pending"))
      }
      return successResponse(input, 200, command(serverStatus))
    })

    const status = await runJson(harness.runtime, [
      "ads",
      "campaigns",
      "status",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--set",
      "enable",
      "--auth-id",
      "9",
      "--idempotency-key",
      KEY,
      "--request-id",
      "runtime_status_request",
    ])
    expect(status.exitCode).toBe(0)
    expect(status.envelope).toMatchObject({
      ok: true,
      data: { command: { status: "pending", isFinal: false } },
    })
    expect(harness.transport.requests).toStrictEqual([
      expectedStatusRequest({
        requestId: "runtime_status_request",
        authId: 9,
      }),
    ])
    expect(await harness.runtime.pendingRepository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "command_known", commandId: COMMAND_ID },
    })

    const beforePending = harness.transport.requests.length
    const pending = await runJson(harness.runtime, ["commands", "pending"])
    expect(pending).toMatchObject({
      exitCode: 0,
      envelope: {
        ok: true,
        data: { counts: { total: 1, query: 1, blocked: 0 } },
      },
    })
    expect(harness.transport.requests).toHaveLength(beforePending)

    const humanPending = await runHuman(harness.runtime, [
      "commands",
      "pending",
    ])
    expect(humanPending.exitCode).toBe(0)
    expect(humanPending.stdout.values).toHaveLength(0)
    expect(humanPending.stderr.values.length).toBeGreaterThan(0)
    expect(harness.transport.requests).toHaveLength(beforePending)
    expect(
      [...humanPending.stdout.values, ...humanPending.stderr.values].join("")
    ).not.toContain(OWNER_SESSION_TOKEN)

    const beforeById = harness.transport.requests.length
    const byId = await runJson(harness.runtime, [
      "commands",
      "get",
      "--command-id",
      COMMAND_ID,
    ])
    expect(byId.exitCode).toBe(0)
    expect(harness.transport.requests.slice(beforeById)).toStrictEqual([
      expectedCommandGetRequest(`/public/v1/commands/${COMMAND_ID}`),
    ])

    const beforeByKey = harness.transport.requests.length
    const byKey = await runJson(harness.runtime, [
      "commands",
      "get",
      "--idempotency-key",
      KEY,
    ])
    expect(byKey.exitCode).toBe(0)
    expect(harness.transport.requests.slice(beforeByKey)).toStrictEqual([
      expectedCommandGetRequest(`/public/v1/commands?idempotencyKey=${KEY}`),
    ])

    const beforeResume = harness.transport.requests.length
    const resumed = await runJson(harness.runtime, [
      "commands",
      "resume",
      "--idempotency-key",
      KEY,
      "--request-id",
      "runtime_resume_request",
    ])
    expect(resumed.exitCode).toBe(0)
    expect(harness.transport.requests.slice(beforeResume)).toStrictEqual([
      expectedCommandGetRequest(
        `/public/v1/commands/${COMMAND_ID}`,
        "runtime_resume_request"
      ),
      expectedStatusRequest({
        requestId: "runtime_resume_request",
        authId: 9,
      }),
    ])

    serverStatus = "succeeded"
    const beforeFinal = harness.transport.requests.length
    const final = await runJson(harness.runtime, [
      "commands",
      "resume",
      "--idempotency-key",
      KEY,
    ])
    expect(final.exitCode).toBe(0)
    expect(harness.transport.requests.slice(beforeFinal)).toStrictEqual([
      expectedCommandGetRequest(`/public/v1/commands/${COMMAND_ID}`),
    ])
    expect(await harness.runtime.pendingRepository.read(KEY)).toMatchObject({
      kind: "missing",
    })
    expect(
      [
        ...status.stdout.values,
        ...status.stderr.values,
        ...pending.stdout.values,
        ...pending.stderr.values,
        ...byId.stdout.values,
        ...byKey.stdout.values,
        ...resumed.stdout.values,
        ...final.stdout.values,
      ].join("")
    ).not.toContain(OWNER_SESSION_TOKEN)
  })

  it("preserves response-loss evidence and resumes a precise 404 with one same-key POST", async () => {
    const expectedRequests = [
      expectedStatusRequest({ requestId: "runtime_loss_status_request" }),
      expectedCommandGetRequest(
        `/public/v1/commands?idempotencyKey=${KEY}`,
        "runtime_loss_resume_request"
      ),
      expectedStatusRequest({ requestId: "runtime_loss_resume_request" }),
    ]
    let transportCallIndex = 0
    const harness = await createHarness((input) => {
      const callIndex = transportCallIndex
      transportCallIndex += 1
      const expected = expectedRequests[callIndex]
      if (expected === undefined) {
        throw new Error(
          `Unexpected extra transport request at call ${callIndex}.`
        )
      }
      requireExactTransportRequest(input, expected, callIndex)
      if (callIndex === 0) {
        return Promise.reject(
          new HttpTransportError("network", "secret transport detail")
        )
      }
      return callIndex === 1
        ? notFoundResponse(input)
        : successResponse(input, 202, command("pending"))
    })

    const lost = await runJson(harness.runtime, [
      "ads",
      "campaigns",
      "status",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--set",
      "enable",
      "--idempotency-key",
      KEY,
      "--request-id",
      "runtime_loss_status_request",
    ])
    expect(lost.exitCode).toBe(5)
    expect(lost.envelope).toMatchObject({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE", retryable: false },
    })
    expect(await harness.runtime.pendingRepository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "response_unknown", commandId: null },
    })
    expect(harness.transport.requests).toStrictEqual(
      expectedRequests.slice(0, 1)
    )

    const resumed = await runJson(harness.runtime, [
      "commands",
      "resume",
      "--idempotency-key",
      KEY,
      "--request-id",
      "runtime_loss_resume_request",
    ])
    expect(resumed.exitCode).toBe(0)
    expect(transportCallIndex).toBe(3)
    expect(harness.transport.requests).toStrictEqual(expectedRequests)
    expect(await harness.runtime.pendingRepository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "command_known", commandId: COMMAND_ID },
    })
    expect(
      [...lost.stdout.values, ...lost.stderr.values].join("")
    ).not.toContain("secret transport detail")
  })

  it("rejects invalid T10 input before pending creation, credential reads, or network", async () => {
    const harness = await createHarness(() => {
      throw new Error("invalid input must not reach transport")
    })
    const invalidCases: Array<ReadonlyArray<string>> = [
      ["ads", "campaigns", "status", "--adv-id", "70001"],
      [
        "ads",
        "campaigns",
        "status",
        "--adv-id",
        "bad id",
        "--campaign-id",
        "80001",
        "--set",
        "enable",
      ],
      ["commands", "get"],
      ["commands", "get", "--command-id", "NOT-A-UUID"],
      ["commands", "get", "--command-id", COMMAND_ID, "--idempotency-key", KEY],
      ["commands", "resume"],
      ["commands", "pending", "extra"],
      ["commands", "pending", "--test"],
      ["commands", "pending", "--version"],
    ]

    for (const argv of invalidCases) {
      const result = await runJson(harness.runtime, argv)
      expect(result.exitCode).toBe(2)
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", retryable: false },
      })
    }
    for (const argv of [
      ["ads", "campaigns", "status", "--help"],
      ["commands", "get", "--help"],
      ["commands", "pending", "--help"],
      ["commands", "resume", "--help"],
    ]) {
      expect((await runJson(harness.runtime, argv)).exitCode).toBe(0)
    }

    expect(harness.keychain.readCount).toBe(0)
    expect(harness.transport.requests).toHaveLength(0)
    expect(
      await harness.runtime.fileSystem.exists(
        harness.runtime.state.paths.pendingCommands
      )
    ).toBe(false)
  })

  it("allows only one concurrent production status invocation to POST", async () => {
    const postEntered = deferred()
    const releasePost = deferred()
    const harness = await createHarness(async (input) => {
      postEntered.resolve()
      await releasePost.promise
      return successResponse(input, 202, command("pending"))
    })

    const first = runJson(harness.runtime, [
      "ads",
      "campaigns",
      "status",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--set",
      "enable",
      "--idempotency-key",
      KEY,
    ])
    await postEntered.promise
    const second = await runJson(harness.runtime, [
      "ads",
      "campaigns",
      "status",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--set",
      "enable",
      "--idempotency-key",
      KEY,
    ])
    expect(second.exitCode).toBe(2)
    expect(second.envelope).toMatchObject({
      error: {
        code: "LOCAL_PENDING_COMMAND_EXISTS",
        details: { suggestedAction: "resume_command" },
      },
    })
    expect(harness.transport.requests).toHaveLength(1)

    releasePost.resolve()
    expect((await first).exitCode).toBe(0)
    expect(harness.transport.requests).toStrictEqual([expectedStatusRequest()])
  })

  it("detects credential generation drift in the production fence with zero POST", async () => {
    const secondReadEntered = deferred()
    const releaseSecondRead = deferred()
    const harness = await createHarness(() => {
      throw new Error("credential drift must not reach transport")
    })
    harness.keychain.beforeRead = async (count) => {
      if (count !== 2) return
      secondReadEntered.resolve()
      await releaseSecondRead.promise
    }

    const running = runJson(harness.runtime, [
      "ads",
      "campaigns",
      "status",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--set",
      "enable",
      "--idempotency-key",
      KEY,
    ])
    await secondReadEntered.promise
    await harness.runtime.state.withAuthLock(() =>
      harness.runtime.state.writeTokenIndex({
        ...harness.index,
        generation: "77777777-7777-4777-8777-777777777777",
      })
    )
    releaseSecondRead.resolve()

    const result = await running
    expect(result.exitCode).toBe(4)
    expect(result.envelope).toMatchObject({
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        retryable: true,
        details: { localStateChanged: true },
      },
    })
    expect(harness.transport.requests).toHaveLength(0)
    expect(await harness.runtime.pendingRepository.read(KEY)).toMatchObject({
      kind: "found",
      record: { localState: "prepared" },
    })
    expect(
      [...result.stdout.values, ...result.stderr.values].join("")
    ).not.toContain(OWNER_SESSION_TOKEN)
  })
})
