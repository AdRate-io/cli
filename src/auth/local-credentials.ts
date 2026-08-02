import { lstat, readdir } from "node:fs/promises"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { Buffer } from "node:buffer"
import { join } from "node:path"
import { parseOwnerSessionToken } from "../contracts/oauth.js"
import { DEVICE_TRANSACTION_LEASE_MS, EXIT_CODE } from "../constants.js"
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
import { DefaultProcessIdentityProbe } from "./process-identity.js"
import type {
  ProcessIdentity,
  ProcessIdentityProbe,
} from "./process-identity.js"
import type { CliStateStore } from "../storage/state-store.js"
import type {
  AuthCleanupReservation,
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
  cleanupReservation: AuthCleanupReservation | null
  fallbackExists: boolean
}

export interface LocalAuthIdentity {
  environment: CliConfig["environment"] | null
  issuerOrigin: string | null
  clientInstanceId: string | null
  tokenGeneration: string | null
  deviceGeneration: string | null
  issueOwnerToken: string | null
  pollOwnerToken: string | null
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
    snapshot.pollAttempt
      ? {
          environment: snapshot.pollAttempt.environment,
          issuerOrigin: snapshot.pollAttempt.issuerOrigin,
          clientInstanceId: snapshot.pollAttempt.clientInstanceId,
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
    issueOwnerToken: snapshot.issueReservation?.ownerToken ?? null,
    pollOwnerToken: snapshot.pollAttempt?.ownerToken ?? null,
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
  private readonly processIdentity: ProcessIdentityProbe

  constructor(
    readonly state: CliStateStore,
    readonly credentials: CredentialStore,
    options: {
      now?: () => Date
      processIdentity?: ProcessIdentityProbe
    } = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.processIdentity =
      options.processIdentity ?? new DefaultProcessIdentityProbe()
  }

  storageCommitProcessIdentity(): Promise<ProcessIdentity> {
    return this.processIdentity.current()
  }

  async readLocalSnapshotLocked(): Promise<LocalAuthSnapshot> {
    const [
      config,
      index,
      metadata,
      device,
      issueReservation,
      pollAttempt,
      cleanupReservation,
      fallbackExists,
    ] = await Promise.all([
      this.state.readConfig(),
      this.state.readTokenIndex(),
      this.state.readCredentials(),
      this.state.readDeviceState(),
      this.state.readDeviceIssueReservation(),
      this.state.readDevicePollAttempt(),
      this.state.readAuthCleanupReservation(),
      this.state.fileSystem.exists(this.state.paths.fallbackToken),
    ])
    return {
      config,
      index,
      metadata,
      device,
      issueReservation,
      pollAttempt,
      cleanupReservation,
      fallbackExists,
    }
  }

  async inspectAndRecover(): Promise<CredentialInspection> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await this.state.withAuthLock(async () =>
        this.settleTerminalDeviceLocked(await this.readLocalSnapshotLocked())
      )
      const local = this.inspectLocalSnapshot(snapshot)
      if (local !== null) return local

      const index = snapshot.index!
      if (index.state === "staging") {
        await this.assertStagingRecoveryAllowed(index)
      }
      const token = await this.credentials.read(index)
      const finalized = await this.state.withAuthLock(async () => {
        const current = await this.readLocalSnapshotLocked()
        if (!snapshotsEqual(snapshot, current)) {
          return null
        }
        if (token === null) {
          if (index.state === "staging") {
            const device = current.device
            if (
              current.pollAttempt !== null &&
              !pollAttemptMatchesIndex(current.pollAttempt, index)
            ) {
              throw outcomeUnknownFailure(
                "The staging Token transaction no longer owns the exact Device poll evidence; no local evidence was modified.",
                { deliveryState: "delivery_unknown" }
              )
            }
            if (
              !device ||
              device.generation !== index.deviceGeneration ||
              device.environment !== index.environment ||
              device.issuerOrigin !== index.issuerOrigin ||
              device.clientInstanceId !== index.clientInstanceId ||
              device.localState === "token_received" ||
              device.deviceCode === null
            ) {
              throw outcomeUnknownFailure(
                "The staging Token transaction no longer matches its Device evidence; no local evidence was removed.",
                { deliveryState: "delivery_unknown" }
              )
            }

            // 恢复顺序是持久合同：先立 tombstone，再清 poll，最后删除
            // staging index。任一步崩溃后重入都只能重复当前或后续步骤。
            if (
              device.localState !== "delivery_unknown" ||
              device.deliveryVerificationAttemptedAt !== index.tokenReceivedAt
            ) {
              await this.state.writeDeviceState({
                ...device,
                localState: "delivery_unknown",
                deliveryVerificationAttemptedAt: index.tokenReceivedAt,
              })
            }

            if (current.pollAttempt) {
              await this.state.clearDevicePollAttempt()
            }

            await this.state.fileSystem.removeSecureFile(
              this.state.paths.tokenIndex
            )
            throw outcomeUnknownFailure(
              "A one-time Token may have been delivered but was not durably stored. Do not restart the old exchange.",
              { deliveryState: "delivery_unknown" }
            )
          }
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

        let currentIndex = index
        let currentDevice = current.device
        if (index.state === "staging") {
          if (
            current.pollAttempt === null ||
            !pollAttemptMatchesIndex(current.pollAttempt, index)
          ) {
            return {
              state: "local_incomplete",
              reason: "metadata_mismatch",
            } as const
          }
          currentIndex = { ...index, state: "stored", storageCommit: null }
          await this.state.writeTokenIndex(currentIndex)
        }
        if (
          current.device &&
          current.device.generation === index.deviceGeneration &&
          (current.device.localState === "issued" ||
            current.device.localState === "polling" ||
            current.device.localState === "delivery_unknown")
        ) {
          currentDevice = {
            ...current.device,
            localState: "token_received",
            deviceCode: null,
            userCode: null,
            deliveryVerificationAttemptedAt: null,
            terminalEvidence: null,
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
          index: currentIndex,
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
   * 返回即表示在该线性化点凭证仍精确一致；调用方必须紧接
   * 发出唯一 POST，不得在中间再做异步工作。网络和 Keychain
   * I/O 不得持有跨进程 auth lock。
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
      expected.index.storageCommit !== null ||
      !isOwnerCredentialKind(expected.index.credentialKind) ||
      !isOwnerCredentialKind(expectedMetadata.credentialKind) ||
      !credentialMetadataMatches(expectedMetadata, expected.index) ||
      !Number.isSafeInteger(expectedMetadata.teamId) ||
      expectedMetadata.teamId < 1
    ) {
      throw credentialDispatchFenceFailure()
    }

    // 只使用 expected.index 的冻结 backend/address，不先读当前 index
    // 来猜 locator。Token 读取可能较慢，必须位于 auth lock 外。
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
          snapshot.cleanupReservation !== null ||
          this.inspectLocalSnapshot(snapshot) !== null ||
          index === null ||
          metadata === null ||
          !authIdentitiesEqual(currentIdentity, expected.identity) ||
          expected.identity.tokenGeneration !== expected.index.generation ||
          expected.index.state !== "stored" ||
          expected.index.storageCommit !== null ||
          index.generation !== expected.index.generation ||
          index.state !== "stored" ||
          index.storageCommit !== null ||
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

  /**
   * terminal Device 是 Token 端点已返回稳定终态的内部墓碑。
   * 它冻结完整 dispatch attempt；只允许删除该 attempt 原值或已删状态。
   * 调用者必须已持有 auth lock。
   */
  async settleTerminalDeviceLocked(
    snapshot: LocalAuthSnapshot
  ): Promise<LocalAuthSnapshot> {
    const device = snapshot.device
    if (device?.localState !== "terminal") return snapshot
    const terminalAttempt = device.terminalEvidence?.attempt
    if (
      !terminalAttempt ||
      snapshot.index ||
      snapshot.metadata ||
      snapshot.fallbackExists ||
      snapshot.issueReservation ||
      snapshot.cleanupReservation ||
      !snapshot.config ||
      snapshot.config.environment !== device.environment ||
      snapshot.config.issuerOrigin !== device.issuerOrigin ||
      snapshot.config.clientInstanceId !== device.clientInstanceId ||
      (snapshot.pollAttempt !== null &&
        !pollAttemptsEqual(snapshot.pollAttempt, terminalAttempt))
    ) {
      throw usageFailure(
        "The terminal Device transaction conflicts with other local authentication evidence.",
        { reason: "metadata_mismatch" }
      )
    }
    if (snapshot.pollAttempt) await this.state.clearDevicePollAttempt()
    await this.state.clearDeviceState()
    return this.readLocalSnapshotLocked()
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
      cleanupReservation,
      fallbackExists,
    } = snapshot
    if (issueReservation || cleanupReservation) {
      return {
        state: "local_incomplete",
        reason: "metadata_mismatch",
      }
    }
    if (device?.localState === "terminal") {
      return { state: "local_incomplete", reason: "metadata_mismatch" }
    }
    if (
      (device &&
        (!config ||
          config.issuerOrigin !== device.issuerOrigin ||
          config.environment !== device.environment ||
          config.clientInstanceId !== device.clientInstanceId)) ||
      (pollAttempt &&
        (!device ||
          pollAttempt.deviceGeneration !== device.generation ||
          pollAttempt.issuerOrigin !== device.issuerOrigin ||
          pollAttempt.environment !== device.environment ||
          pollAttempt.clientInstanceId !== device.clientInstanceId))
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
    let persistedIndex: TokenIndex | null = null
    try {
      if (
        input.attempt.phase !== "dispatch_intent" ||
        input.attempt.storageKind === null ||
        input.attempt.deviceGeneration !== input.device.generation ||
        input.attempt.environment !== input.device.environment ||
        input.attempt.issuerOrigin !== input.device.issuerOrigin ||
        input.attempt.clientInstanceId !== input.device.clientInstanceId
      ) {
        throw usageFailure(
          "The Token response is not bound to a valid Device poll attempt."
        )
      }
      const dispatchBoundary =
        input.attempt.verificationClaimedAt ?? input.attempt.dispatchedAt
      if (
        input.attempt.dispatchedAt === null ||
        dispatchBoundary === null ||
        new Date(input.tokenReceivedAt).getTime() <
          new Date(dispatchBoundary).getTime()
      ) {
        throw outcomeUnknownFailure(
          "The local clock moved behind the persisted Device dispatch timestamp; the Token response was not committed with an earlier delivery boundary.",
          { deliveryState: "delivery_unknown" }
        )
      }
      const index: TokenIndex = {
        tokenIndexFormatVersion: 1,
        generation: randomUUID(),
        state: "staging",
        environment: input.attempt.environment,
        issuerOrigin: input.device.issuerOrigin,
        credentialKind: "owner_cli_session",
        credentialId: input.response.credentialId,
        clientInstanceId: input.device.clientInstanceId,
        deviceGeneration: input.device.generation,
        pollAttemptOwnerToken: input.attempt.ownerToken,
        deviceName: input.device.deviceName,
        tokenReceivedAt: input.tokenReceivedAt,
        storageKind: input.attempt.storageKind,
        storageCommit: {
          transactionId: randomUUID(),
          ownerPid: input.attempt.ownerPid,
          ownerProcessFingerprint: input.attempt.ownerProcessFingerprint,
          leaseExpiresAt: new Date(
            new Date(input.tokenReceivedAt).getTime() +
              DEVICE_TRANSACTION_LEASE_MS
          ).toISOString(),
        },
      }
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
          snapshot.cleanupReservation ||
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
        // Token 200 后的第一笔持久化动作必须是无外部 I/O 的 staging index。
        await this.state.writeTokenIndex(index)
      })
      persistedIndex = index
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
          !currentIndex ||
          !tokenIndexesEqual(currentIndex, index) ||
          !currentDevice ||
          currentDevice.generation !== input.device.generation ||
          currentDevice.issuerOrigin !== input.device.issuerOrigin ||
          !currentAttempt ||
          !pollAttemptsEqual(currentAttempt, input.attempt)
        ) {
          throw outcomeUnknownFailure(
            "The Token was stored, but local transaction ownership changed before finalization.",
            { deliveryState: "delivery_unknown" }
          )
        }
        const stored: TokenIndex = {
          ...index,
          state: "stored",
          storageCommit: null,
        }
        await this.state.writeTokenIndex(stored)
        const tokenReceivedDevice: DeviceAuthorizationState = {
          ...currentDevice,
          localState: "token_received",
          deviceCode: null,
          userCode: null,
          deliveryVerificationAttemptedAt: null,
          terminalEvidence: null,
        }
        await this.state.writeDeviceState(tokenReceivedDevice)
        await this.state.clearDevicePollAttempt()
        const identity = identityForSnapshot({
          ...(await this.readLocalSnapshotLocked()),
          index: stored,
          device: tokenReceivedDevice,
          pollAttempt: null,
        })
        return {
          located: {
            index: stored,
            token: input.response.accessToken,
            credentials: null,
            device: tokenReceivedDevice,
            identity,
          },
          warning: credentialStorageWarning(stored.storageKind),
        }
      })
    } catch (error) {
      if (error instanceof Error && error.name === "CliFailure") {
        const failure = error as { exitCode?: unknown }
        if (failure.exitCode === 5) throw error
      }
      throw prependFailureWarning(
        outcomeUnknownFailure(
          "The one-time Token response was received, but secure storage could not be confirmed.",
          { deliveryState: "delivery_unknown" }
        ),
        persistedIndex === null
          ? null
          : credentialStorageWarning(persistedIndex.storageKind)
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
        snapshot.index.clientInstanceId !== located.index.clientInstanceId ||
        snapshot.cleanupReservation
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
      this.state.paths.authCleanupReservation,
      this.state.paths.logoutDeliveryJournal,
    ]
    for (const path of candidates) {
      if (await this.state.fileSystem.exists(path)) return true
    }
    return false
  }

  private async assertStagingRecoveryAllowed(index: TokenIndex): Promise<void> {
    const commit = index.storageCommit
    if (!commit) {
      throw usageFailure(
        "The staging Token index is missing its storage commit fence.",
        { reason: "metadata_mismatch" }
      )
    }
    const nowMs = this.now().getTime()
    const leaseExpiresMs = new Date(commit.leaseExpiresAt).getTime()
    if (nowMs <= leaseExpiresMs) {
      throw dependencyFailure(
        "Another CLI process is still committing the one-time Token to secure storage.",
        undefined,
        {
          localTransaction: "storage_commit_busy",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((leaseExpiresMs - nowMs) / 1000)
          ),
        }
      )
    }
    const status = await this.processIdentity.inspect({
      pid: commit.ownerPid,
      fingerprint: commit.ownerProcessFingerprint,
    })
    if (status === "same_process" || status === "permission_unknown") {
      throw dependencyFailure(
        "The Token storage lease elapsed, but the owning process is still active or cannot be safely distinguished.",
        undefined,
        {
          localTransaction: "storage_commit_busy",
          ownerLiveness: status,
          retryAfterSeconds: 1,
        }
      )
    }
    // dead 与 reused 都证明原 owner 进程实例已不存在；严格租约已在上面验证。
  }
}

function snapshotsEqual(
  left: LocalAuthSnapshot,
  right: LocalAuthSnapshot
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function tokenIndexesEqual(left: TokenIndex, right: TokenIndex): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
