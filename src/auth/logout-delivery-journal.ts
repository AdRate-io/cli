import { randomUUID } from "node:crypto"
import {
  environmentForMachineOrigin,
  issuerForEnvironment,
} from "../config/issuer.js"
import { EXIT_CODE } from "../constants.js"
import { createLocalError, createLocalSuccess } from "../contracts/envelope.js"
import {
  isCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "../contracts/json.js"
import {
  authenticationFailure,
  dependencyFailure,
  localRequestId,
  outcomeUnknownFailure,
} from "../errors.js"
import { outcomeFromEnvelope, warningsForEnvelope } from "../output.js"
import { withPendingMeta } from "./auth-command-support.js"
import {
  authIdentitiesEqual,
  identityForSnapshot,
} from "./local-credentials.js"
import type { AuthContext } from "./auth-context.js"
import type {
  LocalAuthIdentity,
  LocalAuthSnapshot,
} from "./local-credentials.js"
import type { CliOutcome } from "../errors.js"
import type { PublicEnvelope } from "../contracts/envelope.js"
import type {
  AuthCleanupReservation,
  LogoutCredentialNoticeFact,
  LogoutDeliveryJournal,
  LogoutDeliveryReason,
  LogoutDeliveryResponseFact,
  LogoutRemoteOutcome,
} from "../storage/schemas.js"

export interface LogoutPostRenderAcknowledgement {
  acknowledge: () => Promise<void>
}

export interface LogoutCliOutcome extends CliOutcome {
  postRenderAcknowledgement?: LogoutPostRenderAcknowledgement
}

export type LogoutCleanupPreparation =
  | { kind: "clean" }
  | { kind: "start"; expected: LocalAuthIdentity }
  | { kind: "resume"; reservation: AuthCleanupReservation }
  | { kind: "current_credential_preserved" }
  | { kind: "journal_changed" }

function journalsEqual(
  left: LogoutDeliveryJournal,
  right: LogoutDeliveryJournal
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function journalIdentity(journal: LogoutDeliveryJournal): LocalAuthIdentity {
  return {
    environment: journal.expectedEnvironment,
    issuerOrigin: journal.expectedIssuerOrigin,
    clientInstanceId: journal.expectedClientInstanceId,
    tokenGeneration: journal.expectedTokenGeneration,
    deviceGeneration: journal.expectedDeviceGeneration,
    issueOwnerToken: journal.expectedIssueOwnerToken,
    pollOwnerToken: journal.expectedPollOwnerToken,
  }
}

function identityOnlyRemovesJournal(
  journal: LogoutDeliveryJournal,
  current: LocalAuthIdentity
): boolean {
  const expected = journalIdentity(journal)
  return (
    (current.environment === null ||
      current.environment === expected.environment) &&
    (current.issuerOrigin === null ||
      current.issuerOrigin === expected.issuerOrigin) &&
    (current.clientInstanceId === null ||
      current.clientInstanceId === expected.clientInstanceId) &&
    (current.tokenGeneration === null ||
      current.tokenGeneration === expected.tokenGeneration) &&
    (current.deviceGeneration === null ||
      current.deviceGeneration === expected.deviceGeneration) &&
    (current.issueOwnerToken === null ||
      current.issueOwnerToken === expected.issueOwnerToken) &&
    (current.pollOwnerToken === null ||
      current.pollOwnerToken === expected.pollOwnerToken)
  )
}

function reservationMatchesJournal(
  journal: LogoutDeliveryJournal,
  reservation: AuthCleanupReservation
): boolean {
  return (
    reservation.expectedEnvironment === journal.expectedEnvironment &&
    reservation.expectedIssuerOrigin === journal.expectedIssuerOrigin &&
    reservation.expectedClientInstanceId === journal.expectedClientInstanceId &&
    reservation.expectedTokenGeneration === journal.expectedTokenGeneration &&
    reservation.expectedDeviceGeneration === journal.expectedDeviceGeneration &&
    reservation.expectedIssueOwnerToken === journal.expectedIssueOwnerToken &&
    reservation.expectedPollOwnerToken === journal.expectedPollOwnerToken &&
    (reservation.credentialLocator?.credentialId ?? null) ===
      journal.expectedCredentialId
  )
}

function hasManagedAuthenticationArtifacts(
  snapshot: LocalAuthSnapshot
): boolean {
  return Boolean(
    snapshot.index ||
    snapshot.metadata ||
    snapshot.device ||
    snapshot.issueReservation ||
    snapshot.pollAttempt ||
    snapshot.cleanupReservation ||
    snapshot.fallbackExists
  )
}

function pendingWarnings(
  pendingCommands: number,
  remoteUnknown: boolean
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

function mergeWarnings(
  ...groups: ReadonlyArray<ReadonlyArray<string>>
): Array<string> {
  return [...new Set(groups.flat())]
}

const CREDENTIAL_NOTICE_MESSAGES = Object.freeze({
  absolute_expiring:
    "This CLI credential is nearing its maximum lifetime. Reauthorize it before access expires.",
  idle_expiring:
    "This CLI credential is nearing its idle timeout. Use it soon to keep the session active.",
})

function captureCredentialNotice(
  envelope: PublicEnvelope,
  issuerOrigin: string
): LogoutCredentialNoticeFact | null {
  const notice = envelope.meta._notice?.credential
  const environment = environmentForMachineOrigin(issuerOrigin)
  if (
    environment === null ||
    !isPlainObject(notice) ||
    (notice.level !== "warning" && notice.level !== "critical") ||
    !Array.isArray(notice.reasons) ||
    !isCanonicalUtcIso(notice.absoluteExpiresAt) ||
    !(
      notice.idleExpiresAt === null || isCanonicalUtcIso(notice.idleExpiresAt)
    ) ||
    !isSafeIntegerInRange(notice.absoluteRemainingDays, 0) ||
    !(
      notice.idleRemainingDays === null ||
      isSafeIntegerInRange(notice.idleRemainingDays, 0)
    ) ||
    (notice.suggestedAction !== "reauthorize_credential" &&
      notice.suggestedAction !== "keep_session_active")
  ) {
    return null
  }

  const reasonKey = JSON.stringify(notice.reasons)
  if (
    ![
      '["absolute_expiring"]',
      '["idle_expiring"]',
      '["absolute_expiring","idle_expiring"]',
    ].includes(reasonKey) ||
    (notice.idleExpiresAt === null) !== (notice.idleRemainingDays === null) ||
    (notice.reasons.includes("idle_expiring") &&
      notice.idleExpiresAt === null) ||
    (notice.reasons.includes("absolute_expiring")
      ? notice.suggestedAction !== "reauthorize_credential"
      : notice.suggestedAction !== "keep_session_active" ||
        notice.level !== "warning")
  ) {
    return null
  }

  const expectedResolutionUrl = new URL(
    "/settings/security",
    issuerForEnvironment(environment).browserOrigin
  ).toString()
  if (
    notice.resolutionUrl !== null &&
    notice.resolutionUrl !== expectedResolutionUrl
  ) {
    return null
  }
  return {
    level: notice.level,
    reasons: [...notice.reasons] as LogoutCredentialNoticeFact["reasons"],
    absoluteExpiresAt: notice.absoluteExpiresAt,
    idleExpiresAt: notice.idleExpiresAt,
    absoluteRemainingDays: notice.absoluteRemainingDays,
    idleRemainingDays: notice.idleRemainingDays,
    suggestedAction: notice.suggestedAction,
    resolutionAvailable: notice.resolutionUrl === expectedResolutionUrl,
  }
}

/**
 * 从已经 PublicHttpClient 严格解码的 Envelope 中仅投影可持久化
 * allowlist，不复制 message/details/body 或任意 notice 文本。
 */
export function captureLogoutDeliveryResponseFact(
  envelope: PublicEnvelope,
  issuerOrigin: string
): LogoutDeliveryResponseFact {
  return {
    kind: envelope.ok ? "success" : "error",
    errorCode: envelope.ok ? null : envelope.error.code,
    retryAfterSeconds: envelope.ok
      ? null
      : (envelope.meta.retryAfterSeconds ?? null),
    credentialNotice: captureCredentialNotice(envelope, issuerOrigin),
  }
}

function credentialNoticeFromFact(
  journal: LogoutDeliveryJournal
): Record<string, unknown> | null {
  const notice = journal.responseFact?.credentialNotice
  if (!notice) return null
  const hasAbsolute = notice.reasons.includes("absolute_expiring")
  const environment = journal.expectedEnvironment
  return {
    level: notice.level,
    reasons: [...notice.reasons],
    absoluteExpiresAt: notice.absoluteExpiresAt,
    idleExpiresAt: notice.idleExpiresAt,
    absoluteRemainingDays: notice.absoluteRemainingDays,
    idleRemainingDays: notice.idleRemainingDays,
    suggestedAction: notice.suggestedAction,
    resolutionUrl:
      notice.resolutionAvailable && environment !== null
        ? new URL(
            "/settings/security",
            issuerForEnvironment(environment).browserOrigin
          ).toString()
        : null,
    message:
      CREDENTIAL_NOTICE_MESSAGES[
        hasAbsolute ? "absolute_expiring" : "idle_expiring"
      ],
  }
}

function attachResponseMeta(
  envelope: PublicEnvelope,
  journal: LogoutDeliveryJournal,
  sourceEnvelope?: PublicEnvelope
): PublicEnvelope {
  const retryAfterSeconds =
    sourceEnvelope?.meta.retryAfterSeconds ??
    journal.responseFact?.retryAfterSeconds ??
    null
  const credentialNotice =
    sourceEnvelope?.meta._notice?.credential ??
    credentialNoticeFromFact(journal)
  return {
    ...envelope,
    meta: {
      ...envelope.meta,
      requestId: journal.requestId,
      ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
      ...(credentialNotice === null
        ? {}
        : { _notice: { credential: credentialNotice } }),
    },
  } as PublicEnvelope
}

/**
 * `.logout-delivery.json` 是输出投递事务，不属于认证 artifact 清理事务。
 * 输出流确认写入后先按原值 CAS 为 `output_acknowledged`，再尝试物理删除。
 * 因此清理完成与结果交付之间的任意崩溃都不会重复 DELETE；已确认输出也不会重放。
 */
export class LogoutDeliveryJournalCoordinator {
  constructor(private readonly context: AuthContext) {}

  read(): Promise<LogoutDeliveryJournal | null> {
    return this.context.local.state.withAuthLock(() =>
      this.context.local.state.readLogoutDeliveryJournal()
    )
  }

  /**
   * `output_acknowledged` 是已对用户可见的耐久事实。物理删除只是垃圾回收：
   * 即使 unlink 或目录 fsync 失败，也不得重放输出或再发 DELETE。
   */
  async finalizeAcknowledgedOutput(): Promise<boolean> {
    return this.context.local.state.withAuthLock(async () => {
      const current = await this.context.local.state.readLogoutDeliveryJournal()
      if (current?.phase !== "output_acknowledged") return false
      try {
        await this.context.local.state.clearLogoutDeliveryJournal()
      } catch {
        // phase 已先于删除耐久化；后续命令可重入地继续本地回收。
      }
      return true
    })
  }

  async assertNoPending(command: "login" | "whoami"): Promise<void> {
    const journal = await this.read()
    if (!journal) return
    if (journal.phase === "output_acknowledged") {
      await this.finalizeAcknowledgedOutput()
      throw dependencyFailure(
        "A previous logout output acknowledgement was finalized locally. Retry the requested command.",
        EXIT_CODE.retryable,
        {
          logoutDeliveryFinalized: true,
          suggestedAction: "retry_command",
        }
      )
    }
    throw authenticationFailure(
      `A previous logout result is waiting for delivery acknowledgement. Run auth logout before auth ${command}.`,
      "INVALID_CREDENTIAL",
      {
        logoutDeliveryPending: true,
        remoteOutcome:
          journal.phase !== "dispatch_intent"
            ? journal.remoteOutcome
            : "unknown",
        suggestedAction: "query_command",
      }
    )
  }

  async beginDispatch(input: {
    expected: LocalAuthIdentity
    expectedCredentialId: string
    requestId: string
  }): Promise<LogoutDeliveryJournal> {
    return this.begin({
      expected: input.expected,
      expectedCredentialId: input.expectedCredentialId,
      requestId: input.requestId,
      phase: "dispatch_intent",
      remoteOutcome: null,
      reason: "transport_unknown",
      responseFact: null,
    })
  }

  async beginRecorded(input: {
    expected: LocalAuthIdentity
    expectedCredentialId: string | null
    requestId: string
    remoteOutcome: LogoutRemoteOutcome
    reason: LogoutDeliveryReason
    responseFact?: LogoutDeliveryResponseFact | null
    resolutionEnvironment?: LogoutDeliveryJournal["resolutionEnvironment"]
  }): Promise<LogoutDeliveryJournal> {
    return this.begin({
      ...input,
      phase: "outcome_recorded",
    })
  }

  async beginInterruptedCleanup(
    reservation: AuthCleanupReservation,
    requestId = localRequestId()
  ): Promise<LogoutDeliveryJournal> {
    const createdAt = this.context.now().toISOString()
    const journal: LogoutDeliveryJournal = {
      formatVersion: 1,
      ownerToken: randomUUID(),
      phase: "outcome_recorded",
      remoteOutcome: "unknown",
      reason: "interrupted_cleanup",
      responseFact: null,
      expectedEnvironment: reservation.expectedEnvironment,
      expectedIssuerOrigin: reservation.expectedIssuerOrigin,
      expectedCredentialId: reservation.credentialLocator?.credentialId ?? null,
      expectedClientInstanceId: reservation.expectedClientInstanceId,
      expectedTokenGeneration: reservation.expectedTokenGeneration,
      expectedDeviceGeneration: reservation.expectedDeviceGeneration,
      expectedIssueOwnerToken: reservation.expectedIssueOwnerToken,
      expectedPollOwnerToken: reservation.expectedPollOwnerToken,
      resolutionEnvironment: reservation.expectedEnvironment,
      requestId,
      createdAt,
      recordedAt: createdAt,
    }
    return this.context.local.state.withAuthLock(async () => {
      const current = await this.context.local.state.readLogoutDeliveryJournal()
      if (current) return current
      const snapshot = await this.context.local.readLocalSnapshotLocked()
      if (
        !snapshot.cleanupReservation ||
        JSON.stringify(snapshot.cleanupReservation) !==
          JSON.stringify(reservation)
      ) {
        throw dependencyFailure(
          "Authentication cleanup ownership changed before logout recovery could be journaled."
        )
      }
      await this.context.local.state.writeLogoutDeliveryJournal(journal)
      return journal
    })
  }

  async recordOutcome(
    dispatch: LogoutDeliveryJournal,
    remoteOutcome: LogoutRemoteOutcome,
    reason: LogoutDeliveryReason,
    responseFact: LogoutDeliveryResponseFact | null = null,
    responseRequestId?: string
  ): Promise<LogoutDeliveryJournal | null> {
    const recorded: LogoutDeliveryJournal = {
      ...dispatch,
      phase: "outcome_recorded",
      remoteOutcome,
      reason,
      responseFact,
      ...(responseRequestId === undefined
        ? {}
        : { requestId: responseRequestId }),
      recordedAt: this.context.now().toISOString(),
    }
    return this.context.local.state.withAuthLock(async () => {
      const current = await this.context.local.state.readLogoutDeliveryJournal()
      if (!current || !journalsEqual(current, dispatch)) return null
      await this.context.local.state.writeLogoutDeliveryJournal(recorded)
      return recorded
    })
  }

  async prepareCleanup(
    journal: LogoutDeliveryJournal
  ): Promise<LogoutCleanupPreparation> {
    return this.context.local.state.withAuthLock(async () => {
      const currentJournal =
        await this.context.local.state.readLogoutDeliveryJournal()
      if (!currentJournal || !journalsEqual(currentJournal, journal)) {
        return { kind: "journal_changed" as const }
      }
      const snapshot = await this.context.local.readLocalSnapshotLocked()
      const currentIdentity = identityForSnapshot(snapshot)
      if (
        !identityOnlyRemovesJournal(journal, currentIdentity) ||
        (snapshot.index !== null &&
          snapshot.index.credentialId !== journal.expectedCredentialId)
      ) {
        return { kind: "current_credential_preserved" as const }
      }
      if (snapshot.cleanupReservation) {
        return reservationMatchesJournal(journal, snapshot.cleanupReservation)
          ? {
              kind: "resume" as const,
              reservation: snapshot.cleanupReservation,
            }
          : { kind: "current_credential_preserved" as const }
      }
      if (!hasManagedAuthenticationArtifacts(snapshot)) {
        return { kind: "clean" as const }
      }
      const expected = journalIdentity(journal)
      return authIdentitiesEqual(currentIdentity, expected)
        ? { kind: "start" as const, expected }
        : { kind: "current_credential_preserved" as const }
    })
  }

  outcome(
    journal: LogoutDeliveryJournal,
    pendingCommands: number,
    input: {
      localCleanupFailed?: boolean
      currentCredentialPreserved?: boolean
      sourceEnvelope?: PublicEnvelope
    } = {}
  ): LogoutCliOutcome {
    if (
      journal.phase !== "outcome_recorded" ||
      journal.remoteOutcome === null
    ) {
      throw dependencyFailure(
        "The logout delivery journal has not reached a replayable outcome."
      )
    }
    const details = {
      logoutDeliveryProtected: true,
      remoteOutcome: journal.remoteOutcome,
      logoutReason: journal.reason,
      localCleanupFailed: input.localCleanupFailed ?? false,
      currentCredentialPreserved: input.currentCredentialPreserved ?? false,
      pendingCommandsRetained: pendingCommands,
    }
    const pending = pendingWarnings(pendingCommands, false)
    if (journal.remoteOutcome === "confirmed_not_executed") {
      const errorCode = journal.responseFact?.errorCode
      if (errorCode !== "INVALID_REQUEST" && errorCode !== "RATE_LIMITED") {
        throw dependencyFailure(
          "The logout delivery journal is missing a proven-not-executed response."
        )
      }
      const replayEnvelope = attachResponseMeta(
        createLocalError(
          journal.requestId,
          errorCode,
          errorCode === "RATE_LIMITED"
            ? "The request rate limit was reached."
            : "The request is invalid.",
          errorCode === "RATE_LIMITED",
          {
            ...details,
            credentialPreserved: true,
            suggestedAction:
              errorCode === "RATE_LIMITED" ? "retry_after" : null,
            resolutionUrl: null,
          }
        ),
        journal,
        input.sourceEnvelope
      )
      const outcome = outcomeFromEnvelope(
        replayEnvelope,
        this.context.environment
      )
      return {
        ...outcome,
        envelope: withPendingMeta(replayEnvelope, pendingCommands),
        warnings: mergeWarnings(outcome.warnings, pending),
        postRenderAcknowledgement: this.acknowledgement(journal),
      }
    }
    if (journal.remoteOutcome === "confirmed_inactive") {
      if (input.localCleanupFailed) {
        const failure = dependencyFailure(
          "The remote session is inactive, but local credential cleanup failed.",
          EXIT_CODE.business,
          details
        )
        return {
          exitCode: EXIT_CODE.business,
          envelope: withPendingMeta(
            attachResponseMeta(failure.envelope, journal, input.sourceEnvelope),
            pendingCommands
          ),
          warnings: mergeWarnings(
            warningsForEnvelope(
              attachResponseMeta(
                failure.envelope,
                journal,
                input.sourceEnvelope
              ),
              this.context.environment
            ),
            pending
          ),
        }
      }
      const envelope = attachResponseMeta(
        createLocalSuccess(journal.requestId, {
          revoked: journal.reason === "revoked",
          alreadyInactive: journal.reason === "already_inactive",
          ...details,
        }),
        journal,
        input.sourceEnvelope
      )
      return {
        exitCode: EXIT_CODE.success,
        envelope: withPendingMeta(envelope, pendingCommands),
        warnings: mergeWarnings(
          warningsForEnvelope(envelope, this.context.environment),
          pending
        ),
        postRenderAcknowledgement: this.acknowledgement(journal),
      }
    }

    const environment = journal.resolutionEnvironment
    const remediation =
      environment === null
        ? {
            resolutionEnvironment: "unknown",
            suggestedAction: "confirm_environment",
            environmentConfirmationRequired: true,
          }
        : {
            resolutionEnvironment: environment,
            suggestedAction: "open_account_security",
            resolutionUrl: new URL(
              "/settings/security",
              issuerForEnvironment(environment).browserOrigin
            ).toString(),
          }
    const failure = outcomeUnknownFailure(
      input.localCleanupFailed
        ? "Remote revocation is unknown and local credential cleanup also failed. Verify the device on the official Web page."
        : "Remote revocation is unknown. Verify the device on the official Web page.",
      { ...remediation, ...details }
    )
    const envelope = attachResponseMeta(
      failure.envelope,
      journal,
      input.sourceEnvelope
    )
    return {
      exitCode: EXIT_CODE.outcomeUnknown,
      envelope: withPendingMeta(envelope, pendingCommands),
      warnings: mergeWarnings(
        warningsForEnvelope(envelope, this.context.environment),
        pendingWarnings(pendingCommands, true)
      ),
      ...(!input.localCleanupFailed
        ? { postRenderAcknowledgement: this.acknowledgement(journal) }
        : {}),
    }
  }

  private async begin(input: {
    expected: LocalAuthIdentity
    expectedCredentialId: string | null
    requestId: string
    phase: "dispatch_intent" | "outcome_recorded"
    remoteOutcome: LogoutRemoteOutcome | null
    reason: LogoutDeliveryReason
    responseFact?: LogoutDeliveryResponseFact | null
    resolutionEnvironment?: LogoutDeliveryJournal["resolutionEnvironment"]
  }): Promise<LogoutDeliveryJournal> {
    const createdAt = this.context.now().toISOString()
    const journal: LogoutDeliveryJournal = {
      formatVersion: 1,
      ownerToken: randomUUID(),
      phase: input.phase,
      remoteOutcome: input.remoteOutcome,
      reason: input.reason,
      responseFact: input.responseFact ?? null,
      expectedEnvironment: input.expected.environment,
      expectedIssuerOrigin: input.expected.issuerOrigin,
      expectedCredentialId: input.expectedCredentialId,
      expectedClientInstanceId: input.expected.clientInstanceId,
      expectedTokenGeneration: input.expected.tokenGeneration,
      expectedDeviceGeneration: input.expected.deviceGeneration,
      expectedIssueOwnerToken: input.expected.issueOwnerToken,
      expectedPollOwnerToken: input.expected.pollOwnerToken,
      resolutionEnvironment:
        input.resolutionEnvironment ?? input.expected.environment,
      requestId: input.requestId,
      createdAt,
      recordedAt: input.phase === "outcome_recorded" ? createdAt : null,
    }
    return this.context.local.state.withAuthLock(async () => {
      const current = await this.context.local.state.readLogoutDeliveryJournal()
      if (current) {
        throw dependencyFailure(
          "A previous logout result is waiting for delivery acknowledgement."
        )
      }
      const snapshot = await this.context.local.readLocalSnapshotLocked()
      if (
        !authIdentitiesEqual(identityForSnapshot(snapshot), input.expected) ||
        (snapshot.index?.credentialId ?? null) !== input.expectedCredentialId
      ) {
        throw dependencyFailure(
          "Local authentication state changed before logout could be journaled; no remote request was sent.",
          EXIT_CODE.retryable,
          { localStateChanged: true }
        )
      }
      await this.context.local.state.writeLogoutDeliveryJournal(journal)
      return journal
    })
  }

  private acknowledgement(
    journal: LogoutDeliveryJournal
  ): LogoutPostRenderAcknowledgement {
    return {
      acknowledge: () =>
        this.context.local.state.withAuthLock(async () => {
          const current =
            await this.context.local.state.readLogoutDeliveryJournal()
          if (
            current === null ||
            current.phase !== "outcome_recorded" ||
            !journalsEqual(current, journal)
          ) {
            throw dependencyFailure(
              "Logout output acknowledgement no longer owns the exact delivery journal.",
              EXIT_CODE.business
            )
          }
          const acknowledged: LogoutDeliveryJournal = {
            ...current,
            phase: "output_acknowledged",
          }
          await this.context.local.state.writeLogoutDeliveryJournal(
            acknowledged
          )
          try {
            await this.context.local.state.clearLogoutDeliveryJournal()
          } catch {
            // 输出已经确认，删除只是可重入的本地回收。
          }
        }),
    }
  }
}
