import {
  EXIT_CODE,
  IDEMPOTENCY_KEY_PATTERN,
  REQUEST_ID_PATTERN,
} from "../constants.js"
import { createLocalError } from "../contracts/envelope.js"
import { decodePublicCommandData } from "../contracts/command.js"
import { isCanonicalUtcIso } from "../contracts/json.js"
import {
  CliFailure,
  authenticationFailure,
  dependencyFailure,
  localRequestId,
  usageFailure,
} from "../errors.js"
import { hasExactCommandNotFoundProof } from "./command-query-service.js"
import {
  PENDING_COMMAND_RECORD_ID_PATTERN,
  parsePendingCommandRecord,
  pendingCredentialScopeMatches,
  pendingRecordId,
  pendingRecordsHaveSameIdentity,
} from "./pending-command-contract.js"
import type {
  LocalCredentialCoordinator,
  LocatedCredential,
} from "../auth/local-credentials.js"
import type { CliEnvelope, LocalErrorEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { CommandQueryService } from "./command-query-service.js"
import type { PendingCommandRecord } from "./pending-command-contract.js"
import type {
  PendingCommandInvalidEntry,
  PendingCommandRecordEntry,
  PendingCommandRepository,
  PendingCommandScanResult,
} from "./pending-command-repository.js"
import type { StatusCommandDispatcher } from "./status-command-dispatcher.js"

const RESUME_POST_WINDOW_MS = 86_400_000

class ResumePostWindowExpiredError extends Error {
  constructor(readonly observedAt: Date) {
    super("The pending Command recovery window expired at dispatch time.")
    this.name = "ResumePostWindowExpiredError"
  }
}

export interface CommandResumeInput {
  idempotencyKey?: string
  requestId?: string
}

export interface ValidatedCommandResumeInput {
  idempotencyKey: string
  requestId?: string
}

export interface QualifiedCommandResume {
  entry: PendingCommandRecordEntry
  located: LocatedCredential
  observedAt: Date
  requestId?: string
}

interface LocatedCommandResume {
  entry: PendingCommandRecordEntry
  observedAt: Date
}

export interface CommandResumeServiceOptions {
  now?: () => Date
  query?: Pick<CommandQueryService, "get">
  dispatcher?: Pick<StatusCommandDispatcher, "dispatch">
}

interface ControlledInvalidEntry extends JsonObject {
  recordId: string | null
  reason: PendingCommandInvalidEntry["reason"]
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

function unsafeResumeFailure(
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

export function validateCommandResumeInput(
  input: CommandResumeInput
): ValidatedCommandResumeInput {
  if (input.idempotencyKey === undefined) {
    throw usageFailure("--idempotency-key is required.")
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    throw usageFailure("--idempotency-key must match ^[A-Za-z0-9_-]{1,128}$.")
  }
  if (
    input.requestId !== undefined &&
    !REQUEST_ID_PATTERN.test(input.requestId)
  ) {
    throw usageFailure("--request-id must match ^[A-Za-z0-9_-]{1,128}$.")
  }
  return Object.freeze({
    idempotencyKey: input.idempotencyKey,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  })
}

/** 从一次已完成的安全全量 scan 中唯一定位 Resume 原记录。 */
function findResumePendingOptional(
  scan: PendingCommandScanResult,
  input: ValidatedCommandResumeInput
): PendingCommandRecordEntry | null {
  if (scan.invalidEntries.length > 0) {
    throw unsafeResumeFailure(scan.invalidEntries)
  }
  const matches = scan.records.filter(
    ({ record }) => record.idempotencyKey === input.idempotencyKey
  )
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw unsafeResumeFailure(
      matches
        .map(({ recordId }) => ({
          recordId,
          reason: "duplicate_key" as const,
        }))
        .sort((left, right) => left.recordId.localeCompare(right.recordId))
    )
  }

  const match = matches[0]!
  const record = parsePendingCommandRecord(match.record)
  if (
    !PENDING_COMMAND_RECORD_ID_PATTERN.test(match.recordId) ||
    record === null ||
    pendingRecordId(record.idempotencyKey) !== match.recordId
  ) {
    throw unsafeResumeFailure([
      {
        recordId: PENDING_COMMAND_RECORD_ID_PATTERN.test(match.recordId)
          ? match.recordId
          : null,
        reason: "schema",
      },
    ])
  }
  return Object.freeze({ recordId: match.recordId, record })
}

export function findResumePending(
  scan: PendingCommandScanResult,
  input: ValidatedCommandResumeInput
): PendingCommandRecordEntry {
  const entry = findResumePendingOptional(scan, input)
  if (entry === null) {
    throw usageFailure(
      "No pending Command exists for the supplied idempotency key.",
      { reason: "pending_command_missing" }
    )
  }
  return entry
}

function localStateFailure(
  message: string,
  details: JsonObject = {}
): CliFailure<LocalErrorEnvelope> {
  return new CliFailure(
    message,
    EXIT_CODE.business,
    createLocalError(
      localRequestId(),
      "LOCAL_STATE_UNSAFE",
      message,
      false,
      details
    )
  )
}

function terminalFailure(
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

function qualificationNow(now: () => Date, previous?: Date): Date {
  let value: Date
  try {
    value = now()
  } catch {
    throw localStateFailure(
      "The local clock is invalid; pending Command evidence was not modified.",
      { reason: "invalid_clock" }
    )
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw localStateFailure(
      "The local clock is invalid; pending Command evidence was not modified.",
      { reason: "invalid_clock" }
    )
  }
  if (previous !== undefined && value.getTime() < previous.getTime()) {
    throw localStateFailure(
      "The local clock moved backwards; pending Command evidence was not modified.",
      { reason: "clock_rollback" }
    )
  }
  return value
}

function assertSafeCreatedAt(
  entry: PendingCommandRecordEntry,
  now: Date
): void {
  const createdAt = entry.record.createdAt
  if (!isCanonicalUtcIso(createdAt) || Date.parse(createdAt) > now.getTime()) {
    throw localStateFailure(
      "The pending Command creation time is unsafe or in the future; no credential access occurred.",
      { recordId: entry.recordId, reason: "invalid_created_at" }
    )
  }
}

function scopeMatches(
  entry: PendingCommandRecordEntry,
  located: LocatedCredential
): boolean {
  return pendingCredentialScopeMatches(entry.record, {
    credentialId: located.index.credentialId,
    issuerOrigin: located.index.issuerOrigin,
    teamId: located.credentials!.teamId,
  })
}

function monotonicTimestamp(record: PendingCommandRecord, now: Date): string {
  return new Date(
    Math.max(now.getTime(), new Date(record.updatedAt).getTime())
  ).toISOString()
}

/** Resume 的本地资格闸门：本阶段不发 HTTP，不判定 24h POST 分支。 */
export class CommandResumeService {
  private readonly now: () => Date
  private readonly query: Pick<CommandQueryService, "get"> | null
  private readonly dispatcher: Pick<StatusCommandDispatcher, "dispatch"> | null

  constructor(
    private readonly local: LocalCredentialCoordinator,
    private readonly pending: PendingCommandRepository,
    options: CommandResumeServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.query = options.query ?? null
    this.dispatcher = options.dispatcher ?? null
  }

  async qualify(input: CommandResumeInput): Promise<QualifiedCommandResume> {
    const validated = validateCommandResumeInput(input)
    const located = await this.locateValidated(validated)
    return this.qualifyLocated(located, validated)
  }

  /**
   * 完成一次显式 Resume。GET 先行；精确 404 且未满 24h 时使用原 Key POST。
   */
  async resume(input: CommandResumeInput): Promise<CliOutcome<CliEnvelope>> {
    const validated = validateCommandResumeInput(input)
    if (this.query === null || this.dispatcher === null) {
      throw dependencyFailure(
        "Command resume execution dependencies are unavailable.",
        EXIT_CODE.retryable,
        { reason: "resume_dependencies_unavailable" }
      )
    }
    const located = await this.locateValidated(validated)
    const initial = await this.qualifyLocated(located, validated)
    return this.resumeValidated(
      validated,
      initial,
      this.query,
      this.dispatcher
    )
  }

  private locateValidated(
    validated: ValidatedCommandResumeInput,
    allowMissing?: false,
    previousObservedAt?: Date
  ): Promise<LocatedCommandResume>
  private locateValidated(
    validated: ValidatedCommandResumeInput,
    allowMissing: true,
    previousObservedAt?: Date
  ): Promise<LocatedCommandResume | null>
  private async locateValidated(
    validated: ValidatedCommandResumeInput,
    allowMissing = false,
    previousObservedAt?: Date
  ): Promise<LocatedCommandResume | null> {
    const entry = findResumePendingOptional(
      await this.pending.scan(),
      validated
    )
    if (entry === null) {
      if (allowMissing) return null
      throw usageFailure(
        "No pending Command exists for the supplied idempotency key.",
        { reason: "pending_command_missing" }
      )
    }

    if (entry.record.localState === "expired_unsubmitted") {
      throw terminalFailure(entry, "expired_unsubmitted")
    }
    if (entry.record.localState === "orphaned_credential") {
      throw terminalFailure(entry, "orphaned_credential")
    }

    const now = qualificationNow(this.now, previousObservedAt)
    assertSafeCreatedAt(entry, now)

    return Object.freeze({ entry, observedAt: now })
  }

  private async qualifyLocated(
    locatedResume: LocatedCommandResume,
    validated: ValidatedCommandResumeInput
  ): Promise<QualifiedCommandResume> {
    const { entry, observedAt } = locatedResume
    const located = await this.local.requireLocated()
    if (!located.credentials) {
      throw authenticationFailure(
        "The credential has not completed /me activation. Run auth whoami."
      )
    }
    if (!scopeMatches(entry, located)) {
      await this.markOrphaned(entry, observedAt)
      throw terminalFailure(entry, "orphaned_credential")
    }

    return Object.freeze({
      entry,
      located,
      observedAt,
      ...(validated.requestId === undefined
        ? {}
        : { requestId: validated.requestId }),
    })
  }

  private async resumeValidated(
    validated: ValidatedCommandResumeInput,
    initial: QualifiedCommandResume,
    query: Pick<CommandQueryService, "get">,
    dispatcher: Pick<StatusCommandDispatcher, "dispatch">
  ): Promise<CliOutcome<CliEnvelope>> {
    const queryOutcome = await query.get({
      ...(initial.entry.record.commandId === null
        ? { idempotencyKey: initial.entry.record.idempotencyKey }
        : { commandId: initial.entry.record.commandId }),
      ...(validated.requestId === undefined
        ? {}
        : { requestId: validated.requestId }),
    })

    if (!queryOutcome.envelope.ok) {
      if (!hasExactCommandNotFoundProof(queryOutcome)) {
        return queryOutcome
      }
      return this.resumeAfterNotFound(
        validated,
        initial,
        queryOutcome,
        dispatcher
      )
    }

    const data = decodePublicCommandData(queryOutcome.envelope.data)
    if (data === null) {
      throw dependencyFailure(
        "The validated Command query result could not be consumed safely; no Status request was sent.",
        EXIT_CODE.retryable,
        { reason: "invalid_query_handoff" }
      )
    }
    if (data.command.isFinal || data.command.status !== "pending") {
      return queryOutcome
    }

    const refreshed = await this.refreshCompatible(initial, validated)
    if (refreshed === null) return queryOutcome
    if (
      refreshed.entry.record.localState !== "command_known" ||
      refreshed.entry.record.commandId !== data.command.commandId
    ) {
      throw localStateFailure(
        "Pending Command evidence did not match the converged query result; no Status request was sent.",
        { recordId: initial.entry.recordId, reason: "query_convergence_drift" }
      )
    }
    const boundary = await this.rereadCompatible(
      refreshed.entry,
      "Pending Command evidence changed after query convergence; no Status request was sent."
    )
    if (boundary === null) return queryOutcome
    if (
      boundary.record.localState !== "command_known" ||
      boundary.record.commandId !== data.command.commandId
    ) {
      throw localStateFailure(
        "Pending Command evidence no longer matched the pending Command; no Status request was sent.",
        { recordId: initial.entry.recordId, reason: "query_convergence_drift" }
      )
    }
    return dispatcher.dispatch({
      record: boundary.record,
      expectedCredential: refreshed.located,
      ...(validated.requestId === undefined
        ? {}
        : { requestId: validated.requestId }),
    })
  }

  private async resumeAfterNotFound(
    validated: ValidatedCommandResumeInput,
    initial: QualifiedCommandResume,
    notFoundOutcome: CliOutcome<CliEnvelope>,
    dispatcher: Pick<StatusCommandDispatcher, "dispatch">
  ): Promise<CliOutcome<CliEnvelope>> {
    const refreshed = await this.refreshCompatible(initial, validated)
    if (refreshed === null) return notFoundOutcome
    const boundary = await this.rereadCompatible(
      refreshed.entry,
      "Pending Command evidence changed at the recovery dispatch boundary; no Status request was sent."
    )
    if (boundary === null) return notFoundOutcome
    try {
      return await dispatcher.dispatch({
        record: boundary.record,
        expectedCredential: refreshed.located,
        ...(validated.requestId === undefined
          ? {}
          : { requestId: validated.requestId }),
        beforePost: () => {
          const dispatchNow = qualificationNow(this.now, refreshed.observedAt)
          const expiresAt =
            Date.parse(boundary.record.createdAt) + RESUME_POST_WINDOW_MS
          if (dispatchNow.getTime() >= expiresAt) {
            throw new ResumePostWindowExpiredError(dispatchNow)
          }
        },
      })
    } catch (error) {
      if (!(error instanceof ResumePostWindowExpiredError)) throw error
      if (await this.markExpired(boundary, error.observedAt)) {
        throw terminalFailure(boundary, "expired_unsubmitted")
      }
      return notFoundOutcome
    }
  }

  private async refreshCompatible(
    initial: QualifiedCommandResume,
    validated: ValidatedCommandResumeInput
  ): Promise<QualifiedCommandResume | null> {
    const located = await this.locateValidated(
      validated,
      true,
      initial.observedAt
    )
    if (located === null) return null
    const refreshed = await this.qualifyLocated(located, validated)
    this.assertCompatibleProgression(initial.entry, refreshed.entry)
    return refreshed
  }

  private assertCompatibleProgression(
    expected: PendingCommandRecordEntry,
    current: PendingCommandRecordEntry
  ): void {
    const expectedRecord = expected.record
    const currentRecord = current.record
    const commandEvidenceRegressed =
      (expectedRecord.localState === "command_known" &&
        currentRecord.localState !== "command_known") ||
      (expectedRecord.localState === "response_unknown" &&
        currentRecord.localState === "prepared")
    if (
      expected.recordId !== current.recordId ||
      !pendingRecordsHaveSameIdentity(expectedRecord, currentRecord) ||
      commandEvidenceRegressed ||
      (expectedRecord.commandId !== null &&
        currentRecord.commandId !== expectedRecord.commandId)
    ) {
      throw localStateFailure(
        "Pending Command evidence changed incompatibly; no Status request was sent.",
        { recordId: expected.recordId, reason: "query_evidence_drift" }
      )
    }
  }

  private async rereadCompatible(
    expected: PendingCommandRecordEntry,
    message: string
  ): Promise<PendingCommandRecordEntry | null> {
    const current = await this.pending.read(expected.record.idempotencyKey)
    if (current.kind === "missing") return null
    if (current.kind !== "found") {
      throw localStateFailure(message, {
        recordId: expected.recordId,
        reason: "record_changed",
      })
    }
    const entry = Object.freeze({
      recordId: current.recordId,
      record: current.record,
    })
    if (entry.record.localState === "expired_unsubmitted") {
      throw terminalFailure(entry, "expired_unsubmitted")
    }
    if (entry.record.localState === "orphaned_credential") {
      throw terminalFailure(entry, "orphaned_credential")
    }
    this.assertCompatibleProgression(expected, entry)
    return entry
  }

  private async markExpired(
    entry: PendingCommandRecordEntry,
    now: Date
  ): Promise<boolean> {
    const next: PendingCommandRecord = {
      ...entry.record,
      localState: "expired_unsubmitted",
      updatedAt: monotonicTimestamp(entry.record, now),
    }
    try {
      await this.pending.replaceExact(entry.record, next)
      return true
    } catch {
      const current = await this.pending.read(entry.record.idempotencyKey)
      if (current.kind === "missing") return false
      if (
        current.kind === "found" &&
        current.record.localState === "expired_unsubmitted" &&
        pendingRecordsHaveSameIdentity(entry.record, current.record)
      ) {
        return true
      }
      if (
        current.kind === "found" &&
        pendingRecordsHaveSameIdentity(entry.record, current.record) &&
        (current.record.localState === "command_known" ||
          current.record.localState === "response_unknown")
      ) {
        return false
      }
      throw localStateFailure(
        "Pending Command evidence changed while expiring its recovery window; no Status request was sent.",
        { recordId: entry.recordId, reason: "record_changed" }
      )
    }
  }

  private async markOrphaned(
    entry: PendingCommandRecordEntry,
    now: Date
  ): Promise<void> {
    const next: PendingCommandRecord = {
      ...entry.record,
      localState: "orphaned_credential",
      updatedAt: monotonicTimestamp(entry.record, now),
    }
    try {
      await this.pending.replaceExact(entry.record, next)
    } catch {
      const current = await this.pending.read(entry.record.idempotencyKey)
      if (
        current.kind === "found" &&
        current.record.localState === "orphaned_credential" &&
        pendingRecordsHaveSameIdentity(entry.record, current.record)
      ) {
        return
      }
      throw dependencyFailure(
        "Pending Command evidence changed while blocking a prior credential; no request was sent.",
        EXIT_CODE.retryable,
        { recordId: entry.recordId }
      )
    }
  }
}
