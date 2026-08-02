import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SecureFileSystem } from "../src/storage/secure-files.js"
import { createCliPaths } from "../src/storage/paths.js"
import type {
  AuthCleanupReservation,
  CliConfig,
  CredentialMetadata,
  DeviceAuthorizationState,
  DeviceIssueReservation,
  DevicePollAttempt,
  LogoutDeliveryJournal,
  TokenIndex,
} from "../src/storage/schemas.js"
import type { ProcessIdentityProbe } from "../src/auth/process-identity.js"

export const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111"
export const CLIENT_INSTANCE_ID = "22222222-2222-4222-8222-222222222222"
export const OWNER_TOKEN = "33333333-3333-4333-8333-333333333333"
export const TOKEN_GENERATION = "44444444-4444-4444-8444-444444444444"
export const DEVICE_GENERATION = "55555555-5555-4555-8555-555555555555"
export const POLL_OWNER_TOKEN = "66666666-6666-4666-8666-666666666666"
export const TOKEN_SECRET = "A".repeat(43)
export const OWNER_SESSION_TOKEN = `adr_owner_${CREDENTIAL_ID}_${TOKEN_SECRET}`
export const DEVICE_CODE = "A".repeat(43)
export const NOW_ISO = "2026-07-31T08:00:00.000Z"

export function stableTestProcessIdentity(
  label = "command-attempt"
): ProcessIdentityProbe {
  const identity = { pid: 42_001, fingerprint: `test:${label}:1` }
  return {
    current: () => Promise.resolve(identity),
    inspect: (expected) =>
      Promise.resolve(
        expected.pid === identity.pid &&
          expected.fingerprint === identity.fingerprint
          ? "same_process"
          : "reused"
      ),
  }
}

export interface TemporaryStateFixture {
  parent: string
  root: string
  fileSystem: SecureFileSystem
  paths: ReturnType<typeof createCliPaths>
  cleanup: () => Promise<void>
}

export async function createTemporaryStateFixture(
  options: {
    now?: () => number
    lockStaleAfterMs?: number
  } = {}
): Promise<TemporaryStateFixture> {
  const parent = await mkdtemp(join(tmpdir(), "adrate-cli-storage-test-"))
  await chmod(parent, 0o700)
  const root = join(parent, "state")
  const fileSystem = new SecureFileSystem({
    root,
    platform: process.platform,
    ...(options.now ? { now: options.now } : {}),
    ...(options.lockStaleAfterMs !== undefined
      ? { lockStaleAfterMs: options.lockStaleAfterMs }
      : {}),
  })
  return {
    parent,
    root,
    fileSystem,
    paths: createCliPaths(root),
    async cleanup() {
      await rm(parent, { recursive: true, force: true })
    },
  }
}

export function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (reason?: unknown) => void
} {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function validConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    configFormatVersion: 1,
    issuerOrigin: "https://api.adrate.io",
    clientInstanceId: CLIENT_INSTANCE_ID,
    environment: "production",
    ...overrides,
  }
}

export function validTokenIndex(
  overrides: Partial<TokenIndex> = {}
): TokenIndex {
  return {
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
    deviceName: "Boss-Mac",
    tokenReceivedAt: NOW_ISO,
    storageKind: "keychain",
    storageCommit: null,
    ...overrides,
  }
}

export function validCredentialMetadata(
  overrides: Partial<CredentialMetadata> = {}
): CredentialMetadata {
  return {
    credentialFormatVersion: 1,
    credentialKind: "owner_cli_session",
    credentialId: CREDENTIAL_ID,
    issuerOrigin: "https://api.adrate.io",
    teamId: 42,
    teamName: "Boss Team",
    deviceName: "Boss-Mac",
    clientInstanceId: CLIENT_INSTANCE_ID,
    loggedInAt: NOW_ISO,
    cliVersion: "0.1.0",
    ...overrides,
  }
}

export function validDeviceState(
  overrides: Partial<DeviceAuthorizationState> = {}
): DeviceAuthorizationState {
  return {
    formatVersion: 1,
    generation: DEVICE_GENERATION,
    localState: "issued",
    clientId: "adrate-cli",
    clientInstanceId: CLIENT_INSTANCE_ID,
    deviceName: "Boss-Mac",
    requestedScopes: [
      "identity.read",
      "connections.read",
      "ads.campaign.read",
      "ads.report.read",
      "ads.campaign.status.write",
    ],
    environment: "production",
    issuerOrigin: "https://api.adrate.io",
    deviceCode: DEVICE_CODE,
    userCode: "ABCD-EFGH",
    verificationUri: "https://app.adrate.io/cli/authorize",
    verificationUriComplete:
      "https://app.adrate.io/cli/authorize?user_code=ABCD-EFGH",
    expiresAt: "2026-07-31T08:10:00.000Z",
    intervalSeconds: 5,
    createdAt: NOW_ISO,
    nextPollAt: "2026-07-31T08:00:05.000Z",
    deliveryVerificationAttemptedAt: null,
    terminalEvidence: null,
    ...overrides,
  }
}

export function validDeviceIssueReservation(
  overrides: Partial<DeviceIssueReservation> = {}
): DeviceIssueReservation {
  return {
    formatVersion: 1,
    ownerToken: OWNER_TOKEN,
    environment: "production",
    issuerOrigin: "https://api.adrate.io",
    clientInstanceId: CLIENT_INSTANCE_ID,
    deviceName: "Boss-Mac",
    createdAt: NOW_ISO,
    ...overrides,
  }
}

export function validDevicePollAttempt(
  overrides: Partial<DevicePollAttempt> = {}
): DevicePollAttempt {
  const value: DevicePollAttempt = {
    formatVersion: 1,
    ownerToken: POLL_OWNER_TOKEN,
    deviceGeneration: DEVICE_GENERATION,
    environment: "production",
    issuerOrigin: "https://api.adrate.io",
    clientInstanceId: CLIENT_INSTANCE_ID,
    phase: "ready",
    deliveryVerification: false,
    storageKind: "keychain",
    ownerPid: 12345,
    ownerProcessFingerprint: "test-process:started-at-1",
    createdAt: NOW_ISO,
    dispatchedAt: null,
    verificationClaimedAt: null,
    responseAcknowledgement: null,
    leaseExpiresAt: "2026-07-31T08:00:45.000Z",
    ...overrides,
  }
  if (
    value.phase === "dispatch_intent" ||
    value.phase === "response_acknowledged"
  ) {
    if (overrides.dispatchedAt === undefined) value.dispatchedAt = NOW_ISO
    if (
      value.deliveryVerification &&
      overrides.verificationClaimedAt === undefined
    ) {
      value.verificationClaimedAt = value.dispatchedAt
    }
  }
  if (
    value.phase === "response_acknowledged" &&
    overrides.responseAcknowledgement === undefined
  ) {
    value.responseAcknowledgement = {
      responseKind: "authorization_pending",
      responseReceivedAt: "2026-07-31T08:00:01.000Z",
      previousProtocolIntervalSeconds: 5,
      protocolIntervalSeconds: 5,
      retryAfterSeconds: null,
      nextPollAt: "2026-07-31T08:00:06.000Z",
    }
  }
  return value
}

export function validAuthCleanupReservation(
  overrides: Partial<AuthCleanupReservation> = {}
): AuthCleanupReservation {
  return {
    formatVersion: 1,
    ownerToken: OWNER_TOKEN,
    phase: "prepared",
    credentialLocator: {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: CREDENTIAL_ID,
      storageKind: "keychain",
    },
    expectedFallbackExists: false,
    expectedEnvironment: "production",
    expectedIssuerOrigin: "https://api.adrate.io",
    expectedClientInstanceId: CLIENT_INSTANCE_ID,
    expectedTokenGeneration: TOKEN_GENERATION,
    expectedDeviceGeneration: DEVICE_GENERATION,
    expectedIssueOwnerToken: null,
    expectedPollOwnerToken: POLL_OWNER_TOKEN,
    expectedConfigDigest: "a".repeat(64),
    expectedTokenDigest: "b".repeat(64),
    expectedMetadataDigest: null,
    expectedDeviceDigest: "c".repeat(64),
    expectedIssueDigest: null,
    expectedPollDigest: "d".repeat(64),
    createdAt: NOW_ISO,
    ...overrides,
  }
}

export function validLogoutDeliveryJournal(
  overrides: Partial<LogoutDeliveryJournal> = {}
): LogoutDeliveryJournal {
  const journal: LogoutDeliveryJournal = {
    formatVersion: 1,
    ownerToken: OWNER_TOKEN,
    phase: "dispatch_intent",
    remoteOutcome: null,
    reason: "transport_unknown",
    responseFact: null,
    expectedEnvironment: "production",
    expectedIssuerOrigin: "https://api.adrate.io",
    expectedCredentialId: CREDENTIAL_ID,
    expectedClientInstanceId: CLIENT_INSTANCE_ID,
    expectedTokenGeneration: TOKEN_GENERATION,
    expectedDeviceGeneration: DEVICE_GENERATION,
    expectedIssueOwnerToken: null,
    expectedPollOwnerToken: POLL_OWNER_TOKEN,
    resolutionEnvironment: "production",
    requestId: "server_request_1",
    createdAt: NOW_ISO,
    recordedAt: null,
    ...overrides,
  }
  if (overrides.responseFact !== undefined) return journal
  if (journal.phase === "dispatch_intent") return journal
  if (journal.reason === "revoked") {
    journal.responseFact = {
      kind: "success",
      errorCode: null,
      retryAfterSeconds: null,
      credentialNotice: null,
    }
  } else if (journal.reason === "owner_required") {
    journal.responseFact = {
      kind: "error",
      errorCode: "OWNER_REQUIRED",
      retryAfterSeconds: null,
      credentialNotice: null,
    }
  } else if (journal.reason === "request_rejected") {
    journal.responseFact = {
      kind: "error",
      errorCode: "RATE_LIMITED",
      retryAfterSeconds: 5,
      credentialNotice: null,
    }
  } else if (journal.reason === "ambiguous_response") {
    journal.responseFact = {
      kind: "error",
      errorCode: "DEPENDENCY_UNAVAILABLE",
      retryAfterSeconds: null,
      credentialNotice: null,
    }
  }
  return journal
}
