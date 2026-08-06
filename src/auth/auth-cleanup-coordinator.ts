import {
  authIdentitiesEqual,
  identityForSnapshot,
} from "./local-credentials.js"
import type {
  LocalAuthIdentity,
  LocalAuthSnapshot,
  LocalCredentialCoordinator,
} from "./local-credentials.js"
import type { CredentialLocator } from "../storage/credential-backend.js"

function credentialLocatorForSnapshot(
  snapshot: LocalAuthSnapshot
): CredentialLocator | null {
  if (!snapshot.index) return null
  return {
    issuerOrigin: snapshot.index.issuerOrigin,
    credentialKind: snapshot.index.credentialKind,
    credentialId: snapshot.index.credentialId,
    storageKind: snapshot.index.storageKind,
  }
}

/**
 * 登出清理在同一把 auth lock 内完成。旧请求获取锁后必须重新比较
 * 完整身份，因此无需额外的 owner token、phase journal 或接管协议。
 */
export class AuthCleanupCoordinator {
  constructor(private readonly local: LocalCredentialCoordinator) {}

  async clearIfUnchanged(
    expected: LocalAuthIdentity
  ): Promise<"cleared" | "stale"> {
    return this.local.state.withAuthLock(async () => {
      const snapshot = await this.local.readLocalSnapshotLocked()
      if (!authIdentitiesEqual(identityForSnapshot(snapshot), expected)) {
        return "stale"
      }

      await this.local.credentials.removeAuthenticationArtifactsAt(
        credentialLocatorForSnapshot(snapshot),
        snapshot.fallbackExists
      )
      await this.clearLocalState(snapshot)
      return "cleared"
    })
  }

  /**
   * 显式 logout 遇到 TokenIndex 存在但 secret 确认已缺失时，只清理
   * 剩余本地记录。该路径不删除 secret，远端状态仍按未知返回。
   */
  async clearMissingCredentialState(): Promise<"cleared" | "stale"> {
    return this.local.state.withAuthLock(async () => {
      const snapshot = await this.local.readLocalSnapshotLocked()
      if (!snapshot.index) return "stale"
      if ((await this.local.credentials.read(snapshot.index)) !== null) {
        return "stale"
      }
      await this.clearLocalState(snapshot)
      return "cleared"
    })
  }

  private async clearLocalState(snapshot: LocalAuthSnapshot): Promise<void> {
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
    // TokenIndex 保留到最后，secret 删除失败时仍可用原 locator 重试。
    if (snapshot.index !== null) {
      await this.local.state.fileSystem.removeSecureFile(
        this.local.state.paths.tokenIndex
      )
    }
  }
}
