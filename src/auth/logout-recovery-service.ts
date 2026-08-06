import {
  DEADLINES_MS,
  EXIT_CODE,
  INACTIVE_CREDENTIAL_CODES,
} from "../constants.js"
import { createLocalSuccess } from "../contracts/envelope.js"
import { decodeCurrentSessionDeleteSuccess } from "../contracts/logout.js"
import { issuerForEnvironment } from "../config/issuer.js"
import {
  CliFailure,
  dependencyFailure,
  localRequestId,
  outcomeUnknownFailure,
} from "../errors.js"
import { AuthCleanupCoordinator } from "./auth-cleanup-coordinator.js"
import { withPendingMeta } from "./auth-command-support.js"
import type { AuthContext } from "./auth-context.js"
import type { DevicePollCoordinator } from "./device-poll-coordinator.js"
import type { CredentialInspection } from "./local-credentials.js"
import type { CliOutcome } from "../errors.js"
import type { GlobalOptions } from "../parser.js"

/**
 * 简化版 logout：远端 DELETE 一次判定，精确 inactive 才清理本地凭据，
 * 不确定结果保留凭据并 exit 5。
 */
export class LogoutRecoveryService {
  private readonly cleanup: AuthCleanupCoordinator

  constructor(
    private readonly context: AuthContext,
    private readonly devicePoll: DevicePollCoordinator
  ) {
    this.cleanup = new AuthCleanupCoordinator(context.local)
  }

  async logout(global: GlobalOptions): Promise<CliOutcome> {
    const pendingCommands = await this.context.local.countPendingCommands()

    try {
      await this.devicePoll.normalizeForLogout()
    } catch {
      return this.unknownOutcome(
        "The local Device poll state could not be safely normalized for logout.",
        pendingCommands
      )
    }

    let inspection
    try {
      inspection = await this.context.local.inspectAndRecover()
    } catch (error) {
      if (error instanceof CliFailure && error.exitCode === EXIT_CODE.retryable) {
        throw error
      }
      return this.unknownOutcome(
        "The local credential state could not be safely inspected; no state was removed.",
        pendingCommands,
        { localStatePreserved: true }
      )
    }

    return this.resolveInspectedLogout(global, inspection, pendingCommands)
  }

  /**
   * login 归一化复用 logout 的唯一证据判定。传入已冻结的检查结果，
   * 远端请求始终使用该结果里的 Token，本地清理仍由 identity fence 保护。
   */
  async logoutInspected(
    global: GlobalOptions,
    inspection: CredentialInspection
  ): Promise<CliOutcome> {
    const pendingCommands = await this.context.local.countPendingCommands()
    return this.resolveInspectedLogout(global, inspection, pendingCommands)
  }

  private async resolveInspectedLogout(
    global: GlobalOptions,
    inspection: CredentialInspection,
    pendingCommands: number
  ): Promise<CliOutcome> {
    if (inspection.state === "none" || inspection.state === "device_only") {
      return this.noLocalCredentialOutcome(pendingCommands)
    }

    if (inspection.state === "local_incomplete") {
      if (inspection.reason === "token_missing") {
        try {
          const cleared = await this.cleanup.clearMissingCredentialState()
          if (cleared === "cleared") {
            return this.unknownOutcome(
              "The local credential secret was already missing. Remaining local authentication records were cleared, but remote revocation is unknown.",
              pendingCommands,
              { reason: inspection.reason, localStateCleared: true }
            )
          }
        } catch {
          // 无法再次确认 secret 缺失时保留所有本地状态。
        }
      }
      return this.unknownOutcome(
        "Local authentication state is incomplete; no credential was removed.",
        pendingCommands,
        { reason: inspection.reason, localStatePreserved: true }
      )
    }

    const requestId = global.requestId ?? localRequestId()
    const expected = inspection.identity

    let envelope
    let responseStatus: number
    try {
      const response = await this.context.http.requestPublic({
        method: "DELETE",
        issuerOrigin: inspection.index.issuerOrigin,
        path: "/public/v1/sessions/current",
        token: inspection.token,
        requestId,
        deadlineMs: DEADLINES_MS.standard,
      })
      envelope = response.envelope
      responseStatus = response.response.status
    } catch {
      return this.unknownOutcome(
        "Remote revocation is unknown. Verify the device on the official Web security page.",
        pendingCommands,
        {
          resolutionUrl: new URL(
            "/settings/security",
            issuerForEnvironment(inspection.index.environment).browserOrigin
          ).toString(),
          suggestedAction: "open_account_security",
        }
      )
    }

    const revoked = envelope.ok
      ? decodeCurrentSessionDeleteSuccess(
          responseStatus,
          envelope,
          inspection.index.credentialId
        )
      : null
    const alreadyInactive =
      !envelope.ok && INACTIVE_CREDENTIAL_CODES.has(envelope.error.code)

    if (revoked || alreadyInactive) {
      try {
        const cleared = await this.cleanup.clearIfUnchanged(expected)
        if (cleared === "stale") {
          return this.unknownOutcome(
            "Authentication state changed during conditional cleanup.",
            pendingCommands,
            { currentCredentialPreserved: true }
          )
        }
      } catch {
        return this.unknownOutcome(
          "The remote session is inactive, but local credential cleanup failed.",
          pendingCommands,
          { localCleanupFailed: true }
        )
      }
      return this.inactiveOutcome(
        revoked ? "revoked" : "already_inactive",
        pendingCommands,
        revoked !== null,
        envelope
      )
    }

    const ownerRequired = !envelope.ok && envelope.error.code === "OWNER_REQUIRED"
    const httpAuthFailure =
      !envelope.ok &&
      (responseStatus === 401 ||
        responseStatus === 403 ||
        ownerRequired ||
        !INACTIVE_CREDENTIAL_CODES.has(envelope.error.code))

    if (httpAuthFailure) {
      return this.unknownOutcome(
        ownerRequired
          ? "Remote revocation requires Owner confirmation. Verify the device on the official Web security page."
          : "Remote revocation is unknown. Verify the device on the official Web security page.",
        pendingCommands,
        {
          resolutionUrl: new URL(
            "/settings/security",
            issuerForEnvironment(inspection.index.environment).browserOrigin
          ).toString(),
          suggestedAction: "open_account_security",
          errorCode: envelope.ok ? null : envelope.error.code,
        },
        envelope
      )
    }

    return this.unknownOutcome(
      "Remote revocation is unknown. Verify the device on the official Web security page.",
      pendingCommands,
      {
        resolutionUrl: new URL(
          "/settings/security",
          issuerForEnvironment(inspection.index.environment).browserOrigin
        ).toString(),
        suggestedAction: "open_account_security",
      },
      envelope
    )
  }

  private inactiveOutcome(
    reason: "revoked" | "already_inactive",
    pendingCommands: number,
    revoked: boolean,
    sourceEnvelope?: CliOutcome["envelope"]
  ): CliOutcome {
    const requestId = sourceEnvelope?.meta.requestId ?? localRequestId()
    const envelope = createLocalSuccess(requestId, {
      revoked,
      alreadyInactive: reason === "already_inactive",
      logoutReason: reason,
    })
    return {
      exitCode: EXIT_CODE.success,
      envelope: withPendingMeta(envelope, pendingCommands),
      warnings: this.pendingWarnings(pendingCommands),
    }
  }

  private noLocalCredentialOutcome(pendingCommands: number): CliOutcome {
    const envelope = createLocalSuccess(localRequestId(), {
      revoked: false,
      alreadyInactive: true,
      localCredentialFound: false,
    })
    return {
      exitCode: EXIT_CODE.success,
      envelope: withPendingMeta(envelope, pendingCommands),
      warnings: this.pendingWarnings(pendingCommands),
      humanLines: ["No local AdRate credential was found."],
    }
  }

  private unknownOutcome(
    message: string,
    pendingCommands: number,
    details: Record<string, unknown> = {},
    sourceEnvelope?: CliOutcome["envelope"]
  ): CliOutcome {
    const failure = outcomeUnknownFailure(message, {
      ...details,
      pendingCommandsRetained: pendingCommands,
    })
    const envelope = sourceEnvelope
      ? {
          ...failure.envelope,
          meta: {
            ...failure.envelope.meta,
            requestId: sourceEnvelope.meta.requestId,
          },
        }
      : failure.envelope
    return {
      exitCode: EXIT_CODE.outcomeUnknown,
      envelope: withPendingMeta(envelope, pendingCommands),
      warnings: this.pendingWarnings(pendingCommands, true),
    }
  }

  private pendingWarnings(
    pendingCommands: number,
    remoteUnknown = false
  ): Array<string> {
    return [
      ...(pendingCommands > 0
        ? [
            `${pendingCommands} pending Command record(s) were preserved. A new credential cannot resume Commands created by the previous credential.`,
          ]
        : []),
      ...(remoteUnknown
        ? [
            "Remote revocation is not confirmed. Verify or revoke the device on the official Web security page.",
          ]
        : []),
    ]
  }
}
