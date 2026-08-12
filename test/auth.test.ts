import { chmod, mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthService } from "../src/auth/auth-service.js"
import { AuthCleanupCoordinator } from "../src/auth/auth-cleanup-coordinator.js"
import { DevicePollCoordinator } from "../src/auth/device-poll-coordinator.js"
import { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import { CliApplication } from "../src/application.js"
import { CLI_SCOPE } from "../src/constants.js"
import { HttpTransportError, PublicHttpClient } from "../src/http/client.js"
import { renderOutcome } from "../src/output.js"
import { runCli } from "../src/runner.js"
import { CredentialStore } from "../src/storage/credential-backend.js"
import { createCliPaths } from "../src/storage/paths.js"
import { SecureFileSystem } from "../src/storage/secure-files.js"
import { CliStateStore } from "../src/storage/state-store.js"
import { CliFailure } from "../src/errors.js"
import type { CliOutcome } from "../src/errors.js"
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/http/client.js"
import type {
  CredentialAddress,
  CredentialBackend,
} from "../src/storage/credential-backend.js"
import type {
  DeviceAuthorizationState,
  DevicePollAttempt,
  TokenIndex,
  TokenStorageKind,
} from "../src/storage/schemas.js"

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111"
const CLIENT_INSTANCE_ID = "22222222-2222-4222-8222-222222222222"
const TOKEN_GENERATION = "33333333-3333-4333-8333-333333333333"
const DEVICE_GENERATION = "44444444-4444-4444-8444-444444444444"
const DEVICE_CODE = "A".repeat(43)
const TOKEN = `adr_owner_${CREDENTIAL_ID}_${"A".repeat(43)}`
const NOW = Date.parse("2026-07-31T02:00:00.000Z")

const GLOBAL = Object.freeze({
  json: true,
  noInput: true,
  verbose: false,
  test: false,
})

class MemoryCredentialBackend implements CredentialBackend {
  readonly values = new Map<string, string>()
  available = true
  readError: Error | null = null
  availabilityChecks = 0
  reads = 0
  writes = 0
  removes = 0
  onRead: ((address: CredentialAddress) => Promise<void>) | null = null
  onWrite:
    | ((address: CredentialAddress, token: string) => Promise<void>)
    | null = null
  onRemove: ((address: CredentialAddress) => Promise<void>) | null = null

  constructor(readonly kind: TokenStorageKind) {}

  isAvailable(): Promise<boolean> {
    this.availabilityChecks += 1
    return Promise.resolve(this.available)
  }

  async read(address: CredentialAddress): Promise<string | null> {
    this.reads += 1
    if (this.onRead) await this.onRead(address)
    if (this.readError) throw this.readError
    return this.values.get(addressKey(address)) ?? null
  }

  async write(address: CredentialAddress, token: string): Promise<void> {
    this.writes += 1
    if (this.onWrite) await this.onWrite(address, token)
    this.values.set(addressKey(address), token)
  }

  async remove(address: CredentialAddress): Promise<void> {
    this.removes += 1
    if (this.onRemove) await this.onRemove(address)
    this.values.delete(addressKey(address))
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
    if (!handler) throw new Error(`Unexpected request: ${input.path}`)
    return Promise.resolve(handler(input))
  }

  enqueue(
    handler: (input: HttpRequest) => Promise<HttpResponse> | HttpResponse
  ): void {
    this.handlers.push(handler)
  }
}

interface Harness {
  root: string
  now: { value: number }
  state: CliStateStore
  local: LocalCredentialCoordinator
  keychain: MemoryCredentialBackend
  fallback: MemoryCredentialBackend
  transport: QueueTransport
  auth: AuthService
  sleepCalls: { value: number }
}

const roots: Array<string> = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  }
})

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "adrate-cli-auth-"))
  roots.push(root)
  await chmod(root, 0o700)
  const paths = createCliPaths(root)
  const fileSystem = new SecureFileSystem({ root })
  const state = new CliStateStore(fileSystem, paths)
  const keychain = new MemoryCredentialBackend("keychain")
  const fallback = new MemoryCredentialBackend("fallback_file")
  const credentials = new CredentialStore(keychain, fallback)
  const transport = new QueueTransport()
  const now = { value: NOW }
  const sleepCalls = { value: 0 }
  const local = new LocalCredentialCoordinator(state, credentials, {
    now: () => new Date(now.value),
  })
  const auth = new AuthService({
    http: new PublicHttpClient(transport),
    local,
    now: () => new Date(now.value),
    sleep: () => {
      sleepCalls.value += 1
      return Promise.resolve()
    },
  })
  return {
    root,
    now,
    state,
    local,
    keychain,
    fallback,
    transport,
    auth,
    sleepCalls,
  }
}

function createPeer(
  harness: Harness,
  transport = new QueueTransport()
): Harness {
  const paths = createCliPaths(harness.root)
  const state = new CliStateStore(
    new SecureFileSystem({ root: harness.root }),
    paths
  )
  const local = new LocalCredentialCoordinator(
    state,
    new CredentialStore(harness.keychain, harness.fallback),
    {
      now: () => new Date(harness.now.value),
    }
  )
  return {
    ...harness,
    state,
    local,
    transport,
    auth: new AuthService({
      http: new PublicHttpClient(transport),
      local,
      now: () => new Date(harness.now.value),
      sleep: () => {
        harness.sleepCalls.value += 1
        return Promise.resolve()
      },
    }),
  }
}

function gate<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function addressKey(address: CredentialAddress): string {
  return `${address.issuerOrigin}|${address.credentialKind}|${address.credentialId}`
}

function response(
  input: HttpRequest,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): HttpResponse {
  const requestId = input.requestId ?? "server_request_1"
  return {
    status,
    text: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      ...headers,
    },
    requestId,
  }
}

function captureStream(): {
  stream: Pick<NodeJS.WriteStream, "write">
  read: () => string
} {
  let output = ""
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        output +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8")
        return true
      },
    } as Pick<NodeJS.WriteStream, "write">,
    read: () => output,
  }
}

function enqueueDeviceCode(
  harness: Harness,
  beforeResponse: () => Promise<void> = () => Promise.resolve()
): void {
  harness.transport.enqueue(async (input) => {
    await beforeResponse()
    return response(input, 200, {
      device_code: DEVICE_CODE,
      user_code: "ABCD-EFGH",
      verification_uri: "https://app.adrate.io/device",
      verification_uri_complete:
        "https://app.adrate.io/device?user_code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    })
  })
}

function enqueueToken(harness: Harness): void {
  harness.transport.enqueue((input) =>
    response(input, 200, {
      access_token: TOKEN,
      token_type: "Bearer",
      expires_in: 900,
      activation_expires_at: "2026-07-31T02:10:00.000Z",
      idle_expires_at: null,
      absolute_expires_at: "2026-08-30T02:00:00.000Z",
      credential_kind: "adrate_sliding_session",
    })
  )
}

function enqueueMe(
  harness: Harness,
  options: {
    credentialId?: string
    credential?: {
      activationExpiresAt: string | null
      idleExpiresAt: string | null
      absoluteExpiresAt: string
    }
    beforeResponse?: () => Promise<void>
  } = {}
): void {
  harness.transport.enqueue(async (input) => {
    await options.beforeResponse?.()
    return response(input, 200, {
      ok: true,
      data: {
        principal: {
          kind: "owner_cli_session",
          credentialId: options.credentialId ?? CREDENTIAL_ID,
        },
        subject: { userId: 19, nickname: "Boss" },
        team: { teamId: 7, teamName: "AdRate" },
        credential: options.credential ?? {
          activationExpiresAt: null,
          idleExpiresAt: "2026-07-31T03:00:00.000Z",
          absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
        },
        capabilities: CLI_SCOPE.split(" ").map((capabilityId, index) => ({
          capabilityId,
          granted: true,
          available: true,
          unavailableReason: null,
          risk: index < 2 ? "low" : index < 4 ? "medium" : "high",
          rateClass:
            index < 2
              ? "public_read"
              : index < 4
                ? "upstream_read"
                : "public_write",
          operationUnits: index < 2 ? 0 : index < 4 ? index - 1 : 3,
          idempotencyRequired: index === 4,
        })),
        plan: {
          planType: "pro",
          benefitStatus: "normal",
          publicApiRequestsPerMinute: 60,
          publicApiRequestBurst: 10,
          publicApiWritesPerMinute: 10,
          publicApiTikTokUnitsPerDay: 3000,
        },
      },
      meta: {
        requestId: input.requestId ?? "server_request_1",
        apiVersion: "v1",
      },
    })
  })
}

function enqueuePublicError(
  harness: Harness,
  code:
    | "INVALID_CREDENTIAL"
    | "CREDENTIAL_EXPIRED"
    | "USER_DISABLED"
    | "OWNER_REQUIRED"
    | "RATE_LIMITED"
): void {
  harness.transport.enqueue((input) =>
    response(input, code === "RATE_LIMITED" ? 429 : 401, {
      ok: false,
      error: {
        code,
        message: code,
        retryable: code === "RATE_LIMITED",
        details: {},
      },
      meta: {
        requestId: input.requestId ?? "server_request_1",
        apiVersion: "v1",
      },
    })
  )
}

async function issue(harness: Harness): Promise<void> {
  enqueueDeviceCode(harness)
  const outcome = await harness.auth.login({
    global: GLOBAL,
    noWait: true,
    resume: false,
    deviceName: "test-device",
  })
  expect(outcome.exitCode).toBe(0)
}

async function installStoredCredential(
  harness: Harness,
  withMetadata = false
): Promise<TokenIndex> {
  const index: TokenIndex = {
    tokenIndexFormatVersion: 1,
    generation: TOKEN_GENERATION,
    state: "stored",
    environment: "production",
    issuerOrigin: "https://api.adrate.io",
    credentialKind: "owner_cli_session",
    credentialId: CREDENTIAL_ID,
    clientInstanceId: CLIENT_INSTANCE_ID,
    deviceGeneration: DEVICE_GENERATION,
    deviceName: "test-device",
    tokenReceivedAt: "2026-07-31T02:00:00.000Z",
    storageKind: "keychain",
  }
  await harness.state.withAuthLock(async () => {
    await harness.state.ensureConfig("production")
    const config = await harness.state.readConfig()
    expect(config).not.toBeNull()
    index.clientInstanceId = config!.clientInstanceId
    await harness.state.writeTokenIndex(index)
    if (withMetadata) {
      await harness.state.writeCredentials({
        credentialFormatVersion: 1,
        credentialKind: "owner_cli_session",
        credentialId: CREDENTIAL_ID,
        issuerOrigin: "https://api.adrate.io",
        teamId: 7,
        teamName: "AdRate",
        deviceName: "test-device",
        clientInstanceId: index.clientInstanceId,
        loggedInAt: index.tokenReceivedAt,
        cliVersion: "0.1.0",
        absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
      })
    }
  })
  await harness.keychain.write(
    harness.local.credentials.addressFor(index),
    TOKEN
  )
  return index
}

async function installLogoutCleanupFixture(harness: Harness): Promise<void> {
  await issue(harness)
  const device = (await harness.state.readDeviceState())!
  const index = await installStoredCredential(harness, true)
  index.deviceGeneration = device.generation
  await harness.state.withAuthLock(async () => {
    await harness.state.writeTokenIndex(index)
    await harness.state.writeDeviceState({
      ...device,
      localState: "token_received",
      deviceCode: null,
      userCode: null,
    })
  })
}

function injectLogoutCleanupFailure(harness: Harness): () => void {
  harness.keychain.onRemove = () =>
    Promise.reject(new Error("simulated Keychain delete crash"))
  return () => {
    harness.keychain.onRemove = null
  }
}

describe("Device Authorization", () => {
  it.each([
    {
      label: "test plus resume",
      input: {
        global: { ...GLOBAL, test: true },
        noWait: false,
        resume: true,
      },
    },
    {
      label: "resume plus device name",
      input: {
        global: GLOBAL,
        noWait: false,
        resume: true,
        deviceName: "must-not-be-ignored",
      },
    },
    {
      label: "no-wait plus resume",
      input: { global: GLOBAL, noWait: true, resume: true },
    },
    {
      label: "129-code-point device name",
      input: {
        global: GLOBAL,
        noWait: true,
        resume: false,
        deviceName: "🚀".repeat(129),
      },
    },
    {
      label: "no-input implicit wait",
      input: {
        global: { ...GLOBAL, noInput: true },
        noWait: false,
        resume: false,
      },
    },
  ])("rejects pure input $label before any lower layer", async ({ input }) => {
    const harness = await createHarness()
    await expect(harness.auth.login(input)).rejects.toMatchObject({
      exitCode: 2,
    })
    expect(harness.transport.requests).toHaveLength(0)
    expect(harness.keychain.availabilityChecks).toBe(0)
    expect(harness.fallback.availabilityChecks).toBe(0)
    expect(harness.sleepCalls.value).toBe(0)
    expect(await harness.state.readConfig()).toBeNull()
    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readDeviceIssueReservation()).toBeNull()
  })

  it.each([
    "production_device",
    "expired_device",
    "test_device",
    "stored_token",
    "credentials_only",
    "token_received",
    "expired_issue",
  ] as const)(
    "--test refuses %s instead of resuming or replacing it",
    async (stateKind) => {
      const harness = await createHarness()
      if (
        stateKind === "production_device" ||
        stateKind === "expired_device" ||
        stateKind === "token_received"
      ) {
        await issue(harness)
        if (stateKind === "expired_device") {
          harness.now.value += 601_000
        } else if (stateKind === "token_received") {
          await harness.state.withAuthLock(async () => {
            const device = (await harness.state.readDeviceState())!
            await harness.state.writeDeviceState({
              ...device,
              localState: "token_received",
              deviceCode: null,
              userCode: null,
            })
          })
        }
      } else if (stateKind === "test_device") {
        harness.transport.enqueue((input) =>
          response(input, 200, {
            device_code: DEVICE_CODE,
            user_code: "ABCD-EFGH",
            verification_uri: "https://test.adrate.io/device",
            verification_uri_complete:
              "https://test.adrate.io/device?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          })
        )
        await harness.auth.login({
          global: { ...GLOBAL, test: true },
          noWait: true,
          resume: false,
        })
      } else if (stateKind === "stored_token") {
        await installStoredCredential(harness, true)
      } else if (stateKind === "expired_issue") {
        await harness.state.withAuthLock(() =>
          harness.state.writeDeviceIssueReservation({
            formatVersion: 1,
            generation: "77777777-7777-4777-8777-777777777777",
            environment: "production",
            issuerOrigin: "https://api.adrate.io",
            clientInstanceId: CLIENT_INSTANCE_ID,
            deviceName: null,
          })
        )
      } else {
        await harness.state.withAuthLock(() =>
          harness.state.writeCredentials({
            credentialFormatVersion: 1,
            credentialKind: "owner_cli_session",
            credentialId: CREDENTIAL_ID,
            issuerOrigin: "https://api.adrate.io",
            teamId: 7,
            teamName: "AdRate",
            deviceName: "Boss-Mac",
            clientInstanceId: CLIENT_INSTANCE_ID,
            loggedInAt: "2026-07-31T02:00:00.000Z",
            cliVersion: "0.1.0",
          })
        )
      }
      const before = JSON.stringify(
        await harness.state.withAuthLock(() =>
          harness.local.readLocalSnapshotLocked()
        )
      )
      const requestCount = harness.transport.requests.length
      harness.keychain.availabilityChecks = 0
      harness.fallback.availabilityChecks = 0
      harness.sleepCalls.value = 0

      await expect(
        harness.auth.login({
          global: { ...GLOBAL, test: true },
          noWait: true,
          resume: false,
        })
      ).rejects.toMatchObject({ exitCode: 2 })

      expect(harness.transport.requests).toHaveLength(requestCount)
      expect(harness.keychain.availabilityChecks).toBe(0)
      expect(harness.fallback.availabilityChecks).toBe(0)
      expect(harness.sleepCalls.value).toBe(0)
      expect(
        JSON.stringify(
          await harness.state.withAuthLock(() =>
            harness.local.readLocalSnapshotLocked()
          )
        )
      ).toBe(before)
    }
  )

  it("issues the exact CLI scope request and never exposes device_code", async () => {
    const harness = await createHarness()
    let acquiredDuringRequest = false
    enqueueDeviceCode(harness, () =>
      harness.state.withAuthLock(() => {
        acquiredDuringRequest = true
        return Promise.resolve()
      })
    )
    const issueOutcome = await harness.auth.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
      deviceName: "test-device",
    })
    expect(issueOutcome.exitCode).toBe(0)
    expect(acquiredDuringRequest).toBe(true)

    const request = harness.transport.requests[0]!
    expect(request.path).toBe("/oauth/device/code")
    expect(request.deadlineMs).toBe(15_000)
    expect(request.form?.get("client_id")).toBe("adrate-cli")
    expect(request.form?.get("scope")).toBe(CLI_SCOPE)
    expect(request.form?.get("device_name")).toBe("test-device")
    expect(request.form?.get("client_instance_id")).toMatch(/^[0-9a-f-]{36}$/)

    const state = await harness.state.readDeviceState()
    expect(state?.deviceCode).toBe(DEVICE_CODE)
    const stateText = await readFile(harness.state.paths.deviceCurrent, "utf8")
    expect(stateText).toContain(DEVICE_CODE)
    expect((await stat(harness.state.paths.deviceCurrent)).mode & 0o777).toBe(
      0o600
    )
    const outcome = await harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    expect(outcome.exitCode).toBe(4)
    expect(harness.transport.requests).toHaveLength(1)
  })

  it("replaces orphaned issue staging with a fresh Device generation", async () => {
    const harness = await createHarness()
    const config = await harness.state.ensureConfig("production")
    const orphanedGeneration = "77777777-7777-4777-8777-777777777777"
    await harness.state.writeDeviceIssueReservation({
      formatVersion: 1,
      generation: orphanedGeneration,
      environment: "production",
      issuerOrigin: config.issuerOrigin,
      clientInstanceId: config.clientInstanceId,
      deviceName: "stopped-process",
    })
    enqueueDeviceCode(harness)

    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: true,
        resume: false,
        deviceName: "fresh-device",
      })
    ).resolves.toMatchObject({ exitCode: 0 })

    expect(await harness.state.readDeviceIssueReservation()).toBeNull()
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "issued",
      deviceName: "fresh-device",
    })
    expect((await harness.state.readDeviceState())?.generation).not.toBe(
      orphanedGeneration
    )
  })

  it("does not let an older Device issue response overwrite a fresh generation", async () => {
    const harness = await createHarness()
    const entered = gate<void>()
    const release = gate<void>()
    enqueueDeviceCode(harness, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    const olderIssue = harness.auth.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
      deviceName: "older-device",
    })
    await entered.promise

    const peer = createPeer(harness)
    enqueueDeviceCode(peer)
    await expect(
      peer.auth.login({
        global: GLOBAL,
        noWait: true,
        resume: false,
        deviceName: "fresh-device",
      })
    ).resolves.toMatchObject({ exitCode: 0 })
    const freshDevice = (await harness.state.readDeviceState())!

    release.resolve(undefined)
    await expect(olderIssue).rejects.toMatchObject({ exitCode: 4 })
    expect(await harness.state.readDeviceState()).toEqual(freshDevice)
  })

  it("persists pending and slow_down polling boundaries", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.transport.enqueue((input) =>
      response(input, 400, { error: "authorization_pending" })
    )
    const pending = await harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    expect(pending).toMatchObject({
      exitCode: 4,
      retryAfterSeconds: 5,
      envelope: { meta: { retryAfterSeconds: 5 } },
      warnings: ["Retry after 5 second(s) before repeating this request."],
    })
    expect((await harness.state.readDeviceState())?.intervalSeconds).toBe(5)

    harness.now.value += 5_000
    harness.transport.enqueue((input) =>
      response(input, 400, { error: "slow_down" }, { "retry-after": "12" })
    )
    const slowed = await harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    expect(slowed).toMatchObject({
      exitCode: 4,
      retryAfterSeconds: 12,
      envelope: { meta: { retryAfterSeconds: 12 } },
      warnings: ["Retry after 12 second(s) before repeating this request."],
    })
    const state = await harness.state.readDeviceState()
    expect(state?.intervalSeconds).toBe(12)
    expect(state?.nextPollAt).toBe("2026-07-31T02:00:22.000Z")
  })

  it.each([600, 86_400])(
    "persists temporarily_unavailable Retry-After=%s without changing the protocol interval",
    async (retryAfterSeconds) => {
      const harness = await createHarness()
      await issue(harness)
      await harness.state.withAuthLock(async () => {
        const device = await harness.state.readDeviceState()
        expect(device).not.toBeNull()
        await harness.state.writeDeviceState({
          ...device!,
          expiresAt: new Date(NOW + 2 * 86_400_000).toISOString(),
        })
      })
      harness.now.value += 5_000
      harness.transport.enqueue((input) =>
        response(
          input,
          503,
          { error: "temporarily_unavailable" },
          { "retry-after": String(retryAfterSeconds) }
        )
      )

      const failure = await harness.auth
        .login({
          global: GLOBAL,
          noWait: false,
          resume: true,
        })
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({
        exitCode: 4,
        retryAfterSeconds,
        warnings: [
          `Retry after ${retryAfterSeconds} second(s) before repeating this request.`,
        ],
        envelope: {
          meta: { retryAfterSeconds },
          error: {
            details: {
              retryAfterSeconds,
              oauthError: "temporarily_unavailable",
              suggestedAction: "retry_after",
            },
          },
        },
      })

      const nextPollAtMs = harness.now.value + retryAfterSeconds * 1000
      expect(await harness.state.readDeviceState()).toMatchObject({
        intervalSeconds: 5,
        nextPollAt: new Date(nextPollAtMs).toISOString(),
      })

      const restarted = createPeer(harness)
      harness.now.value = nextPollAtMs - 1
      const early = await restarted.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
      expect(early.exitCode).toBe(4)
      expect(restarted.transport.requests).toHaveLength(0)

      harness.now.value = nextPollAtMs
      const dispatched = gate<void>()
      const release = gate<void>()
      restarted.transport.enqueue(async (input) => {
        dispatched.resolve(undefined)
        await release.promise
        return response(input, 400, { error: "authorization_pending" })
      })
      const boundaryPromise = restarted.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
      await dispatched.promise
      release.resolve(undefined)
      const boundary = await boundaryPromise
      expect(boundary.exitCode).toBe(4)
      expect(restarted.transport.requests).toHaveLength(1)
      expect(await restarted.state.readDeviceState()).toMatchObject({
        intervalSeconds: 5,
        nextPollAt: new Date(nextPollAtMs + 5_000).toISOString(),
      })
    }
  )

  it.each([undefined, "0", "86401", "1.5", "invalid"])(
    "falls back to the protocol interval for invalid Retry-After=%s",
    async (retryAfterHeader) => {
      const harness = await createHarness()
      await issue(harness)
      harness.now.value += 5_000
      harness.transport.enqueue((input) =>
        response(
          input,
          503,
          { error: "temporarily_unavailable" },
          retryAfterHeader === undefined
            ? {}
            : { "retry-after": retryAfterHeader }
        )
      )

      const failure = await harness.auth
        .login({
          global: GLOBAL,
          noWait: false,
          resume: true,
        })
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({
        exitCode: 4,
        retryAfterSeconds: 5,
        warnings: ["Retry after 5 second(s) before repeating this request."],
        envelope: {
          meta: { retryAfterSeconds: 5 },
          error: { details: { retryAfterSeconds: 5 } },
        },
      })
      expect(await harness.state.readDeviceState()).toMatchObject({
        intervalSeconds: 5,
        nextPollAt: "2026-07-31T02:00:10.000Z",
      })
    }
  )

  it("drops transport-unknown poll state and lets the next login issue a fresh Device", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.transport.enqueue(() =>
      Promise.reject(new HttpTransportError("timeout", "timeout"))
    )
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 5 })
    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readDevicePollAttempt()).toBeNull()

    enqueueDeviceCode(harness)
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: true,
        resume: false,
        deviceName: "fresh-device",
      })
    ).resolves.toMatchObject({ exitCode: 0 })
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "issued",
      deviceName: "fresh-device",
    })
  })

  it("resumes the same Device generation from poll staging left by a killed process", async () => {
    // 场景：上个进程被强杀于 poll 中（pollAttempt 残留），用户已在浏览器
    // 完成授权。重新 login 必须复用同代 Device 立即取回 Token，而不是
    // 丢弃已批准的授权重新发码。
    const harness = await createHarness()
    await issue(harness)
    const previousDevice = (await harness.state.readDeviceState())!
    await harness.state.writeDevicePollAttempt({
      formatVersion: 1,
      deviceGeneration: previousDevice.generation,
      storageKind: "keychain",
    })

    harness.now.value += 5_000
    enqueueToken(harness)
    enqueueMe(harness)
    const deviceLines: Array<string> = []
    await expect(
      harness.auth.login(
        {
          global: GLOBAL,
          noWait: false,
          resume: false,
          device: true,
        },
        (line) => deviceLines.push(line)
      )
    ).resolves.toMatchObject({ exitCode: 0 })

    expect(deviceLines).toHaveLength(1)
    expect(JSON.parse(deviceLines[0]!)).toMatchObject({
      userCode: "ABCD-EFGH",
    })
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "stored",
      deviceGeneration: previousDevice.generation,
    })
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/device/code"
      )
    ).toHaveLength(1)
  })

  it("discards expired poll staging during login normalization", async () => {
    const harness = await createHarness()
    await issue(harness)
    const previousDevice = (await harness.state.readDeviceState())!
    await harness.state.writeDevicePollAttempt({
      formatVersion: 1,
      deviceGeneration: previousDevice.generation,
      storageKind: "keychain",
    })

    harness.now.value += 601_000
    const coordinator = new DevicePollCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    await coordinator.normalizeForLogin()

    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
  })

  it("falls back only after a failed Keychain readiness probe is fully cleaned", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.keychain.onWrite = () =>
      Promise.reject(new Error("Keychain is read-only"))
    harness.transport.enqueue(async (input) => {
      expect(await harness.state.readDevicePollAttempt()).toMatchObject({
        storageKind: "fallback_file",
      })
      return response(input, 200, {
        access_token: TOKEN,
        token_type: "Bearer",
        expires_in: 900,
        activation_expires_at: "2026-07-31T02:10:00.000Z",
        idle_expires_at: null,
        absolute_expires_at: "2026-08-30T02:00:00.000Z",
        credential_kind: "adrate_sliding_session",
      })
    })
    enqueueMe(harness)

    const outcome = await harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })

    expect(outcome.exitCode).toBe(0)
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(1)
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "stored",
      storageKind: "fallback_file",
    })
    expect(harness.keychain.values.size).toBe(0)
    expect([...harness.fallback.values.values()]).toEqual([TOKEN])
  })

  it("sends no Token POST when Keychain readiness cleanup is uncertain", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.keychain.onRemove = () =>
      Promise.reject(new Error("Keychain delete failed"))

    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 4 })

    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(0)
    expect(harness.fallback.values.size).toBe(0)
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
  })

  it("sends no Token POST when fallback readiness cannot write", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.keychain.available = false
    harness.fallback.onWrite = () =>
      Promise.reject(new Error("fallback write failed"))

    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 4 })

    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(0)
    expect(harness.keychain.values.size).toBe(0)
    expect(harness.fallback.values.size).toBe(0)
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
  })

  it("drops an invalid Token response so logout can clear local transient state", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.transport.enqueue((input) => response(input, 200, {}))
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 5 })
    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
    await expect(harness.auth.logout(GLOBAL)).resolves.toMatchObject({
      exitCode: 0,
      envelope: { data: { localCredentialFound: false } },
    })
  })

  it("lets logout clear poll staging left by a stopped process", async () => {
    const harness = await createHarness()
    await issue(harness)
    const device = (await harness.state.readDeviceState())!
    await harness.state.writeDevicePollAttempt({
      formatVersion: 1,
      deviceGeneration: device.generation,
      storageKind: "fallback_file",
    })

    await expect(harness.auth.logout(GLOBAL)).resolves.toMatchObject({
      exitCode: 0,
      envelope: { data: { localCredentialFound: false } },
    })
    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
  })

  it("keeps a received Token when first /me is transiently unavailable", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    enqueueToken(harness)
    harness.transport.enqueue(() =>
      Promise.reject(new HttpTransportError("timeout", "timeout"))
    )

    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 4 })
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "stored",
    })
    expect(await harness.state.readCredentials()).toBeNull()
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "token_received",
      deviceCode: null,
      userCode: null,
    })

    enqueueMe(harness)
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).resolves.toMatchObject({ exitCode: 0, envelope: { ok: true } })
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/public/v1/sessions/current"
      )
    ).toHaveLength(0)
    expect(await harness.state.readCredentials()).toMatchObject({
      absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
    })
  })
})

describe("local authentication cleanup", () => {
  it("retries exact secret deletion while the original identity is unchanged", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    const cleanup = new AuthCleanupCoordinator(harness.local)
    const expected = await harness.local.captureIdentity()
    let injected = false
    harness.keychain.onRemove = (address) => {
      if (!injected && address.credentialId === CREDENTIAL_ID) {
        injected = true
        harness.keychain.values.delete(addressKey(address))
        throw new Error("simulated crash after secret delete")
      }
      return Promise.resolve()
    }

    await expect(cleanup.clearIfUnchanged(expected)).rejects.toThrow(
      "simulated crash"
    )
    expect(harness.keychain.values.size).toBe(0)

    // 归一化只能确认本地 secret 已缺失，远端撤销状态仍是 unknown。
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).resolves.toMatchObject({ exitCode: 5 })

    harness.keychain.onRemove = null
    // 状态已被归一化清理，identity 不再匹配
    await expect(cleanup.clearIfUnchanged(expected)).resolves.toBe("stale")
    expect(await harness.state.readTokenIndex()).toBeNull()
  })

  it("preserves a replacement credential when the expected identity is stale", async () => {
    const harness = await createHarness()
    const index = await installStoredCredential(harness, true)
    const expected = await harness.local.captureIdentity()
    const replacement = {
      ...index,
      generation: "99999999-9999-4999-8999-999999999999",
    }
    await harness.state.withAuthLock(() =>
      harness.state.writeTokenIndex(replacement)
    )

    const cleanup = new AuthCleanupCoordinator(harness.local)
    await expect(cleanup.clearIfUnchanged(expected)).resolves.toBe("stale")
    expect(await harness.state.readTokenIndex()).toMatchObject({
      generation: replacement.generation,
    })
    expect([...harness.keychain.values.values()]).toEqual([TOKEN])
  })

  it("clears remaining local records on explicit logout when the secret is already missing", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    const cleanup = new AuthCleanupCoordinator(harness.local)
    const expected = await harness.local.captureIdentity()
    const fileSystem = harness.state.fileSystem
    const originalRemove = fileSystem.removeSecureFile.bind(fileSystem)
    let injected = false
    fileSystem.removeSecureFile = async (path) => {
      const removed = await originalRemove(path)
      if (!injected && path === harness.state.paths.credentials) {
        injected = true
        throw new Error("simulated local cleanup interruption")
      }
      return removed
    }

    await expect(cleanup.clearIfUnchanged(expected)).rejects.toThrow(
      "simulated local cleanup interruption"
    )
    fileSystem.removeSecureFile = originalRemove
    const requestCount = harness.transport.requests.length
    await expect(harness.auth.logout(GLOBAL)).resolves.toMatchObject({
      exitCode: 5,
      envelope: {
        ok: false,
        error: { details: { localStateCleared: true } },
      },
    })
    expect(harness.transport.requests).toHaveLength(requestCount)
    await expect(harness.local.hasAnyAuthenticationArtifact()).resolves.toBe(
      false
    )
  })

  it("lets real logout converge a stored Token crash after Device finalization", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    enqueueToken(harness)
    const originalClearPoll = harness.state.clearDevicePollAttempt.bind(
      harness.state
    )
    harness.state.clearDevicePollAttempt = () =>
      Promise.reject(new Error("simulated crash before poll cleanup"))

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toMatchObject({ exitCode: 5 })
    harness.state.clearDevicePollAttempt = originalClearPoll
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "stored",
    })
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "token_received",
      deviceCode: null,
    })
    expect(await harness.state.readDevicePollAttempt()).toMatchObject({
      storageKind: "keychain",
    })
    harness.transport.enqueue((input) =>
      response(input, 200, {
        ok: true,
        data: {
          revoked: true,
          credentialId: CREDENTIAL_ID,
          revokedAt: "2026-07-31T02:00:00.000Z",
        },
        meta: {
          requestId: input.requestId ?? "server_request_1",
          apiVersion: "v1",
        },
      })
    )

    await expect(harness.auth.logout(GLOBAL)).resolves.toMatchObject({
      exitCode: 0,
    })
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(1)
    expect(await harness.state.readTokenIndex()).toBeNull()
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
  })

  it("recovers a Device issue crash after Device write and before reservation cleanup", async () => {
    const harness = await createHarness()
    enqueueDeviceCode(harness)
    const originalClearIssue = harness.state.clearDeviceIssueReservation.bind(
      harness.state
    )
    harness.state.clearDeviceIssueReservation = () =>
      Promise.reject(new Error("simulated issue finalization crash"))

    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: true,
        resume: false,
        deviceName: "test-device",
      })
    ).rejects.toThrow("simulated issue finalization crash")
    harness.state.clearDeviceIssueReservation = originalClearIssue
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "issued",
    })
    expect(await harness.state.readDeviceIssueReservation()).not.toBeNull()

    await expect(
      createPeer(harness).auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).resolves.toMatchObject({ exitCode: 4 })
    harness.now.value += 46_000
    harness.transport.enqueue((input) =>
      response(input, 400, { error: "authorization_pending" })
    )
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).resolves.toMatchObject({ exitCode: 4 })
    expect(await harness.state.readDeviceIssueReservation()).toBeNull()
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(1)
  })

  it("drops a stale staging record from another Device generation", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    const device = (await harness.state.readDeviceState())!
    const attempt: DevicePollAttempt = {
      formatVersion: 1,
      deviceGeneration: "99999999-9999-4999-8999-999999999999",
      storageKind: "keychain",
    }
    await harness.state.withAuthLock(() =>
      harness.state.writeDevicePollAttempt(attempt)
    )
    const coordinator = new DevicePollCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )

    await expect(coordinator.prepare()).resolves.toMatchObject({
      kind: "select_backend",
    })
    expect(await harness.state.readDevicePollAttempt()).toEqual({
      formatVersion: 1,
      deviceGeneration: device.generation,
      storageKind: null,
    })
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(0)
  })
})

describe("auth status and logout", () => {
  it("returns stable local status without network", async () => {
    const harness = await createHarness()
    const empty = await harness.auth.status(GLOBAL)
    expect(empty).toMatchObject({
      exitCode: 0,
      envelope: {
        ok: true,
        data: {
          status: "not_authenticated",
          authenticated: false,
          reason: "token_missing",
        },
      },
    })
    expect(harness.transport.requests).toHaveLength(0)

    await installStoredCredential(harness)
    harness.keychain.values.clear()
    const incomplete = await harness.auth.status(GLOBAL)
    expect(incomplete).toMatchObject({
      exitCode: 0,
      envelope: {
        ok: true,
        data: {
          status: "local_incomplete",
          reason: "token_missing",
        },
      },
    })
    expect(harness.transport.requests).toHaveLength(0)
  })

  it("clears residual test state when the indexed secret is missing", async () => {
    const harness = await createHarness()
    const config = await harness.state.ensureConfig("test")
    await harness.state.writeTokenIndex({
      tokenIndexFormatVersion: 1,
      generation: TOKEN_GENERATION,
      state: "stored",
      environment: "test",
      issuerOrigin: "https://api.test.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
      clientInstanceId: config.clientInstanceId,
      deviceGeneration: DEVICE_GENERATION,
      deviceName: "test-device",
      tokenReceivedAt: "2026-07-31T02:00:00.000Z",
      storageKind: "keychain",
    })

    const outcome = await harness.auth.logout(GLOBAL)

    expect(outcome).toMatchObject({
      exitCode: 5,
      envelope: {
        ok: false,
        error: {
          details: {
            reason: "token_missing",
            localStateCleared: true,
          },
        },
      },
    })
    expect(harness.transport.requests).toHaveLength(0)
    expect(await harness.state.readTokenIndex()).toBeNull()
  })

  it.each([
    ["production", "test"],
    ["test", "production"],
  ] as const)(
    "uses credential index %s evidence ahead of opposite %s config",
    async (configEnvironment, indexEnvironment) => {
      const harness = await createHarness()
      const config = await harness.state.ensureConfig(configEnvironment)
      await harness.state.writeTokenIndex({
        tokenIndexFormatVersion: 1,
        generation: TOKEN_GENERATION,
        state: "stored",
        environment: indexEnvironment,
        issuerOrigin:
          indexEnvironment === "test"
            ? "https://api.test.adrate.io"
            : "https://api.adrate.io",
        credentialKind: "owner_cli_session",
        credentialId: CREDENTIAL_ID,
        clientInstanceId: config.clientInstanceId,
        deviceGeneration: DEVICE_GENERATION,
        deviceName: "conflicting-config",
        tokenReceivedAt: "2026-07-31T02:00:00.000Z",
        storageKind: "keychain",
      })

      const outcome = await harness.auth.logout(GLOBAL)
      expect(outcome).toMatchObject({
        exitCode: 5,
        envelope: {
          error: {
            details: {
              reason: "metadata_mismatch",
              localStatePreserved: true,
            },
          },
        },
      })
      expect(harness.transport.requests).toHaveLength(0)
      expect(await harness.state.readTokenIndex()).not.toBeNull()
    }
  )

  it("does not emit a guessed security URL for damaged higher-priority state", async () => {
    const harness = await createHarness()
    await harness.state.ensureConfig("production")
    await harness.state.withAuthLock(() =>
      harness.state.fileSystem.atomicWrite(
        harness.state.paths.tokenIndex,
        '{"tokenIndexFormatVersion":1,"state":"damaged"}\n'
      )
    )

    const outcome = await harness.auth.logout(GLOBAL)
    expect(outcome.exitCode).toBe(5)
    expect(outcome.envelope.ok).toBe(false)
    if (!outcome.envelope.ok) {
      expect(outcome.envelope.error.details.resolutionUrl).toBeNull()
    }
    expect(
      await harness.state.fileSystem.exists(harness.state.paths.tokenIndex)
    ).toBe(true)
    expect(harness.transport.requests).toHaveLength(0)
  })

  it("calls /me exactly once and distinguishes active from remote_invalid", async () => {
    const active = await createHarness()
    await installStoredCredential(active)
    enqueueMe(active)
    const outcome = await active.auth.status(GLOBAL)
    expect(outcome).toMatchObject({
      exitCode: 0,
      envelope: {
        ok: true,
        data: { status: "active", authenticated: true },
      },
    })
    expect(active.transport.requests).toHaveLength(1)

    const invalid = await createHarness()
    await installStoredCredential(invalid)
    enqueuePublicError(invalid, "INVALID_CREDENTIAL")
    const invalidOutcome = await invalid.auth.status(GLOBAL)
    expect(invalidOutcome).toMatchObject({
      exitCode: 0,
      envelope: {
        ok: true,
        data: {
          status: "remote_invalid",
          authenticated: false,
          reason: "invalid_credential",
        },
      },
    })
    expect(await invalid.state.readTokenIndex()).not.toBeNull()
  })

  it("marks an unverifiable remote status and preserves local state", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness)
    enqueuePublicError(harness, "RATE_LIMITED")
    const outcome = await harness.auth.status(GLOBAL)
    expect(outcome).toMatchObject({
      exitCode: 4,
      envelope: {
        ok: false,
        error: { details: { authStatus: "unverified" } },
      },
    })
    expect(await harness.state.readTokenIndex()).not.toBeNull()
  })

  it("validates malformed /me before identity mismatch and preserves the Token generation", async () => {
    const malformed = await createHarness()
    const malformedIndex = await installStoredCredential(malformed)
    malformed.transport.enqueue((input) =>
      response(input, 200, {
        ok: true,
        data: {
          principal: {
            kind: "owner_cli_session",
            credentialId: "99999999-9999-4999-8999-999999999999",
          },
          capabilities: CLI_SCOPE.split(" "),
        },
        meta: {
          requestId: input.requestId ?? "server_request_1",
          apiVersion: "v1",
        },
      })
    )
    await expect(malformed.auth.whoami(GLOBAL)).rejects.toMatchObject({
      exitCode: 4,
      envelope: {
        error: {
          details: {
            authStatus: "unverified",
            responseKind: "me_contract_invalid",
          },
        },
      },
    })
    expect(await malformed.state.readTokenIndex()).toEqual(malformedIndex)
    expect([...malformed.keychain.values.values()]).toEqual([TOKEN])

    const malformedStatus = await createHarness()
    const malformedStatusIndex = await installStoredCredential(malformedStatus)
    malformedStatus.transport.enqueue((input) =>
      response(input, 200, {
        ok: true,
        data: {
          principal: {
            kind: "owner_cli_session",
            credentialId: "99999999-9999-4999-8999-999999999999",
          },
          subject: null,
          team: { teamId: 7, teamName: "AdRate" },
          capabilities: [],
          credential: {
            activationExpiresAt: null,
            idleExpiresAt: "2026-07-31T03:00:00.000Z",
            absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
          },
          plan: null,
        },
        meta: {
          requestId: input.requestId ?? "server_request_1",
          apiVersion: "v1",
        },
      })
    )
    const unverified = await malformedStatus.auth.status(GLOBAL)
    expect(unverified).toMatchObject({
      exitCode: 0,
      envelope: {
        ok: true,
        data: {
          status: "local_incomplete",
          reason: "metadata_mismatch",
        },
      },
    })
    expect(await malformedStatus.state.readTokenIndex()).toEqual(
      malformedStatusIndex
    )
    expect([...malformedStatus.keychain.values.values()]).toEqual([TOKEN])

    const mismatch = await createHarness()
    await installStoredCredential(mismatch)
    enqueueMe(mismatch, {
      credentialId: "99999999-9999-4999-8999-999999999999",
    })
    const status = await mismatch.auth.status(GLOBAL)
    expect(status).toMatchObject({
      exitCode: 0,
      envelope: {
        ok: true,
        data: {
          status: "local_incomplete",
          reason: "metadata_mismatch",
        },
      },
    })
    expect(await mismatch.state.readTokenIndex()).not.toBeNull()
    expect([...mismatch.keychain.values.values()]).toEqual([TOKEN])

    const fallbackMismatch = await createHarness()
    const fallbackIndex = {
      ...(await installStoredCredential(fallbackMismatch)),
      storageKind: "fallback_file" as const,
    }
    await fallbackMismatch.state.withAuthLock(() =>
      fallbackMismatch.state.writeTokenIndex(fallbackIndex)
    )
    fallbackMismatch.keychain.values.clear()
    await fallbackMismatch.fallback.write(
      fallbackMismatch.local.credentials.addressFor(fallbackIndex),
      TOKEN
    )
    enqueueMe(fallbackMismatch, {
      credentialId: "99999999-9999-4999-8999-999999999999",
    })
    const fallbackStatus = await fallbackMismatch.auth.status(GLOBAL)
    expect(fallbackStatus).toMatchObject({
      exitCode: 0,
      envelope: {
        ok: true,
        data: {
          status: "local_incomplete",
          reason: "metadata_mismatch",
        },
      },
      warnings: [
        "OS Keychain is unavailable; using the protected local token file.",
      ],
    })
    expect(await fallbackMismatch.state.readTokenIndex()).not.toBeNull()
    expect([...fallbackMismatch.fallback.values.values()]).toEqual([TOKEN])
  })

  it.each([
    {
      command: "status",
      argv: ["auth", "status", "--json"],
      credential: {
        activationExpiresAt: "2026-07-31T02:10:00.000Z",
        idleExpiresAt: null,
        absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
      },
    },
    {
      command: "whoami",
      argv: ["auth", "whoami", "--json"],
      credential: {
        activationExpiresAt: null,
        idleExpiresAt: "2026-08-30T02:00:00.001Z",
        absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
      },
    },
    {
      command: "login",
      argv: ["auth", "login", "--resume", "--json"],
      credential: {
        activationExpiresAt: "2026-07-31T02:10:00.000Z",
        idleExpiresAt: "2026-07-31T03:00:00.000Z",
        absoluteExpiresAt: "2026-08-30T02:00:00.000Z",
      },
    },
  ])(
    "rejects an impossible /me lifecycle through the real auth $command entry and preserves the Token generation",
    async ({ command, argv, credential }) => {
      const harness = await createHarness()
      let indexBeforeResponse: TokenIndex | null = null
      if (command === "login") {
        await issue(harness)
        harness.now.value += 5_000
        enqueueToken(harness)
      } else {
        indexBeforeResponse = await installStoredCredential(harness)
      }
      enqueueMe(harness, {
        credentialId: "99999999-9999-4999-8999-999999999999",
        credential,
        beforeResponse: async () => {
          indexBeforeResponse ??= await harness.state.readTokenIndex()
        },
      })

      const outcome = (await (
        command === "status"
          ? harness.auth.status(GLOBAL)
          : command === "whoami"
            ? harness.auth.whoami(GLOBAL)
            : harness.auth.login({
                global: GLOBAL,
                noWait: false,
                resume: true,
              })
      ).catch((error: unknown) => error)) as CliOutcome | CliFailure

      expect(outcome.exitCode).toBe(4)
      expect(outcome.envelope).toMatchObject({
        ok: false,
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          details: {
            authStatus: "unverified",
            responseKind: "me_contract_invalid",
          },
        },
      })
      expect(indexBeforeResponse).not.toBeNull()
      expect(await harness.state.readTokenIndex()).toEqual(indexBeforeResponse)
      expect([...harness.keychain.values.values()]).toEqual([TOKEN])
    }
  )

  it("merges logout Retry-After, credential and pending warnings into human output", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    await harness.state.fileSystem.atomicWrite(
      join(harness.state.paths.pendingCommands, "pending-1.json"),
      "{}\n"
    )
    harness.transport.enqueue((input) =>
      response(
        input,
        429,
        {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "wait",
            retryable: true,
            details: {},
          },
          meta: {
            requestId: input.requestId ?? "server_request_1",
            apiVersion: "v1",
            _notice: {
              credential: { message: "Credential expires soon." },
            },
          },
        },
        { "retry-after": "17" }
      )
    )

    const outcome = await harness.auth.logout(GLOBAL)
    expect(outcome).toMatchObject({
      exitCode: 5,
      envelope: { meta: { pendingCommandsRetained: 1 } },
      warnings: [
        "1 pending Command record(s) were preserved. A new credential cannot resume Commands created by the previous credential.",
        "Remote revocation is not confirmed. Verify or revoke the device on the official Web security page.",
      ],
    })
    expect(new Set(outcome.warnings).size).toBe(outcome.warnings.length)

    const stdout = captureStream()
    const stderr = captureStream()
    renderOutcome(
      outcome,
      { json: false, verbose: false },
      { stdout: stdout.stream, stderr: stderr.stream }
    )
    expect(stdout.read()).toBe("")
    expect(stderr.read()).toContain(
      "Warning: 1 pending Command record(s) were preserved."
    )
    expect(stderr.read()).toContain(
      "Warning: Remote revocation is not confirmed."
    )
  })

  it("deduplicates an identical credential and pending warning during logout", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    await harness.state.fileSystem.atomicWrite(
      join(harness.state.paths.pendingCommands, "pending-1.json"),
      "{}\n"
    )
    const duplicatedWarning =
      "1 pending Command record(s) were preserved. A new credential cannot resume Commands created by the previous credential."
    harness.transport.enqueue((input) =>
      response(input, 429, {
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "wait",
          retryable: true,
          details: {},
        },
        meta: {
          requestId: input.requestId ?? "server_request_1",
          apiVersion: "v1",
          _notice: { credential: { message: duplicatedWarning } },
        },
      })
    )

    const outcome = await harness.auth.logout(GLOBAL)
    expect(
      outcome.warnings.filter((value) => value === duplicatedWarning)
    ).toHaveLength(1)
  })

  it.each(
    (["confirmed_inactive", "unknown"] as const).flatMap((remoteOutcome) =>
      (["keychain"] as const).map(
        (failurePoint) => [remoteOutcome, failurePoint] as const
      )
    )
  )(
    "keeps remote %s authoritative across %s cleanup failure and recovery",
    async (remoteOutcome, failurePoint) => {
      const harness = await createHarness()
      await installLogoutCleanupFixture(harness)
      if (remoteOutcome === "unknown") {
        enqueuePublicError(harness, "OWNER_REQUIRED")
      } else {
        harness.transport.enqueue((input) =>
          response(input, 200, {
            ok: true,
            data: {
              revoked: true,
              credentialId: CREDENTIAL_ID,
              revokedAt: "2026-07-31T02:00:00.000Z",
            },
            meta: {
              requestId: input.requestId ?? "server_request_1",
              apiVersion: "v1",
            },
          })
        )
      }
      const restore = injectLogoutCleanupFailure(harness)

      const failedCleanup = await harness.auth.logout(GLOBAL)
      expect(failedCleanup.exitCode).toBe(5)
      if (remoteOutcome === "confirmed_inactive") {
        expect(failedCleanup.envelope).toMatchObject({
          ok: false,
          error: {
            details: {
              localCleanupFailed: true,
            },
          },
        })
      } else {
        expect(failedCleanup.envelope).toMatchObject({
          ok: false,
          error: {
            details: {
              errorCode: "OWNER_REQUIRED",
              resolutionUrl: "https://app.adrate.io/settings/security",
            },
          },
        })
      }
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/public/v1/sessions/current"
        )
      ).toHaveLength(1)
      restore()

      if (remoteOutcome === "unknown") {
        harness.transport.enqueue((input) =>
          response(input, 401, {
            ok: false,
            error: {
              code: "OWNER_REQUIRED",
              message: "Owner required",
              retryable: false,
              details: {},
            },
            meta: {
              requestId: input.requestId ?? "server_request_1",
              apiVersion: "v1",
            },
          })
        )
      } else {
        harness.transport.enqueue((input) =>
          response(input, 200, {
            ok: true,
            data: {
              revoked: true,
              credentialId: CREDENTIAL_ID,
              revokedAt: "2026-07-31T02:00:00.000Z",
            },
            meta: {
              requestId: input.requestId ?? "server_request_1",
              apiVersion: "v1",
            },
          })
        )
      }

      const recovered = await harness.auth.logout(GLOBAL)
      expect(recovered.exitCode).toBe(remoteOutcome === "unknown" ? 5 : 0)
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/public/v1/sessions/current"
        )
      ).toHaveLength(2)
    }
  )

  it("lets logout cancel an in-flight local Device issue without a recovery journal", async () => {
    const harness = await createHarness()
    const entered = gate<void>()
    const release = gate<void>()
    enqueueDeviceCode(harness, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    const issuing = harness.auth.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
      deviceName: "test-device",
    })
    await entered.promise

    const peer = createPeer(harness)
    const logout = await peer.auth.logout(GLOBAL)
    expect(logout.exitCode).toBe(0)
    expect(await harness.state.readDeviceIssueReservation()).toBeNull()
    release.resolve(undefined)
    await expect(issuing).rejects.toMatchObject({ exitCode: 4 })
    expect(await harness.state.readDeviceState()).toBeNull()
  })

  it("blocks a new login while Keychain cleanup holds the auth lock", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    const peer = createPeer(harness)
    const entered = gate<void>()
    const release = gate<void>()
    harness.keychain.onRemove = async () => {
      entered.resolve(undefined)
      await release.promise
    }
    harness.transport.enqueue((input) =>
      response(input, 200, {
        ok: true,
        data: {
          revoked: true,
          credentialId: CREDENTIAL_ID,
          revokedAt: "2026-07-31T02:00:00.000Z",
        },
        meta: {
          requestId: input.requestId ?? "server_request_1",
          apiVersion: "v1",
        },
      })
    )
    const logout = harness.auth.logout(GLOBAL)
    await entered.promise

    await expect(
      peer.auth.login({
        global: GLOBAL,
        noWait: true,
        resume: false,
        deviceName: "blocked-device",
      })
    ).rejects.toThrow(
      "Another AdRate CLI process is updating local authentication state."
    )
    expect(peer.transport.requests).toHaveLength(0)

    release.resolve(undefined)
    expect((await logout).exitCode).toBe(0)
  })

  it.each([
    ["INVALID_CREDENTIAL", 0, true],
    ["OWNER_REQUIRED", 5, false],
  ] as const)(
    "clears local auth for logout %s",
    async (code, exitCode, alreadyInactive) => {
      const harness = await createHarness()
      await installStoredCredential(harness, true)
      enqueuePublicError(harness, code)
      const outcome = await harness.auth.logout(GLOBAL)
      expect(outcome.exitCode).toBe(exitCode)
      if (outcome.envelope.ok) {
        expect(outcome.envelope.data.alreadyInactive).toBe(alreadyInactive)
      }
      if (exitCode === 0) {
        expect(await harness.state.readTokenIndex()).toBeNull()
        expect(harness.keychain.values.size).toBe(0)
      } else {
        expect(await harness.state.readTokenIndex()).not.toBeNull()
        expect(harness.keychain.values.size).toBeGreaterThan(0)
      }
    }
  )

  it.each(["network", "malformed", "mismatch"] as const)(
    "preserves fallback storage warning for first /me %s failure",
    async (failureKind) => {
      const harness = await createHarness()
      harness.keychain.available = false
      await issue(harness)
      harness.now.value += 5_000
      enqueueToken(harness)
      if (failureKind === "network") {
        harness.transport.enqueue(() =>
          Promise.reject(new HttpTransportError("network", "offline"))
        )
      } else if (failureKind === "mismatch") {
        enqueueMe(harness, {
          credentialId: "99999999-9999-4999-8999-999999999999",
        })
      } else {
        harness.transport.enqueue((input) =>
          response(input, 200, {
            ok: true,
            data: { principal: { credentialId: CREDENTIAL_ID } },
            meta: {
              requestId: input.requestId ?? "server_request_1",
              apiVersion: "v1",
            },
          })
        )
      }

      const failure = await harness.auth
        .login({ global: GLOBAL, noWait: false, resume: true })
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({
        warnings: [
          "OS Keychain is unavailable; using the protected local token file.",
        ],
      })
    }
  )
})

describe("--device output mode", () => {
  it("emits a single parseable JSON line with the required four fields", async () => {
    const harness = await createHarness()
    const stdoutLines: Array<string> = []
    const authWithOutput = new AuthService({
      http: new PublicHttpClient(harness.transport),
      local: harness.local,
      now: () => new Date(harness.now.value),
      sleep: (ms) => {
        harness.now.value += ms
        return Promise.resolve()
      },
    })

    enqueueDeviceCode(harness)
    enqueueToken(harness)
    enqueueMe(harness)

    const outcome = await authWithOutput.login(
      {
        global: GLOBAL,
        noWait: false,
        resume: false,
        device: true,
      },
      (line) => stdoutLines.push(line)
    )

    expect(outcome.exitCode).toBe(0)
    expect(stdoutLines).toHaveLength(1)
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed).toHaveProperty("verificationUriComplete")
    expect(parsed).toHaveProperty("verificationUri")
    expect(parsed).toHaveProperty("userCode")
    expect(parsed).toHaveProperty("expiresIn")
    expect(parsed.verificationUriComplete).toBe(
      "https://app.adrate.io/device?user_code=ABCD-EFGH"
    )
    expect(parsed.verificationUri).toBe("https://app.adrate.io/device")
    expect(parsed.userCode).toBe("ABCD-EFGH")
    expect(typeof parsed.expiresIn).toBe("number")
    expect(parsed.expiresIn).toBeGreaterThan(0)
    expect(parsed.expiresIn).toBeLessThanOrEqual(600)
    expect(parsed).not.toHaveProperty("deviceCode")
    expect(parsed).not.toHaveProperty("device_code")
    expect(Object.keys(parsed)).toHaveLength(4)

    const finalStdout = captureStream()
    renderOutcome(
      outcome,
      { json: true, verbose: false },
      {
        stdout: finalStdout.stream,
        stderr: captureStream().stream,
      }
    )
    const combinedLines = [...stdoutLines, finalStdout.read().trim()]
    expect(combinedLines).toHaveLength(2)
    expect(JSON.parse(combinedLines[1]!)).toMatchObject({ ok: true })
  })

  it("emits JSON when resuming existing device state on reconnection", async () => {
    const harness = await createHarness()
    const stdoutLines: Array<string> = []
    const authWithOutput = new AuthService({
      http: new PublicHttpClient(harness.transport),
      local: harness.local,
      now: () => new Date(harness.now.value),
      sleep: (ms) => {
        harness.now.value += ms
        return Promise.resolve()
      },
    })

    // First: issue device code (--no-wait creates valid device state without polling)
    enqueueDeviceCode(harness)
    const issued = await authWithOutput.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
      device: false,
    })
    expect(issued.exitCode).toBe(0)
    expect(stdoutLines).toHaveLength(0)

    // Advance time to be within the polling window
    harness.now.value += 5_000

    // Second: --device login should find existing device state, emit JSON, and poll
    enqueueToken(harness)
    enqueueMe(harness)

    const outcome = await authWithOutput.login(
      {
        global: GLOBAL,
        noWait: false,
        resume: false,
        device: true,
      },
      (line) => stdoutLines.push(line)
    )

    expect(outcome.exitCode).toBe(0)
    expect(stdoutLines).toHaveLength(1)
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed.userCode).toBe("ABCD-EFGH")
    expect(parsed.verificationUriComplete).toBe(
      "https://app.adrate.io/device?user_code=ABCD-EFGH"
    )
    expect(parsed).not.toHaveProperty("deviceCode")
    expect(parsed).not.toHaveProperty("device_code")
  })

  it("re-issues and emits when existing device state has expired", async () => {
    const harness = await createHarness()
    const stdoutLines: Array<string> = []
    const authWithOutput = new AuthService({
      http: new PublicHttpClient(harness.transport),
      local: harness.local,
      now: () => new Date(harness.now.value),
      sleep: (ms) => {
        harness.now.value += ms
        return Promise.resolve()
      },
    })

    // Issue device code
    enqueueDeviceCode(harness)
    await authWithOutput.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
      device: false,
    })
    expect(stdoutLines).toHaveLength(0)

    // Advance time past expiry (device_code expires_in=600s)
    harness.now.value += 700_000

    // Device re-issue (expired state cleared → new issue) + poll + me
    enqueueDeviceCode(harness)
    enqueueToken(harness)
    enqueueMe(harness)

    const outcome = await authWithOutput.login(
      {
        global: GLOBAL,
        noWait: false,
        resume: false,
        device: true,
      },
      (line) => stdoutLines.push(line)
    )

    expect(outcome.exitCode).toBe(0)
    expect(stdoutLines).toHaveLength(1)
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed.userCode).toBe("ABCD-EFGH")
    expect(Object.keys(parsed)).toHaveLength(4)
  })

  it("is mutually exclusive with --no-wait and --resume", async () => {
    const harness = await createHarness()
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: true,
        resume: false,
        device: true,
      })
    ).rejects.toMatchObject({ exitCode: 2 })
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
        device: true,
      })
    ).rejects.toMatchObject({ exitCode: 2 })
  })

  it("does not emit stdout in --no-wait mode", async () => {
    const harness = await createHarness()
    const stdoutLines: Array<string> = []
    const authWithoutOutput = new AuthService({
      http: new PublicHttpClient(harness.transport),
      local: harness.local,
      now: () => new Date(harness.now.value),
      sleep: () => Promise.resolve(),
    })

    enqueueDeviceCode(harness)

    const outcome = await authWithoutOutput.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
      device: false,
    })

    expect(outcome.exitCode).toBe(0)
    expect(stdoutLines).toHaveLength(0)
  })

  it("satisfies --no-input validation when --device is present", async () => {
    const harness = await createHarness()
    // --no-input without --no-wait/--resume/--device should fail
    await expect(
      harness.auth.login({
        global: { ...GLOBAL, noInput: true },
        noWait: false,
        resume: false,
        device: false,
      })
    ).rejects.toMatchObject({ exitCode: 2 })

    // --no-input with --device should pass validation
    const authWithTime = new AuthService({
      http: new PublicHttpClient(harness.transport),
      local: harness.local,
      now: () => new Date(harness.now.value),
      sleep: (ms) => {
        harness.now.value += ms
        return Promise.resolve()
      },
    })
    enqueueDeviceCode(harness)
    enqueueToken(harness)
    enqueueMe(harness)
    const outcome = await authWithTime.login(
      {
        global: { ...GLOBAL, noInput: true },
        noWait: false,
        resume: false,
        device: true,
      },
      () => undefined
    )
    expect(outcome.exitCode).toBe(0)
  })
})

describe("credential normalization before login", () => {
  it("reports unknown after clearing token_missing residual state, then allows an explicit retry", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    // 凭据文件和 secret 都缺失，无法确认远端是否已撤销。
    await harness.state.fileSystem.removeSecureFile(
      harness.state.paths.credentials
    )
    harness.keychain.values.clear()

    const first = await harness.auth.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
    })
    expect(first).toMatchObject({
      exitCode: 5,
      envelope: {
        error: { details: { localStateCleared: true } },
      },
    })
    expect(await harness.state.readTokenIndex()).toBeNull()

    enqueueDeviceCode(harness)
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).resolves.toMatchObject({ exitCode: 0, envelope: { ok: true } })
  })

  it("revokes the preserved Token when Accio removed only credentials.json", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    const index = await harness.state.readTokenIndex()
    await harness.state.fileSystem.removeSecureFile(
      harness.state.paths.credentials
    )

    // Enqueue successful DELETE /sessions/current (归一化 logout)
    harness.transport.enqueue((input) =>
      response(input, 200, {
        ok: true,
        data: {
          revoked: true,
          credentialId: index!.credentialId,
          revokedAt: "2026-07-31T03:00:00.000Z",
        },
        meta: { requestId: input.requestId ?? "r1", apiVersion: "v1" },
      })
    )
    // Enqueue device code for the new login after normalization clears state
    enqueueDeviceCode(harness)

    const outcome = await harness.auth.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.envelope.ok).toBe(true)
    expect(harness.transport.requests[0]).toMatchObject({
      method: "DELETE",
      path: "/public/v1/sessions/current",
    })
    expect(await harness.state.readDeviceState()).not.toBeNull()
  })

  it("preserves a valid stored credential and does not send DELETE", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).rejects.toMatchObject({ exitCode: 2 })
    expect(harness.transport.requests).toHaveLength(0)
    expect(await harness.state.readTokenIndex()).not.toBeNull()
    expect([...harness.keychain.values.values()]).toEqual([TOKEN])
  })

  it("revokes locally expired metadata before issuing a new Device flow", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    const metadata = await harness.state.readCredentials()
    await harness.state.writeCredentials({
      ...metadata!,
      absoluteExpiresAt: "2026-07-31T01:59:59.000Z",
    })

    enqueuePublicError(harness, "CREDENTIAL_EXPIRED")
    enqueueDeviceCode(harness)

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).resolves.toMatchObject({ exitCode: 0, envelope: { ok: true } })
    expect(harness.transport.requests[0]).toMatchObject({
      method: "DELETE",
      path: "/public/v1/sessions/current",
    })
  })

  it("clears credentials on INVALID_CREDENTIAL response and allows new login", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    await harness.state.fileSystem.removeSecureFile(
      harness.state.paths.credentials
    )

    // Enqueue DELETE /sessions/current → INVALID_CREDENTIAL (inactive)
    harness.transport.enqueue((input) =>
      response(input, 401, {
        ok: false,
        error: {
          code: "INVALID_CREDENTIAL",
          message: "Credential not found",
          retryable: false,
          details: {},
        },
        meta: { requestId: input.requestId ?? "r1", apiVersion: "v1" },
      })
    )
    // Enqueue device code for the new login after normalization clears state
    enqueueDeviceCode(harness)

    const outcome = await harness.auth.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.envelope.ok).toBe(true)
    // Old token-index should have been cleared by normalization
    expect(await harness.state.readTokenIndex()).toBeNull()
  })

  it("preserves credentials when remote logout transport fails", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    await harness.state.fileSystem.removeSecureFile(
      harness.state.paths.credentials
    )
    harness.transport.enqueue(() =>
      Promise.reject(new HttpTransportError("timeout", "timeout"))
    )

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).resolves.toMatchObject({ exitCode: 5, envelope: { ok: false } })
    expect(await harness.state.readTokenIndex()).not.toBeNull()
    expect([...harness.keychain.values.values()]).toEqual([TOKEN])
  })

  it("returns unknown when remote revocation succeeded but local cleanup fails", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    const index = await harness.state.readTokenIndex()
    await harness.state.fileSystem.removeSecureFile(
      harness.state.paths.credentials
    )
    harness.transport.enqueue((input) =>
      response(input, 200, {
        ok: true,
        data: {
          revoked: true,
          credentialId: index!.credentialId,
          revokedAt: "2026-07-31T03:00:00.000Z",
        },
        meta: { requestId: input.requestId ?? "r1", apiVersion: "v1" },
      })
    )
    harness.keychain.onRemove = () =>
      Promise.reject(new Error("simulated cleanup failure"))

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).resolves.toMatchObject({
      exitCode: 5,
      envelope: { error: { details: { localCleanupFailed: true } } },
    })
    expect(await harness.state.readTokenIndex()).not.toBeNull()
  })

  it("skips normalization in --test mode", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    // Delete credentials.json to create disconnect scenario
    await harness.state.fileSystem.removeSecureFile(
      harness.state.paths.credentials
    )
    harness.keychain.values.clear()

    // --test should not normalize, but directly fail because state is not clean for test
    await expect(
      harness.auth.login({
        global: { ...GLOBAL, test: true },
        noWait: true,
        resume: false,
      })
    ).rejects.toMatchObject({ exitCode: 2 })
  })
})
