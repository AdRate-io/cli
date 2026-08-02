import { chmod, mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthService } from "../src/auth/auth-service.js"
import { AuthCleanupCoordinator } from "../src/auth/auth-cleanup-coordinator.js"
import { DevicePollCoordinator } from "../src/auth/device-poll-coordinator.js"
import { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import { CliApplication } from "../src/application.js"
import { DEVICE_DELIVERY_SAFETY_WINDOW_MS, M0_SCOPE } from "../src/constants.js"
import { HttpTransportError, PublicHttpClient } from "../src/http/client.js"
import { renderOutcome } from "../src/output.js"
import { runCli } from "../src/runner.js"
import { CredentialStore } from "../src/storage/credential-backend.js"
import { createCliPaths } from "../src/storage/paths.js"
import { SecureFileSystem } from "../src/storage/secure-files.js"
import { CliStateStore } from "../src/storage/state-store.js"
import type {
  ProcessIdentity,
  ProcessIdentityProbe,
  ProcessIdentityStatus,
} from "../src/auth/process-identity.js"
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
const POLL_OWNER_TOKEN = "55555555-5555-4555-8555-555555555555"
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
  processRegistry: TestProcessRegistry
  processIdentity: ProcessIdentity
  sleepCalls: { value: number }
}

class TestProcessRegistry {
  private readonly processes = new Map<number, string>()
  private readonly permissionUnknown = new Set<number>()
  private nextPid = 10_000

  createProcess(label: string): ProcessIdentity {
    const identity = {
      pid: this.nextPid++,
      fingerprint: `test-process:${label}:${this.nextPid}`,
    }
    this.processes.set(identity.pid, identity.fingerprint)
    return identity
  }

  probeFor(current: ProcessIdentity): ProcessIdentityProbe {
    return {
      current: () => Promise.resolve(current),
      inspect: (expected) => Promise.resolve(this.inspect(expected)),
    }
  }

  stop(identity: ProcessIdentity): void {
    this.processes.delete(identity.pid)
    this.permissionUnknown.delete(identity.pid)
  }

  reuse(identity: ProcessIdentity): void {
    this.processes.set(identity.pid, `${identity.fingerprint}:reused`)
  }

  denyProbe(identity: ProcessIdentity): void {
    this.permissionUnknown.add(identity.pid)
  }

  private inspect(expected: ProcessIdentity): ProcessIdentityStatus {
    if (this.permissionUnknown.has(expected.pid)) return "permission_unknown"
    const fingerprint = this.processes.get(expected.pid)
    if (fingerprint === undefined) return "dead"
    return fingerprint === expected.fingerprint ? "same_process" : "reused"
  }
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
  const processRegistry = new TestProcessRegistry()
  const processIdentity = processRegistry.createProcess("owner")
  const sleepCalls = { value: 0 }
  const local = new LocalCredentialCoordinator(state, credentials, {
    now: () => new Date(now.value),
    processIdentity: processRegistry.probeFor(processIdentity),
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
    processRegistry,
    processIdentity,
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
  const processIdentity = harness.processRegistry.createProcess("peer")
  const local = new LocalCredentialCoordinator(
    state,
    new CredentialStore(harness.keychain, harness.fallback),
    {
      now: () => new Date(harness.now.value),
      processIdentity: harness.processRegistry.probeFor(processIdentity),
    }
  )
  return {
    ...harness,
    state,
    local,
    transport,
    processIdentity,
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

function captureAcknowledgedStream(): {
  stream: {
    write: (value: string, callback: (error?: Error | null) => void) => boolean
  }
  read: () => string
  callbacks: () => number
} {
  let output = ""
  let callbackCount = 0
  return {
    stream: {
      write(value, callback) {
        output += value
        queueMicrotask(() => {
          callbackCount += 1
          callback()
        })
        return true
      },
    },
    read: () => output,
    callbacks: () => callbackCount,
  }
}

function createAuthCliApplication(auth: AuthService): CliApplication {
  return new CliApplication(
    auth,
    {
      execute() {
        return Promise.reject(
          new Error("auth entry must not call read service")
        )
      },
    } as never,
    {
      campaignStatus: { status: vi.fn() },
      commandQuery: { get: vi.fn() },
      pendingCommands: { pending: vi.fn() },
      commandResume: { resume: vi.fn() },
      skills: { list: vi.fn(), read: vi.fn() },
    }
  )
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
        capabilities: M0_SCOPE.split(" ").map((capabilityId, index) => ({
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

async function leaveAcknowledgedPollCrash(harness: Harness): Promise<void> {
  await issue(harness)
  harness.now.value += 5_000
  harness.transport.enqueue((input) =>
    response(input, 400, { error: "authorization_pending" })
  )
  const originalClearPoll = harness.state.clearDevicePollAttempt.bind(
    harness.state
  )
  let injected = false
  harness.state.clearDevicePollAttempt = () => {
    if (!injected) {
      injected = true
      return Promise.reject(
        new Error("simulated crash before acknowledged poll cleanup")
      )
    }
    return originalClearPoll()
  }
  await expect(
    harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
  ).rejects.toThrow("simulated crash")
  harness.state.clearDevicePollAttempt = originalClearPoll
  expect(await harness.state.readDevicePollAttempt()).toMatchObject({
    phase: "response_acknowledged",
  })
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
    pollAttemptOwnerToken: POLL_OWNER_TOKEN,
    deviceName: "test-device",
    tokenReceivedAt: "2026-07-31T02:00:00.000Z",
    storageKind: "keychain",
    storageCommit: null,
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
      })
    }
  })
  await harness.keychain.write(
    harness.local.credentials.addressFor(index),
    TOKEN
  )
  return index
}

type LogoutCleanupFailurePoint =
  | "prepared"
  | "keychain"
  | "credentials"
  | "device"
  | "token_index"
  | "reservation"

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
      deliveryVerificationAttemptedAt: null,
      terminalEvidence: null,
    })
  })
}

function injectLogoutCleanupFailure(
  harness: Harness,
  point: LogoutCleanupFailurePoint
): () => void {
  if (point === "prepared") {
    const original = harness.state.writeAuthCleanupReservation.bind(
      harness.state
    )
    let injected = false
    harness.state.writeAuthCleanupReservation = async (reservation) => {
      await original(reservation)
      if (!injected && reservation.phase === "prepared") {
        injected = true
        throw new Error("simulated prepared crash")
      }
    }
    return () => {
      harness.state.writeAuthCleanupReservation = original
    }
  }
  if (point === "keychain") {
    harness.keychain.onRemove = () =>
      Promise.reject(new Error("simulated Keychain delete crash"))
    return () => {
      harness.keychain.onRemove = null
    }
  }

  const target =
    point === "credentials"
      ? harness.state.paths.credentials
      : point === "device"
        ? harness.state.paths.deviceCurrent
        : point === "token_index"
          ? harness.state.paths.tokenIndex
          : harness.state.paths.authCleanupReservation
  const fileSystem = harness.state.fileSystem
  const original = fileSystem.removeSecureFile.bind(fileSystem)
  let injected = false
  fileSystem.removeSecureFile = async (path) => {
    const removed = await original(path)
    if (!injected && path === target) {
      injected = true
      throw new Error(`simulated ${point} pruning crash`)
    }
    return removed
  }
  return () => {
    fileSystem.removeSecureFile = original
  }
}

async function installCompleteCleanupFixture(harness: Harness): Promise<void> {
  await issue(harness)
  const device = (await harness.state.readDeviceState())!
  const index = await installStoredCredential(harness, true)
  index.deviceGeneration = device.generation
  index.pollAttemptOwnerToken = POLL_OWNER_TOKEN
  await harness.state.withAuthLock(async () => {
    await harness.state.writeTokenIndex(index)
    await harness.state.writeDeviceIssueReservation({
      formatVersion: 1,
      ownerToken: "77777777-7777-4777-8777-777777777777",
      environment: device.environment,
      issuerOrigin: device.issuerOrigin,
      clientInstanceId: device.clientInstanceId,
      deviceName: device.deviceName,
      createdAt: "2026-07-31T02:00:01.000Z",
    })
    await harness.state.writeDevicePollAttempt({
      formatVersion: 1,
      ownerToken: POLL_OWNER_TOKEN,
      deviceGeneration: device.generation,
      environment: device.environment,
      issuerOrigin: device.issuerOrigin,
      clientInstanceId: device.clientInstanceId,
      phase: "ready",
      deliveryVerification: false,
      storageKind: "keychain",
      ownerPid: harness.processIdentity.pid,
      ownerProcessFingerprint: harness.processIdentity.fingerprint,
      createdAt: "2026-07-31T02:00:01.000Z",
      dispatchedAt: null,
      verificationClaimedAt: null,
      responseAcknowledgement: null,
      leaseExpiresAt: "2026-07-31T02:00:46.000Z",
    })
  })
}

async function installExpiredStagingWithoutToken(
  harness: Harness
): Promise<{ tokenReceivedAt: string }> {
  await issue(harness)
  const device = (await harness.state.readDeviceState())!
  const tokenReceivedAt = "2026-07-31T02:00:05.000Z"
  await harness.state.withAuthLock(async () => {
    await harness.state.writeDeviceState({
      ...device,
      localState: "polling",
    })
    await harness.state.writeDevicePollAttempt({
      formatVersion: 1,
      ownerToken: POLL_OWNER_TOKEN,
      deviceGeneration: device.generation,
      environment: device.environment,
      issuerOrigin: device.issuerOrigin,
      clientInstanceId: device.clientInstanceId,
      phase: "dispatch_intent",
      deliveryVerification: false,
      storageKind: "keychain",
      ownerPid: 9_000,
      ownerProcessFingerprint: "test-process:crashed",
      createdAt: "2026-07-31T02:00:04.000Z",
      dispatchedAt: "2026-07-31T02:00:04.000Z",
      verificationClaimedAt: null,
      responseAcknowledgement: null,
      leaseExpiresAt: "2026-07-31T02:00:45.000Z",
    })
    await harness.state.writeTokenIndex({
      tokenIndexFormatVersion: 1,
      generation: TOKEN_GENERATION,
      state: "staging",
      environment: device.environment,
      issuerOrigin: device.issuerOrigin,
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
      clientInstanceId: device.clientInstanceId,
      deviceGeneration: device.generation,
      pollAttemptOwnerToken: POLL_OWNER_TOKEN,
      deviceName: device.deviceName,
      tokenReceivedAt,
      storageKind: "keychain",
      storageCommit: {
        transactionId: "88888888-8888-4888-8888-888888888888",
        ownerPid: 9_000,
        ownerProcessFingerprint: "test-process:crashed",
        leaseExpiresAt: "2026-07-31T02:00:45.000Z",
      },
    })
  })
  harness.now.value += 46_000
  return { tokenReceivedAt }
}

async function installStagingPollForIndex(
  harness: Harness,
  device: DeviceAuthorizationState,
  index: TokenIndex
): Promise<void> {
  const commit = index.storageCommit
  if (!commit) throw new Error("staging index must carry storage commit")
  await harness.state.withAuthLock(async () => {
    await harness.state.writeDeviceState({
      ...device,
      localState: "polling",
    })
    await harness.state.writeDevicePollAttempt({
      formatVersion: 1,
      ownerToken: index.pollAttemptOwnerToken,
      deviceGeneration: index.deviceGeneration,
      environment: index.environment,
      issuerOrigin: index.issuerOrigin,
      clientInstanceId: index.clientInstanceId,
      phase: "dispatch_intent",
      deliveryVerification: false,
      storageKind: index.storageKind,
      ownerPid: commit.ownerPid,
      ownerProcessFingerprint: commit.ownerProcessFingerprint,
      createdAt: "2026-07-31T02:00:04.000Z",
      dispatchedAt: index.tokenReceivedAt,
      verificationClaimedAt: null,
      responseAcknowledgement: null,
      leaseExpiresAt: commit.leaseExpiresAt,
    })
    await harness.state.writeTokenIndex(index)
  })
}

async function installTerminalCrashState(harness: Harness): Promise<void> {
  await issue(harness)
  harness.now.value += 5_000
  const coordinator = new DevicePollCoordinator(
    harness.local,
    () => new Date(harness.now.value)
  )
  const preparation = await coordinator.prepare()
  if (preparation.kind !== "select_backend") throw new Error("unreachable")
  const frozen = await coordinator.freezeBackend(preparation)
  const dispatched = await coordinator.markDispatchIntent(frozen)
  await harness.state.withAuthLock(() =>
    harness.state.writeDeviceState({
      ...dispatched.device,
      localState: "terminal",
      deviceCode: null,
      userCode: null,
      deliveryVerificationAttemptedAt: null,
      terminalEvidence: {
        acknowledgedAt: new Date(harness.now.value).toISOString(),
        attempt: dispatched.attempt,
      },
    })
  )
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
    const originalReadJournal = harness.state.readLogoutDeliveryJournal.bind(
      harness.state
    )
    let journalReads = 0
    harness.state.readLogoutDeliveryJournal = () => {
      journalReads += 1
      return originalReadJournal()
    }
    await expect(harness.auth.login(input)).rejects.toMatchObject({
      exitCode: 2,
    })
    expect(journalReads).toBe(0)
    expect(harness.transport.requests).toHaveLength(0)
    expect(harness.keychain.availabilityChecks).toBe(0)
    expect(harness.fallback.availabilityChecks).toBe(0)
    expect(harness.sleepCalls.value).toBe(0)
    expect(await harness.state.readConfig()).toBeNull()
    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readDeviceIssueReservation()).toBeNull()
  })

  it("rejects invalid login argv through real output callbacks before state access", async () => {
    const harness = await createHarness()
    const originalReadJournal = harness.state.readLogoutDeliveryJournal.bind(
      harness.state
    )
    let journalReads = 0
    harness.state.readLogoutDeliveryJournal = () => {
      journalReads += 1
      return originalReadJournal()
    }
    const stdout = captureAcknowledgedStream()
    const stderr = captureAcknowledgedStream()

    const exitCode = await runCli(
      createAuthCliApplication(harness.auth),
      ["auth", "login", "--test", "--resume", "--json"],
      { stdout: stdout.stream, stderr: stderr.stream }
    )

    expect(exitCode).toBe(2)
    expect(journalReads).toBe(0)
    expect(stdout.callbacks()).toBe(1)
    expect(JSON.parse(stdout.read())).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    expect(harness.transport.requests).toHaveLength(0)
    expect(harness.keychain.availabilityChecks).toBe(0)
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
            ownerToken: "77777777-7777-4777-8777-777777777777",
            environment: "production",
            issuerOrigin: "https://api.adrate.io",
            clientInstanceId: CLIENT_INSTANCE_ID,
            deviceName: null,
            createdAt: "2026-07-31T01:00:00.000Z",
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
          noWait: false,
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

  it("issues the exact five-scope request and never exposes device_code", async () => {
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
    expect(request.form?.get("scope")).toBe(M0_SCOPE)
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

  it("clears a delivery tombstone at safeRestartAt without issuing a new code until the next no-wait invocation", async () => {
    const harness = await createHarness()
    await issue(harness)
    const device = (await harness.state.readDeviceState())!
    const attemptedAt = new Date(NOW + 5_000).toISOString()
    const safeRestartAt = Math.max(
      new Date(device.expiresAt).getTime(),
      new Date(attemptedAt).getTime() + DEVICE_DELIVERY_SAFETY_WINDOW_MS
    )
    await harness.state.withAuthLock(() =>
      harness.state.writeDeviceState({
        ...device,
        localState: "delivery_unknown",
        deliveryVerificationAttemptedAt: attemptedAt,
      })
    )
    harness.now.value = safeRestartAt
    const requestCount = harness.transport.requests.length

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).rejects.toMatchObject({
      exitCode: 3,
      envelope: {
        error: {
          code: "CREDENTIAL_EXPIRED",
          details: {
            deliveryState: "safe_restart_cleared",
            safeRestartAt: new Date(safeRestartAt).toISOString(),
          },
        },
      },
    })
    expect(harness.transport.requests).toHaveLength(requestCount)
    expect(await harness.state.readDeviceState()).toBeNull()

    enqueueDeviceCode(harness)
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).resolves.toMatchObject({ exitCode: 0 })
    expect(harness.transport.requests).toHaveLength(requestCount + 1)
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
      const competitor = createPeer(harness)
      const competitorOutcome = await competitor.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
      expect(competitorOutcome.exitCode).toBe(4)
      expect(competitor.transport.requests).toHaveLength(0)
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

  it("fences concurrent resume to one Token POST and preserves the winner", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    const peer = createPeer(harness)
    const entered = gate<void>()
    const release = gate<void>()
    harness.transport.enqueue(async (input) => {
      const attempt = await harness.state.readDevicePollAttempt()
      expect(attempt).toMatchObject({
        phase: "dispatch_intent",
        storageKind: "keychain",
      })
      expect(await harness.state.readTokenIndex()).toBeNull()
      entered.resolve(undefined)
      await release.promise
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

    const winner = harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    await entered.promise
    const loser = await peer.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    expect(loser.exitCode).toBe(4)
    expect(peer.transport.requests).toHaveLength(0)

    release.resolve(undefined)
    expect((await winner).exitCode).toBe(0)
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(1)
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "stored",
      storageKind: "keychain",
    })
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
        phase: "dispatch_intent",
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

  it("lets only the poll owner persist authorization_pending", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    const peer = createPeer(harness)
    const entered = gate<void>()
    const release = gate<void>()
    harness.transport.enqueue(async (input) => {
      entered.resolve(undefined)
      await release.promise
      return response(input, 400, { error: "authorization_pending" })
    })
    const owner = harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    await entered.promise
    const contender = await peer.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    expect(contender.exitCode).toBe(4)
    expect(peer.transport.requests).toHaveLength(0)
    release.resolve(undefined)
    expect((await owner).exitCode).toBe(4)
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "polling",
      nextPollAt: "2026-07-31T02:00:10.000Z",
    })
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
  })

  it("lets only the poll owner clear an expired Device flow", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    const peer = createPeer(harness)
    const entered = gate<void>()
    const release = gate<void>()
    harness.transport.enqueue(async (input) => {
      entered.resolve(undefined)
      await release.promise
      return response(input, 400, { error: "expired_token" })
    })
    const owner = harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    await entered.promise
    const contender = await peer.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    expect(contender.exitCode).toBe(4)
    expect(peer.transport.requests).toHaveLength(0)
    release.resolve(undefined)
    await expect(owner).rejects.toMatchObject({ exitCode: 3 })
    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
  })

  it("recovers an abandoned dispatch intent as delivery_unknown without replay", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    const peer = createPeer(harness)
    const entered = gate<void>()
    const lateResponse = gate<HttpResponse>()
    harness.transport.enqueue((input) => {
      entered.resolve(undefined)
      return lateResponse.promise.then(() =>
        response(input, 400, { error: "authorization_pending" })
      )
    })
    const oldOwner = harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    await entered.promise

    harness.now.value += 46_000
    await expect(
      peer.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({
      exitCode: 5,
      envelope: {
        error: {
          details: { deliveryState: "delivery_unknown" },
        },
      },
    })
    expect(peer.transport.requests).toHaveLength(0)
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
    })
    expect(await harness.state.readDevicePollAttempt()).toBeNull()

    lateResponse.resolve(
      response(
        {
          method: "POST",
          issuerOrigin: "https://api.adrate.io",
          path: "/oauth/token",
          deadlineMs: 15_000,
        },
        400,
        { error: "authorization_pending" }
      )
    )
    await expect(oldOwner).rejects.toMatchObject({ exitCode: 4 })
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
    })
  })

  it("fences delivery_unknown verification to one cross-process attempt", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.transport.enqueue(() =>
      Promise.reject(new HttpTransportError("network", "lost"))
    )
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 5 })
    expect(
      (await harness.state.readDeviceState())?.deliveryVerificationAttemptedAt
    ).toBeNull()

    harness.now.value += 5_000
    harness.transport.enqueue(() =>
      Promise.reject(new HttpTransportError("timeout", "lost"))
    )
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 5 })
    const afterVerification = await harness.state.readDeviceState()
    expect(afterVerification?.deliveryVerificationAttemptedAt).toBe(
      "2026-07-31T02:00:10.000Z"
    )
    expect(harness.transport.requests).toHaveLength(3)

    harness.now.value += 60_000
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 5 })
    expect(harness.transport.requests).toHaveLength(3)
  })

  it("stores the Token before /me and scrubs Device secrets", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    enqueueToken(harness)
    enqueueMe(harness)
    let acquiredDuringKeychainWrite = false
    harness.keychain.onWrite = (address) =>
      address.credentialId === CREDENTIAL_ID
        ? harness.state.withAuthLock(async () => {
            acquiredDuringKeychainWrite = true
            expect(await harness.state.readTokenIndex()).toMatchObject({
              state: "staging",
              storageKind: "keychain",
            })
            expect(await harness.state.readDevicePollAttempt()).toMatchObject({
              phase: "dispatch_intent",
              storageKind: "keychain",
            })
          })
        : Promise.resolve()

    const outcome = await harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    expect(outcome.exitCode).toBe(0)
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "stored",
      credentialId: CREDENTIAL_ID,
      storageKind: "keychain",
    })
    expect(await harness.state.readCredentials()).toMatchObject({
      credentialId: CREDENTIAL_ID,
      teamId: 7,
    })
    expect(await harness.state.readDeviceState()).toBeNull()
    expect([...harness.keychain.values.values()]).toEqual([TOKEN])
    expect(acquiredDuringKeychainWrite).toBe(true)
  })

  it("keeps a live staging owner fenced before and after lease expiry", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    enqueueToken(harness)
    enqueueMe(harness)
    const peer = createPeer(harness)
    const enteredStorageCommit = gate<void>()
    const releaseStorageCommit = gate<void>()
    harness.keychain.onWrite = async (address) => {
      if (address.issuerOrigin.endsWith(".invalid")) return
      enteredStorageCommit.resolve(undefined)
      await releaseStorageCommit.promise
    }

    const owner = harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    await enteredStorageCommit.promise
    const staging = await harness.state.readTokenIndex()
    expect(staging).toMatchObject({
      state: "staging",
      storageCommit: {
        ownerPid: harness.processIdentity.pid,
        ownerProcessFingerprint: harness.processIdentity.fingerprint,
      },
    })
    const protectedPaths = [
      harness.state.paths.tokenIndex,
      harness.state.paths.deviceCurrent,
      harness.state.paths.devicePollAttempt,
    ]
    const identitiesBefore = await Promise.all(
      protectedPaths.map(async (path) => {
        const value = await stat(path)
        return { ino: value.ino, mtimeMs: value.mtimeMs }
      })
    )

    expect((await peer.auth.status(GLOBAL)).exitCode).toBe(4)
    await expect(peer.auth.whoami(GLOBAL)).rejects.toMatchObject({
      exitCode: 4,
    })
    await expect(
      peer.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 4 })
    expect(peer.transport.requests).toHaveLength(0)

    harness.now.value += 46_000
    expect((await peer.auth.status(GLOBAL)).exitCode).toBe(4)
    harness.processRegistry.denyProbe(harness.processIdentity)
    await expect(peer.auth.whoami(GLOBAL)).rejects.toMatchObject({
      exitCode: 4,
    })
    const identitiesAfter = await Promise.all(
      protectedPaths.map(async (path) => {
        const value = await stat(path)
        return { ino: value.ino, mtimeMs: value.mtimeMs }
      })
    )
    expect(identitiesAfter).toEqual(identitiesBefore)
    expect(peer.transport.requests).toHaveLength(0)

    releaseStorageCommit.resolve(undefined)
    expect((await owner).exitCode).toBe(0)
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "stored",
      storageCommit: null,
    })
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
  })

  it("recovers a staging index with a durably stored Token", async () => {
    const harness = await createHarness()
    await issue(harness)
    const device = (await harness.state.readDeviceState())!
    const index: TokenIndex = {
      tokenIndexFormatVersion: 1,
      generation: TOKEN_GENERATION,
      state: "staging",
      environment: device.environment,
      issuerOrigin: device.issuerOrigin,
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
      clientInstanceId: device.clientInstanceId,
      deviceGeneration: device.generation,
      pollAttemptOwnerToken: POLL_OWNER_TOKEN,
      deviceName: device.deviceName,
      tokenReceivedAt: "2026-07-31T02:00:05.000Z",
      storageKind: "keychain",
      storageCommit: {
        transactionId: "77777777-7777-4777-8777-777777777777",
        ownerPid: harness.processIdentity.pid,
        ownerProcessFingerprint: harness.processIdentity.fingerprint,
        leaseExpiresAt: "2026-07-31T02:00:45.000Z",
      },
    }
    await installStagingPollForIndex(harness, device, index)
    await harness.keychain.write(
      harness.local.credentials.addressFor(index),
      TOKEN
    )
    let acquiredDuringRead = false
    harness.keychain.onRead = () =>
      harness.state.withAuthLock(() => {
        acquiredDuringRead = true
        return Promise.resolve()
      })

    harness.processRegistry.reuse(harness.processIdentity)
    harness.now.value += 46_000
    const recovered = await harness.local.inspectAndRecover()
    expect(recovered).toMatchObject({
      state: "located",
      index: { state: "stored", credentialId: CREDENTIAL_ID },
    })
    expect(acquiredDuringRead).toBe(true)
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "token_received",
      deviceCode: null,
      userCode: null,
    })
  })

  it("derives the warning from a fallback staging index during process recovery", async () => {
    const harness = await createHarness()
    await issue(harness)
    const device = (await harness.state.readDeviceState())!
    const index: TokenIndex = {
      tokenIndexFormatVersion: 1,
      generation: TOKEN_GENERATION,
      state: "staging",
      environment: device.environment,
      issuerOrigin: device.issuerOrigin,
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
      clientInstanceId: device.clientInstanceId,
      deviceGeneration: device.generation,
      pollAttemptOwnerToken: POLL_OWNER_TOKEN,
      deviceName: device.deviceName,
      tokenReceivedAt: "2026-07-31T02:00:05.000Z",
      storageKind: "fallback_file",
      storageCommit: {
        transactionId: "77777777-7777-4777-8777-777777777777",
        ownerPid: harness.processIdentity.pid,
        ownerProcessFingerprint: harness.processIdentity.fingerprint,
        leaseExpiresAt: "2026-07-31T02:00:45.000Z",
      },
    }
    await installStagingPollForIndex(harness, device, index)
    await harness.fallback.write(
      harness.local.credentials.addressFor(index),
      TOKEN
    )
    harness.processRegistry.reuse(harness.processIdentity)
    harness.now.value += 46_000
    enqueueMe(harness)

    const outcome = await harness.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.warnings).toContain(
      "OS Keychain is unavailable; using the protected local token file."
    )
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "stored",
      storageKind: "fallback_file",
    })
  })

  it("preserves the fallback warning when finalization cannot be confirmed", async () => {
    const harness = await createHarness()
    harness.keychain.available = false
    await issue(harness)
    harness.now.value += 5_000
    enqueueToken(harness)
    harness.fallback.onRead = (address) =>
      address.issuerOrigin.endsWith(".invalid")
        ? Promise.resolve()
        : Promise.reject(new Error("simulated finalize crash"))

    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({
      exitCode: 5,
      warnings: [
        "OS Keychain is unavailable; using the protected local token file.",
      ],
    })
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "staging",
      storageKind: "fallback_file",
    })
  })

  it("fences a staging crash with no stored Token as delivery_unknown", async () => {
    const harness = await createHarness()
    await issue(harness)
    const device = (await harness.state.readDeviceState())!
    const tokenReceivedAt = "2026-07-31T02:00:05.000Z"
    await harness.state.withAuthLock(() =>
      harness.state.writeTokenIndex({
        tokenIndexFormatVersion: 1,
        generation: TOKEN_GENERATION,
        state: "staging",
        environment: device.environment,
        issuerOrigin: device.issuerOrigin,
        credentialKind: "owner_cli_session",
        credentialId: CREDENTIAL_ID,
        clientInstanceId: device.clientInstanceId,
        deviceGeneration: device.generation,
        pollAttemptOwnerToken: POLL_OWNER_TOKEN,
        deviceName: device.deviceName,
        tokenReceivedAt,
        storageKind: "keychain",
        storageCommit: {
          transactionId: "77777777-7777-4777-8777-777777777777",
          ownerPid: 9_000,
          ownerProcessFingerprint: "test-process:crashed",
          leaseExpiresAt: "2026-07-31T02:00:45.000Z",
        },
      })
    )

    await expect(harness.local.inspectAndRecover()).rejects.toMatchObject({
      exitCode: 4,
      envelope: {
        error: {
          details: { localTransaction: "storage_commit_busy" },
        },
      },
    })
    expect(await harness.state.readTokenIndex()).toMatchObject({
      state: "staging",
    })
    harness.now.value += 46_000
    await expect(harness.local.inspectAndRecover()).rejects.toMatchObject({
      exitCode: 5,
    })
    expect(await harness.state.readTokenIndex()).toBeNull()
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
      deliveryVerificationAttemptedAt: tokenReceivedAt,
    })
    const logout = await harness.auth.logout(GLOBAL)
    expect(logout).toMatchObject({
      exitCode: 5,
      envelope: {
        error: { details: { deliveryState: "delivery_unknown" } },
      },
    })
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
      deliveryVerificationAttemptedAt: tokenReceivedAt,
    })
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).rejects.toMatchObject({ exitCode: 2 })
  })
})

describe("crash-safe local authentication transactions", () => {
  it("retries the frozen secret deletion after a crash before the phase CAS", async () => {
    const harness = await createHarness()
    await installCompleteCleanupFixture(harness)
    const cleanup = new AuthCleanupCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    const expected = await harness.local.captureIdentity()
    const requestCount = harness.transport.requests.length
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
    expect(await harness.state.readAuthCleanupReservation()).toMatchObject({
      phase: "prepared",
      credentialLocator: {
        credentialId: CREDENTIAL_ID,
        storageKind: "keychain",
      },
    })
    expect(harness.keychain.values.size).toBe(0)

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).rejects.toMatchObject({ exitCode: 2 })
    expect(harness.transport.requests).toHaveLength(requestCount)

    harness.keychain.onRemove = null
    await expect(cleanup.clearIfUnchanged(expected)).resolves.toBe("cleared")
    expect(await harness.state.readAuthCleanupReservation()).toBeNull()
    expect(await harness.state.readTokenIndex()).toBeNull()
  })

  it("does not repeat secret deletion after secret_removed was durably written", async () => {
    const harness = await createHarness()
    await installCompleteCleanupFixture(harness)
    const cleanup = new AuthCleanupCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    const expected = await harness.local.captureIdentity()
    const originalWrite = harness.state.writeAuthCleanupReservation.bind(
      harness.state
    )
    let injected = false
    harness.state.writeAuthCleanupReservation = async (reservation) => {
      await originalWrite(reservation)
      if (!injected && reservation.phase === "secret_removed") {
        injected = true
        throw new Error("simulated crash after phase CAS")
      }
    }

    await expect(cleanup.clearIfUnchanged(expected)).rejects.toThrow(
      "simulated crash"
    )
    expect(await harness.state.readAuthCleanupReservation()).toMatchObject({
      phase: "secret_removed",
    })
    expect(harness.keychain.removes).toBe(1)

    harness.state.writeAuthCleanupReservation = originalWrite
    await expect(cleanup.clearIfUnchanged(expected)).resolves.toBe("cleared")
    expect(harness.keychain.removes).toBe(1)
  })

  it.each([
    "credentials",
    "deviceCurrent",
    "deviceIssueReservation",
    "devicePollAttempt",
    "tokenIndex",
    "authCleanupReservation",
  ] as const)(
    "resumes pruning after a crash immediately after deleting %s",
    async (pathKey) => {
      const harness = await createHarness()
      await installCompleteCleanupFixture(harness)
      const cleanup = new AuthCleanupCoordinator(
        harness.local,
        () => new Date(harness.now.value)
      )
      const expected = await harness.local.captureIdentity()
      const target = harness.state.paths[pathKey]
      const fileSystem = harness.state.fileSystem
      const originalRemove = fileSystem.removeSecureFile.bind(fileSystem)
      let injected = false
      fileSystem.removeSecureFile = async (path) => {
        const removed = await originalRemove(path)
        if (!injected && path === target) {
          injected = true
          throw new Error(`simulated crash after ${pathKey}`)
        }
        return removed
      }

      await expect(cleanup.clearIfUnchanged(expected)).rejects.toThrow(
        "simulated crash"
      )
      fileSystem.removeSecureFile = originalRemove
      const requestCount = harness.transport.requests.length
      await expect(harness.auth.logout(GLOBAL)).resolves.toMatchObject({
        exitCode: pathKey === "authCleanupReservation" ? 0 : 5,
      })
      expect(harness.transport.requests).toHaveLength(requestCount)

      const final = await harness.state.withAuthLock(() =>
        harness.local.readLocalSnapshotLocked()
      )
      expect(final).toMatchObject({
        index: null,
        metadata: null,
        device: null,
        issueReservation: null,
        pollAttempt: null,
        cleanupReservation: null,
        fallbackExists: false,
      })
    }
  )

  it("resumes partial pruning with the original pre-cleanup identity", async () => {
    const harness = await createHarness()
    await installCompleteCleanupFixture(harness)
    const cleanup = new AuthCleanupCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    const expected = await harness.local.captureIdentity()
    const fileSystem = harness.state.fileSystem
    const originalRemove = fileSystem.removeSecureFile.bind(fileSystem)
    let injected = false
    fileSystem.removeSecureFile = async (path) => {
      const removed = await originalRemove(path)
      if (!injected && path === harness.state.paths.deviceCurrent) {
        injected = true
        throw new Error("simulated pruning crash")
      }
      return removed
    }

    await expect(cleanup.clearIfUnchanged(expected)).rejects.toThrow(
      "simulated pruning crash"
    )
    fileSystem.removeSecureFile = originalRemove
    await expect(cleanup.clearIfUnchanged(expected)).resolves.toBe("cleared")
  })

  it("does not turn an observed cleanup reservation into a new-generation cleanup after ABA", async () => {
    const harness = await createHarness()
    await installCompleteCleanupFixture(harness)
    const cleanup = new AuthCleanupCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    let injected = false
    harness.keychain.onRemove = (address) => {
      if (!injected && address.credentialId === CREDENTIAL_ID) {
        injected = true
        harness.keychain.values.delete(addressKey(address))
        return Promise.reject(new Error("simulated cleanup pause"))
      }
      return Promise.resolve()
    }
    await expect(
      cleanup.clearIfUnchanged(await harness.local.captureIdentity())
    ).rejects.toThrow("simulated cleanup pause")
    harness.keychain.onRemove = null
    const observed = (await harness.state.readAuthCleanupReservation())!

    const peerCleanup = new AuthCleanupCoordinator(
      createPeer(harness).local,
      () => new Date(harness.now.value)
    )
    await expect(peerCleanup.resumeExisting(observed)).resolves.toBe("cleared")
    const replacement = await installStoredCredential(harness, true)
    replacement.generation = "99999999-9999-4999-8999-999999999999"
    await harness.state.withAuthLock(() =>
      harness.state.writeTokenIndex(replacement)
    )

    await expect(cleanup.resumeExisting(observed)).resolves.toBe("stale")
    expect(await harness.state.readTokenIndex()).toMatchObject({
      generation: replacement.generation,
    })
    expect([...harness.keychain.values.values()]).toEqual([TOKEN])
  })

  it("keeps a new fallback Token when an old cleanup resumes after three-party ABA", async () => {
    const harness = await createHarness()
    await installCompleteCleanupFixture(harness)
    const oldIndex = (await harness.state.readTokenIndex())!
    const oldPoll = (await harness.state.readDevicePollAttempt())!
    await harness.keychain.remove(
      harness.local.credentials.addressFor(oldIndex)
    )
    const fallbackIndex: TokenIndex = {
      ...oldIndex,
      storageKind: "fallback_file",
    }
    await harness.state.withAuthLock(async () => {
      await harness.state.writeTokenIndex(fallbackIndex)
      await harness.state.writeDevicePollAttempt({
        ...oldPoll,
        storageKind: "fallback_file",
      })
    })
    await harness.fallback.write(
      harness.local.credentials.addressFor(fallbackIndex),
      TOKEN
    )

    const cleanup = new AuthCleanupCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    const entered = gate<void>()
    const release = gate<void>()
    const originalKeychainRemoval =
      harness.local.credentials.removeKeychainAuthenticationArtifactAt.bind(
        harness.local.credentials
      )
    let calls = 0
    harness.local.credentials.removeKeychainAuthenticationArtifactAt = async (
      locator
    ) => {
      calls += 1
      await originalKeychainRemoval(locator)
      if (calls === 1) {
        entered.resolve(undefined)
        await release.promise
      }
    }

    const oldCleanup = cleanup.clearIfUnchanged(
      await harness.local.captureIdentity()
    )
    await entered.promise
    expect(harness.fallback.values.size).toBe(0)
    const observed = (await harness.state.readAuthCleanupReservation())!
    const peerCleanup = new AuthCleanupCoordinator(
      createPeer(harness).local,
      () => new Date(harness.now.value)
    )
    await expect(peerCleanup.resumeExisting(observed)).resolves.toBe("cleared")

    const replacement = await installStoredCredential(harness, true)
    await harness.keychain.remove(
      harness.local.credentials.addressFor(replacement)
    )
    replacement.generation = "99999999-9999-4999-8999-999999999999"
    replacement.storageKind = "fallback_file"
    await harness.state.withAuthLock(() =>
      harness.state.writeTokenIndex(replacement)
    )
    await harness.fallback.write(
      harness.local.credentials.addressFor(replacement),
      TOKEN
    )

    release.resolve(undefined)
    await expect(oldCleanup).rejects.toMatchObject({ exitCode: 4 })
    harness.local.credentials.removeKeychainAuthenticationArtifactAt =
      originalKeychainRemoval
    expect(await harness.state.readTokenIndex()).toMatchObject({
      generation: replacement.generation,
      storageKind: "fallback_file",
    })
    expect([...harness.fallback.values.values()]).toEqual([TOKEN])
  })

  it("resumes cleanup before normalizing an expired orphaned poll attempt", async () => {
    const harness = await createHarness()
    await installCompleteCleanupFixture(harness)
    const cleanup = new AuthCleanupCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    const fileSystem = harness.state.fileSystem
    const originalRemove = fileSystem.removeSecureFile.bind(fileSystem)
    let injected = false
    fileSystem.removeSecureFile = async (path) => {
      const removed = await originalRemove(path)
      if (!injected && path === harness.state.paths.deviceCurrent) {
        injected = true
        throw new Error("simulated crash after old Device delete")
      }
      return removed
    }

    await expect(
      cleanup.clearIfUnchanged(await harness.local.captureIdentity())
    ).rejects.toThrow("simulated crash")
    fileSystem.removeSecureFile = originalRemove
    harness.now.value += 60_000
    const requestCount = harness.transport.requests.length

    await expect(harness.auth.logout(GLOBAL)).resolves.toMatchObject({
      exitCode: 5,
    })
    expect(harness.transport.requests).toHaveLength(requestCount)
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
    expect(await harness.state.readAuthCleanupReservation()).toBeNull()
  })

  it("resumes cleanup before delivery_unknown remediation", async () => {
    const harness = await createHarness()
    await installCompleteCleanupFixture(harness)
    const device = (await harness.state.readDeviceState())!
    const poll = (await harness.state.readDevicePollAttempt())!
    const attemptedAt = "2026-07-31T02:00:02.000Z"
    await harness.state.withAuthLock(async () => {
      await harness.state.writeDeviceState({
        ...device,
        localState: "delivery_unknown",
        deliveryVerificationAttemptedAt: attemptedAt,
      })
      await harness.state.writeDevicePollAttempt({
        ...poll,
        phase: "dispatch_intent",
        deliveryVerification: true,
        dispatchedAt: attemptedAt,
        verificationClaimedAt: attemptedAt,
      })
    })
    const cleanup = new AuthCleanupCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    let injected = false
    harness.keychain.onRemove = (address) => {
      if (!injected && address.credentialId === CREDENTIAL_ID) {
        injected = true
        harness.keychain.values.delete(addressKey(address))
        return Promise.reject(new Error("simulated crash after secret delete"))
      }
      return Promise.resolve()
    }

    await expect(
      cleanup.clearIfUnchanged(await harness.local.captureIdentity())
    ).rejects.toThrow("simulated crash")
    harness.keychain.onRemove = null
    const requestCount = harness.transport.requests.length

    await expect(harness.auth.logout(GLOBAL)).resolves.toMatchObject({
      exitCode: 5,
      envelope: {
        error: {
          details: { resolutionEnvironment: "production" },
        },
      },
    })
    expect(harness.transport.requests).toHaveLength(requestCount)
    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readAuthCleanupReservation()).toBeNull()
  })

  it("fails closed without deleting a different generation during pruning recovery", async () => {
    const harness = await createHarness()
    await installCompleteCleanupFixture(harness)
    const cleanup = new AuthCleanupCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    const originalDevice = (await harness.state.readDeviceState())!
    const fileSystem = harness.state.fileSystem
    const originalRemove = fileSystem.removeSecureFile.bind(fileSystem)
    let injected = false
    fileSystem.removeSecureFile = async (path) => {
      const removed = await originalRemove(path)
      if (!injected && path === harness.state.paths.deviceCurrent) {
        injected = true
        throw new Error("simulated crash after old Device delete")
      }
      return removed
    }
    await expect(
      cleanup.clearIfUnchanged(await harness.local.captureIdentity())
    ).rejects.toThrow("simulated crash")
    fileSystem.removeSecureFile = originalRemove

    const replacementGeneration = "99999999-9999-4999-8999-999999999999"
    await harness.state.withAuthLock(() =>
      harness.state.writeDeviceState({
        ...originalDevice,
        generation: replacementGeneration,
      })
    )
    await expect(
      cleanup.clearIfUnchanged(await harness.local.captureIdentity())
    ).rejects.toMatchObject({ exitCode: 4 })
    expect(await harness.state.readDeviceState()).toMatchObject({
      generation: replacementGeneration,
    })
  })

  it.each(["device", "poll", "index"] as const)(
    "recovers the staging no-token transaction after the %s step crashes",
    async (crashStep) => {
      const harness = await createHarness()
      const { tokenReceivedAt } =
        await installExpiredStagingWithoutToken(harness)
      const originalWriteDevice = harness.state.writeDeviceState.bind(
        harness.state
      )
      const originalClearPoll = harness.state.clearDevicePollAttempt.bind(
        harness.state
      )
      const fileSystem = harness.state.fileSystem
      const originalRemove = fileSystem.removeSecureFile.bind(fileSystem)
      let injected = false
      if (crashStep === "device") {
        harness.state.writeDeviceState = async (device) => {
          await originalWriteDevice(device)
          if (!injected && device.localState === "delivery_unknown") {
            injected = true
            throw new Error("simulated staging Device crash")
          }
        }
      } else if (crashStep === "poll") {
        harness.state.clearDevicePollAttempt = async () => {
          await originalClearPoll()
          if (!injected) {
            injected = true
            throw new Error("simulated staging poll crash")
          }
        }
      } else {
        fileSystem.removeSecureFile = async (path) => {
          const removed = await originalRemove(path)
          if (!injected && path === harness.state.paths.tokenIndex) {
            injected = true
            throw new Error("simulated staging index crash")
          }
          return removed
        }
      }

      await expect(harness.local.inspectAndRecover()).rejects.toThrow(
        "simulated staging"
      )
      harness.state.writeDeviceState = originalWriteDevice
      harness.state.clearDevicePollAttempt = originalClearPoll
      fileSystem.removeSecureFile = originalRemove
      expect(await harness.state.readDeviceState()).toMatchObject({
        localState: "delivery_unknown",
        deliveryVerificationAttemptedAt: tokenReceivedAt,
      })

      const before = harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      ).length
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
        ).rejects.toMatchObject({ exitCode: 5 })
      }
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/oauth/token"
        )
      ).toHaveLength(before)
      expect(await harness.state.readTokenIndex()).toBeNull()
      expect(await harness.state.readDevicePollAttempt()).toBeNull()
    }
  )

  it("re-enters prepare when concurrent staging recovery removes the observed index", async () => {
    const harness = await createHarness()
    await installExpiredStagingWithoutToken(harness)
    const peer = createPeer(harness)
    const entered = gate<void>()
    const release = gate<void>()
    const originalInspect = peer.local.inspectAndRecover.bind(peer.local)
    peer.local.inspectAndRecover = async () => {
      entered.resolve(undefined)
      await release.promise
      return originalInspect()
    }

    const contender = peer.auth.login({
      global: GLOBAL,
      noWait: false,
      resume: true,
    })
    await entered.promise
    await expect(harness.local.inspectAndRecover()).rejects.toMatchObject({
      exitCode: 5,
    })
    release.resolve(undefined)

    await expect(contender).rejects.toMatchObject({ exitCode: 5 })
    await expect(
      createPeer(harness).auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
    ).rejects.toMatchObject({ exitCode: 5 })
    expect(peer.transport.requests).toHaveLength(0)
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(0)
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
      phase: "dispatch_intent",
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

  it.each(
    (["ack_after_write", "device_before_clear"] as const).flatMap(
      (crashPoint) =>
        (
          [
            "authorization_pending",
            "slow_down",
            "temporarily_unavailable",
            "oauth_error",
            "invalid_slow_down",
          ] as const
        ).map((responseKind) => ({ crashPoint, responseKind }))
    )
  )(
    "locally recovers $responseKind after $crashPoint without another Token POST",
    async ({ crashPoint, responseKind }) => {
      const harness = await createHarness()
      await issue(harness)
      await harness.state.withAuthLock(async () => {
        const device = (await harness.state.readDeviceState())!
        await harness.state.writeDeviceState({
          ...device,
          expiresAt: new Date(NOW + 2 * 86_400_000).toISOString(),
        })
      })
      harness.now.value += 5_000
      if (responseKind === "authorization_pending") {
        harness.transport.enqueue((input) =>
          response(input, 400, { error: responseKind })
        )
      } else if (responseKind === "slow_down") {
        harness.transport.enqueue((input) =>
          response(input, 400, { error: responseKind }, { "retry-after": "12" })
        )
      } else if (responseKind === "temporarily_unavailable") {
        harness.transport.enqueue((input) =>
          response(
            input,
            503,
            { error: responseKind },
            { "retry-after": "600" }
          )
        )
      } else if (responseKind === "oauth_error") {
        harness.transport.enqueue((input) =>
          response(input, 400, { error: "invalid_scope" })
        )
      } else {
        harness.transport.enqueue((input) =>
          response(input, 400, { error: "slow_down" })
        )
      }

      const originalWriteAttempt = harness.state.writeDevicePollAttempt.bind(
        harness.state
      )
      const originalClearPoll = harness.state.clearDevicePollAttempt.bind(
        harness.state
      )
      let injected = false
      if (crashPoint === "ack_after_write") {
        harness.state.writeDevicePollAttempt = async (attempt) => {
          await originalWriteAttempt(attempt)
          if (!injected && attempt.phase === "response_acknowledged") {
            injected = true
            throw new Error("simulated crash after response acknowledgement")
          }
        }
      } else {
        harness.state.clearDevicePollAttempt = () => {
          if (!injected) {
            injected = true
            return Promise.reject(
              new Error("simulated crash before acknowledged poll cleanup")
            )
          }
          return originalClearPoll()
        }
      }

      await expect(
        harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
      ).rejects.toThrow("simulated crash")
      harness.state.writeDevicePollAttempt = originalWriteAttempt
      harness.state.clearDevicePollAttempt = originalClearPoll

      const expectedInterval = responseKind === "slow_down" ? 12 : 5
      const expectedDelay =
        responseKind === "temporarily_unavailable" ? 600 : expectedInterval
      const expectedResponseKind =
        responseKind === "invalid_slow_down" ? "oauth_error" : responseKind
      const expectedNextPollAt = new Date(
        harness.now.value + expectedDelay * 1000
      ).toISOString()
      expect(await harness.state.readDevicePollAttempt()).toMatchObject({
        phase: "response_acknowledged",
        responseAcknowledgement: {
          responseKind: expectedResponseKind,
          responseReceivedAt: "2026-07-31T02:00:05.000Z",
          previousProtocolIntervalSeconds: 5,
          protocolIntervalSeconds: expectedInterval,
          retryAfterSeconds:
            responseKind === "slow_down"
              ? 12
              : responseKind === "temporarily_unavailable"
                ? 600
                : null,
          nextPollAt: expectedNextPollAt,
        },
      })

      const restarted = createPeer(harness)
      const recovered = restarted.auth.login({
        global: GLOBAL,
        noWait: false,
        resume: true,
      })
      if (responseKind === "temporarily_unavailable") {
        await expect(recovered).rejects.toMatchObject({
          exitCode: 4,
          envelope: {
            error: {
              details: {
                oauthError: "temporarily_unavailable",
                retryAfterSeconds: expectedDelay,
              },
            },
          },
        })
      } else if (
        responseKind === "oauth_error" ||
        responseKind === "invalid_slow_down"
      ) {
        await expect(recovered).rejects.toMatchObject({
          exitCode: 1,
          envelope: {
            error: { details: { responseKind: "oauth_error" } },
          },
        })
      } else {
        await expect(recovered).resolves.toMatchObject({
          exitCode: 4,
          envelope: {
            error: { details: { oauthError: responseKind } },
          },
        })
      }
      expect(restarted.transport.requests).toHaveLength(0)
      expect(await harness.state.readDevicePollAttempt()).toBeNull()
      expect(await harness.state.readDeviceState()).toMatchObject({
        localState: "polling",
        intervalSeconds: expectedInterval,
        nextPollAt: expectedNextPollAt,
        deliveryVerificationAttemptedAt: null,
      })
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/oauth/token"
        )
      ).toHaveLength(1)
    }
  )

  it.each([
    {
      responseKind: "authorization_pending",
      previousProtocolIntervalSeconds: 6,
      protocolIntervalSeconds: 6,
      retryAfterSeconds: null,
      nextPollAt: "2026-07-31T02:00:11.000Z",
    },
    {
      responseKind: "temporarily_unavailable",
      previousProtocolIntervalSeconds: 5,
      protocolIntervalSeconds: 5,
      retryAfterSeconds: 600,
      nextPollAt: "2026-07-31T02:10:05.000Z",
    },
    {
      responseKind: "oauth_error",
      previousProtocolIntervalSeconds: 6,
      protocolIntervalSeconds: 6,
      retryAfterSeconds: null,
      nextPollAt: "2026-07-31T02:00:11.000Z",
    },
    {
      responseKind: "slow_down",
      previousProtocolIntervalSeconds: 6,
      protocolIntervalSeconds: 11,
      retryAfterSeconds: 3,
      nextPollAt: "2026-07-31T02:00:16.000Z",
    },
  ] as const)(
    "rejects an individually valid $responseKind acknowledgement whose previous interval conflicts with Device",
    async (facts) => {
      const harness = await createHarness()
      await leaveAcknowledgedPollCrash(harness)
      const attempt = (await harness.state.readDevicePollAttempt())!
      await harness.state.writeDevicePollAttempt({
        ...attempt,
        responseAcknowledgement: {
          responseKind: facts.responseKind,
          responseReceivedAt: "2026-07-31T02:00:05.000Z",
          previousProtocolIntervalSeconds:
            facts.previousProtocolIntervalSeconds,
          protocolIntervalSeconds: facts.protocolIntervalSeconds,
          retryAfterSeconds: facts.retryAfterSeconds,
          nextPollAt: facts.nextPollAt,
        },
      })
      expect(await harness.state.readDevicePollAttempt()).toMatchObject({
        phase: "response_acknowledged",
        responseAcknowledgement: {
          responseKind: facts.responseKind,
          previousProtocolIntervalSeconds:
            facts.previousProtocolIntervalSeconds,
        },
      })

      const restarted = createPeer(harness)
      await expect(
        restarted.auth.login({ global: GLOBAL, noWait: false, resume: true })
      ).rejects.toMatchObject({
        exitCode: 4,
        envelope: { error: { code: "DEPENDENCY_UNAVAILABLE" } },
      })
      expect(restarted.transport.requests).toHaveLength(0)
      expect(await harness.state.readDevicePollAttempt()).not.toBeNull()
      expect(await harness.state.readDeviceState()).toMatchObject({
        intervalSeconds: 5,
        nextPollAt: "2026-07-31T02:00:10.000Z",
      })
    }
  )

  it.each([
    ["status", 0],
    ["whoami", 3],
  ] as const)(
    "settles response_acknowledged before real auth %s entry without another Token POST",
    async (command, expectedExitCode) => {
      const harness = await createHarness()
      await leaveAcknowledgedPollCrash(harness)
      const restarted = createPeer(harness)
      const stdout = captureAcknowledgedStream()
      const stderr = captureAcknowledgedStream()

      const exitCode = await runCli(
        createAuthCliApplication(restarted.auth),
        ["auth", command, "--json"],
        { stdout: stdout.stream, stderr: stderr.stream }
      )

      expect(exitCode).toBe(expectedExitCode)
      expect(stdout.callbacks()).toBeGreaterThan(0)
      expect(JSON.parse(stdout.read())).toMatchObject(
        command === "status"
          ? {
              ok: true,
              data: { status: "local_incomplete", reason: "token_missing" },
            }
          : { ok: false, error: { code: "INVALID_CREDENTIAL" } }
      )
      expect(restarted.transport.requests).toHaveLength(0)
      expect(await harness.state.readDevicePollAttempt()).toBeNull()
      expect(await harness.state.readDeviceState()).toMatchObject({
        localState: "polling",
        nextPollAt: "2026-07-31T02:00:10.000Z",
      })
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/oauth/token"
        )
      ).toHaveLength(1)
    }
  )

  it("keeps the dispatch fence when the process crashes before acknowledging a received response", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.transport.enqueue((input) =>
      response(input, 400, { error: "authorization_pending" })
    )
    const originalWriteAttempt = harness.state.writeDevicePollAttempt.bind(
      harness.state
    )
    harness.state.writeDevicePollAttempt = (attempt) =>
      attempt.phase === "response_acknowledged"
        ? Promise.reject(
            new Error("simulated crash before response acknowledgement")
          )
        : originalWriteAttempt(attempt)

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toThrow("simulated crash before response acknowledgement")
    harness.state.writeDevicePollAttempt = originalWriteAttempt
    expect(await harness.state.readDevicePollAttempt()).toMatchObject({
      phase: "dispatch_intent",
      responseAcknowledgement: null,
    })

    harness.now.value += 46_000
    const restarted = createPeer(harness)
    await expect(
      restarted.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toMatchObject({
      exitCode: 5,
      envelope: {
        error: { details: { deliveryState: "delivery_unknown" } },
      },
    })
    expect(restarted.transport.requests).toHaveLength(0)
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
    })
  })

  it("stops interactive login after locally recovering an acknowledged response", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.transport.enqueue((input) =>
      response(input, 400, { error: "authorization_pending" })
    )
    const originalWriteAttempt = harness.state.writeDevicePollAttempt.bind(
      harness.state
    )
    harness.state.writeDevicePollAttempt = async (attempt) => {
      await originalWriteAttempt(attempt)
      if (attempt.phase === "response_acknowledged") {
        throw new Error("simulated interactive acknowledgement crash")
      }
    }
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toThrow("simulated interactive acknowledgement crash")
    harness.state.writeDevicePollAttempt = originalWriteAttempt

    // 即使崩溃恢复时冻结的 nextPollAt 已经过期，本次交互式
    // login 也只完成本地提交，不在同一调用的等待循环里再发 POST。
    harness.now.value += 60_000
    const restarted = createPeer(harness)
    const outcome = await restarted.auth.login({
      global: { ...GLOBAL, noInput: false },
      noWait: false,
      resume: false,
    })
    expect(outcome.exitCode).toBe(4)
    expect(restarted.transport.requests).toHaveLength(0)
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "polling",
      nextPollAt: "2026-07-31T02:00:10.000Z",
    })
  })

  it("does not downgrade delivery_unknown after an acknowledged verification response", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.transport.enqueue(() =>
      Promise.reject(new HttpTransportError("network", "lost response"))
    )
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toMatchObject({ exitCode: 5 })

    harness.now.value += 5_000
    harness.transport.enqueue((input) =>
      response(input, 400, { error: "authorization_pending" })
    )
    const originalWriteAttempt = harness.state.writeDevicePollAttempt.bind(
      harness.state
    )
    harness.state.writeDevicePollAttempt = async (attempt) => {
      await originalWriteAttempt(attempt)
      if (attempt.phase === "response_acknowledged") {
        throw new Error("simulated verification acknowledgement crash")
      }
    }
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toThrow("simulated verification acknowledgement crash")
    harness.state.writeDevicePollAttempt = originalWriteAttempt
    expect(await harness.state.readDevicePollAttempt()).toMatchObject({
      phase: "response_acknowledged",
      deliveryVerification: true,
      responseAcknowledgement: {
        responseKind: "authorization_pending",
      },
    })

    const restarted = createPeer(harness)
    await expect(
      restarted.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toMatchObject({
      exitCode: 5,
      envelope: {
        error: {
          details: {
            deliveryState: "delivery_unknown",
            safeRestartAt: "2026-07-31T02:10:25.000Z",
          },
        },
      },
    })
    expect(restarted.transport.requests).toHaveLength(0)
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
      deliveryVerificationAttemptedAt: "2026-07-31T02:00:10.000Z",
    })
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(2)
  })

  it("recovers an acknowledged 86400-second backoff and continues ordinary pending/temporary rounds", async () => {
    const harness = await createHarness()
    await issue(harness)
    await harness.state.withAuthLock(async () => {
      const device = (await harness.state.readDeviceState())!
      await harness.state.writeDeviceState({
        ...device,
        expiresAt: new Date(NOW + 4 * 86_400_000).toISOString(),
      })
    })
    harness.now.value += 5_000
    harness.transport.enqueue((input) =>
      response(
        input,
        503,
        { error: "temporarily_unavailable" },
        { "retry-after": "86400" }
      )
    )
    const originalClearPoll = harness.state.clearDevicePollAttempt.bind(
      harness.state
    )
    harness.state.clearDevicePollAttempt = () =>
      Promise.reject(new Error("simulated crash after backoff write"))

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toThrow("simulated crash after backoff write")
    harness.state.clearDevicePollAttempt = originalClearPoll
    const backoffBoundary = NOW + 5_000 + 86_400_000
    expect(await harness.state.readDevicePollAttempt()).toMatchObject({
      phase: "response_acknowledged",
      responseAcknowledgement: {
        responseKind: "temporarily_unavailable",
        responseReceivedAt: "2026-07-31T02:00:05.000Z",
        previousProtocolIntervalSeconds: 5,
        protocolIntervalSeconds: 5,
        retryAfterSeconds: 86_400,
        nextPollAt: new Date(backoffBoundary).toISOString(),
      },
    })
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "polling",
      nextPollAt: new Date(backoffBoundary).toISOString(),
    })

    harness.now.value += 46_000
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toMatchObject({
      exitCode: 4,
      envelope: {
        error: {
          details: {
            oauthError: "temporarily_unavailable",
            retryAfterSeconds: 86_354,
          },
        },
      },
    })
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "polling",
      nextPollAt: new Date(backoffBoundary).toISOString(),
    })
    harness.now.value = backoffBoundary - 1
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).resolves.toMatchObject({ exitCode: 4 })
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(1)

    harness.now.value = backoffBoundary
    harness.transport.enqueue((input) =>
      response(input, 400, { error: "authorization_pending" })
    )
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).resolves.toMatchObject({ exitCode: 4 })

    harness.now.value = backoffBoundary + 5_000
    harness.transport.enqueue((input) =>
      response(
        input,
        503,
        { error: "temporarily_unavailable" },
        { "retry-after": "86400" }
      )
    )
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toMatchObject({ exitCode: 4 })

    const secondBackoffBoundary = backoffBoundary + 5_000 + 86_400_000
    harness.now.value = secondBackoffBoundary
    harness.transport.enqueue((input) =>
      response(input, 400, { error: "authorization_pending" })
    )
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).resolves.toMatchObject({ exitCode: 4 })
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "polling",
      intervalSeconds: 5,
      nextPollAt: new Date(secondBackoffBoundary + 5_000).toISOString(),
    })
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/oauth/token"
      )
    ).toHaveLength(4)
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
    ).rejects.toMatchObject({ exitCode: 2 })
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

  it.each([false, true])(
    "fails closed before mutating a staging transaction with mismatched full poll binding (token=%s)",
    async (tokenPresent) => {
      const harness = await createHarness()
      await installExpiredStagingWithoutToken(harness)
      const index = (await harness.state.readTokenIndex())!
      if (tokenPresent) {
        await harness.keychain.write(
          harness.local.credentials.addressFor(index),
          TOKEN
        )
      }
      const originalDevice = await harness.state.readDeviceState()
      const poll = (await harness.state.readDevicePollAttempt())!
      await harness.state.withAuthLock(() =>
        harness.state.writeDevicePollAttempt({
          ...poll,
          ownerProcessFingerprint: "test-process:replacement",
        })
      )

      await expect(harness.local.inspectAndRecover()).resolves.toMatchObject({
        state: "local_incomplete",
        reason: "metadata_mismatch",
      })
      expect(await harness.state.readDeviceState()).toEqual(originalDevice)
      expect(await harness.state.readTokenIndex()).toMatchObject({
        state: "staging",
      })
      expect(await harness.state.readDevicePollAttempt()).toMatchObject({
        ownerProcessFingerprint: "test-process:replacement",
      })
    }
  )

  it.each(["pending", "terminal", "token", "network"] as const)(
    "preserves dispatch evidence when the clock rolls back during a %s response",
    async (responseKind) => {
      const harness = await createHarness()
      await issue(harness)
      harness.now.value += 5_000
      harness.transport.enqueue((input) => {
        harness.now.value -= 1_000
        if (responseKind === "network") {
          throw new HttpTransportError("timeout", "clock rollback")
        }
        if (responseKind === "pending") {
          return response(input, 400, { error: "authorization_pending" })
        }
        if (responseKind === "terminal") {
          return response(input, 400, { error: "expired_token" })
        }
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

      await expect(
        harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
      ).rejects.toMatchObject({ exitCode: 5 })
      expect(await harness.state.readDevicePollAttempt()).toMatchObject({
        phase: "dispatch_intent",
        dispatchedAt: "2026-07-31T02:00:05.000Z",
      })
      expect(await harness.state.readTokenIndex()).toBeNull()
      expect(await harness.state.readDeviceState()).toMatchObject({
        localState: "polling",
        terminalEvidence: null,
      })
    }
  )

  it.each(["terminal_device", "poll", "device"] as const)(
    "converges terminal completion after the %s crash point with concurrent natural entries",
    async (crashStep) => {
      const harness = await createHarness()
      await issue(harness)
      harness.now.value += 5_000
      harness.transport.enqueue((input) =>
        response(input, 400, { error: "expired_token" })
      )
      const originalWriteDevice = harness.state.writeDeviceState.bind(
        harness.state
      )
      const originalClearPoll = harness.state.clearDevicePollAttempt.bind(
        harness.state
      )
      const originalClearDevice = harness.state.clearDeviceState.bind(
        harness.state
      )
      let injected = false
      if (crashStep === "terminal_device") {
        harness.state.writeDeviceState = async (device) => {
          await originalWriteDevice(device)
          if (!injected && device.localState === "terminal") {
            injected = true
            throw new Error("simulated terminal Device crash")
          }
        }
      } else if (crashStep === "poll") {
        harness.state.clearDevicePollAttempt = async () => {
          await originalClearPoll()
          if (!injected) {
            injected = true
            throw new Error("simulated terminal poll crash")
          }
        }
      } else {
        harness.state.clearDeviceState = async () => {
          await originalClearDevice()
          if (!injected) {
            injected = true
            throw new Error("simulated terminal delete crash")
          }
        }
      }

      await expect(
        harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
      ).rejects.toThrow("simulated terminal")
      harness.state.writeDeviceState = originalWriteDevice
      harness.state.clearDevicePollAttempt = originalClearPoll
      harness.state.clearDeviceState = originalClearDevice

      const statusPeer = createPeer(harness)
      const logoutPeer = createPeer(harness)
      const concurrent = await Promise.allSettled([
        statusPeer.auth.status(GLOBAL),
        logoutPeer.auth.logout(GLOBAL),
      ])
      expect(
        concurrent.some(
          (result) =>
            result.status === "fulfilled" && result.value.exitCode === 0
        )
      ).toBe(true)
      expect((await createPeer(harness).auth.status(GLOBAL)).exitCode).toBe(0)
      expect((await createPeer(harness).auth.logout(GLOBAL)).exitCode).toBe(0)
      await expect(
        createPeer(harness).auth.login({
          global: GLOBAL,
          noWait: false,
          resume: true,
        })
      ).rejects.toMatchObject({ exitCode: 3 })
      expect(statusPeer.transport.requests).toHaveLength(0)
      expect(logoutPeer.transport.requests).toHaveLength(0)
      expect(await harness.state.readDeviceState()).toBeNull()
      expect(await harness.state.readDevicePollAttempt()).toBeNull()
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/oauth/token"
        )
      ).toHaveLength(1)
    }
  )

  it("preserves terminal evidence when a different nonnull poll attempt appears", async () => {
    const harness = await createHarness()
    await installTerminalCrashState(harness)
    const terminal = (await harness.state.readDeviceState())!
    const frozenAttempt = terminal.terminalEvidence!.attempt
    const replacementOwner = "99999999-9999-4999-8999-999999999999"
    await harness.state.withAuthLock(() =>
      harness.state.writeDevicePollAttempt({
        ...frozenAttempt,
        ownerToken: replacementOwner,
      })
    )
    const requestCount = harness.transport.requests.length

    const pendingStatus = await harness.auth.status(GLOBAL)
    expect(pendingStatus).toMatchObject({
      exitCode: 0,
      envelope: {
        data: { status: "local_incomplete", reason: "metadata_mismatch" },
      },
    })
    expect(pendingStatus.envelope.ok).toBe(true)
    if (pendingStatus.envelope.ok) {
      expect(Object.keys(pendingStatus.envelope.data).sort()).toEqual(
        [
          "status",
          "authenticated",
          "issuerOrigin",
          "credentialKind",
          "credentialId",
          "team",
          "credential",
          "reason",
        ].sort()
      )
    }
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toMatchObject({ exitCode: 2 })
    expect(await harness.state.readDeviceState()).toEqual(terminal)
    expect(await harness.state.readDevicePollAttempt()).toMatchObject({
      ownerToken: replacementOwner,
    })
    expect(harness.transport.requests).toHaveLength(requestCount)
  })

  it("settles terminal evidence before resolving process identity", async () => {
    const harness = await createHarness()
    await installTerminalCrashState(harness)
    harness.local.storageCommitProcessIdentity = () =>
      Promise.reject(new Error("process probe unavailable"))
    const coordinator = new DevicePollCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )

    await expect(coordinator.prepare()).rejects.toMatchObject({ exitCode: 3 })
    expect(await harness.state.readDeviceState()).toBeNull()
    expect(await harness.state.readDevicePollAttempt()).toBeNull()
  })

  it("recovers the exact verification claim time after attempt-to-Device crash", async () => {
    const harness = await createHarness()
    await issue(harness)
    await harness.state.withAuthLock(async () => {
      const device = (await harness.state.readDeviceState())!
      await harness.state.writeDeviceState({
        ...device,
        localState: "delivery_unknown",
      })
    })
    harness.now.value += 5_000
    const coordinator = new DevicePollCoordinator(
      harness.local,
      () => new Date(harness.now.value)
    )
    const preparation = await coordinator.prepare()
    expect(preparation.kind).toBe("select_backend")
    if (preparation.kind !== "select_backend") throw new Error("unreachable")
    const frozen = await coordinator.freezeBackend(preparation)
    harness.now.value += 60_000
    const claimedAt = new Date(harness.now.value).toISOString()
    const originalWriteDevice = harness.state.writeDeviceState.bind(
      harness.state
    )
    harness.state.writeDeviceState = () =>
      Promise.reject(new Error("simulated crash before Device timestamp"))

    await expect(coordinator.markDispatchIntent(frozen)).rejects.toThrow(
      "simulated crash"
    )
    harness.state.writeDeviceState = originalWriteDevice
    expect(await harness.state.readDevicePollAttempt()).toMatchObject({
      phase: "dispatch_intent",
      createdAt: "2026-07-31T02:00:05.000Z",
      dispatchedAt: claimedAt,
      verificationClaimedAt: claimedAt,
    })
    expect(
      (await harness.state.readDeviceState())?.deliveryVerificationAttemptedAt
    ).toBeNull()

    harness.now.value += 46_000
    const recovered = await coordinator.prepare()
    expect(recovered).toEqual({
      kind: "recovered_unknown",
      safeRestartAt: "2026-07-31T02:11:20.000Z",
    })
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
      nextPollAt: "2026-07-31T02:01:10.000Z",
      deliveryVerificationAttemptedAt: claimedAt,
    })
  })

  it.each(["generation", "client", "issuer"] as const)(
    "preserves an expired mismatched dispatch intent for %s mismatch",
    async (mismatchKind) => {
      const harness = await createHarness()
      await issue(harness)
      const device = (await harness.state.readDeviceState())!
      const attempt: DevicePollAttempt = {
        formatVersion: 1,
        ownerToken: POLL_OWNER_TOKEN,
        deviceGeneration:
          mismatchKind === "generation"
            ? "99999999-9999-4999-8999-999999999999"
            : device.generation,
        environment: mismatchKind === "issuer" ? "test" : device.environment,
        issuerOrigin:
          mismatchKind === "issuer"
            ? "https://api.test.adrate.io"
            : device.issuerOrigin,
        clientInstanceId:
          mismatchKind === "client"
            ? "88888888-8888-4888-8888-888888888888"
            : device.clientInstanceId,
        phase: "dispatch_intent",
        deliveryVerification: false,
        storageKind: "keychain",
        ownerPid: 9_000,
        ownerProcessFingerprint: "test-process:crashed",
        createdAt: "2026-07-31T01:59:00.000Z",
        dispatchedAt: "2026-07-31T01:59:00.000Z",
        verificationClaimedAt: null,
        responseAcknowledgement: null,
        leaseExpiresAt: "2026-07-31T01:59:45.000Z",
      }
      await harness.state.withAuthLock(() =>
        harness.state.writeDevicePollAttempt(attempt)
      )
      const coordinator = new DevicePollCoordinator(
        harness.local,
        () => new Date(harness.now.value)
      )

      await expect(coordinator.prepare()).rejects.toMatchObject({ exitCode: 4 })
      expect(await harness.state.readDevicePollAttempt()).toEqual(attempt)
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/oauth/token"
        )
      ).toHaveLength(0)
    }
  )
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

  it("uses the residual test issuer for incomplete-state logout recovery", async () => {
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
      pollAttemptOwnerToken: POLL_OWNER_TOKEN,
      deviceName: "test-device",
      tokenReceivedAt: "2026-07-31T02:00:00.000Z",
      storageKind: "keychain",
      storageCommit: null,
    })

    const outcome = await harness.auth.logout(GLOBAL)

    expect(outcome).toMatchObject({
      exitCode: 5,
      envelope: {
        ok: false,
        error: {
          details: {
            resolutionUrl: "https://test.adrate.io/settings/security",
          },
        },
      },
    })
    expect(harness.transport.requests).toHaveLength(0)
    expect(await harness.state.readTokenIndex()).toBeNull()
  })

  it.each([
    ["production", "test", "https://test.adrate.io/settings/security"],
    ["test", "production", "https://app.adrate.io/settings/security"],
  ] as const)(
    "uses credential index %s evidence ahead of opposite %s config",
    async (configEnvironment, indexEnvironment, resolutionUrl) => {
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
        pollAttemptOwnerToken: POLL_OWNER_TOKEN,
        deviceName: "conflicting-config",
        tokenReceivedAt: "2026-07-31T02:00:00.000Z",
        storageKind: "keychain",
        storageCommit: null,
      })

      const outcome = await harness.auth.logout(GLOBAL)
      expect(outcome).toMatchObject({
        exitCode: 5,
        envelope: {
          error: {
            details: { resolutionEnvironment: indexEnvironment, resolutionUrl },
          },
        },
      })
      expect(harness.transport.requests).toHaveLength(0)
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
    expect(outcome).toMatchObject({
      exitCode: 5,
      envelope: {
        error: {
          details: {
            resolutionEnvironment: "unknown",
            suggestedAction: "confirm_environment",
            environmentConfirmationRequired: true,
          },
        },
      },
    })
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
          capabilities: M0_SCOPE.split(" "),
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
      const stdout = captureAcknowledgedStream()
      const stderr = captureAcknowledgedStream()

      const exitCode = await runCli(
        createAuthCliApplication(harness.auth),
        argv,
        { stdout: stdout.stream, stderr: stderr.stream }
      )

      expect(exitCode).toBe(4)
      expect(stdout.callbacks()).toBe(1)
      expect(JSON.parse(stdout.read())).toMatchObject({
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
      exitCode: 4,
      retryAfterSeconds: 17,
      envelope: { meta: { pendingCommandsRetained: 1 } },
      warnings: [
        "Retry after 17 second(s) before repeating this request.",
        "Credential expires soon.",
        "1 pending Command record(s) were preserved. A new credential cannot resume Commands created by the previous credential.",
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
      "Warning: Retry after 17 second(s) before repeating this request."
    )
    expect(stderr.read()).toContain("Warning: Credential expires soon.")
    expect(stderr.read()).toContain(
      "Warning: 1 pending Command record(s) were preserved."
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

  it("replays an unacknowledged unknown logout with zero repeated DELETE and gates every auth entry", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    harness.transport.enqueue(() =>
      Promise.reject(
        new HttpTransportError("timeout", "server-secret-body-marker")
      )
    )

    const first = await harness.auth.logout(GLOBAL)
    expect(first.exitCode).toBe(5)
    expect(
      harness.transport.requests.filter(
        (request) => request.path === "/public/v1/sessions/current"
      )
    ).toHaveLength(1)
    expect(await harness.state.readLogoutDeliveryJournal()).toMatchObject({
      phase: "outcome_recorded",
      remoteOutcome: "unknown",
      reason: "transport_unknown",
    })
    const journalText = await readFile(
      harness.state.paths.logoutDeliveryJournal,
      "utf8"
    )
    expect(journalText).not.toContain(TOKEN)
    expect(journalText).not.toContain("server-secret-body-marker")
    expect(
      (await stat(harness.state.paths.logoutDeliveryJournal)).mode & 0o777
    ).toBe(0o600)

    const requestCount = harness.transport.requests.length
    await expect(
      harness.auth.login({
        global: GLOBAL,
        noWait: true,
        resume: false,
      })
    ).rejects.toMatchObject({ exitCode: 3 })
    await expect(harness.auth.whoami(GLOBAL)).rejects.toMatchObject({
      exitCode: 3,
    })
    const logoutPendingStatus = await harness.auth.status(GLOBAL)
    expect(logoutPendingStatus).toMatchObject({
      exitCode: 0,
      envelope: {
        data: {
          status: "local_incomplete",
          reason: "metadata_mismatch",
        },
      },
    })
    expect(logoutPendingStatus.envelope.ok).toBe(true)
    if (logoutPendingStatus.envelope.ok) {
      expect(Object.keys(logoutPendingStatus.envelope.data).sort()).toEqual(
        [
          "status",
          "authenticated",
          "issuerOrigin",
          "credentialKind",
          "credentialId",
          "team",
          "credential",
          "reason",
        ].sort()
      )
    }
    expect(harness.transport.requests).toHaveLength(requestCount)

    const replay = await harness.auth.logout(GLOBAL)
    expect(replay.exitCode).toBe(5)
    expect(harness.transport.requests).toHaveLength(requestCount)
    expect(replay.postRenderAcknowledgement).toBeDefined()
    await replay.postRenderAcknowledgement!.acknowledge()
    expect(await harness.state.readLogoutDeliveryJournal()).toBeNull()

    enqueueDeviceCode(harness)
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).resolves.toMatchObject({ exitCode: 0 })
  })

  it.each([
    ["before_delete", "dispatch_intent", 0, 5],
    ["before_outcome_record", "dispatch_intent", 1, 5],
    ["after_outcome_record", "outcome_recorded", 1, 0],
  ] as const)(
    "recovers logout crash %s without repeating DELETE",
    async (crashPoint, expectedPhase, expectedDeletes, replayExitCode) => {
      const harness = await createHarness()
      await installStoredCredential(harness, true)
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
      const original = harness.state.writeLogoutDeliveryJournal.bind(
        harness.state
      )
      let injected = false
      harness.state.writeLogoutDeliveryJournal = async (journal) => {
        if (
          !injected &&
          crashPoint === "before_outcome_record" &&
          journal.phase === "outcome_recorded"
        ) {
          injected = true
          throw new Error("simulated crash before outcome record")
        }
        await original(journal)
        if (
          !injected &&
          ((crashPoint === "before_delete" &&
            journal.phase === "dispatch_intent") ||
            (crashPoint === "after_outcome_record" &&
              journal.phase === "outcome_recorded"))
        ) {
          injected = true
          throw new Error(`simulated ${crashPoint} crash`)
        }
      }

      await expect(harness.auth.logout(GLOBAL)).rejects.toThrow("simulated")
      harness.state.writeLogoutDeliveryJournal = original
      expect(await harness.state.readLogoutDeliveryJournal()).toMatchObject({
        phase: expectedPhase,
      })
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/public/v1/sessions/current"
        )
      ).toHaveLength(expectedDeletes)

      const replay = await harness.auth.logout(GLOBAL)
      expect(replay.exitCode).toBe(replayExitCode)
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/public/v1/sessions/current"
        )
      ).toHaveLength(expectedDeletes)
      await replay.postRenderAcknowledgement?.acknowledge()
      expect(await harness.state.readLogoutDeliveryJournal()).toBeNull()
    }
  )

  it.each(
    (["confirmed_inactive", "unknown"] as const).flatMap((remoteOutcome) =>
      (
        [
          "prepared",
          "keychain",
          "credentials",
          "device",
          "token_index",
          "reservation",
        ] as const
      ).map((failurePoint) => [remoteOutcome, failurePoint] as const)
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
      const restore = injectLogoutCleanupFailure(harness, failurePoint)

      const failedCleanup = await harness.auth.logout(GLOBAL)
      expect(failedCleanup.exitCode).toBe(remoteOutcome === "unknown" ? 5 : 1)
      expect(failedCleanup.postRenderAcknowledgement).toBeUndefined()
      expect(failedCleanup.envelope).toMatchObject({
        ok: false,
        error: {
          details: {
            remoteOutcome,
            localCleanupFailed: true,
          },
        },
      })
      if (remoteOutcome === "unknown") {
        expect(failedCleanup.envelope).toMatchObject({
          error: {
            details: {
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

      const recovered = await harness.auth.logout(GLOBAL)
      expect(recovered.exitCode).toBe(remoteOutcome === "unknown" ? 5 : 0)
      expect(recovered.postRenderAcknowledgement).toBeDefined()
      expect(
        harness.transport.requests.filter(
          (request) => request.path === "/public/v1/sessions/current"
        )
      ).toHaveLength(1)
      await recovered.postRenderAcknowledgement!.acknowledge()
      expect(await harness.state.readLogoutDeliveryJournal()).toBeNull()
    }
  )

  it("replays only the old logout fact and preserves a newer credential generation", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
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
    const old = await harness.auth.logout(GLOBAL)
    expect(old.exitCode).toBe(0)
    expect(await harness.state.readLogoutDeliveryJournal()).not.toBeNull()

    const replacement = await installStoredCredential(harness, true)
    replacement.generation = "99999999-9999-4999-8999-999999999999"
    await harness.state.withAuthLock(() =>
      harness.state.writeTokenIndex(replacement)
    )
    const requestCount = harness.transport.requests.length

    const replay = await harness.auth.logout(GLOBAL)
    expect(replay).toMatchObject({
      exitCode: 0,
      envelope: {
        data: {
          remoteOutcome: "confirmed_inactive",
          currentCredentialPreserved: true,
        },
      },
    })
    expect(harness.transport.requests).toHaveLength(requestCount)
    expect(await harness.state.readTokenIndex()).toMatchObject({
      generation: replacement.generation,
    })
    await replay.postRenderAcknowledgement!.acknowledge()
    expect(await harness.state.readLogoutDeliveryJournal()).toBeNull()
    expect(await harness.state.readTokenIndex()).toMatchObject({
      generation: replacement.generation,
    })
  })

  it("fences logout against an in-flight Device issue response", async () => {
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
    expect(logout.exitCode).toBe(5)
    expect(await harness.state.readDeviceIssueReservation()).toBeNull()
    release.resolve(undefined)
    await expect(issuing).rejects.toMatchObject({ exitCode: 4 })
    expect(await harness.state.readDeviceState()).toBeNull()
  })

  it("keeps a new Device flow when stale whoami completes", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    const peer = createPeer(harness)
    const entered = gate<void>()
    const release = gate<void>()
    harness.transport.enqueue(async (input) => {
      entered.resolve(undefined)
      await release.promise
      return response(input, 401, {
        ok: false,
        error: {
          code: "INVALID_CREDENTIAL",
          message: "invalid",
          retryable: false,
          details: {},
        },
        meta: {
          requestId: input.requestId ?? "server_request_1",
          apiVersion: "v1",
        },
      })
    })
    const staleWhoami = harness.auth.whoami(GLOBAL)
    await entered.promise

    enqueuePublicError(peer, "INVALID_CREDENTIAL")
    const logout = await peer.auth.logout(GLOBAL)
    expect(logout.exitCode).toBe(0)
    await logout.postRenderAcknowledgement?.acknowledge()
    enqueueDeviceCode(peer)
    expect(
      (
        await peer.auth.login({
          global: GLOBAL,
          noWait: true,
          resume: false,
          deviceName: "new-device",
        })
      ).exitCode
    ).toBe(0)
    const generation = (await peer.state.readDeviceState())?.generation

    release.resolve(undefined)
    expect((await staleWhoami).exitCode).toBe(3)
    expect(await peer.state.readDeviceState()).toMatchObject({
      generation,
      localState: "issued",
      deviceName: "new-device",
    })
  })

  it("keeps a new Device flow when a stale logout response arrives", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    const peer = createPeer(harness)
    const entered = gate<void>()
    const release = gate<void>()
    harness.transport.enqueue(async (input) => {
      entered.resolve(undefined)
      await release.promise
      return response(input, 200, {
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
    })
    const staleLogout = harness.auth.logout(GLOBAL)
    await entered.promise

    const recovered = await peer.auth.logout(GLOBAL)
    expect(recovered.exitCode).toBe(5)
    expect(peer.transport.requests).toHaveLength(0)
    await recovered.postRenderAcknowledgement?.acknowledge()
    enqueueDeviceCode(peer)
    await peer.auth.login({
      global: GLOBAL,
      noWait: true,
      resume: false,
      deviceName: "new-device",
    })
    const generation = (await peer.state.readDeviceState())?.generation

    release.resolve(undefined)
    await expect(staleLogout).rejects.toMatchObject({ exitCode: 5 })
    expect(await peer.state.readDeviceState()).toMatchObject({
      generation,
      localState: "issued",
      deviceName: "new-device",
    })
  })

  it("blocks a new login while Keychain cleanup is outside the lock", async () => {
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
    expect(await harness.state.readAuthCleanupReservation()).not.toBeNull()

    await expect(
      peer.auth.login({
        global: GLOBAL,
        noWait: true,
        resume: false,
        deviceName: "blocked-device",
      })
    ).rejects.toMatchObject({ exitCode: 3 })
    expect(peer.transport.requests).toHaveLength(0)

    release.resolve(undefined)
    expect((await logout).exitCode).toBe(0)
    expect(await harness.state.readAuthCleanupReservation()).toBeNull()
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
      expect(await harness.state.readTokenIndex()).toBeNull()
      expect(harness.keychain.values.size).toBe(0)
    }
  )

  it("clears local auth but reports outcome unknown on revoke timeout", async () => {
    const harness = await createHarness()
    await installStoredCredential(harness, true)
    harness.transport.enqueue(() =>
      Promise.reject(new HttpTransportError("timeout", "timeout"))
    )
    const outcome = await harness.auth.logout(GLOBAL)
    expect(outcome).toMatchObject({
      exitCode: 5,
      envelope: { ok: false },
    })
    expect(await harness.state.readTokenIndex()).toBeNull()
    expect(harness.keychain.values.size).toBe(0)
  })

  it("preserves delivery_unknown through logout and blocks a replacement login", async () => {
    const harness = await createHarness()
    await issue(harness)
    harness.now.value += 5_000
    harness.transport.enqueue(() =>
      Promise.reject(new HttpTransportError("timeout", "lost response"))
    )
    await expect(
      harness.auth.login({ global: GLOBAL, noWait: false, resume: true })
    ).rejects.toMatchObject({ exitCode: 5 })
    const requestCount = harness.transport.requests.length

    const logout = await harness.auth.logout(GLOBAL)
    expect(logout).toMatchObject({
      exitCode: 5,
      envelope: {
        ok: false,
        error: {
          details: {
            deliveryState: "delivery_unknown",
            resolutionEnvironment: "production",
            resolutionUrl: "https://app.adrate.io/settings/security",
          },
        },
      },
    })
    expect(await harness.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
    })
    expect(harness.transport.requests).toHaveLength(requestCount)

    await expect(
      harness.auth.login({ global: GLOBAL, noWait: true, resume: false })
    ).rejects.toMatchObject({ exitCode: 2 })
    expect(harness.transport.requests).toHaveLength(requestCount)
  })

  it("normalizes expired pre-dispatch and dispatch-intent leases before logout", async () => {
    const predispatch = await createHarness()
    await issue(predispatch)
    const preDevice = (await predispatch.state.readDeviceState())!
    const expiredPredispatch: DevicePollAttempt = {
      formatVersion: 1,
      ownerToken: POLL_OWNER_TOKEN,
      deviceGeneration: preDevice.generation,
      environment: preDevice.environment,
      issuerOrigin: preDevice.issuerOrigin,
      clientInstanceId: preDevice.clientInstanceId,
      phase: "selecting_backend",
      deliveryVerification: false,
      storageKind: null,
      ownerPid: predispatch.processIdentity.pid,
      ownerProcessFingerprint: predispatch.processIdentity.fingerprint,
      createdAt: "2026-07-31T01:59:00.000Z",
      dispatchedAt: null,
      verificationClaimedAt: null,
      responseAcknowledgement: null,
      leaseExpiresAt: "2026-07-31T01:59:45.000Z",
    }
    await predispatch.state.withAuthLock(() =>
      predispatch.state.writeDevicePollAttempt(expiredPredispatch)
    )
    expect((await predispatch.auth.logout(GLOBAL)).exitCode).toBe(0)
    expect(await predispatch.state.readDevicePollAttempt()).toBeNull()
    expect(await predispatch.state.readDeviceState()).toBeNull()
    expect(predispatch.transport.requests).toHaveLength(1)

    const dispatched = await createHarness()
    await issue(dispatched)
    const dispatchDevice = (await dispatched.state.readDeviceState())!
    await dispatched.state.withAuthLock(async () => {
      await dispatched.state.writeDeviceState({
        ...dispatchDevice,
        localState: "polling",
      })
      await dispatched.state.writeDevicePollAttempt({
        ...expiredPredispatch,
        deviceGeneration: dispatchDevice.generation,
        environment: dispatchDevice.environment,
        issuerOrigin: dispatchDevice.issuerOrigin,
        clientInstanceId: dispatchDevice.clientInstanceId,
        phase: "dispatch_intent",
        storageKind: "keychain",
        dispatchedAt: "2026-07-31T01:59:00.000Z",
        verificationClaimedAt: null,
        ownerPid: dispatched.processIdentity.pid,
        ownerProcessFingerprint: dispatched.processIdentity.fingerprint,
      })
    })
    const unknown = await dispatched.auth.logout(GLOBAL)
    expect(unknown).toMatchObject({
      exitCode: 5,
      envelope: {
        error: { details: { deliveryState: "delivery_unknown" } },
      },
    })
    expect(await dispatched.state.readDeviceState()).toMatchObject({
      localState: "delivery_unknown",
    })
    expect(await dispatched.state.readDevicePollAttempt()).toBeNull()
    expect(dispatched.transport.requests).toHaveLength(1)
  })

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
