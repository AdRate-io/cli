import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthService } from "../src/auth/auth-service.js"
import { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import { CliApplication } from "../src/application.js"
import { ReadCommandService } from "../src/commands/read-service.js"
import { PublicHttpClient } from "../src/http/client.js"
import { runCli } from "../src/runner.js"
import { CredentialStore } from "../src/storage/credential-backend.js"
import { createCliPaths } from "../src/storage/paths.js"
import { SecureFileSystem } from "../src/storage/secure-files.js"
import { parseLogoutDeliveryJournal } from "../src/storage/schemas.js"
import { CliStateStore } from "../src/storage/state-store.js"
import {
  CREDENTIAL_ID,
  OWNER_SESSION_TOKEN,
  createTemporaryStateFixture,
  validCredentialMetadata,
  validLogoutDeliveryJournal,
  validTokenIndex,
} from "./helpers.js"
import type {
  LogoutDeliveryJournal,
  TokenStorageKind,
} from "../src/storage/schemas.js"
import type {
  CredentialAddress,
  CredentialBackend,
} from "../src/storage/credential-backend.js"
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/http/client.js"
import type { AcknowledgedOutputStream } from "../src/output.js"
import type { TemporaryStateFixture } from "./helpers.js"

const NOW = Date.parse("2026-07-31T08:00:00.000Z")
const REQUEST_ID = "logout_delivery_request_1"

function addressKey(address: CredentialAddress): string {
  return `${address.issuerOrigin}|${address.credentialKind}|${address.credentialId}`
}

class MemoryCredentialBackend implements CredentialBackend {
  readonly values = new Map<string, string>()
  removeFailures = 0

  constructor(readonly kind: TokenStorageKind) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true)
  }

  read(address: CredentialAddress): Promise<string | null> {
    return Promise.resolve(this.values.get(addressKey(address)) ?? null)
  }

  write(address: CredentialAddress, token: string): Promise<void> {
    this.values.set(addressKey(address), token)
    return Promise.resolve()
  }

  remove(address: CredentialAddress): Promise<void> {
    if (this.removeFailures > 0) {
      this.removeFailures -= 1
      return Promise.reject(new Error("simulated credential cleanup crash"))
    }
    this.values.delete(addressKey(address))
    return Promise.resolve()
  }
}

class QueueTransport implements HttpTransport {
  readonly requests: Array<HttpRequest> = []
  readonly handlers: Array<
    (input: HttpRequest) => Promise<HttpResponse> | HttpResponse
  > = []

  request(input: HttpRequest): Promise<HttpResponse> {
    this.requests.push(input)
    const handler = this.handlers.shift()
    if (!handler) {
      return Promise.reject(new Error(`Unexpected request: ${input.path}`))
    }
    return Promise.resolve(handler(input))
  }

  enqueue(
    handler: (input: HttpRequest) => Promise<HttpResponse> | HttpResponse
  ): void {
    this.handlers.push(handler)
  }
}

class AutoCallbackStream implements AcknowledgedOutputStream {
  readonly values: Array<string> = []
  private writes = 0

  constructor(private readonly failAtWrite: number | null = null) {}

  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.values.push(value)
    this.writes += 1
    const error =
      this.failAtWrite === this.writes
        ? new Error("simulated output callback crash")
        : null
    queueMicrotask(() => callback(error))
    return true
  }
}

class ControlledCallbackStream implements AcknowledgedOutputStream {
  readonly values: Array<string> = []
  readonly callbacks: Array<(error?: Error | null) => void> = []

  write(value: string, callback: (error?: Error | null) => void): boolean {
    this.values.push(value)
    this.callbacks.push(callback)
    return false
  }

  completeNext(error?: Error): void {
    const callback = this.callbacks.shift()
    if (!callback) throw new Error("No pending output callback")
    callback(error)
  }
}

interface RuntimeHarness {
  state: CliStateStore
  local: LocalCredentialCoordinator
  auth: AuthService
  application: CliApplication
  transport: QueueTransport
}

interface SharedHarness {
  fixture: TemporaryStateFixture
  keychain: MemoryCredentialBackend
  fallback: MemoryCredentialBackend
  createRuntime: (transport?: QueueTransport) => RuntimeHarness
}

const fixtures: Array<TemporaryStateFixture> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

async function createHarness(): Promise<SharedHarness> {
  const fixture = await createTemporaryStateFixture()
  fixtures.push(fixture)
  const keychain = new MemoryCredentialBackend("keychain")
  const fallback = new MemoryCredentialBackend("fallback_file")
  const createRuntime = (transport = new QueueTransport()): RuntimeHarness => {
    const fileSystem = new SecureFileSystem({ root: fixture.root })
    const state = new CliStateStore(fileSystem, createCliPaths(fixture.root))
    const credentials = new CredentialStore(keychain, fallback)
    const local = new LocalCredentialCoordinator(state, credentials, {
      now: () => new Date(NOW),
    })
    const http = new PublicHttpClient(transport)
    const auth = new AuthService({
      http,
      local,
      now: () => new Date(NOW),
      environment: {},
    })
    return {
      state,
      local,
      auth,
      application: new CliApplication(
        auth,
        new ReadCommandService(http, local, {}),
        {
          campaignStatus: { status: vi.fn() },
          commandQuery: { get: vi.fn() },
          pendingCommands: { pending: vi.fn() },
          commandResume: { resume: vi.fn() },
          skills: { list: vi.fn(), read: vi.fn() },
        }
      ),
      transport,
    }
  }
  return { fixture, keychain, fallback, createRuntime }
}

async function installCredential(
  shared: SharedHarness,
  runtime: RuntimeHarness
): Promise<void> {
  let index = validTokenIndex()
  await runtime.state.withAuthLock(async () => {
    const config = await runtime.state.ensureConfig("production")
    index = validTokenIndex({ clientInstanceId: config.clientInstanceId })
    await runtime.state.writeTokenIndex(index)
    await runtime.state.writeCredentials(
      validCredentialMetadata({ clientInstanceId: config.clientInstanceId })
    )
  })
  await shared.keychain.write(
    runtime.local.credentials.addressFor(index),
    OWNER_SESSION_TOKEN
  )
}

function response(
  input: HttpRequest,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): HttpResponse {
  const requestId = input.requestId ?? REQUEST_ID
  return {
    status,
    text: JSON.stringify(body),
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      ...headers,
    },
    requestId,
  }
}

function credentialNotice(): Record<string, unknown> {
  return {
    level: "warning",
    reasons: ["idle_expiring"],
    absoluteExpiresAt: "2026-10-29T08:00:00.000Z",
    idleExpiresAt: "2026-08-01T08:00:00.000Z",
    absoluteRemainingDays: 90,
    idleRemainingDays: 1,
    suggestedAction: "keep_session_active",
    resolutionUrl: "https://app.adrate.io/settings/security",
    message:
      "This CLI credential is nearing its idle timeout. Use it soon to keep the session active.",
  }
}

function enqueueError(
  transport: QueueTransport,
  input: {
    code: "INVALID_REQUEST" | "RATE_LIMITED" | "DEPENDENCY_UNAVAILABLE"
    status: 400 | 429 | 503
    retryable: boolean
    retryAfterSeconds?: number
    withCredentialNotice?: boolean
  }
): void {
  transport.enqueue((request) =>
    response(
      request,
      input.status,
      {
        ok: false,
        error: {
          code: input.code,
          message: "server response message must not enter the journal",
          retryable: input.retryable,
          details: {
            serverDetailMarker: "raw response details must not enter journal",
          },
        },
        meta: {
          requestId: request.requestId ?? REQUEST_ID,
          apiVersion: "v1",
          ...(input.withCredentialNotice
            ? { _notice: { credential: credentialNotice() } }
            : {}),
        },
      },
      input.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(input.retryAfterSeconds) }
    )
  )
}

function enqueueSuccess(
  transport: QueueTransport,
  status: number,
  data: Record<string, unknown>
): void {
  transport.enqueue((request) =>
    response(request, status, {
      ok: true,
      data,
      meta: {
        requestId: request.requestId ?? REQUEST_ID,
        apiVersion: "v1",
      },
    })
  )
}

function deleteCount(...transports: Array<QueueTransport>): number {
  return transports
    .flatMap((transport) => transport.requests)
    .filter((request) => request.path === "/public/v1/sessions/current").length
}

describe("strict logout response delivery journal", () => {
  it("accepts only allowlisted response facts and rejects message/details/Token fields", () => {
    const journal = validLogoutDeliveryJournal({
      phase: "outcome_recorded",
      remoteOutcome: "confirmed_not_executed",
      reason: "request_rejected",
      responseFact: {
        kind: "error",
        errorCode: "RATE_LIMITED",
        retryAfterSeconds: 17,
        credentialNotice: {
          level: "warning",
          reasons: ["idle_expiring"],
          absoluteExpiresAt: "2026-10-29T08:00:00.000Z",
          idleExpiresAt: "2026-08-01T08:00:00.000Z",
          absoluteRemainingDays: 90,
          idleRemainingDays: 1,
          suggestedAction: "keep_session_active",
          resolutionAvailable: true,
        },
      },
      recordedAt: "2026-07-31T08:00:01.000Z",
    })
    expect(parseLogoutDeliveryJournal(journal)).toEqual(journal)

    for (const forbidden of ["message", "details", "body", "Token"] as const) {
      expect(
        parseLogoutDeliveryJournal({
          ...journal,
          responseFact: {
            ...journal.responseFact,
            [forbidden]: "adr_owner_secret",
          },
        })
      ).toBeNull()
    }
    expect(
      parseLogoutDeliveryJournal({
        ...journal,
        responseFact: {
          ...journal.responseFact,
          errorCode: "DEPENDENCY_UNAVAILABLE",
        },
      })
    ).toBeNull()
  })

  it.each([
    [
      "HTTP 201",
      201,
      {
        revoked: true,
        credentialId: CREDENTIAL_ID,
        revokedAt: "2026-07-31T08:00:00.000Z",
      },
    ],
    ["empty data", 200, {}],
    [
      "revoked false",
      200,
      {
        revoked: false,
        credentialId: CREDENTIAL_ID,
        revokedAt: "2026-07-31T08:00:00.000Z",
      },
    ],
    [
      "wrong credential id",
      200,
      {
        revoked: true,
        credentialId: "99999999-9999-4999-8999-999999999999",
        revokedAt: "2026-07-31T08:00:00.000Z",
      },
    ],
    [
      "noncanonical revokedAt",
      200,
      {
        revoked: true,
        credentialId: CREDENTIAL_ID,
        revokedAt: "2026-07-31T16:00:00+08:00",
      },
    ],
    [
      "extra data key",
      200,
      {
        revoked: true,
        credentialId: CREDENTIAL_ID,
        revokedAt: "2026-07-31T08:00:00.000Z",
        message: "must not be trusted or persisted",
      },
    ],
  ] as const)(
    "treats endpoint-level malformed logout success %s as unknown through the real entry",
    async (_caseName, status, data) => {
      const shared = await createHarness()
      const runtime = shared.createRuntime()
      await installCredential(shared, runtime)
      enqueueSuccess(runtime.transport, status, data)

      await expect(
        runCli(
          runtime.application,
          ["auth", "logout", "--json", "--request-id", REQUEST_ID],
          {
            stdout: new AutoCallbackStream(1),
            stderr: new AutoCallbackStream(),
          }
        )
      ).resolves.toBe(5)
      expect(deleteCount(runtime.transport)).toBe(1)
      expect(await runtime.state.readTokenIndex()).toBeNull()
      expect(shared.keychain.values.size).toBe(0)
      expect(await runtime.state.readLogoutDeliveryJournal()).toMatchObject({
        phase: "outcome_recorded",
        remoteOutcome: "unknown",
        reason: "ambiguous_response",
        responseFact: {
          kind: "success",
          errorCode: null,
          retryAfterSeconds: null,
        },
      })
      const persisted = await readFile(
        runtime.state.paths.logoutDeliveryJournal,
        "utf8"
      )
      expect(persisted).not.toContain("must not be trusted")
      expect(persisted).not.toContain('"data"')
      expect(persisted).not.toContain('"message"')
      expect(persisted).not.toContain(OWNER_SESSION_TOKEN)

      const replay = shared.createRuntime()
      await expect(
        runCli(
          replay.application,
          ["auth", "logout", "--json", "--request-id", REQUEST_ID],
          {
            stdout: new AutoCallbackStream(),
            stderr: new AutoCallbackStream(),
          }
        )
      ).resolves.toBe(5)
      expect(deleteCount(runtime.transport, replay.transport)).toBe(1)
      expect(await replay.state.readLogoutDeliveryJournal()).toBeNull()
    }
  )

  it("confirms revocation only for the exact HTTP 200 endpoint DTO", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    enqueueSuccess(runtime.transport, 200, {
      revoked: true,
      credentialId: CREDENTIAL_ID,
      revokedAt: "2026-07-31T08:00:00.000Z",
    })

    const stdout = new AutoCallbackStream()
    await expect(
      runCli(
        runtime.application,
        ["auth", "logout", "--json", "--request-id", REQUEST_ID],
        { stdout, stderr: new AutoCallbackStream() }
      )
    ).resolves.toBe(0)
    expect(stdout.values.join("")).toContain(
      '"remoteOutcome":"confirmed_inactive"'
    )
    expect(deleteCount(runtime.transport)).toBe(1)
    expect(await runtime.state.readLogoutDeliveryJournal()).toBeNull()
  })

  it("treats an empty HTTP success body as unknown and never repeats DELETE", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    runtime.transport.enqueue((request) => ({
      status: 200,
      text: "",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": request.requestId ?? REQUEST_ID,
      },
      requestId: request.requestId ?? REQUEST_ID,
    }))

    await expect(
      runCli(
        runtime.application,
        ["auth", "logout", "--json", "--request-id", REQUEST_ID],
        {
          stdout: new AutoCallbackStream(1),
          stderr: new AutoCallbackStream(),
        }
      )
    ).resolves.toBe(5)
    expect(await runtime.state.readLogoutDeliveryJournal()).toMatchObject({
      phase: "outcome_recorded",
      remoteOutcome: "unknown",
      reason: "transport_unknown",
      responseFact: null,
    })
    expect(await runtime.state.readTokenIndex()).toBeNull()
    expect(deleteCount(runtime.transport)).toBe(1)

    const recovery = shared.createRuntime()
    const replay = await recovery.auth.logout({
      json: true,
      noInput: true,
      verbose: false,
      test: false,
      requestId: REQUEST_ID,
    })
    expect(replay.exitCode).toBe(5)
    expect(deleteCount(runtime.transport, recovery.transport)).toBe(1)
    await replay.postRenderAcknowledgement?.acknowledge()
    expect(await recovery.state.readLogoutDeliveryJournal()).toBeNull()
  })

  // PublicRuntime consumes the body and current-session parseInput runs before
  // the DELETE handler. That real route can only produce INVALID_REQUEST or
  // RATE_LIMITED before revocation, so these are the complete trusted allowlist.
  it("persists a proven pre-handler rejection, preserves the credential, and waits for every real write callback before ack", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    await runtime.state.fileSystem.atomicWrite(
      join(runtime.state.paths.pendingCommands, "pending.json"),
      "{}\n"
    )
    enqueueError(runtime.transport, {
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
      retryAfterSeconds: 17,
      withCredentialNotice: true,
    })
    const stdout = new ControlledCallbackStream()
    const stderr = new ControlledCallbackStream()
    const running = runCli(
      runtime.application,
      ["auth", "logout", "--request-id", REQUEST_ID],
      { stdout, stderr }
    )

    await vi.waitFor(() => expect(stderr.callbacks).toHaveLength(1))
    expect(await runtime.state.readLogoutDeliveryJournal()).toMatchObject({
      phase: "outcome_recorded",
      remoteOutcome: "confirmed_not_executed",
      reason: "request_rejected",
      responseFact: {
        kind: "error",
        errorCode: "RATE_LIMITED",
        retryAfterSeconds: 17,
        credentialNotice: { reasons: ["idle_expiring"] },
      },
    })
    expect(await runtime.state.readTokenIndex()).not.toBeNull()
    expect(shared.keychain.values.size).toBe(1)
    expect(deleteCount(runtime.transport)).toBe(1)

    // human error + suggested action + Retry-After + credential + pending warning
    for (let write = 0; write < 5; write += 1) {
      await vi.waitFor(() => expect(stderr.callbacks).toHaveLength(1))
      if (write < 4) {
        expect(await runtime.state.readLogoutDeliveryJournal()).not.toBeNull()
      }
      stderr.completeNext()
    }
    await expect(running).resolves.toBe(4)
    expect(stdout.values).toEqual([])
    expect(await runtime.state.readLogoutDeliveryJournal()).toBeNull()
    expect(await runtime.state.readTokenIndex()).not.toBeNull()
    expect(shared.keychain.values.size).toBe(1)
    const warnings = stderr.values.filter((value) =>
      value.startsWith("Warning:")
    )
    expect(new Set(warnings).size).toBe(warnings.length)
  })

  it("replays the other proven pre-handler INVALID_REQUEST without repeating DELETE", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    enqueueError(runtime.transport, {
      code: "INVALID_REQUEST",
      status: 400,
      retryable: false,
    })

    const rejected = await runtime.auth.logout({
      json: true,
      noInput: true,
      verbose: false,
      test: false,
      requestId: REQUEST_ID,
    })
    expect(rejected.exitCode).toBe(2)
    expect(await runtime.state.readLogoutDeliveryJournal()).toMatchObject({
      phase: "outcome_recorded",
      remoteOutcome: "confirmed_not_executed",
      reason: "request_rejected",
      responseFact: {
        kind: "error",
        errorCode: "INVALID_REQUEST",
      },
    })
    expect(await runtime.state.readTokenIndex()).not.toBeNull()
    expect(shared.keychain.values.size).toBe(1)

    const replayTransport = new QueueTransport()
    const replay = shared.createRuntime(replayTransport)
    const replayed = await replay.auth.logout({
      json: true,
      noInput: true,
      verbose: false,
      test: false,
      requestId: REQUEST_ID,
    })
    expect(replayed.exitCode).toBe(2)
    expect(deleteCount(runtime.transport, replayTransport)).toBe(1)
    expect(await replay.state.readTokenIndex()).not.toBeNull()
    await replayed.postRenderAcknowledgement?.acknowledge()
    expect(await replay.state.readLogoutDeliveryJournal()).toBeNull()
  })

  it.each(["before_record", "after_record"] as const)(
    "recovers an ambiguous 503 response crash %s with zero repeated DELETE",
    async (crashPoint) => {
      const shared = await createHarness()
      const runtime = shared.createRuntime()
      await installCredential(shared, runtime)
      enqueueError(runtime.transport, {
        code: "DEPENDENCY_UNAVAILABLE",
        status: 503,
        retryable: true,
        retryAfterSeconds: 23,
        withCredentialNotice: true,
      })

      const original = runtime.state.writeLogoutDeliveryJournal.bind(
        runtime.state
      )
      let injected = false
      runtime.state.writeLogoutDeliveryJournal = async (journal) => {
        if (
          !injected &&
          journal.phase === "outcome_recorded" &&
          crashPoint === "before_record"
        ) {
          injected = true
          throw new Error("simulated response-before-journal crash")
        }
        await original(journal)
        if (
          !injected &&
          journal.phase === "outcome_recorded" &&
          crashPoint === "after_record"
        ) {
          injected = true
          throw new Error("simulated response-after-journal crash")
        }
      }

      await expect(
        runtime.auth.logout({
          json: true,
          noInput: true,
          verbose: false,
          test: false,
          requestId: REQUEST_ID,
        })
      ).rejects.toThrow("simulated response-")
      runtime.state.writeLogoutDeliveryJournal = original
      expect(deleteCount(runtime.transport)).toBe(1)

      const replayTransport = new QueueTransport()
      const replay = shared.createRuntime(replayTransport)
      const outcome = await replay.auth.logout({
        json: true,
        noInput: true,
        verbose: false,
        test: false,
        requestId: REQUEST_ID,
      })
      expect(outcome).toMatchObject({
        exitCode: 5,
        envelope: {
          error: {
            details: {
              remoteOutcome: "unknown",
              localCleanupFailed: false,
            },
          },
        },
      })
      expect(deleteCount(runtime.transport, replayTransport)).toBe(1)
      expect(await replay.state.readTokenIndex()).toBeNull()
      expect(shared.keychain.values.size).toBe(0)
      await outcome.postRenderAcknowledgement?.acknowledge()
      expect(await replay.state.readLogoutDeliveryJournal()).toBeNull()
    }
  )

  it("keeps an ambiguous response journal across cleanup failure and resumes without DELETE", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    shared.keychain.removeFailures = 1
    enqueueError(runtime.transport, {
      code: "DEPENDENCY_UNAVAILABLE",
      status: 503,
      retryable: true,
      retryAfterSeconds: 31,
      withCredentialNotice: true,
    })

    const failedCleanup = await runtime.auth.logout({
      json: true,
      noInput: true,
      verbose: false,
      test: false,
      requestId: REQUEST_ID,
    })
    expect(failedCleanup).toMatchObject({
      exitCode: 5,
      envelope: {
        error: {
          details: {
            remoteOutcome: "unknown",
            localCleanupFailed: true,
          },
        },
      },
    })
    expect(failedCleanup.postRenderAcknowledgement).toBeUndefined()
    expect(await runtime.state.readLogoutDeliveryJournal()).toMatchObject({
      reason: "ambiguous_response",
      responseFact: {
        errorCode: "DEPENDENCY_UNAVAILABLE",
        retryAfterSeconds: 31,
      },
    })

    const replayTransport = new QueueTransport()
    const replay = shared.createRuntime(replayTransport)
    const recovered = await replay.auth.logout({
      json: true,
      noInput: true,
      verbose: false,
      test: false,
      requestId: REQUEST_ID,
    })
    expect(recovered.exitCode).toBe(5)
    expect(deleteCount(runtime.transport, replayTransport)).toBe(1)
    expect(recovered.warnings).toEqual(
      expect.arrayContaining([
        "Retry after 31 second(s) before repeating this request.",
        "This CLI credential is nearing its idle timeout. Use it soon to keep the session active.",
      ])
    )
    await recovered.postRenderAcknowledgement?.acknowledge()
    expect(await replay.state.readLogoutDeliveryJournal()).toBeNull()
  })

  it("runs real AuthService -> CliApplication -> runCli and replays after a write callback crash without DELETE", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    enqueueError(runtime.transport, {
      code: "DEPENDENCY_UNAVAILABLE",
      status: 503,
      retryable: true,
      retryAfterSeconds: 29,
      withCredentialNotice: true,
    })
    const failedStdout = new AutoCallbackStream(1)
    const firstStderr = new AutoCallbackStream()
    await expect(
      runCli(
        runtime.application,
        ["auth", "logout", "--json", "--request-id", REQUEST_ID],
        { stdout: failedStdout, stderr: firstStderr }
      )
    ).resolves.toBe(5)
    expect(await runtime.state.readLogoutDeliveryJournal()).not.toBeNull()
    expect(deleteCount(runtime.transport)).toBe(1)

    const replayTransport = new QueueTransport()
    const replay = shared.createRuntime(replayTransport)
    const replayStdout = new AutoCallbackStream()
    const replayStderr = new AutoCallbackStream()
    await expect(
      runCli(
        replay.application,
        ["auth", "logout", "--json", "--request-id", REQUEST_ID],
        { stdout: replayStdout, stderr: replayStderr }
      )
    ).resolves.toBe(5)
    expect(deleteCount(runtime.transport, replayTransport)).toBe(1)
    expect(replayStdout.values.join("")).toContain('"remoteOutcome":"unknown"')
    expect(await replay.state.readLogoutDeliveryJournal()).toBeNull()
  })

  it.each(["before_phase_write", "after_phase_write"] as const)(
    "recovers acknowledgement crash %s without replaying DELETE",
    async (crashPoint) => {
      const shared = await createHarness()
      const runtime = shared.createRuntime()
      await installCredential(shared, runtime)
      enqueueError(runtime.transport, {
        code: "RATE_LIMITED",
        status: 429,
        retryable: true,
        retryAfterSeconds: 19,
      })
      const originalWrite = runtime.state.writeLogoutDeliveryJournal.bind(
        runtime.state
      )
      let failed = false
      runtime.state.writeLogoutDeliveryJournal = async (journal) => {
        if (
          !failed &&
          journal.phase === "output_acknowledged" &&
          crashPoint === "before_phase_write"
        ) {
          failed = true
          throw new Error("simulated crash before acknowledgement phase")
        }
        await originalWrite(journal)
        if (
          !failed &&
          journal.phase === "output_acknowledged" &&
          crashPoint === "after_phase_write"
        ) {
          failed = true
          throw new Error("simulated crash after acknowledgement phase")
        }
      }

      await expect(
        runCli(
          runtime.application,
          ["auth", "logout", "--json", "--request-id", REQUEST_ID],
          {
            stdout: new AutoCallbackStream(),
            stderr: new AutoCallbackStream(),
          }
        )
      ).resolves.toBe(4)
      expect(await runtime.state.readLogoutDeliveryJournal()).toMatchObject({
        phase:
          crashPoint === "before_phase_write"
            ? "outcome_recorded"
            : "output_acknowledged",
      })
      expect(await runtime.state.readTokenIndex()).not.toBeNull()
      runtime.state.writeLogoutDeliveryJournal = originalWrite

      const recovery = shared.createRuntime()
      const stdout = new AutoCallbackStream()
      await expect(
        runCli(
          recovery.application,
          ["auth", "logout", "--json", "--request-id", REQUEST_ID],
          { stdout, stderr: new AutoCallbackStream() }
        )
      ).resolves.toBe(4)
      expect(deleteCount(runtime.transport, recovery.transport)).toBe(1)
      expect(await recovery.state.readLogoutDeliveryJournal()).toBeNull()
      expect(await recovery.state.readTokenIndex()).not.toBeNull()
      expect(stdout.values.join("")).toContain(
        crashPoint === "before_phase_write"
          ? '"remoteOutcome":"confirmed_not_executed"'
          : '"logoutDeliveryFinalized":true'
      )
    }
  )

  it.each(["before_delete", "after_delete"] as const)(
    "keeps output acknowledgement authoritative across %s crash",
    async (crashPoint) => {
      const shared = await createHarness()
      const runtime = shared.createRuntime()
      await installCredential(shared, runtime)
      enqueueError(runtime.transport, {
        code: "RATE_LIMITED",
        status: 429,
        retryable: true,
        retryAfterSeconds: 19,
      })
      const originalClear = runtime.state.clearLogoutDeliveryJournal.bind(
        runtime.state
      )
      runtime.state.clearLogoutDeliveryJournal = async () => {
        if (crashPoint === "before_delete") {
          throw new Error("simulated crash before journal deletion")
        }
        await originalClear()
        throw new Error("simulated crash after journal deletion")
      }

      await expect(
        runCli(
          runtime.application,
          ["auth", "logout", "--json", "--request-id", REQUEST_ID],
          {
            stdout: new AutoCallbackStream(),
            stderr: new AutoCallbackStream(),
          }
        )
      ).resolves.toBe(4)
      expect(await runtime.state.readLogoutDeliveryJournal()).toEqual(
        crashPoint === "before_delete"
          ? expect.objectContaining({ phase: "output_acknowledged" })
          : null
      )
      runtime.state.clearLogoutDeliveryJournal = originalClear

      if (crashPoint === "before_delete") {
        const recovery = shared.createRuntime()
        await expect(
          runCli(recovery.application, ["auth", "status", "--json"], {
            stdout: new AutoCallbackStream(),
            stderr: new AutoCallbackStream(),
          })
        ).resolves.toBe(4)
        expect(await recovery.state.readLogoutDeliveryJournal()).toBeNull()
        expect(deleteCount(runtime.transport, recovery.transport)).toBe(1)
      }
    }
  )

  it("never reports acknowledgement failure after unlink succeeds but directory fsync fails", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    enqueueError(runtime.transport, {
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
      retryAfterSeconds: 19,
    })
    const stdout = new ControlledCallbackStream()
    const stderr = new ControlledCallbackStream()
    const running = runCli(
      runtime.application,
      ["auth", "logout", "--json", "--request-id", REQUEST_ID],
      { stdout, stderr }
    )
    await vi.waitFor(() => expect(stdout.callbacks).toHaveLength(1))

    const fileSystem = runtime.state.fileSystem as unknown as {
      syncDirectory: (path: string) => Promise<void>
    }
    const originalSync = fileSystem.syncDirectory.bind(fileSystem)
    let syncCalls = 0
    let failedAfterUnlink = false
    fileSystem.syncDirectory = async (path) => {
      await originalSync(path)
      syncCalls += 1
      if (syncCalls === 2) {
        failedAfterUnlink = true
        throw new Error("simulated directory fsync failure after unlink")
      }
    }
    stdout.completeNext()
    await vi.waitFor(() => expect(stderr.callbacks).toHaveLength(1))
    stderr.completeNext()

    await expect(running).resolves.toBe(4)
    expect(failedAfterUnlink).toBe(true)
    expect(syncCalls).toBeGreaterThanOrEqual(2)
    expect(await runtime.state.readLogoutDeliveryJournal()).toBeNull()
    expect(deleteCount(runtime.transport)).toBe(1)
  })

  it.each([
    ["status", ["auth", "status", "--json"]],
    ["whoami", ["auth", "whoami", "--json"]],
    ["login", ["auth", "login", "--resume", "--json"]],
    ["logout", ["auth", "logout", "--json"]],
  ] as const)(
    "lets auth %s only finalize an acknowledged logout before any handler",
    async (_command, argv) => {
      const shared = await createHarness()
      const runtime = shared.createRuntime()
      await installCredential(shared, runtime)
      enqueueError(runtime.transport, {
        code: "RATE_LIMITED",
        status: 429,
        retryable: true,
        retryAfterSeconds: 19,
      })
      await runtime.auth.logout({
        json: true,
        noInput: true,
        verbose: false,
        test: false,
        requestId: REQUEST_ID,
      })
      const outcome = await runtime.state.readLogoutDeliveryJournal()
      if (!outcome || outcome.phase !== "outcome_recorded") {
        throw new Error("Expected a recorded logout outcome")
      }
      await runtime.state.withAuthLock(() =>
        runtime.state.writeLogoutDeliveryJournal({
          ...outcome,
          phase: "output_acknowledged",
        })
      )

      const recovery = shared.createRuntime()
      const stdout = new AutoCallbackStream()
      await expect(
        runCli(recovery.application, argv, {
          stdout,
          stderr: new AutoCallbackStream(),
        })
      ).resolves.toBe(4)
      expect(stdout.values.join("")).toContain('"logoutDeliveryFinalized":true')
      expect(deleteCount(runtime.transport, recovery.transport)).toBe(1)
      expect(recovery.transport.requests).toHaveLength(0)
      expect(await recovery.state.readLogoutDeliveryJournal()).toBeNull()
      expect(await recovery.state.readTokenIndex()).not.toBeNull()
    }
  )

  it("finalizes an old acknowledged journal without pruning a replacement generation", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    enqueueError(runtime.transport, {
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
      retryAfterSeconds: 19,
    })
    await runtime.auth.logout({
      json: true,
      noInput: true,
      verbose: false,
      test: false,
      requestId: REQUEST_ID,
    })
    const outcome = await runtime.state.readLogoutDeliveryJournal()
    const oldIndex = await runtime.state.readTokenIndex()
    if (!outcome || outcome.phase !== "outcome_recorded" || !oldIndex) {
      throw new Error("Expected a recorded logout outcome and Token index")
    }
    const replacementGeneration = "99999999-9999-4999-8999-999999999999"
    await runtime.state.withAuthLock(async () => {
      await runtime.state.writeTokenIndex({
        ...oldIndex,
        generation: replacementGeneration,
      })
      await runtime.state.writeLogoutDeliveryJournal({
        ...outcome,
        phase: "output_acknowledged",
      })
    })
    await shared.keychain.write(
      runtime.local.credentials.addressFor(oldIndex),
      "replacement_token"
    )

    const recovery = shared.createRuntime()
    await expect(
      runCli(recovery.application, ["auth", "logout", "--json"], {
        stdout: new AutoCallbackStream(),
        stderr: new AutoCallbackStream(),
      })
    ).resolves.toBe(4)
    expect(await recovery.state.readLogoutDeliveryJournal()).toBeNull()
    expect(await recovery.state.readTokenIndex()).toMatchObject({
      generation: replacementGeneration,
    })
    await expect(
      shared.keychain.read(runtime.local.credentials.addressFor(oldIndex))
    ).resolves.toBe("replacement_token")
    expect(deleteCount(runtime.transport, recovery.transport)).toBe(1)
  })

  it("writes only strict allowlist facts with secure permissions", async () => {
    const shared = await createHarness()
    const runtime = shared.createRuntime()
    await installCredential(shared, runtime)
    enqueueError(runtime.transport, {
      code: "DEPENDENCY_UNAVAILABLE",
      status: 503,
      retryable: true,
      retryAfterSeconds: 37,
      withCredentialNotice: true,
    })
    shared.keychain.removeFailures = 1
    await runtime.auth.logout({
      json: true,
      noInput: true,
      verbose: false,
      test: false,
      requestId: REQUEST_ID,
    })

    const text = await readFile(
      runtime.state.paths.logoutDeliveryJournal,
      "utf8"
    )
    expect(text).not.toContain(OWNER_SESSION_TOKEN)
    expect(text).not.toContain("server response message")
    expect(text).not.toContain("raw response details")
    expect(text).not.toContain('"message"')
    expect(text).not.toContain('"details"')
    expect(text).not.toContain('"body"')
    expect(text).not.toContain('"Token"')
    expect(text).toContain('"errorCode": "DEPENDENCY_UNAVAILABLE"')
    expect(
      (await stat(runtime.state.paths.logoutDeliveryJournal)).mode & 0o777
    ).toBe(0o600)
  })
})
