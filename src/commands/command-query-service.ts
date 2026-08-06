import {
  DEADLINES_MS,
  EXIT_CODE,
  IDEMPOTENCY_KEY_PATTERN,
  LOWERCASE_UUID_PATTERN,
  REQUEST_ID_PATTERN,
} from "../constants.js"
import { createLocalError } from "../contracts/envelope.js"
import {
  CliFailure,
  authenticationFailure,
  dependencyFailure,
  localRequestId,
  usageFailure,
} from "../errors.js"
import { HttpTransportError } from "../http/client.js"
import { outcomeFromEnvelope } from "../output.js"
import { decideCommandGetPendingCommand } from "./command-response.js"
import { settlePendingCommand } from "./pending-command-settlement.js"
import {
  PENDING_COMMAND_RECORD_ID_PATTERN,
  pendingCredentialScopeMatches,
  pendingRecordsHaveSameIdentity,
} from "./pending-command-contract.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../auth/local-credentials.js"
import type { CliEnvelope, LocalErrorEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { PublicHttpClient, PublicResponse } from "../http/client.js"
import type { ExpectedCommandIdentity } from "./command-response.js"
import type {
  PendingCommandLastResponse,
  PendingCommandRecord,
  PendingCredentialScope,
} from "./pending-command-contract.js"
import type {
  PendingCommandInvalidEntry,
  PendingCommandInvalidReason,
  PendingCommandRecordEntry,
  PendingCommandRepository,
  PendingCommandScanResult,
} from "./pending-command-repository.js"

export interface CommandGetInput {
  commandId?: string
  idempotencyKey?: string
  requestId?: string
}

export interface ExactCommandNotFoundProof {
  readonly kind: "exact_command_not_found"
  readonly httpStatus: 404
  readonly errorCode: "RESOURCE_NOT_FOUND"
  readonly retryable: false
}

export interface CommandQueryOutcome extends CliOutcome<CliEnvelope> {
  /** 只有 QueryService 已验证精确 404 合同时才存在。 */
  readonly exactNotFound?: ExactCommandNotFoundProof
}

export type ValidatedCommandGetQuery =
  | {
      kind: "command_id"
      commandId: string
      path: string
      requestId?: string
    }
  | {
      kind: "idempotency_key"
      idempotencyKey: string
      path: string
      requestId?: string
    }

interface ControlledInvalidEntry extends JsonObject {
  recordId: string | null
  reason: PendingCommandInvalidReason
}

function controlledInvalidEntry(
  entry: PendingCommandInvalidEntry
): ControlledInvalidEntry {
  return {
    recordId:
      entry.recordId !== null &&
      PENDING_COMMAND_RECORD_ID_PATTERN.test(entry.recordId)
        ? entry.recordId
        : null,
    reason: entry.reason,
  }
}

function unsafeScanFailure(
  invalidEntries: Array<PendingCommandInvalidEntry>
): CliFailure<LocalErrorEnvelope> {
  const message =
    "Pending Command evidence is unsafe; no credential or network access occurred."
  return new CliFailure(
    message,
    EXIT_CODE.business,
    createLocalError(localRequestId(), "LOCAL_STATE_UNSAFE", message, false, {
      invalidEntries: invalidEntries.map(controlledInvalidEntry),
    })
  )
}

/**
 * Command GET 的纯输入闸门。返回值可直接用于后续 GET，
 * 且完成前不应触发 scan、credential 或网络。
 */
export function validateCommandGetInput(
  input: CommandGetInput
): ValidatedCommandGetQuery {
  const hasCommandId = input.commandId !== undefined
  const hasIdempotencyKey = input.idempotencyKey !== undefined
  if (hasCommandId === hasIdempotencyKey) {
    throw usageFailure(
      "Exactly one of --command-id or --idempotency-key is required."
    )
  }
  if (
    input.requestId !== undefined &&
    !REQUEST_ID_PATTERN.test(input.requestId)
  ) {
    throw usageFailure("--request-id must match ^[A-Za-z0-9_-]{1,128}$.")
  }

  if (hasCommandId) {
    const commandId = input.commandId!
    if (!LOWERCASE_UUID_PATTERN.test(commandId)) {
      throw usageFailure("--command-id must be a lowercase UUID.")
    }
    return {
      kind: "command_id",
      commandId,
      path: `/public/v1/commands/${commandId}`,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    }
  }

  const idempotencyKey = input.idempotencyKey!
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw usageFailure("--idempotency-key must match ^[A-Za-z0-9_-]{1,128}$.")
  }
  const query = new URLSearchParams()
  query.set("idempotencyKey", idempotencyKey)
  return {
    kind: "idempotency_key",
    idempotencyKey,
    path: `/public/v1/commands?${query.toString()}`,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  }
}

/**
 * 仅在 repository 已完成安全 scan 后关联本地证据。
 * 任何损坏项或非唯一关联都 fail-loud，不猜测应使用哪条记录。
 */
export function findAssociatedPending(
  scan: PendingCommandScanResult,
  query: ValidatedCommandGetQuery
): PendingCommandRecordEntry | null {
  if (scan.invalidEntries.length > 0) {
    throw unsafeScanFailure(scan.invalidEntries)
  }

  const matches = scan.records.filter(({ record }) =>
    query.kind === "idempotency_key"
      ? record.idempotencyKey === query.idempotencyKey
      : record.commandId === query.commandId
  )
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]!

  const reason: PendingCommandInvalidReason =
    query.kind === "idempotency_key" ? "duplicate_key" : "schema"
  throw unsafeScanFailure(
    matches
      .map(({ recordId }) => ({ recordId, reason }))
      .sort((left, right) => left.recordId.localeCompare(right.recordId))
  )
}

function blockedFailure(
  entry: PendingCommandRecordEntry,
  reason: "expired_unsubmitted" | "orphaned_credential"
): CliFailure<LocalErrorEnvelope> {
  const credentialMismatch = reason === "orphaned_credential"
  const message = credentialMismatch
    ? "The pending Command belongs to a different credential; no request was sent."
    : "The pending Command recovery window has expired; no request was sent."
  return new CliFailure(
    message,
    credentialMismatch ? EXIT_CODE.authentication : EXIT_CODE.business,
    createLocalError(
      localRequestId(),
      credentialMismatch ? "LOCAL_CREDENTIAL_MISMATCH" : "LOCAL_STATE_UNSAFE",
      message,
      false,
      { recordId: entry.recordId, blockedReason: reason }
    )
  )
}

function currentScope(located: LocatedCredential): PendingCredentialScope {
  return {
    credentialId: located.index.credentialId,
    issuerOrigin: located.index.issuerOrigin,
    teamId: located.credentials!.teamId,
  }
}

function monotonicTimestamp(record: PendingCommandRecord, now: Date): string {
  const nowMilliseconds = now.getTime()
  if (!Number.isFinite(nowMilliseconds)) {
    const message =
      "The local clock is invalid; pending Command evidence was not modified."
    throw new CliFailure(
      message,
      EXIT_CODE.business,
      createLocalError(localRequestId(), "LOCAL_STATE_UNSAFE", message, false, {
        reason: "invalid_clock",
      })
    )
  }
  return new Date(
    Math.max(nowMilliseconds, new Date(record.updatedAt).getTime())
  ).toISOString()
}

function responseFact(response: PublicResponse): PendingCommandLastResponse {
  return {
    requestId: response.response.requestId,
    httpStatus: response.response.status,
    errorCode: response.envelope.ok ? null : response.envelope.error.code,
  }
}

function expectedIdentity(
  query: ValidatedCommandGetQuery,
  associated: PendingCommandRecordEntry | null
): ExpectedCommandIdentity {
  const selector: ExpectedCommandIdentity =
    query.kind === "command_id"
      ? { commandId: query.commandId }
      : { idempotencyKey: query.idempotencyKey }
  if (associated === null) return selector
  return {
    ...selector,
    idempotencyKey: associated.record.idempotencyKey,
    ...(associated.record.commandId === null
      ? {}
      : { commandId: associated.record.commandId }),
    capabilityId: associated.record.capabilityId,
    intent: associated.record.intent,
  }
}

function exactCommandNotFoundProof(
  response: PublicResponse
): ExactCommandNotFoundProof | null {
  if (
    response.envelope.ok ||
    response.envelope.error.code !== "RESOURCE_NOT_FOUND"
  ) {
    return null
  }
  if (
    response.response.status !== 404 ||
    response.envelope.error.retryable !== false
  ) {
    throw dependencyFailure(
      "The server returned contradictory Command not-found evidence; local evidence was retained.",
      EXIT_CODE.retryable,
      { responseKind: "invalid_command_not_found_contract" }
    )
  }
  return Object.freeze({
    kind: "exact_command_not_found",
    httpStatus: 404,
    errorCode: "RESOURCE_NOT_FOUND",
    retryable: false,
  })
}

export function hasExactCommandNotFoundProof(
  outcome: CommandQueryOutcome
): boolean {
  const proof = outcome.exactNotFound
  return (
    proof !== undefined &&
    !outcome.envelope.ok &&
    outcome.envelope.error.code === "RESOURCE_NOT_FOUND" &&
    outcome.envelope.error.retryable === false
  )
}

/** GET-only Command 查询与本地 recovery journal 收敛。 */
export class CommandQueryService {
  private readonly now: () => Date
  private readonly environment: NodeJS.ProcessEnv

  constructor(
    private readonly http: PublicHttpClient,
    private readonly local: LocalCredentialCoordinator,
    private readonly pending: PendingCommandRepository,
    options: {
      now?: () => Date
      environment?: NodeJS.ProcessEnv
    } = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.environment = options.environment ?? process.env
  }

  async get(input: CommandGetInput): Promise<CommandQueryOutcome> {
    const query = validateCommandGetInput(input)
    const associated = findAssociatedPending(await this.pending.scan(), query)

    if (associated?.record.localState === "expired_unsubmitted") {
      throw blockedFailure(associated, "expired_unsubmitted")
    }
    if (associated?.record.localState === "orphaned_credential") {
      throw blockedFailure(associated, "orphaned_credential")
    }

    const located = await this.local.requireLocated()
    if (!located.credentials) {
      throw authenticationFailure(
        "The credential has not completed /me activation. Run auth whoami."
      )
    }
    if (
      associated !== null &&
      !pendingCredentialScopeMatches(associated.record, currentScope(located))
    ) {
      await this.markOrphaned(associated)
      throw blockedFailure(associated, "orphaned_credential")
    }

    const response = await this.sendGet(query, located)
    if (response.envelope.ok && response.response.status !== 200) {
      throw dependencyFailure(
        "The server returned a Command success with an invalid HTTP status; local evidence was retained.",
        EXIT_CODE.retryable,
        { responseKind: "unexpected_command_get_status" }
      )
    }
    const notFoundProof = exactCommandNotFoundProof(response)

    const decision = decideCommandGetPendingCommand(
      response.envelope,
      expectedIdentity(query, associated)
    )
    if (decision.action === "retain_unknown") {
      throw dependencyFailure(
        "The server returned invalid Command query evidence; local evidence was retained.",
        decision.exitCode,
        { responseKind: "invalid_command_response" }
      )
    }
    if (decision.action === "retain") {
      const outcome = outcomeFromEnvelope(response.envelope, this.environment)
      return {
        ...outcome,
        exitCode: decision.exitCode,
        ...(notFoundProof === null ? {} : { exactNotFound: notFoundProof }),
      }
    }

    if (associated !== null) {
      try {
        if (decision.action === "remove") {
          if (decision.command === null) {
            throw new Error("Command GET final decision omitted its Command.")
          }
          await settlePendingCommand(this.pending, associated.record, {
            kind: "final",
            commandId: decision.command.commandId,
          })
        } else {
          await settlePendingCommand(this.pending, associated.record, {
            kind: "command_known",
            commandId: decision.command.commandId,
            updatedAt: monotonicTimestamp(associated.record, this.now()),
            lastResponse: responseFact(response),
          })
        }
      } catch (error) {
        if (error instanceof CliFailure) throw error
        throw dependencyFailure(
          "The Command response was received, but local recovery evidence changed; retry the GET.",
          EXIT_CODE.retryable,
          { recordId: associated.recordId }
        )
      }
    }

    const outcome = outcomeFromEnvelope(response.envelope, this.environment)
    return { ...outcome, exitCode: decision.exitCode }
  }

  private async sendGet(
    query: ValidatedCommandGetQuery,
    located: LocatedCredential
  ): Promise<PublicResponse> {
    try {
      return await this.http.requestPublic({
        method: "GET",
        issuerOrigin: located.index.issuerOrigin,
        path: query.path,
        token: located.token,
        ...(query.requestId === undefined
          ? {}
          : { requestId: query.requestId }),
        deadlineMs: DEADLINES_MS.standard,
      })
    } catch (error) {
      if (error instanceof CliFailure) throw error
      if (error instanceof HttpTransportError) {
        throw dependencyFailure(
          "The Command GET could not be completed and may be retried.",
          EXIT_CODE.retryable,
          { failureKind: error.kind }
        )
      }
      throw dependencyFailure(
        "The Command GET could not be completed and may be retried.",
        EXIT_CODE.retryable
      )
    }
  }

  private async markOrphaned(
    associated: PendingCommandRecordEntry
  ): Promise<void> {
    const next: PendingCommandRecord = {
      ...associated.record,
      localState: "orphaned_credential",
      updatedAt: monotonicTimestamp(associated.record, this.now()),
    }
    try {
      await this.pending.replaceExact(associated.record, next)
    } catch {
      const current = await this.pending.read(associated.record.idempotencyKey)
      if (
        current.kind === "found" &&
        current.record.localState === "orphaned_credential" &&
        pendingRecordsHaveSameIdentity(associated.record, current.record)
      ) {
        return
      }
      throw dependencyFailure(
        "Pending Command evidence changed while blocking a prior credential; no request was sent.",
        EXIT_CODE.retryable,
        { recordId: associated.recordId }
      )
    }
  }
}
