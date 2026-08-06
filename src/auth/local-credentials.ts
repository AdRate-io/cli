import { lstat, readdir } from "node:fs/promises"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { Buffer } from "node:buffer"
import { join } from "node:path"
import { parseOwnerSessionToken } from "../contracts/oauth.js"
import { EXIT_CODE } from "../constants.js"
import {
  authenticationFailure,
  dependencyFailure,
  outcomeUnknownFailure,
  prependFailureWarning,
  usageFailure,
} from "../errors.js"
import { environmentForMachineOrigin } from "../config/issuer.js"
import { newCredentialMetadata } from "../storage/schemas.js"
import { credentialStorageWarning } from "../storage/credential-backend.js"
import { SecureFileLockBusyError } from "../storage/secure-files.js"
import {
  pollAttemptMatchesIndex,
  pollAttemptsEqual,
} from "./device-state-contract.js"
import type { CliStateStore } from "../storage/state-store.js"
import type {
  CliConfig,
  CredentialMetadata,
  DeviceAuthorizationState,
  DeviceIssueReservation,
  DevicePollAttempt,
  TokenIndex,
} from "../storage/schemas.js"
import type { CredentialStore } from "../storage/credential-backend.js"
import type { DeviceTokenResponse } from "../contracts/oauth.js"
import type { MeFacts } from "../contracts/me.js"

export interface LocatedCredential {
  index: TokenIndex
  token: string
  credentials: CredentialMetadata | null
  device: DeviceAuthorizationState | null
  identity: LocalAuthIdentity
}

export type CredentialInspection =
  | { state: "none" }
  | { state: "device_only"; device: DeviceAuthorizationState }
  | { state: "local_incomplete"; reason: string }
  | ({ state: "located" } & LocatedCredential)

export interface LocalAuthSnapshot {
  config: CliConfig | null
  index: TokenIndex | null
  metadata: CredentialMetadata | null
  device: DeviceAuthorizationState | null
  issueReservation: DeviceIssueReservation | null
  pollAttempt: DevicePollAttempt | null
  fallbackExists: boolean
}

export interface LocalAuthIdentity {
  environment: CliConfig["environment"] | null
  issuerOrigin: string | null
  clientInstanceId: string | null
  tokenGeneration: string | null
  deviceGeneration: string | null
}

export function identityForSnapshot(
  snapshot: LocalAuthSnapshot
): LocalAuthIdentity {
  const candidates = [
    snapshot.config
      ? {
          environment: snapshot.config.environment,
          issuerOrigin: snapshot.config.issuerOrigin,
          clientInstanceId: snapshot.config.clientInstanceId,
        }
      : null,
    snapshot.index
      ? {
          environment: snapshot.index.environment,
          issuerOrigin: snapshot.index.issuerOrigin,
          clientInstanceId: snapshot.index.clientInstanceId,
        }
      : null,
    snapshot.device
      ? {
          environment: snapshot.device.environment,
          issuerOrigin: snapshot.device.issuerOrigin,
          clientInstanceId: snapshot.device.clientInstanceId,
        }
      : null,
    snapshot.issueReservation
      ? {
          environment: snapshot.issueReservation.environment,
          issuerOrigin: snapshot.issueReservation.issuerOrigin,
          clientInstanceId: snapshot.issueReservation.clientInstanceId,
        }
      : null,
  ].filter((candidate) => candidate !== null)
  const canonical = candidates[0] ?? null
  const consistent =
    canonical !== null &&
    candidates.every(
      (candidate) =>
        candidate.environment === canonical.environment &&
        candidate.issuerOrigin === canonical.issuerOrigin &&
        candidate.clientInstanceId === canonical.clientInstanceId
    )
  return {
    environment: consistent ? canonical.environment : null,
    issuerOrigin: consistent ? canonical.issuerOrigin : null,
    clientInstanceId: consistent ? canonical.clientInstanceId : null,
    tokenGeneration: snapshot.index?.generation ?? null,
    deviceGeneration: snapshot.device?.generation ?? null,
  }
}

export function authIdentitiesEqual(
  left: LocalAuthIdentity,
  right: LocalAuthIdentity
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function credentialDispatchFenceFailure() {
  return dependencyFailure(
    "Local authentication state changed before the remote write; no request was sent.",
    EXIT_CODE.retryable,
    { localStateChanged: true }
  )
}

function isOwnerCredentialKind(value: unknown): boolean {
  return value === "owner_cli_session"
}

function constantTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8")
  const b = Buffer.from(right, "utf8")
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function credentialMetadataMatches(
  metadata: CredentialMetadata,
  index: TokenIndex
): boolean {
  return (
    metadata.credentialId === index.credentialId &&
    metadata.issuerOrigin === index.issuerOrigin &&
    metadata.clientInstanceId === index.clientInstanceId &&
    metadata.loggedInAt === index.tokenReceivedAt &&
    metadata.deviceName === index.deviceName
  )
}

export class LocalCredentialCoordinator {
  private readonly now: () => Date

  constructor(
    readonly state: CliStateStore,
    readonly credentials: CredentialStore,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async readLocalSnapshotLocked(): Promise<LocalAuthSnapshot> {
    const [
      config,
      index,
      metadata,
      device,
      issueReservation,
      pollAttempt,
      fallbackExists,
    ] = await Promise.all([
      this.state.readConfig(),
      this.state.readTokenIndex(),
      this.state.readCredentials(),
      this.state.readDeviceState(),
      this.state.readDeviceIssueReservation(),
      this.state.readDevicePollAttempt(),
      this.state.fileSystem.exists(this.state.paths.fallbackToken),
    ])
    return {
      config,
      index,
      metadata,
      device,
      issueReservation,
      pollAttempt,
      fallbackExists,
    }
  }

  async inspectAndRecover(): Promise<CredentialInspection> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await this.state.withAuthLock(async () =>
        this.readLocalSnapshotLocked()
      )
      const local = this.inspectLocalSnapshot(snapshot)
      if (local !== null) return local

      const index = snapshot.index!
      const token = await this.credentials.read(index)
      const finalized = await this.state.withAuthLock(async () => {
        const current = await this.readLocalSnapshotLocked()
        if (!snapshotsEqual(snapshot, current)) {
          return null
        }
        if (token === null) {
          return {
            state: "local_incomplete",
            reason: "token_missing",
          } as const
        }

        const parsed = parseOwnerSessionToken(token)
        if (
          !parsed ||
          parsed.credentialId !== index.credentialId ||
          !constantTextEqual(parsed.token, token)
        ) {
          return {
            state: "local_incomplete",
            reason: "metadata_mismatch",
          } as const
        }

        let currentDevice = current.device
        if (
          current.pollAttempt !== null &&
          !pollAttemptMatchesIndex(current.pollAttempt, index)
        ) {
          return {
            state: "local_incomplete",
            reason: "metadata_mismatch",
          } as const
        }
        if (
          current.device &&
          current.device.generation === index.deviceGeneration &&
          (current.device.localState === "issued" ||
            current.device.localState === "polling")
        ) {
          currentDevice = {
            ...current.device,
            localState: "token_received",
            deviceCode: null,
            userCode: null,
          }
          await this.state.writeDeviceState(currentDevice)
        }
        if (
          current.pollAttempt &&
          pollAttemptMatchesIndex(current.pollAttempt, index)
        ) {
          await this.state.clearDevicePollAttempt()
        }

        const finalSnapshot = await this.readLocalSnapshotLocked()
        return {
          state: "located",
          index,
          token,
          credentials: current.metadata,
          device: currentDevice,
          identity: identityForSnapshot(finalSnapshot),
        } as const
      })
      if (finalized !== null) return finalized
    }
    throw dependencyFailure(
      "Local authentication state changed repeatedly; retry the command."
    )
  }

  captureIdentity(): Promise<LocalAuthIdentity> {
    return this.state.withAuthLock(async () =>
      identityForSnapshot(await this.readLocalSnapshotLocked())
    )
  }

  /**
   * Status POST 的两阶段凭证 fence：先按已冻结 locator 在锁外
   * 读取并核验 Token，再在短 auth lock 内重读完整本地代际。
   */
  async fenceExpectedLocatedCredential(
    expected: LocatedCredential
  ): Promise<string> {
    const expectedMetadata = expected.credentials
    if (
      expectedMetadata === null ||
      expected.identity.tokenGeneration !== expected.index.generation ||
      expected.identity.environment !== expected.index.environment ||
      expected.identity.issuerOrigin !== expected.index.issuerOrigin ||
      expected.identity.clientInstanceId !== expected.index.clientInstanceId ||
      expected.index.state !== "stored" ||
      !isOwnerCredentialKind(expected.index.credentialKind) ||
      !isOwnerCredentialKind(expectedMetadata.credentialKind) ||
      !credentialMetadataMatches(expectedMetadata, expected.index) ||
      !Number.isSafeInteger(expectedMetadata.teamId) ||
      expectedMetadata.teamId < 1
    ) {
      throw credentialDispatchFenceFailure()
    }

    const token = await this.credentials.read(expected.index)
    const parsed = token === null ? null : parseOwnerSessionToken(token)
    if (
      token === null ||
      parsed === null ||
      parsed.credentialId !== expected.index.credentialId ||
      !this.credentials.tokensEqual(token, expected.token)
    ) {
      throw credentialDispatchFenceFailure()
    }

    const transaction = { entered: false }
    try {
      return await this.state.withAuthLock(async () => {
        transaction.entered = true
        const snapshot = await this.readLocalSnapshotLocked()
        const index = snapshot.index
        const metadata = snapshot.metadata
        const currentIdentity = identityForSnapshot(snapshot)
        if (
          this.inspectLocalSnapshot(snapshot) !== null ||
          index === null ||
          metadata === null ||
          !authIdentitiesEqual(currentIdentity, expected.identity) ||
          expected.identity.tokenGeneration !== expected.index.generation ||
          expected.index.state !== "stored" ||
          index.generation !== expected.index.generation ||
          index.state !== "stored" ||
          index.environment !== expected.index.environment ||
          index.issuerOrigin !== expected.index.issuerOrigin ||
          !isOwnerCredentialKind(index.credentialKind) ||
          !isOwnerCredentialKind(expected.index.credentialKind) ||
          index.credentialId !== expected.index.credentialId ||
          index.clientInstanceId !== expected.index.clientInstanceId ||
          index.storageKind !== expected.index.storageKind ||
          !credentialMetadataMatches(metadata, index) ||
          !isOwnerCredentialKind(metadata.credentialKind) ||
          !isOwnerCredentialKind(expectedMetadata.credentialKind) ||
          metadata.credentialId !== expectedMetadata.credentialId ||
          metadata.issuerOrigin !== expectedMetadata.issuerOrigin ||
          metadata.teamId !== expectedMetadata.teamId ||
          metadata.clientInstanceId !== expectedMetadata.clientInstanceId
        ) {
          throw credentialDispatchFenceFailure()
        }
        return token
      })
    } catch (error) {
      if (!transaction.entered && error instanceof SecureFileLockBusyError) {
        throw credentialDispatchFenceFailure()
      }
      throw error
    }
  }

  inspectLocalSnapshot(
    snapshot: LocalAuthSnapshot
  ): Exclude<CredentialInspection, { state: "located" }> | null {
    const {
      config,
      index,
      metadata,
      device,
      issueReservation,
      pollAttempt,
      fallbackExists,
    } = snapshot
    if (issueReservation) {
      return {
        state: "local_incomplete",
        reason: "metadata_mismatch",
      }
    }
    if (
      (device &&
        (!config ||
          config.issuerOrigin !== device.issuerOrigin ||
          config.environment !== device.environment ||
          config.clientInstanceId !== device.clientInstanceId)) ||
      (pollAttempt &&
        (!device ||
          pollAttempt.deviceGeneration !== device.generation))
    ) {
      return { state: "local_incomplete", reason: "metadata_mismatch" }
    }
    if (!index) {
      if (
        metadata ||
        fallbackExists ||
        device?.localState === "token_received" ||
        (pollAttempt !== null && device === null)
      ) {
        return {
          state: "local_incomplete",
          reason: "token_index_missing",
        }
      }
      return device ? { state: "device_only", device } : { state: "none" }
    }

    if (
      !config ||
      config.issuerOrigin !== index.issuerOrigin ||
      config.environment !== index.environment ||
      config.clientInstanceId !== index.clientInstanceId ||
      environmentForMachineOrigin(index.issuerOrigin) !== config.environment ||
      (device !== null && device.generation !== index.deviceGeneration) ||
      (pollAttempt !== null && !pollAttemptMatchesIndex(pollAttempt, index)) ||
      (index.storageKind === "keychain" && fallbackExists) ||
      (metadata !== null && !credentialMetadataMatches(metadata, index))
    ) {
      return { state: "local_incomplete", reason: "metadata_mismatch" }
    }
    return null
  }

  async persistToken(input: {
    response: DeviceTokenResponse
    device: DeviceAuthorizationState
    attempt: DevicePollAttempt
    tokenReceivedAt: string
  }): Promise<{ located: LocatedCredential; warning: string | null }> {
    if (
      input.attempt.storageKind === null ||
      input.attempt.deviceGeneration !== input.device.generation
    ) {
      throw usageFailure(
        "The Token response is not bound to a valid Device poll attempt."
      )
    }

    const index: TokenIndex = {
      tokenIndexFormatVersion: 1,
      generation: randomUUID(),
      state: "stored",
      environment: input.device.environment,
      issuerOrigin: input.device.issuerOrigin,
      credentialKind: "owner_cli_session",
      credentialId: input.response.credentialId,
      clientInstanceId: input.device.clientInstanceId,
      deviceGeneration: input.device.generation,
      deviceName: input.device.deviceName,
      tokenReceivedAt: input.tokenReceivedAt,
      storageKind: input.attempt.storageKind,
    }

    try {
      await this.state.withAuthLock(async () => {
        const snapshot = await this.readLocalSnapshotLocked()
        if (snapshot.index) {
          throw usageFailure(
            "A credential is already stored. Run auth logout before authorizing again."
          )
        }
        if (
          snapshot.metadata ||
          snapshot.fallbackExists ||
          snapshot.issueReservation ||
          !snapshot.device ||
          snapshot.device.generation !== input.device.generation ||
          snapshot.device.issuerOrigin !== input.device.issuerOrigin ||
          snapshot.device.environment !== input.device.environment ||
          snapshot.device.clientInstanceId !== input.device.clientInstanceId ||
          !snapshot.pollAttempt ||
          !pollAttemptsEqual(snapshot.pollAttempt, input.attempt)
        ) {
          throw usageFailure(
            "Local credential state changed before the Token could be stored."
          )
        }
        if (
          !snapshot.config ||
          snapshot.config.environment !== index.environment ||
          snapshot.config.issuerOrigin !== index.issuerOrigin ||
          snapshot.config.clientInstanceId !== index.clientInstanceId
        ) {
          throw usageFailure(
            "The Token response does not match the current CLI configuration."
          )
        }
      })

      await this.credentials.write(index, input.response.accessToken)
      const reread = await this.credentials.read(index)
      if (
        reread === null ||
        !this.credentials.tokensEqual(reread, input.response.accessToken)
      ) {
        throw new Error("credential verification failed")
      }

      return await this.state.withAuthLock(async () => {
        const currentIndex = await this.state.readTokenIndex()
        const currentDevice = await this.state.readDeviceState()
        const currentAttempt = await this.state.readDevicePollAttempt()
        if (
          currentIndex !== null ||
          !currentDevice ||
          currentDevice.generation !== input.device.generation ||
          currentDevice.issuerOrigin !== input.device.issuerOrigin ||
          !currentAttempt ||
          !pollAttemptsEqual(currentAttempt, input.attempt)
        ) {
          throw outcomeUnknownFailure(
            "The Token was stored, but local authentication state changed before finalization."
          )
        }

        await this.state.writeTokenIndex(index)
        const tokenReceivedDevice: DeviceAuthorizationState = {
          ...currentDevice,
          localState: "token_received",
          deviceCode: null,
          userCode: null,
        }
        await this.state.writeDeviceState(tokenReceivedDevice)
        await this.state.clearDevicePollAttempt()
        const identity = identityForSnapshot({
          ...(await this.readLocalSnapshotLocked()),
          index,
          device: tokenReceivedDevice,
          pollAttempt: null,
        })
        return {
          located: {
            index,
            token: input.response.accessToken,
            credentials: null,
            device: tokenReceivedDevice,
            identity,
          },
          warning: credentialStorageWarning(index.storageKind),
        }
      })
    } catch (error) {
      if (error instanceof Error && error.name === "CliFailure") {
        const failure = error as { exitCode?: unknown }
        if (failure.exitCode === 5) throw error
      }
      throw prependFailureWarning(
        outcomeUnknownFailure(
          "The one-time Token response was received, but secure storage could not be confirmed."
        ),
        credentialStorageWarning(index.storageKind)
      )
    }
  }

  async persistMeFacts(
    located: LocatedCredential,
    facts: MeFacts
  ): Promise<CredentialMetadata> {
    return this.state.withAuthLock(async () => {
      const snapshot = await this.readLocalSnapshotLocked()
      if (
        !snapshot.index ||
        snapshot.index.state !== "stored" ||
        snapshot.index.generation !== located.index.generation ||
        snapshot.index.credentialId !== located.index.credentialId ||
        snapshot.index.issuerOrigin !== located.index.issuerOrigin ||
        snapshot.index.environment !== located.index.environment ||
        snapshot.index.clientInstanceId !== located.index.clientInstanceId
      ) {
        throw usageFailure(
          "Local credential state changed while /me was being verified.",
          { reason: "metadata_mismatch" }
        )
      }
      const metadata = newCredentialMetadata({
        credentialId: snapshot.index.credentialId,
        issuerOrigin: snapshot.index.issuerOrigin,
        teamId: facts.teamId,
        teamName: facts.teamName,
        deviceName: snapshot.index.deviceName,
        clientInstanceId: snapshot.index.clientInstanceId,
        loggedInAt: snapshot.index.tokenReceivedAt,
        absoluteExpiresAt: facts.absoluteExpiresAt,
      })
      await this.state.writeCredentials(metadata)
      if (snapshot.device?.generation === snapshot.index.deviceGeneration) {
        await this.state.clearDeviceState()
      }
      return metadata
    })
  }

  async preflightCredentialStorage(): Promise<void> {
    await this.credentials.assertCandidateAvailable()
  }

  async requireLocated(): Promise<LocatedCredential> {
    const inspection = await this.inspectAndRecover()
    if (inspection.state === "located") return inspection
    if (inspection.state === "local_incomplete") {
      throw authenticationFailure(
        "Local authentication state is incomplete.",
        "INVALID_CREDENTIAL",
        { reason: inspection.reason }
      )
    }
    throw authenticationFailure("No AdRate credential is stored.")
  }

  async countPendingCommands(): Promise<number> {
    const path = this.state.paths.pendingCommands
    if (!(await this.state.fileSystem.exists(path))) return 0
    await this.state.fileSystem.ensureDirectory(path)
    const entries = await readdir(path)
    let count = 0
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const full = this.state.fileSystem.assertContained(join(path, entry))
      const info = await lstat(full)
      if (info.isSymbolicLink()) {
        throw usageFailure("A pending Command record is a symbolic link.")
      }
      if (info.isFile()) count += 1
    }
    return count
  }

  async hasAnyAuthenticationArtifact(): Promise<boolean> {
    const candidates = [
      this.state.paths.tokenIndex,
      this.state.paths.credentials,
      this.state.paths.fallbackToken,
      this.state.paths.deviceCurrent,
      this.state.paths.deviceIssueReservation,
      this.state.paths.devicePollAttempt,
    ]
    for (const path of candidates) {
      if (await this.state.fileSystem.exists(path)) return true
    }
    return false
  }
}

function snapshotsEqual(
  left: LocalAuthSnapshot,
  right: LocalAuthSnapshot
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
