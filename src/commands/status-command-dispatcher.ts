import { EXIT_CODE } from "../constants.js"
import {
  dependencyFailure,
  outcomeUnknownFailure,
} from "../errors.js"
import { outcomeFromEnvelope, warningsForEnvelope } from "../output.js"
import { getCliCommandFamily } from "./command-families.js"
import { decideStatusPendingCommand } from "./command-response.js"
import { settlePendingCommand } from "./pending-command-settlement.js"
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
import type { PendingCommandSettlementResult } from "./pending-command-settlement.js"

export interface StatusCommandDispatchInput {
  record: PendingCommandRecord
  expectedCredential: LocatedCredential
  requestId?: string
  /** 凭证 fence 返回后、唯一 POST 紧前执行的同步检查。 */
  beforePost?: () => void
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

const TERMINAL_MISSING_WARNING =
  "Local recovery evidence was already finalized. Query the original idempotency key with commands get; do not issue a new Command request."

/**
 * 对一条已安全落盘的 pending record 执行精确一次 Command POST，
 * 并作为 POST 响应与本地 journal 收敛矩阵的唯一实现。
 *
 * path 和 body 构造从家族注册表分派——Dispatcher 本身不含
 * 任何 capability 特定逻辑。
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
    const record = input.record
    assertCredentialMatchesRecord(record, input.expectedCredential)

    const family = getCliCommandFamily(record.capabilityId)
    if (!family) {
      throw dependencyFailure(
        `Unknown Command family: ${record.capabilityId}; no request was sent.`,
        EXIT_CODE.business,
        { reason: "unknown_command_family" }
      )
    }

    let response: PublicResponse
    const token = await this.local.fenceExpectedLocatedCredential(
      input.expectedCredential
    )
    input.beforePost?.()
    try {
      const pendingResponse = this.http.postPublicJson({
        issuerOrigin: record.issuerOrigin,
        path: family.postPath(record.intent),
        token,
        idempotencyKey: record.idempotencyKey,
        json: family.postBody(record.intent),
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
      })
      response = await pendingResponse
    } catch {
      await this.markResponseUnknownBestEffort(record, null)
      throw outcomeUnknownFailure(
        "The Command write result is unknown. Keep the original idempotency key and recover with commands resume.",
        { suggestedAction: "query_command" }
      )
    }

    const decision = decideStatusPendingCommand(
      response.envelope,
      response.response.status,
      {
        idempotencyKey: record.idempotencyKey,
        capabilityId: record.capabilityId,
        ...(record.commandId === null ? {} : { commandId: record.commandId }),
        intent: record.intent,
      }
    )
    let settlement: PendingCommandSettlementResult
    try {
      if (decision.action === "remove") {
        settlement = await settlePendingCommand(
          this.pending,
          record,
          decision.command === null
            ? { kind: "not_created" }
            : { kind: "final", commandId: decision.command.commandId }
        )
      } else if (decision.action === "retain_command") {
        settlement = await settlePendingCommand(this.pending, record, {
          kind: "command_known",
          commandId: decision.command.commandId,
          updatedAt: monotonicTimestamp(record, this.now()),
          lastResponse: responseFact(response),
        })
      } else {
        settlement = await settlePendingCommand(this.pending, record, {
          kind: "response_unknown",
          updatedAt: monotonicTimestamp(record, this.now()),
          lastResponse: responseFact(response),
        })
      }
    } catch {
      await this.markResponseUnknownBestEffort(record, responseFact(response))
      throw outcomeUnknownFailure(
        "The Command response was received, but local recovery evidence could not be committed.",
        { suggestedAction: "query_command" }
      )
    }

    if (decision.contractViolation === "invalid_command_response") {
      const failure =
        decision.exitCode === EXIT_CODE.retryable
          ? dependencyFailure(
              "The server returned contradictory Command recovery evidence. Keep the original idempotency key.",
              EXIT_CODE.retryable,
              { reason: "invalid_command_response" }
            )
          : outcomeUnknownFailure(
              "The server returned invalid Command evidence. Keep the original idempotency key.",
              { reason: "invalid_command_response" }
            )
      return {
        exitCode: failure.exitCode,
        envelope: failure.envelope,
        warnings: [
          ...failure.warnings,
          ...warningsForEnvelope(response.envelope, this.environment),
          ...(settlement === "terminal_missing"
            ? [TERMINAL_MISSING_WARNING]
            : []),
        ],
      }
    }

    const outcome = outcomeFromEnvelope(response.envelope, this.environment)
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
              ...(settlement === "terminal_missing"
                ? [TERMINAL_MISSING_WARNING]
                : []),
            ],
    }
  }

  private async markResponseUnknownBestEffort(
    expected: PendingCommandRecord,
    lastResponse: PendingCommandRecord["lastResponse"]
  ): Promise<PendingCommandSettlementResult | null> {
    try {
      return await settlePendingCommand(this.pending, expected, {
        kind: "response_unknown",
        updatedAt: monotonicTimestamp(expected, this.now()),
        lastResponse,
      })
    } catch {
      return null
    }
  }
}
