import { createHash, randomUUID } from "node:crypto"
import { dependencyFailure } from "../errors.js"
import {
  authIdentitiesEqual,
  identityForSnapshot,
} from "./local-credentials.js"
import type {
  LocalAuthIdentity,
  LocalAuthSnapshot,
  LocalCredentialCoordinator,
} from "./local-credentials.js"
import type {
  AuthCleanupCredentialLocator,
  AuthCleanupReservation,
} from "../storage/schemas.js"

type DigestibleArtifact = Exclude<
  LocalAuthSnapshot[
    | "config"
    | "index"
    | "metadata"
    | "device"
    | "issueReservation"
    | "pollAttempt"],
  null
>

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function artifactDigest(value: DigestibleArtifact | null): string | null {
  if (value === null) return null
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function digestAllowsOnlyRemoval(
  expectedDigest: string | null,
  current: DigestibleArtifact | null
): boolean {
  return (
    current === null ||
    (expectedDigest !== null && artifactDigest(current) === expectedDigest)
  )
}

function credentialLocatorForSnapshot(
  snapshot: LocalAuthSnapshot
): AuthCleanupCredentialLocator | null {
  if (!snapshot.index) return null
  return {
    issuerOrigin: snapshot.index.issuerOrigin,
    credentialKind: snapshot.index.credentialKind,
    credentialId: snapshot.index.credentialId,
    storageKind: snapshot.index.storageKind,
  }
}

function reservationEvidenceEqual(
  left: AuthCleanupReservation,
  right: AuthCleanupReservation
): boolean {
  const { phase: _leftPhase, ...leftEvidence } = left
  const { phase: _rightPhase, ...rightEvidence } = right
  return canonicalJson(leftEvidence) === canonicalJson(rightEvidence)
}

function snapshotOnlyRemovesReservedArtifacts(
  reservation: AuthCleanupReservation,
  snapshot: LocalAuthSnapshot
): boolean {
  if (
    !digestAllowsOnlyRemoval(
      reservation.expectedConfigDigest,
      snapshot.config
    ) ||
    !digestAllowsOnlyRemoval(reservation.expectedTokenDigest, snapshot.index) ||
    !digestAllowsOnlyRemoval(
      reservation.expectedMetadataDigest,
      snapshot.metadata
    ) ||
    !digestAllowsOnlyRemoval(
      reservation.expectedDeviceDigest,
      snapshot.device
    ) ||
    !digestAllowsOnlyRemoval(
      reservation.expectedIssueDigest,
      snapshot.issueReservation
    ) ||
    !digestAllowsOnlyRemoval(
      reservation.expectedPollDigest,
      snapshot.pollAttempt
    ) ||
    (snapshot.fallbackExists && !reservation.expectedFallbackExists)
  ) {
    return false
  }

  if (
    snapshot.index &&
    (reservation.credentialLocator === null ||
      snapshot.index.generation !== reservation.expectedTokenGeneration ||
      snapshot.index.issuerOrigin !==
        reservation.credentialLocator.issuerOrigin ||
      snapshot.index.credentialId !==
        reservation.credentialLocator.credentialId ||
      snapshot.index.storageKind !== reservation.credentialLocator.storageKind)
  ) {
    return false
  }
  if (
    snapshot.device?.generation !== undefined &&
    snapshot.device.generation !== reservation.expectedDeviceGeneration
  ) {
    return false
  }
  if (
    snapshot.issueReservation?.ownerToken !== undefined &&
    snapshot.issueReservation.ownerToken !== reservation.expectedIssueOwnerToken
  ) {
    return false
  }
  if (
    snapshot.pollAttempt?.ownerToken !== undefined &&
    snapshot.pollAttempt.ownerToken !== reservation.expectedPollOwnerToken
  ) {
    return false
  }
  return true
}

function identityOnlyRemovesReservation(
  reservation: AuthCleanupReservation,
  identity: LocalAuthIdentity
): boolean {
  return (
    (identity.environment === null ||
      identity.environment === reservation.expectedEnvironment) &&
    (identity.issuerOrigin === null ||
      identity.issuerOrigin === reservation.expectedIssuerOrigin) &&
    (identity.clientInstanceId === null ||
      identity.clientInstanceId === reservation.expectedClientInstanceId) &&
    (identity.tokenGeneration === null ||
      identity.tokenGeneration === reservation.expectedTokenGeneration) &&
    (identity.deviceGeneration === null ||
      identity.deviceGeneration === reservation.expectedDeviceGeneration) &&
    (identity.issueOwnerToken === null ||
      identity.issueOwnerToken === reservation.expectedIssueOwnerToken) &&
    (identity.pollOwnerToken === null ||
      identity.pollOwnerToken === reservation.expectedPollOwnerToken)
  )
}

function allManagedArtifactsRemoved(snapshot: LocalAuthSnapshot): boolean {
  return (
    snapshot.index === null &&
    snapshot.metadata === null &&
    snapshot.device === null &&
    snapshot.issueReservation === null &&
    snapshot.pollAttempt === null &&
    snapshot.fallbackExists === false
  )
}

function cleanupChangedFailure(): never {
  throw dependencyFailure(
    "Authentication state changed during conditional cleanup."
  )
}

/**
 * 认证清理是可重入的单调事务。reservation 冻结 secret 定位与每个本地
 * artifact 的摘要；重入只接受原 artifact 或 null，绝不会删除后来的状态。
 */
export class AuthCleanupCoordinator {
  constructor(
    private readonly local: LocalCredentialCoordinator,
    private readonly now: () => Date
  ) {}

  async clearIfUnchanged(
    expected: LocalAuthIdentity
  ): Promise<"cleared" | "stale"> {
    return this.clear(expected, null)
  }

  /** 只续作调用者在短锁内冻结的同一 reservation，禁止 ABA 后新建清理事务。 */
  async resumeExisting(
    required: AuthCleanupReservation
  ): Promise<"cleared" | "stale"> {
    return this.clear(null, required)
  }

  private async clear(
    expected: LocalAuthIdentity | null,
    required: AuthCleanupReservation | null
  ): Promise<"cleared" | "stale"> {
    const prepared = await this.local.state.withAuthLock(async () => {
      const snapshot = await this.local.readLocalSnapshotLocked()
      const currentIdentity = identityForSnapshot(snapshot)
      let reservation = snapshot.cleanupReservation
      if (required) {
        if (!reservation || !reservationEvidenceEqual(reservation, required)) {
          return { kind: "stale" as const }
        }
        if (!snapshotOnlyRemovesReservedArtifacts(reservation, snapshot)) {
          throw dependencyFailure(
            "A different authentication cleanup transaction is already in progress."
          )
        }
      } else if (reservation) {
        if (!snapshotOnlyRemovesReservedArtifacts(reservation, snapshot)) {
          throw dependencyFailure(
            "A different authentication cleanup transaction is already in progress."
          )
        }
        if (
          expected === null ||
          !identityOnlyRemovesReservation(reservation, expected)
        ) {
          return { kind: "stale" as const }
        }
      } else {
        if (
          expected === null ||
          !authIdentitiesEqual(currentIdentity, expected)
        ) {
          return { kind: "stale" as const }
        }
        reservation = {
          formatVersion: 1,
          ownerToken: randomUUID(),
          phase: "prepared",
          credentialLocator: credentialLocatorForSnapshot(snapshot),
          expectedFallbackExists: snapshot.fallbackExists,
          expectedEnvironment: currentIdentity.environment,
          expectedIssuerOrigin: currentIdentity.issuerOrigin,
          expectedClientInstanceId: currentIdentity.clientInstanceId,
          expectedTokenGeneration: currentIdentity.tokenGeneration,
          expectedDeviceGeneration: currentIdentity.deviceGeneration,
          expectedIssueOwnerToken: currentIdentity.issueOwnerToken,
          expectedPollOwnerToken: currentIdentity.pollOwnerToken,
          expectedConfigDigest: artifactDigest(snapshot.config),
          expectedTokenDigest: artifactDigest(snapshot.index),
          expectedMetadataDigest: artifactDigest(snapshot.metadata),
          expectedDeviceDigest: artifactDigest(snapshot.device),
          expectedIssueDigest: artifactDigest(snapshot.issueReservation),
          expectedPollDigest: artifactDigest(snapshot.pollAttempt),
          createdAt: this.now().toISOString(),
        }
        await this.local.state.writeAuthCleanupReservation(reservation)
      }
      if (reservation.phase === "prepared") {
        // fallback Token 使用固定路径，必须在 reservation 存续的
        // auth lock 内删除，防止旧删除者在 ABA 后破坏新 Token。
        await this.local.credentials.removeFallbackAuthenticationArtifactAt(
          reservation.credentialLocator,
          reservation.expectedFallbackExists
        )
      }
      return { kind: "prepared" as const, reservation }
    })
    if (prepared.kind === "stale") return "stale"

    let reservation = prepared.reservation
    if (reservation.phase === "prepared") {
      // Secret I/O 故意位于 auth lock 之外。崩溃后 phase 仍为 prepared，
      // 只会对冻结地址重复一次幂等删除。
      await this.local.credentials.removeKeychainAuthenticationArtifactAt(
        reservation.credentialLocator
      )

      const transition = await this.local.state.withAuthLock(async () => {
        const snapshot = await this.local.readLocalSnapshotLocked()
        const current = snapshot.cleanupReservation
        if (current === null) {
          return allManagedArtifactsRemoved(snapshot)
            ? null
            : cleanupChangedFailure()
        }
        if (
          !reservationEvidenceEqual(current, reservation) ||
          !snapshotOnlyRemovesReservedArtifacts(current, snapshot)
        ) {
          return cleanupChangedFailure()
        }
        if (current.phase === "prepared") {
          const secretRemoved: AuthCleanupReservation = {
            ...current,
            phase: "secret_removed",
          }
          await this.local.state.writeAuthCleanupReservation(secretRemoved)
          return secretRemoved
        }
        return current
      })
      if (transition === null) return "cleared"
      reservation = transition
    }

    return this.local.state.withAuthLock(async () => {
      let snapshot = await this.local.readLocalSnapshotLocked()
      let current = snapshot.cleanupReservation
      if (current === null) {
        if (allManagedArtifactsRemoved(snapshot)) return "cleared" as const
        return cleanupChangedFailure()
      }
      if (
        !reservationEvidenceEqual(current, reservation) ||
        !snapshotOnlyRemovesReservedArtifacts(current, snapshot) ||
        current.phase === "prepared"
      ) {
        return cleanupChangedFailure()
      }
      if (current.phase === "secret_removed") {
        current = { ...current, phase: "pruning" }
        await this.local.state.writeAuthCleanupReservation(current)
      }

      // 删除顺序也是恢复合同。reservation 必须最后删除。
      if (snapshot.metadata !== null) {
        await this.local.state.fileSystem.removeSecureFile(
          this.local.state.paths.credentials
        )
      }
      if (snapshot.device !== null) await this.local.state.clearDeviceState()
      if (snapshot.issueReservation !== null) {
        await this.local.state.clearDeviceIssueReservation()
      }
      if (snapshot.pollAttempt !== null) {
        await this.local.state.clearDevicePollAttempt()
      }
      if (snapshot.index !== null) {
        await this.local.state.fileSystem.removeSecureFile(
          this.local.state.paths.tokenIndex
        )
      }

      snapshot = await this.local.readLocalSnapshotLocked()
      if (
        !snapshot.cleanupReservation ||
        !reservationEvidenceEqual(snapshot.cleanupReservation, current) ||
        !snapshotOnlyRemovesReservedArtifacts(current, snapshot) ||
        !allManagedArtifactsRemoved(snapshot)
      ) {
        return cleanupChangedFailure()
      }
      await this.local.state.clearAuthCleanupReservation()
      return "cleared" as const
    })
  }
}
