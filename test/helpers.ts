import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SecureFileSystem } from "../src/storage/secure-files.js"
import { createCliPaths } from "../src/storage/paths.js"
import type {
  CliConfig,
  CredentialMetadata,
  DeviceAuthorizationState,
  DeviceIssueReservation,
  DevicePollAttempt,
  TokenIndex,
} from "../src/storage/schemas.js"

export const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111"
export const CLIENT_INSTANCE_ID = "22222222-2222-4222-8222-222222222222"
export const OWNER_TOKEN = "33333333-3333-4333-8333-333333333333"
export const TOKEN_GENERATION = "44444444-4444-4444-8444-444444444444"
export const DEVICE_GENERATION = "55555555-5555-4555-8555-555555555555"
export const TOKEN_SECRET = "A".repeat(43)
export const OWNER_SESSION_TOKEN = `adr_owner_${CREDENTIAL_ID}_${TOKEN_SECRET}`
export const DEVICE_CODE = "A".repeat(43)
export const NOW_ISO = "2026-07-31T08:00:00.000Z"

export interface TemporaryStateFixture {
  parent: string
  root: string
  fileSystem: SecureFileSystem
  paths: ReturnType<typeof createCliPaths>
  cleanup: () => Promise<void>
}

export async function createTemporaryStateFixture(): Promise<TemporaryStateFixture> {
  const parent = await mkdtemp(join(tmpdir(), "adrate-cli-storage-test-"))
  await chmod(parent, 0o700)
  const root = join(parent, "state")
  const fileSystem = new SecureFileSystem({
    root,
    platform: process.platform,
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
    deviceName: "Boss-Mac",
    tokenReceivedAt: NOW_ISO,
    storageKind: "keychain",
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
    absoluteExpiresAt: "2026-08-30T08:00:00.000Z",
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
      "feedback.write",
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
    ...overrides,
  }
}

export function validDeviceIssueReservation(
  overrides: Partial<DeviceIssueReservation> = {}
): DeviceIssueReservation {
  return {
    formatVersion: 1,
    generation: OWNER_TOKEN,
    environment: "production",
    issuerOrigin: "https://api.adrate.io",
    clientInstanceId: CLIENT_INSTANCE_ID,
    deviceName: "Boss-Mac",
    ...overrides,
  }
}

export function validDevicePollAttempt(
  overrides: Partial<DevicePollAttempt> = {}
): DevicePollAttempt {
  return {
    formatVersion: 1,
    deviceGeneration: DEVICE_GENERATION,
    storageKind: "keychain",
    ...overrides,
  }
}
