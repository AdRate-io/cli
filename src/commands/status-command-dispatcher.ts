import { EXIT_CODE } from "../constants.js"
import { createLocalError } from "../contracts/envelope.js"
import {
  CliFailure,
  dependencyFailure,
  localRequestId,
  outcomeUnknownFailure,
} from "../errors.js"
import { outcomeFromEnvelope, warningsForEnvelope } from "../output.js"
import { decideStatusPendingCommand } from "./command-response.js"
import { settlePendingCommand } from "./pending-command-settlement.js"
import {
  PendingCommandAttemptBusyError,
  PendingCommandAttemptUnsafeError,
  PendingCommandClockRollbackError,
} from "./pending-command-attempt.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../auth/local-credentials.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { CliOutcome } from "../errors.js"
import type { PublicHttpClient, PublicResponse } from "../http/client.js"
import type {
  PendingCommandLastResponse,
  PendingCommandRecord,
} from "./pending-command-contract.js"
import type { PendingCommandRepository } from "./pending-command-repository.js"
import type { PendingCommandAttemptHandle } from "./pending-command-attempt.js"
import type { PendingCommandSettlementResult } from "./pending-command-settlement.js"

export interface StatusCommandDispatchInput {
  record: PendingCommandRecord
  expectedCredential: LocatedCredential
  requestId?: string
  attempt?: PendingCommandAttemptHandle
  observedAt?: Date
  /** 凭证 fence 返回后、唯一 POST 紧前执行的同步检查。 */
  beforePost?: (attempt: PendingCommandAttemptHandle) => void
}

function isOwnerCredentialKind(value: unknown): boolean {
  return value === "owner_cli_session"
}

function assertCredentialMatchesRecord(
  record: PendingCommandRecord,
  expected: LocatedCredential
): void {
  if (
    expected.credentials === null ||
    !isOwnerCredentialKind(record.credentialKind) ||
    !isOwnerCredentialKind(expected.index.credentialKind) ||
    !isOwnerCredentialKind(expected.credentials.credentialKind) ||
    expected.index.credentialId !== record.credentialId ||
    expected.index.issuerOrigin !== record.issuerOrigin ||
    expected.credentials.credentialId !== record.credentialId ||
    expected.credentials.issuerOrigin !== record.issuerOrigin ||
    expected.credentials.teamId !== record.teamId
  ) {
    throw dependencyFailure(
      "The pending Command no longer matches the expected credential; no request was sent.",
      EXIT_CODE.retryable,
      { localStateChanged: true }
    )
  }
}

function monotonicTimestamp(record: PendingCommandRecord, now: Date): string {
  return new Date(
    Math.max(now.getTime(), new Date(record.updatedAt).getTime())
  ).toISOString()
}

function responseFact(response: PublicResponse): PendingCommandLastResponse {
  return {
    requestId: response.response.requestId,
    httpStatus: response.response.status,
    errorCode: response.envelope.ok ? null : response.envelope.error.code,
  }
}

function chargeUnknownRecoveryWarning(response: PublicResponse): string | null {
  return !response.envelope.ok &&
    response.envelope.meta.usage?.operationUnitsCharged === null
    ? "The write charge result is unknown; keep the original idempotency key and use commands resume. Do not issue a new Status request."
    : null
}

const TERMINAL_MISSING_WARNING =
  "Local recovery evidence was already finalized. Query the original idempotency key with commands get; do not issue a new Status request."

function attemptFailure(error: unknown): unknown {
  if (error instanceof PendingCommandAttemptBusyError) {
    return dependencyFailure(
      "Another Command recovery attempt is in progress; no request was sent.",
      EXIT_CODE.retryable,
      { reason: "command_attempt_in_progress" }
    )
  }
  if (error instanceof PendingCommandClockRollbackError) {
    const message =
      "The local clock moved backwards; no Status request was sent."
    return new CliFailure(
      message,
      EXIT_CODE.business,
      createLocalError(localRequestId(), "LOCAL_STATE_UNSAFE", message, false, {
        reason: "clock_rollback",
      })
    )
  }
  if (error instanceof PendingCommandAttemptUnsafeError) {
    const message =
      "Pending Command attempt evidence is unsafe; no request was sent."
    return new CliFailure(
      message,
      EXIT_CODE.business,
      createLocalError(localRequestId(), "LOCAL_STATE_UNSAFE", message, false, {
        invalidEntries: [
          {
            recordId: error.invalidEntry.recordId,
            reason: error.invalidEntry.reason,
          },
        ],
      })
    )
  }
  return error
}

interface DispatchAttemptState {
  attempt?: PendingCommandAttemptHandle
  cleanupAllowed: boolean
}

/**
 * 对一条已安全落盘的 pending record 执行精确一次 Status POST，
 * 并作为 POST 响应与本地 journal 收敛矩阵的唯一实现。
 */
export class StatusCommandDispatcher {
  private readonly now: () => Date
  private readonly environment: NodeJS.ProcessEnv

  constructor(
    private readonly http: PublicHttpClient,
    private readonly pending: PendingCommandRepository,
    private readonly local: LocalCredentialCoordinator,
    options: {
      now?: () => Date
      environment?: NodeJS.ProcessEnv
    } = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.environment = options.environment ?? process.env
  }

  async dispatch(
    input: StatusCommandDispatchInput
  ): Promise<CliOutcome<CliEnvelope>> {
    const state: DispatchAttemptState = {
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      cleanupAllowed: true,
    }
    let outcome: CliOutcome<CliEnvelope> | undefined
    let failure: unknown
    let failed = false
    try {
      outcome = await this.dispatchWithAttempt(input, state)
    } catch (error) {
      failure = error
      failed = true
    }
    if (state.attempt !== undefined && state.cleanupAllowed) {
      try {
        await this.pending.attempts.release(state.attempt)
      } catch (cleanupError) {
        // 清理失败不得覆盖已经成立的远程/本地主事实。
        // 无主错误时则 fail-loud，由后续显式 Resume 恢复。
        if (!failed) {
          failure = attemptFailure(cleanupError)
          failed = true
        }
      }
    }
    if (failed) throw failure
    return outcome!
  }

  private async dispatchWithAttempt(
    input: StatusCommandDispatchInput,
    state: DispatchAttemptState
  ): Promise<CliOutcome<CliEnvelope>> {
    const record = input.record
    let attempt: PendingCommandAttemptHandle
    assertCredentialMatchesRecord(record, input.expectedCredential)
    try {
      const observedAt = input.observedAt ?? this.now()
      attempt =
        state.attempt === undefined
          ? await this.pending.attempts.reserve({
              expected: record,
              phase: "post_dispatch_intent",
              observedAt,
              allowReclaim: false,
            })
          : await this.pending.attempts.advanceToPost(
              state.attempt,
              record,
              observedAt
            )
      state.attempt = attempt
    } catch (error) {
      throw attemptFailure(error)
    }

    let response: PublicResponse
    const token = await this.local.fenceExpectedLocatedCredential(
      input.expectedCredential
    )
    // fence 与远程调用之间不得加入 await：同步 hook 后立即创建 POST。
    input.beforePost?.(attempt)
    state.cleanupAllowed = false
    try {
      // 不在 Dispatcher 内 retry：一次调用最多发出一次 POST。
      const pendingResponse = this.http.postPublicJson({
        issuerOrigin: record.issuerOrigin,
        path: `/public/v1/ads/advertisers/${record.intent.advId}/campaigns/${record.intent.campaignId}/status`,
        token,
        idempotencyKey: record.idempotencyKey,
        json: {
          desiredStatus: record.intent.desiredStatus,
          ...(record.intent.authId === null
            ? {}
            : { authId: record.intent.authId }),
        },
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
      })
      response = await pendingResponse
    } catch {
      const settlement = await this.markResponseUnknownBestEffort(
        record,
        null,
        attempt.attempt.ownerToken
      )
      state.cleanupAllowed = settlement !== null
      throw outcomeUnknownFailure(
        settlement === "terminal_missing"
          ? "The Status write result is unknown and local recovery evidence was already finalized. Query the original idempotency key with commands get; do not issue a new Status request."
          : "The Status write result is unknown. Keep the original idempotency key and recover with commands resume.",
        { suggestedAction: "query_command" }
      )
    }

    const decision = decideStatusPendingCommand(
      response.envelope,
      response.response.status,
      {
        idempotencyKey: record.idempotencyKey,
        ...(record.commandId === null ? {} : { commandId: record.commandId }),
        intent: record.intent,
      }
    )
    let settlement: PendingCommandSettlementResult
    try {
      const options = { attemptOwnerToken: attempt.attempt.ownerToken }
      if (decision.action === "remove") {
        settlement = await settlePendingCommand(
          this.pending,
          record,
          decision.command === null
            ? { kind: "not_created" }
            : { kind: "final", commandId: decision.command.commandId },
          options
        )
      } else if (decision.action === "retain_command") {
        settlement = await settlePendingCommand(
          this.pending,
          record,
          {
            kind: "command_known",
            commandId: decision.command.commandId,
            updatedAt: monotonicTimestamp(record, this.now()),
            lastResponse: responseFact(response),
          },
          options
        )
      } else {
        settlement = await settlePendingCommand(
          this.pending,
          record,
          {
            kind: "response_unknown",
            updatedAt: monotonicTimestamp(record, this.now()),
            lastResponse: responseFact(response),
          },
          options
        )
      }
      state.cleanupAllowed = true
    } catch {
      const fallback = await this.markResponseUnknownBestEffort(
        record,
        responseFact(response),
        attempt.attempt.ownerToken
      )
      state.cleanupAllowed = fallback !== null
      throw outcomeUnknownFailure(
        fallback === "terminal_missing"
          ? "The Status response was received and local recovery evidence was already finalized. Query the original idempotency key with commands get; do not issue a new Status request."
          : "The Status response was received, but local recovery evidence could not be committed.",
        { suggestedAction: "query_command" }
      )
    }

    if (decision.contractViolation === "invalid_command_response") {
      const chargeWarning =
        settlement === "terminal_missing"
          ? TERMINAL_MISSING_WARNING
          : chargeUnknownRecoveryWarning(response)
      const failure =
        decision.exitCode === EXIT_CODE.retryable
          ? dependencyFailure(
              "The server returned contradictory Status recovery evidence. Keep the original idempotency key.",
              EXIT_CODE.retryable,
              { reason: "invalid_command_response" }
            )
          : outcomeUnknownFailure(
              "The server returned invalid Status Command evidence. Keep the original idempotency key.",
              { reason: "invalid_command_response" }
            )
      return {
        exitCode: failure.exitCode,
        envelope: failure.envelope,
        warnings: [
          ...failure.warnings,
          ...warningsForEnvelope(response.envelope, this.environment),
          ...(chargeWarning === null ? [] : [chargeWarning]),
        ],
      }
    }

    const outcome = outcomeFromEnvelope(response.envelope, this.environment)
    const chargeWarning =
      settlement === "terminal_missing"
        ? TERMINAL_MISSING_WARNING
        : chargeUnknownRecoveryWarning(response)
    return {
      ...outcome,
      exitCode: decision.exitCode,
      warnings:
        decision.contractViolation === "unexpected_status_for_command"
          ? [
              "The server returned a final Command with an unexpected HTTP status; local terminal evidence was still applied.",
              ...outcome.warnings,
            ]
          : [
              ...outcome.warnings,
              ...(chargeWarning === null ? [] : [chargeWarning]),
            ],
    }
  }

  private async markResponseUnknownBestEffort(
    expected: PendingCommandRecord,
    lastResponse: PendingCommandRecord["lastResponse"],
    attemptOwnerToken: string
  ): Promise<PendingCommandSettlementResult | null> {
    try {
      return await settlePendingCommand(
        this.pending,
        expected,
        {
          kind: "response_unknown",
          updatedAt: monotonicTimestamp(expected, this.now()),
          lastResponse,
        },
        { attemptOwnerToken }
      )
    } catch {
      // exact-record CAS 失败时绝不覆盖较新证据。
      return null
    }
  }
}
