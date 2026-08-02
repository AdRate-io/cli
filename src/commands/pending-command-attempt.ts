import { randomUUID } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { DefaultProcessIdentityProbe } from "../auth/process-identity.js"
import { DEADLINES_MS, LOWERCASE_UUID_PATTERN } from "../constants.js"
import { isCanonicalUtcIso, isPlainObject } from "../contracts/json.js"
import {
  PENDING_COMMAND_RECORD_ID_PATTERN,
  pendingRecordId,
  serializePendingCommand,
  sha256Hex,
} from "./pending-command-contract.js"
import type {
  ProcessIdentityProbe,
  ProcessIdentityStatus,
} from "../auth/process-identity.js"
import type { CliPaths } from "../storage/paths.js"
import type { SecureFileSystem } from "../storage/secure-files.js"
import type { PendingCommandRecord } from "./pending-command-contract.js"

const ATTEMPT_FORMAT_VERSION = 1 as const
const ATTEMPT_LEASE_MS = DEADLINES_MS.statusWrite + 3 * 60_000
const ATTEMPT_FILE_PATTERN = /^([0-9a-f]{64})\.json$/u
const ATTEMPT_TEMP_FILE_PATTERN =
  /^([0-9a-f]{64})\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export type PendingCommandAttemptPhase =
  | "query_intent"
  | "post_dispatch_intent"
  | "terminal_cleanup_intent"

export type PendingCommandReservableAttemptPhase = Exclude<
  PendingCommandAttemptPhase,
  "terminal_cleanup_intent"
>

export interface PendingCommandAttemptRecord {
  formatVersion: typeof ATTEMPT_FORMAT_VERSION
  recordId: string
  recordIdentityHash: string
  terminalRecordHash: string | null
  ownerToken: string
  ownerPid: number
  ownerProcessFingerprint: string
  phase: PendingCommandAttemptPhase
  createdAt: string
  leaseExpiresAt: string
  observedAt: string
}

export interface PendingCommandAttemptHandle {
  idempotencyKey: string
  attempt: PendingCommandAttemptRecord
}

export type PendingCommandAttemptInvalidReason =
  | "permission"
  | "symlink"
  | "invalid_json"
  | "schema"

export interface PendingCommandAttemptInvalidEntry {
  recordId: string | null
  reason: PendingCommandAttemptInvalidReason
}

export class PendingCommandAttemptBusyError extends Error {
  constructor() {
    super("Another Command recovery attempt owns this local record.")
    this.name = "PendingCommandAttemptBusyError"
  }
}

export class PendingCommandAttemptUnsafeError extends Error {
  constructor(readonly invalidEntry: PendingCommandAttemptInvalidEntry) {
    super("The pending Command attempt evidence is unsafe.")
    this.name = "PendingCommandAttemptUnsafeError"
  }
}

export class PendingCommandClockRollbackError extends Error {
  constructor() {
    super("The local clock moved backwards during Command recovery.")
    this.name = "PendingCommandClockRollbackError"
  }
}

type PendingReadResult =
  | { kind: "missing"; recordId: string }
  | { kind: "found"; recordId: string; record: PendingCommandRecord }
  | { kind: "unsafe"; recordId: string }

type AttemptReadResult =
  | { kind: "missing"; recordId: string }
  | { kind: "found"; recordId: string; attempt: PendingCommandAttemptRecord }
  | {
      kind: "unsafe"
      recordId: string
      invalidEntry: PendingCommandAttemptInvalidEntry
    }

export interface PendingCommandAttemptCoordinatorOptions {
  now?: () => Date
  processIdentity?: ProcessIdentityProbe
  generateOwnerToken?: () => string
  withKeyLock: <T>(
    idempotencyKey: string,
    action: () => Promise<T>
  ) => Promise<T>
  readPending: (idempotencyKey: string) => Promise<PendingReadResult>
}

function hasExactKeys(value: object, keys: Array<string>): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function isSafeFingerprint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 0x1f || code === 0x7f)
    })
  )
}

export function parsePendingCommandAttempt(
  value: unknown
): PendingCommandAttemptRecord | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "formatVersion",
      "recordId",
      "recordIdentityHash",
      "terminalRecordHash",
      "ownerToken",
      "ownerPid",
      "ownerProcessFingerprint",
      "phase",
      "createdAt",
      "leaseExpiresAt",
      "observedAt",
    ]) ||
    value.formatVersion !== ATTEMPT_FORMAT_VERSION ||
    typeof value.recordId !== "string" ||
    !PENDING_COMMAND_RECORD_ID_PATTERN.test(value.recordId) ||
    typeof value.recordIdentityHash !== "string" ||
    !PENDING_COMMAND_RECORD_ID_PATTERN.test(value.recordIdentityHash) ||
    (value.terminalRecordHash !== null &&
      (typeof value.terminalRecordHash !== "string" ||
        !PENDING_COMMAND_RECORD_ID_PATTERN.test(value.terminalRecordHash))) ||
    typeof value.ownerToken !== "string" ||
    !LOWERCASE_UUID_PATTERN.test(value.ownerToken) ||
    !Number.isSafeInteger(value.ownerPid) ||
    Number(value.ownerPid) <= 0 ||
    !isSafeFingerprint(value.ownerProcessFingerprint) ||
    (value.phase !== "query_intent" &&
      value.phase !== "post_dispatch_intent" &&
      value.phase !== "terminal_cleanup_intent") ||
    !isCanonicalUtcIso(value.createdAt) ||
    !isCanonicalUtcIso(value.leaseExpiresAt) ||
    !isCanonicalUtcIso(value.observedAt)
  ) {
    return null
  }
  if (
    (value.phase === "terminal_cleanup_intent") !==
    (value.terminalRecordHash !== null)
  ) {
    return null
  }
  const createdAtMs = Date.parse(value.createdAt)
  const leaseExpiresAtMs = Date.parse(value.leaseExpiresAt)
  const observedAtMs = Date.parse(value.observedAt)
  if (
    observedAtMs < createdAtMs ||
    leaseExpiresAtMs !== observedAtMs + ATTEMPT_LEASE_MS
  ) {
    return null
  }
  return Object.freeze({
    formatVersion: ATTEMPT_FORMAT_VERSION,
    recordId: value.recordId,
    recordIdentityHash: value.recordIdentityHash,
    terminalRecordHash: value.terminalRecordHash,
    ownerToken: value.ownerToken,
    ownerPid: Number(value.ownerPid),
    ownerProcessFingerprint: value.ownerProcessFingerprint,
    phase: value.phase,
    createdAt: value.createdAt,
    leaseExpiresAt: value.leaseExpiresAt,
    observedAt: value.observedAt,
  })
}

export function serializePendingCommandAttempt(
  attempt: PendingCommandAttemptRecord
): string {
  const parsed = parsePendingCommandAttempt(attempt)
  if (parsed === null)
    throw new TypeError("Pending Command attempt is invalid.")
  return `${JSON.stringify(parsed, null, 2)}\n`
}

export function pendingCommandRecordIdentityHash(
  record: PendingCommandRecord
): string {
  return sha256Hex(
    JSON.stringify({
      formatVersion: record.formatVersion,
      idempotencyKey: record.idempotencyKey,
      capabilityId: record.capabilityId,
      credentialKind: record.credentialKind,
      credentialId: record.credentialId,
      issuerOrigin: record.issuerOrigin,
      teamId: record.teamId,
      intentHash: record.intentHash,
      createdAt: record.createdAt,
    })
  )
}

export function pendingCommandRecordSnapshotHash(
  record: PendingCommandRecord
): string {
  return sha256Hex(serializePendingCommand(record))
}

function recordsExactlyEqual(
  left: PendingCommandRecord,
  right: PendingCommandRecord
): boolean {
  return serializePendingCommand(left) === serializePendingCommand(right)
}

function attemptsExactlyEqual(
  left: PendingCommandAttemptRecord,
  right: PendingCommandAttemptRecord
): boolean {
  return (
    serializePendingCommandAttempt(left) ===
    serializePendingCommandAttempt(right)
  )
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function classifySecureError(
  error: unknown
): PendingCommandAttemptInvalidReason {
  if (!(error instanceof Error)) return "schema"
  const message = error.message.toLowerCase()
  if (message.includes("symbolic link")) return "symlink"
  if (
    message.includes("permission") ||
    message.includes("owner") ||
    message.includes("acl") ||
    message.includes("eacces") ||
    message.includes("eperm")
  ) {
    return "permission"
  }
  return "schema"
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

/** Durable owner reservation；所有 process identity 探测均在 key lock 外。 */
export class PendingCommandAttemptCoordinator {
  private readonly now: () => Date
  private readonly processIdentity: ProcessIdentityProbe
  private readonly generateOwnerToken: () => string

  constructor(
    private readonly fileSystem: SecureFileSystem,
    private readonly paths: CliPaths,
    private readonly options: PendingCommandAttemptCoordinatorOptions
  ) {
    this.now = options.now ?? (() => new Date())
    this.processIdentity =
      options.processIdentity ?? new DefaultProcessIdentityProbe()
    this.generateOwnerToken = options.generateOwnerToken ?? randomUUID
  }

  path(recordId: string): string {
    if (!PENDING_COMMAND_RECORD_ID_PATTERN.test(recordId)) {
      throw new TypeError("Pending Command record ID is invalid.")
    }
    return join(this.paths.pendingCommandAttempts, `${recordId}.json`)
  }

  async reserve(input: {
    expected: PendingCommandRecord
    phase: PendingCommandReservableAttemptPhase
    observedAt: Date
    allowReclaim: boolean
  }): Promise<PendingCommandAttemptHandle> {
    const observedAt = this.observeAfter(input.observedAt)
    const recordId = pendingRecordId(input.expected.idempotencyKey)
    const recordIdentityHash = pendingCommandRecordIdentityHash(input.expected)
    const outsideCandidate = await this.read(recordId)
    if (outsideCandidate.kind === "unsafe") {
      throw new PendingCommandAttemptUnsafeError(outsideCandidate.invalidEntry)
    }

    let reclaimStatus: ProcessIdentityStatus | null = null
    if (outsideCandidate.kind === "found") {
      this.assertMatchesRecord(outsideCandidate.attempt, input.expected)
      if (
        observedAt.getTime() < Date.parse(outsideCandidate.attempt.observedAt)
      ) {
        throw new PendingCommandClockRollbackError()
      }
      if (outsideCandidate.attempt.phase === "terminal_cleanup_intent") {
        throw new PendingCommandAttemptBusyError()
      }
      const expired =
        Date.parse(outsideCandidate.attempt.leaseExpiresAt) <=
        observedAt.getTime()
      if (!expired || !input.allowReclaim) {
        throw new PendingCommandAttemptBusyError()
      }
      reclaimStatus = await this.processIdentity.inspect({
        pid: outsideCandidate.attempt.ownerPid,
        fingerprint: outsideCandidate.attempt.ownerProcessFingerprint,
      })
      if (reclaimStatus !== "dead" && reclaimStatus !== "reused") {
        throw new PendingCommandAttemptBusyError()
      }
    }
    // current() may invoke an external process and therefore stays outside the lock.
    const owner = await this.processIdentity.current()
    const attempt: PendingCommandAttemptRecord = {
      formatVersion: ATTEMPT_FORMAT_VERSION,
      recordId,
      recordIdentityHash,
      terminalRecordHash: null,
      ownerToken: this.generateOwnerToken(),
      ownerPid: owner.pid,
      ownerProcessFingerprint: owner.fingerprint,
      phase: input.phase,
      createdAt: observedAt.toISOString(),
      leaseExpiresAt: new Date(
        observedAt.getTime() + ATTEMPT_LEASE_MS
      ).toISOString(),
      observedAt: observedAt.toISOString(),
    }

    return this.options.withKeyLock(input.expected.idempotencyKey, async () => {
      const lockedCandidate = await this.read(recordId)
      if (outsideCandidate.kind === "missing") {
        if (lockedCandidate.kind !== "missing") {
          if (lockedCandidate.kind === "unsafe") {
            throw new PendingCommandAttemptUnsafeError(
              lockedCandidate.invalidEntry
            )
          }
          throw new PendingCommandAttemptBusyError()
        }
      } else {
        if (
          lockedCandidate.kind !== "found" ||
          !attemptsExactlyEqual(
            outsideCandidate.attempt,
            lockedCandidate.attempt
          ) ||
          (reclaimStatus !== "dead" && reclaimStatus !== "reused")
        ) {
          throw new PendingCommandAttemptBusyError()
        }
      }

      const current = await this.options.readPending(
        input.expected.idempotencyKey
      )
      if (
        current.kind !== "found" ||
        current.recordId !== recordId ||
        !recordsExactlyEqual(current.record, input.expected)
      ) {
        throw new PendingCommandAttemptBusyError()
      }

      if (lockedCandidate.kind === "found") {
        await this.fileSystem.removeSecureFile(this.path(recordId))
      }
      const created = await this.fileSystem.atomicCreate(
        this.path(recordId),
        serializePendingCommandAttempt(attempt)
      )
      if (created !== "created") throw new PendingCommandAttemptBusyError()
      return Object.freeze({
        idempotencyKey: input.expected.idempotencyKey,
        attempt,
      })
    })
  }

  async advanceToPost(
    handle: PendingCommandAttemptHandle,
    expected: PendingCommandRecord,
    observedAt: Date
  ): Promise<PendingCommandAttemptHandle> {
    const nextObservedAt = this.observeAfter(
      new Date(
        Math.max(Date.parse(handle.attempt.observedAt), observedAt.getTime())
      )
    )
    return this.options.withKeyLock(handle.idempotencyKey, async () => {
      const currentAttempt = await this.requireOwned(handle, expected)
      if (
        handle.attempt.phase !== "query_intent" ||
        currentAttempt.phase !== "query_intent" ||
        !attemptsExactlyEqual(handle.attempt, currentAttempt)
      ) {
        throw new PendingCommandAttemptBusyError()
      }
      const currentPending = await this.options.readPending(
        handle.idempotencyKey
      )
      if (
        currentPending.kind !== "found" ||
        pendingCommandRecordIdentityHash(currentPending.record) !==
          handle.attempt.recordIdentityHash
      ) {
        throw new PendingCommandAttemptUnsafeError({
          recordId: handle.attempt.recordId,
          reason: "schema",
        })
      }
      const next: PendingCommandAttemptRecord = {
        ...currentAttempt,
        phase: "post_dispatch_intent",
        terminalRecordHash: null,
        observedAt: nextObservedAt.toISOString(),
        leaseExpiresAt: new Date(
          Math.max(
            Date.parse(currentAttempt.leaseExpiresAt),
            nextObservedAt.getTime() + ATTEMPT_LEASE_MS
          )
        ).toISOString(),
      }
      await this.fileSystem.atomicWrite(
        this.path(next.recordId),
        serializePendingCommandAttempt(next)
      )
      return Object.freeze({
        idempotencyKey: handle.idempotencyKey,
        attempt: next,
      })
    })
  }

  async release(handle: PendingCommandAttemptHandle): Promise<void> {
    await this.options.withKeyLock(handle.idempotencyKey, async () => {
      const current = await this.read(handle.attempt.recordId)
      if (current.kind === "missing") return
      if (current.kind !== "found") {
        throw new PendingCommandAttemptUnsafeError(current.invalidEntry)
      }
      if (
        current.attempt.ownerToken !== handle.attempt.ownerToken ||
        current.attempt.recordIdentityHash !== handle.attempt.recordIdentityHash
      ) {
        throw new PendingCommandAttemptBusyError()
      }
      if (current.attempt.phase === "terminal_cleanup_intent") {
        await this.completeTerminalCleanupLocked(
          handle.idempotencyKey,
          current.attempt
        )
        return
      }
      if (!attemptsExactlyEqual(current.attempt, handle.attempt)) {
        throw new PendingCommandAttemptBusyError()
      }
      await this.fileSystem.removeSecureFile(this.path(handle.attempt.recordId))
    })
  }

  /**
   * 必须只在同 Key 短锁内调用。终态事实先落盘，随后才允许
   * 删除 pending；进程在任一步崩溃时都可由 Resume 只做本地收尾。
   */
  async markTerminalCleanupLocked(
    record: PendingCommandRecord,
    ownerToken: string
  ): Promise<PendingCommandAttemptRecord> {
    const recordId = pendingRecordId(record.idempotencyKey)
    const current = await this.read(recordId)
    if (current.kind !== "found") {
      throw new PendingCommandAttemptUnsafeError(
        current.kind === "unsafe"
          ? current.invalidEntry
          : { recordId, reason: "schema" }
      )
    }
    this.assertMatchesRecord(current.attempt, record)
    if (current.attempt.ownerToken !== ownerToken) {
      throw new PendingCommandAttemptBusyError()
    }
    const terminalRecordHash = pendingCommandRecordSnapshotHash(record)
    if (current.attempt.phase === "terminal_cleanup_intent") {
      if (current.attempt.terminalRecordHash !== terminalRecordHash) {
        throw new PendingCommandAttemptUnsafeError({
          recordId,
          reason: "schema",
        })
      }
      return current.attempt
    }
    const next: PendingCommandAttemptRecord = {
      ...current.attempt,
      phase: "terminal_cleanup_intent",
      terminalRecordHash,
    }
    await this.fileSystem.atomicWrite(
      this.path(recordId),
      serializePendingCommandAttempt(next)
    )
    return next
  }

  /**
   * Resume 开工前的本地恢复闸门。命中终态清理意图时不读
   * credential、不发 GET/POST，只在短锁内完成 pending/sidecar 清理。
   */
  async completeTerminalCleanup(idempotencyKey: string): Promise<boolean> {
    const recordId = pendingRecordId(idempotencyKey)
    const outside = await this.read(recordId)
    if (outside.kind === "missing") return false
    if (outside.kind === "unsafe") {
      throw new PendingCommandAttemptUnsafeError(outside.invalidEntry)
    }
    if (outside.attempt.phase !== "terminal_cleanup_intent") return false

    return this.options.withKeyLock(idempotencyKey, async () => {
      const locked = await this.read(recordId)
      if (
        locked.kind !== "found" ||
        !attemptsExactlyEqual(outside.attempt, locked.attempt)
      ) {
        if (locked.kind === "unsafe") {
          throw new PendingCommandAttemptUnsafeError(locked.invalidEntry)
        }
        throw new PendingCommandAttemptBusyError()
      }
      await this.completeTerminalCleanupLocked(idempotencyKey, locked.attempt)
      return true
    })
  }

  /** 必须只在同 Key 短锁内调用。 */
  async completeTerminalCleanupBeforePrepareLocked(
    idempotencyKey: string
  ): Promise<boolean> {
    const recordId = pendingRecordId(idempotencyKey)
    const current = await this.read(recordId)
    if (current.kind === "missing") return false
    if (current.kind === "unsafe") {
      throw new PendingCommandAttemptUnsafeError(current.invalidEntry)
    }
    if (current.attempt.phase !== "terminal_cleanup_intent") {
      throw new PendingCommandAttemptBusyError()
    }
    await this.completeTerminalCleanupLocked(idempotencyKey, current.attempt)
    return true
  }

  async assertNetworkAllowed(
    record: PendingCommandRecord,
    ownerToken?: string
  ): Promise<void> {
    const current = await this.read(pendingRecordId(record.idempotencyKey))
    if (current.kind === "missing") {
      if (ownerToken !== undefined) throw new PendingCommandAttemptBusyError()
      return
    }
    if (current.kind !== "found") {
      throw new PendingCommandAttemptUnsafeError(current.invalidEntry)
    }
    this.assertMatchesRecord(current.attempt, record)
    if (current.attempt.phase === "terminal_cleanup_intent") {
      throw new PendingCommandAttemptBusyError()
    }
    if (ownerToken === undefined || current.attempt.ownerToken !== ownerToken) {
      throw new PendingCommandAttemptBusyError()
    }
  }

  /** 必须只在同 Key短锁内调用。 */
  async assertMutationAllowedLocked(
    record: PendingCommandRecord,
    ownerToken?: string
  ): Promise<void> {
    const current = await this.read(pendingRecordId(record.idempotencyKey))
    if (current.kind === "missing") {
      if (ownerToken !== undefined) throw new PendingCommandAttemptBusyError()
      return
    }
    if (current.kind !== "found") {
      throw new PendingCommandAttemptUnsafeError(current.invalidEntry)
    }
    this.assertMatchesRecord(current.attempt, record)
    if (current.attempt.phase === "terminal_cleanup_intent") {
      throw new PendingCommandAttemptBusyError()
    }
    if (ownerToken === undefined || current.attempt.ownerToken !== ownerToken) {
      throw new PendingCommandAttemptBusyError()
    }
  }

  async scanAgainst(
    records: Array<{ recordId: string; record: PendingCommandRecord }>
  ): Promise<Array<PendingCommandAttemptInvalidEntry>> {
    const invalidEntries: Array<PendingCommandAttemptInvalidEntry> = []
    let names: Array<string>
    try {
      if (!(await this.fileSystem.exists(this.paths.pendingCommandAttempts))) {
        return invalidEntries
      }
      await this.fileSystem.ensureDirectory(this.paths.pendingCommandAttempts)
      names = await readdir(this.paths.pendingCommandAttempts)
    } catch (error) {
      return [{ recordId: null, reason: classifySecureError(error) }]
    }

    for (const name of [...names].sort()) {
      const temporary = ATTEMPT_TEMP_FILE_PATTERN.exec(name)
      if (temporary) {
        const recordId = temporary[1]!
        const path = join(this.paths.pendingCommandAttempts, name)
        try {
          const info = await lstat(path)
          if (info.isSymbolicLink()) {
            invalidEntries.push({ recordId, reason: "symlink" })
          } else if (!info.isFile()) {
            invalidEntries.push({ recordId, reason: "schema" })
          } else {
            await this.fileSystem.readSecureFile(path)
          }
        } catch (error) {
          if (!isMissingPathError(error)) {
            invalidEntries.push({
              recordId,
              reason: classifySecureError(error),
            })
          }
        }
        continue
      }
      const match = ATTEMPT_FILE_PATTERN.exec(name)
      if (!match) {
        invalidEntries.push({ recordId: null, reason: "schema" })
        continue
      }
      const recordId = match[1]!
      const result = await this.read(recordId)
      if (result.kind !== "found") {
        invalidEntries.push(
          result.kind === "unsafe"
            ? result.invalidEntry
            : { recordId, reason: "schema" }
        )
        continue
      }
      const record = records.find((entry) => entry.recordId === recordId)
      if (!record) {
        if (result.attempt.phase !== "terminal_cleanup_intent") {
          invalidEntries.push({ recordId, reason: "schema" })
        }
        continue
      }
      if (
        result.attempt.recordIdentityHash !==
          pendingCommandRecordIdentityHash(record.record) ||
        (result.attempt.phase === "terminal_cleanup_intent" &&
          result.attempt.terminalRecordHash !==
            pendingCommandRecordSnapshotHash(record.record))
      ) {
        invalidEntries.push({ recordId, reason: "schema" })
      }
    }
    return invalidEntries
  }

  private observeAfter(previous: Date): Date {
    if (!validDate(previous)) throw new PendingCommandClockRollbackError()
    const now = this.now()
    if (!validDate(now) || now.getTime() < previous.getTime()) {
      throw new PendingCommandClockRollbackError()
    }
    return now
  }

  private assertMatchesRecord(
    attempt: PendingCommandAttemptRecord,
    record: PendingCommandRecord
  ): void {
    if (
      attempt.recordId !== pendingRecordId(record.idempotencyKey) ||
      attempt.recordIdentityHash !== pendingCommandRecordIdentityHash(record)
    ) {
      throw new PendingCommandAttemptUnsafeError({
        recordId: attempt.recordId,
        reason: "schema",
      })
    }
  }

  /** 只在同 Key 短锁内调用。 */
  private async completeTerminalCleanupLocked(
    idempotencyKey: string,
    attempt: PendingCommandAttemptRecord
  ): Promise<void> {
    if (
      attempt.phase !== "terminal_cleanup_intent" ||
      attempt.terminalRecordHash === null
    ) {
      throw new PendingCommandAttemptUnsafeError({
        recordId: attempt.recordId,
        reason: "schema",
      })
    }
    const pending = await this.options.readPending(idempotencyKey)
    if (pending.kind === "found") {
      if (
        pending.recordId !== attempt.recordId ||
        pendingCommandRecordIdentityHash(pending.record) !==
          attempt.recordIdentityHash ||
        pendingCommandRecordSnapshotHash(pending.record) !==
          attempt.terminalRecordHash
      ) {
        throw new PendingCommandAttemptUnsafeError({
          recordId: attempt.recordId,
          reason: "schema",
        })
      }
      await this.fileSystem.removeSecureFile(
        join(this.paths.pendingCommands, `${attempt.recordId}.json`)
      )
    } else if (pending.kind === "unsafe") {
      throw new PendingCommandAttemptUnsafeError({
        recordId: attempt.recordId,
        reason: "schema",
      })
    }
    await this.fileSystem.removeSecureFile(this.path(attempt.recordId))
  }

  private async requireOwned(
    handle: PendingCommandAttemptHandle,
    record: PendingCommandRecord
  ): Promise<PendingCommandAttemptRecord> {
    const current = await this.read(handle.attempt.recordId)
    if (current.kind !== "found") {
      throw new PendingCommandAttemptUnsafeError(
        current.kind === "unsafe"
          ? current.invalidEntry
          : { recordId: handle.attempt.recordId, reason: "schema" }
      )
    }
    this.assertMatchesRecord(current.attempt, record)
    if (
      current.attempt.ownerToken !== handle.attempt.ownerToken ||
      current.attempt.recordIdentityHash !== handle.attempt.recordIdentityHash
    ) {
      throw new PendingCommandAttemptBusyError()
    }
    return current.attempt
  }

  private async read(recordId: string): Promise<AttemptReadResult> {
    const path = this.path(recordId)
    try {
      const text = await this.fileSystem.readSecureFile(path)
      if (text === null) return { kind: "missing", recordId }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return {
          kind: "unsafe",
          recordId,
          invalidEntry: { recordId, reason: "invalid_json" },
        }
      }
      const attempt = parsePendingCommandAttempt(raw)
      if (attempt === null || attempt.recordId !== recordId) {
        return {
          kind: "unsafe",
          recordId,
          invalidEntry: { recordId, reason: "schema" },
        }
      }
      return { kind: "found", recordId, attempt }
    } catch (error) {
      return {
        kind: "unsafe",
        recordId,
        invalidEntry: { recordId, reason: classifySecureError(error) },
      }
    }
  }
}
