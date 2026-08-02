import { DEADLINES_MS, EXIT_CODE } from "../constants.js"
import {
  CliFailure,
  dependencyFailure,
  localRequestId,
  outcomeUnknownFailure,
} from "../errors.js"
import { decodeCurrentSessionDeleteSuccess } from "../contracts/logout.js"
import { AuthCleanupCoordinator } from "./auth-cleanup-coordinator.js"
import {
  readAuthRemediationEvidence,
  remediationDetails,
} from "./auth-remediation.js"
import { withPendingMeta } from "./auth-command-support.js"
import {
  LogoutDeliveryJournalCoordinator,
  captureLogoutDeliveryResponseFact,
} from "./logout-delivery-journal.js"
import type { AuthContext } from "./auth-context.js"
import type { AuthRemediationEvidence } from "./auth-remediation.js"
import type { DevicePollCoordinator } from "./device-poll-coordinator.js"
import type {
  LogoutCleanupPreparation,
  LogoutCliOutcome,
} from "./logout-delivery-journal.js"
import type { PublicEnvelope } from "../contracts/envelope.js"
import type { CliOutcome } from "../errors.js"
import type { GlobalOptions } from "../parser.js"
import type { JsonObject } from "../contracts/json.js"
import type { LogoutDeliveryJournal } from "../storage/schemas.js"

/**
 * 只负责远端撤销、投递日志、条件清理和人工恢复证据。远端 DELETE 的
 * dispatch intent 必须先落盘；清理后的 outcome journal 必须等真实输出
 * 写回确认后才能删除。
 */
export class LogoutRecoveryService {
  private readonly cleanup: AuthCleanupCoordinator
  private readonly delivery: LogoutDeliveryJournalCoordinator

  constructor(
    private readonly context: AuthContext,
    private readonly devicePoll: DevicePollCoordinator
  ) {
    this.cleanup = new AuthCleanupCoordinator(context.local, context.now)
    this.delivery = new LogoutDeliveryJournalCoordinator(context)
  }

  async logout(global: GlobalOptions): Promise<LogoutCliOutcome> {
    const pendingJournal = await this.delivery.read()
    if (pendingJournal) {
      if (pendingJournal.phase === "output_acknowledged") {
        await this.delivery.finalizeAcknowledgedOutput()
        throw dependencyFailure(
          "A previous logout output acknowledgement was finalized locally. Retry the requested command.",
          EXIT_CODE.retryable,
          {
            logoutDeliveryFinalized: true,
            suggestedAction: "retry_command",
          }
        )
      }
      return this.recoverJournal(pendingJournal)
    }

    let normalization
    try {
      normalization = await this.devicePoll.normalizeForLogout()
    } catch {
      return this.unsafeLocalStateOutcome(
        "The local Device poll state could not be safely normalized for logout."
      )
    }
    if (normalization.kind === "cleanup_pending") {
      const journal = await this.delivery.beginInterruptedCleanup(
        normalization.reservation,
        global.requestId ?? localRequestId()
      )
      return this.finishJournal(journal)
    }
    if (normalization.kind === "in_flight") {
      throw dependencyFailure(
        "A Device Token exchange is still in flight. Retry logout after the local poll lease ends.",
        EXIT_CODE.retryable,
        { retryAfterSeconds: normalization.retryAfterSeconds }
      )
    }

    let evidence = await readAuthRemediationEvidence(this.context.local)
    const pendingCommands = await this.context.local.countPendingCommands()
    if (
      normalization.kind !== "credential_pending" &&
      (normalization.kind === "delivery_unknown" ||
        evidence.device.value?.localState === "delivery_unknown")
    ) {
      return this.deliveryUnknownOutcome(
        pendingCommands,
        evidence,
        normalization.kind === "delivery_unknown"
          ? { safeRestartAt: normalization.safeRestartAt }
          : {}
      )
    }

    let expected
    try {
      expected = await this.context.local.captureIdentity()
    } catch {
      return this.unsafeLocalStateOutcome(
        "The local authentication identity is damaged or conflicting; no state was removed.",
        pendingCommands,
        evidence
      )
    }

    let inspection
    try {
      inspection = await this.context.local.inspectAndRecover()
    } catch (error) {
      evidence = await readAuthRemediationEvidence(this.context.local)
      if (
        error instanceof CliFailure &&
        (error.exitCode === EXIT_CODE.outcomeUnknown ||
          evidence.device.value?.localState === "delivery_unknown")
      ) {
        return this.deliveryUnknownOutcome(pendingCommands, evidence)
      }
      if (
        error instanceof CliFailure &&
        error.exitCode === EXIT_CODE.retryable
      ) {
        throw error
      }
      return this.unsafeLocalStateOutcome(
        "The local credential state could not be safely inspected; no state was removed.",
        pendingCommands,
        evidence
      )
    }
    expected =
      inspection.state === "located"
        ? inspection.identity
        : await this.context.local.captureIdentity()

    const requestId = global.requestId ?? localRequestId()
    if (inspection.state === "none" || inspection.state === "device_only") {
      const journal = await this.delivery.beginRecorded({
        expected,
        expectedCredentialId: null,
        requestId,
        remoteOutcome: "confirmed_inactive",
        reason: "already_inactive",
      })
      return this.finishJournal(journal, pendingCommands)
    }

    if (inspection.state === "local_incomplete") {
      const snapshot = await this.context.local.state.withAuthLock(() =>
        this.context.local.readLocalSnapshotLocked()
      )
      const journal = await this.delivery.beginRecorded({
        expected,
        expectedCredentialId: snapshot.index?.credentialId ?? null,
        requestId,
        remoteOutcome: "unknown",
        reason: "unlocatable",
        resolutionEnvironment:
          snapshot.index?.environment ?? expected.environment,
      })
      return this.finishJournal(journal, pendingCommands)
    }

    const dispatch = await this.delivery.beginDispatch({
      expected,
      expectedCredentialId: inspection.index.credentialId,
      requestId,
    })

    let envelope: PublicEnvelope
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
      const recorded = await this.delivery.recordOutcome(
        dispatch,
        "unknown",
        "transport_unknown",
        null
      )
      return recorded
        ? this.finishJournal(recorded, pendingCommands)
        : this.recoverCurrentJournal()
    }

    const alreadyInactive =
      !envelope.ok &&
      ["INVALID_CREDENTIAL", "CREDENTIAL_EXPIRED", "USER_DISABLED"].includes(
        envelope.error.code
      )
    const ownerUnknown =
      !envelope.ok && envelope.error.code === "OWNER_REQUIRED"
    const responseFact = captureLogoutDeliveryResponseFact(
      envelope,
      inspection.index.issuerOrigin
    )
    const revoked = envelope.ok
      ? decodeCurrentSessionDeleteSuccess(
          responseStatus,
          envelope,
          inspection.index.credentialId
        )
      : null
    if (revoked || alreadyInactive || ownerUnknown) {
      const recorded = await this.delivery.recordOutcome(
        dispatch,
        revoked || alreadyInactive ? "confirmed_inactive" : "unknown",
        revoked
          ? "revoked"
          : alreadyInactive
            ? "already_inactive"
            : "owner_required",
        responseFact,
        envelope.meta.requestId
      )
      return recorded
        ? this.finishJournal(recorded, pendingCommands, envelope)
        : this.recoverCurrentJournal()
    }

    // 只有真实 Runtime 中明确发生在 Route handler 前的拒绝才能
    // 证明 DELETE 未执行。即便如此也要保留可重放 journal，直到
    // runner 确认真实 output write callback，不得在 service 层提前清除。
    const provenNotExecuted =
      !envelope.ok &&
      (envelope.error.code === "INVALID_REQUEST" ||
        envelope.error.code === "RATE_LIMITED")
    const recorded = await this.delivery.recordOutcome(
      dispatch,
      provenNotExecuted ? "confirmed_not_executed" : "unknown",
      provenNotExecuted ? "request_rejected" : "ambiguous_response",
      responseFact,
      envelope.meta.requestId
    )
    return recorded
      ? this.finishJournal(recorded, pendingCommands, envelope)
      : this.recoverCurrentJournal()
  }

  private async recoverCurrentJournal(): Promise<LogoutCliOutcome> {
    const current = await this.delivery.read()
    if (!current) {
      throw dependencyFailure(
        "Logout delivery ownership changed before the result could be confirmed.",
        EXIT_CODE.outcomeUnknown
      )
    }
    return this.recoverJournal(current)
  }

  private async recoverJournal(
    journal: LogoutDeliveryJournal
  ): Promise<LogoutCliOutcome> {
    if (journal.phase === "output_acknowledged") {
      await this.delivery.finalizeAcknowledgedOutput()
      throw dependencyFailure(
        "A previous logout output acknowledgement was finalized locally. Retry logout.",
        EXIT_CODE.retryable,
        {
          logoutDeliveryFinalized: true,
          suggestedAction: "retry_command",
        }
      )
    }
    if (journal.phase === "outcome_recorded") {
      return this.finishJournal(journal)
    }
    // dispatch_intent 证明 DELETE 可能已经出站。恢复只能单调收敛 unknown，
    // 绝不能重发 DELETE，也绝不能声称远端已 inactive。
    const recorded = await this.delivery.recordOutcome(
      journal,
      "unknown",
      "transport_unknown"
    )
    return recorded
      ? this.finishJournal(recorded)
      : this.recoverCurrentJournal()
  }

  private async finishJournal(
    journal: LogoutDeliveryJournal,
    knownPendingCommands?: number,
    sourceEnvelope?: PublicEnvelope
  ): Promise<LogoutCliOutcome> {
    const pendingCommands =
      knownPendingCommands ?? (await this.context.local.countPendingCommands())
    if (journal.remoteOutcome === "confirmed_not_executed") {
      // 可证明远端未执行时必须保留当前凭证。journal 仅负责
      // 投递同一拒绝事实，完成 output ack 后才允许清除自身。
      return this.delivery.outcome(journal, pendingCommands, {
        sourceEnvelope,
      })
    }
    const preparation = await this.delivery.prepareCleanup(journal)
    if (preparation.kind === "journal_changed") {
      return this.recoverCurrentJournal()
    }
    if (preparation.kind === "current_credential_preserved") {
      return this.delivery.outcome(journal, pendingCommands, {
        currentCredentialPreserved: true,
        sourceEnvelope,
      })
    }
    if (preparation.kind === "clean") {
      return this.delivery.outcome(journal, pendingCommands, {
        sourceEnvelope,
      })
    }

    try {
      const cleared = await this.runCleanup(preparation)
      if (cleared === "stale") {
        return this.delivery.outcome(journal, pendingCommands, {
          currentCredentialPreserved: true,
          sourceEnvelope,
        })
      }
    } catch {
      // journal 保留且不附带 output ack。unknown + cleanup failure 仍是 exit 5；
      // 只有已确认 inactive + cleanup failure 才是普通业务失败 exit 1。
      return this.delivery.outcome(journal, pendingCommands, {
        localCleanupFailed: true,
        sourceEnvelope,
      })
    }
    return this.delivery.outcome(journal, pendingCommands, {
      sourceEnvelope,
    })
  }

  private runCleanup(
    preparation: Extract<
      LogoutCleanupPreparation,
      { kind: "start" } | { kind: "resume" }
    >
  ): Promise<"cleared" | "stale"> {
    return preparation.kind === "resume"
      ? this.cleanup.resumeExisting(preparation.reservation)
      : this.cleanup.clearIfUnchanged(preparation.expected)
  }

  private deliveryUnknownOutcome(
    pendingCommands: number,
    evidence: AuthRemediationEvidence,
    extra: JsonObject = {}
  ): CliOutcome {
    const failure = outcomeUnknownFailure(
      "The one-time Device Token delivery is unknown. Logout cannot prove revocation or remove the delivery fence; confirm the environment and verify the device on the official Web page.",
      {
        deliveryState: "delivery_unknown",
        ...remediationDetails(evidence),
        ...extra,
        pendingCommandsRetained: pendingCommands,
      }
    )
    return {
      exitCode: EXIT_CODE.outcomeUnknown,
      envelope: withPendingMeta(failure.envelope, pendingCommands),
      warnings: this.pendingWarnings(pendingCommands, true),
    }
  }

  private remoteUnknownOutcome(
    message: string,
    pendingCommands: number,
    evidence: AuthRemediationEvidence,
    extra: JsonObject = {}
  ): CliOutcome {
    const failure = outcomeUnknownFailure(message, {
      ...remediationDetails(evidence),
      ...extra,
      pendingCommandsRetained: pendingCommands,
    })
    return {
      exitCode: EXIT_CODE.outcomeUnknown,
      envelope: withPendingMeta(failure.envelope, pendingCommands),
      warnings: this.pendingWarnings(pendingCommands, true),
    }
  }

  private async unsafeLocalStateOutcome(
    message: string,
    pendingCommands = 0,
    evidence?: AuthRemediationEvidence
  ): Promise<CliOutcome> {
    const currentEvidence =
      evidence ?? (await readAuthRemediationEvidence(this.context.local))
    return this.remoteUnknownOutcome(
      message,
      pendingCommands,
      currentEvidence,
      { localStatePreserved: true }
    )
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
