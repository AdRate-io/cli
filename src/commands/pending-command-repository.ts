import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { IDEMPOTENCY_KEY_PATTERN } from "../constants.js"
import {
  SecureFileError,
  SecureFileLockBusyError,
} from "../storage/secure-files.js"
import {
  createPreparedPendingCommand,
  parsePendingCommandJson,
  pendingCredentialScopeMatches,
  pendingIntentsEqual,
  pendingRecordId,
  pendingRecordsHaveSameIdentity,
  serializePendingCommand,
  sha256Hex,
} from "./pending-command-contract.js"
import type { CliPaths } from "../storage/paths.js"
import type { SecureFileSystem } from "../storage/secure-files.js"
import type {
  NewPendingCommandRecord,
  PendingCommandIntent,
  PendingCommandRecord,
  PendingCredentialScope,
} from "./pending-command-contract.js"

const RECORD_FILE_PATTERN = /^([0-9a-f]{64})\.json$/
const ATOMIC_TEMP_FILE_PATTERN =
  /^([0-9a-f]{64})\.json\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type PendingCommandInvalidReason =
  | "permission"
  | "symlink"
  | "invalid_json"
  | "schema"
  | "hash_mismatch"
  | "duplicate_key"

export interface PendingCommandInvalidEntry {
  recordId: string | null
  reason: PendingCommandInvalidReason
}

export interface PendingCommandRecordEntry {
  recordId: string
  record: PendingCommandRecord
}

export interface PendingCommandScanResult {
  records: Array<PendingCommandRecordEntry>
  invalidEntries: Array<PendingCommandInvalidEntry>
}

export type PendingCommandReadResult =
  | { kind: "missing"; recordId: string }
  | { kind: "found"; recordId: string; record: PendingCommandRecord }
  | {
      kind: "unsafe"
      recordId: string
      invalidEntry: PendingCommandInvalidEntry
    }

export type PendingCommandPrepareResult =
  | { kind: "created"; recordId: string; record: PendingCommandRecord }
  | {
      kind: "existing_same_intent"
      recordId: string
      record: PendingCommandRecord
    }
  | {
      kind: "prior_credential"
      recordId: string
      record: PendingCommandRecord
    }
  | {
      kind: "resource_intent_conflict"
      recordId: string
      record: PendingCommandRecord
    }
  | {
      kind: "idempotency_conflict"
      recordId: string
      record: PendingCommandRecord
    }
  | {
      kind: "credential_mismatch"
      recordId: string
      record: PendingCommandRecord
    }
  | { kind: "unsafe"; scan: PendingCommandScanResult }

export class PendingCommandChangedError extends SecureFileError {
  constructor() {
    super("The pending Command record changed during a local transaction.")
    this.name = "PendingCommandChangedError"
  }
}

export interface PendingCommandRepositoryOptions {
  now?: () => Date
}

function classifySecureFileError(error: unknown): PendingCommandInvalidReason {
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

function recordsExactlyEqual(
  left: PendingCommandRecord,
  right: PendingCommandRecord
): boolean {
  return serializePendingCommand(left) === serializePendingCommand(right)
}

function validateIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new SecureFileError("The local idempotency key is invalid.")
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

function isTransientMissingLock(error: unknown): boolean {
  return isMissingPathError(error)
}

export class PendingCommandRepository {
  constructor(
    private readonly fileSystem: SecureFileSystem,
    private readonly paths: CliPaths,
    private readonly options: PendingCommandRepositoryOptions = {}
  ) {}

  recordPath(idempotencyKey: string): string {
    validateIdempotencyKey(idempotencyKey)
    return join(
      this.paths.pendingCommands,
      `${pendingRecordId(idempotencyKey)}.json`
    )
  }

  keyLockPath(idempotencyKey: string): string {
    validateIdempotencyKey(idempotencyKey)
    return join(
      this.paths.root,
      `.pending-command-key-${pendingRecordId(idempotencyKey)}.lock`
    )
  }

  resourceLockPath(input: {
    issuerOrigin: string
    teamId: number
    intent: Pick<PendingCommandIntent, "advId" | "campaignId">
  }): string {
    const digest = sha256Hex(
      JSON.stringify({
        issuerOrigin: input.issuerOrigin,
        teamId: input.teamId,
        advId: input.intent.advId,
        campaignId: input.intent.campaignId,
      })
    )
    return join(this.paths.root, `.pending-command-resource-${digest}.lock`)
  }

  async scan(): Promise<PendingCommandScanResult> {
    const records: Array<PendingCommandRecordEntry> = []
    const parsedCandidates: Array<
      PendingCommandRecordEntry & { hashMatches: boolean }
    > = []
    const invalidEntries: Array<PendingCommandInvalidEntry> = []
    let names: Array<string>
    try {
      if (!(await this.fileSystem.exists(this.paths.pendingCommands))) {
        names = []
      } else {
        await this.fileSystem.ensureDirectory(this.paths.pendingCommands)
        names = await readdir(this.paths.pendingCommands)
      }
    } catch (error) {
      return {
        records,
        invalidEntries: [
          { recordId: null, reason: classifySecureFileError(error) },
        ],
      }
    }

    for (const name of [...names].sort()) {
      const temporaryMatch = ATOMIC_TEMP_FILE_PATTERN.exec(name)
      if (temporaryMatch) {
        const recordId = temporaryMatch[1]!
        const path = this.fileSystem.assertContained(
          join(this.paths.pendingCommands, name)
        )
        try {
          const info = await lstat(path)
          if (info.isSymbolicLink()) {
            invalidEntries.push({ recordId, reason: "symlink" })
            continue
          }
          if (!info.isFile()) {
            invalidEntries.push({ recordId, reason: "schema" })
            continue
          }
          await this.fileSystem.readSecureFile(path)
        } catch (error) {
          if (isMissingPathError(error)) continue
          invalidEntries.push({
            recordId,
            reason: classifySecureFileError(error),
          })
        }
        continue
      }
      const match = RECORD_FILE_PATTERN.exec(name)
      if (!match) {
        invalidEntries.push({
          recordId: null,
          reason: "schema",
        })
        continue
      }
      const recordId = match[1]!
      const path = this.fileSystem.assertContained(
        join(this.paths.pendingCommands, name)
      )
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink()) {
          invalidEntries.push({ recordId, reason: "symlink" })
          continue
        }
        if (!info.isFile()) {
          invalidEntries.push({ recordId, reason: "schema" })
          continue
        }
        const text = await this.fileSystem.readSecureFile(path)
        if (text === null) {
          invalidEntries.push({ recordId, reason: "schema" })
          continue
        }
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          invalidEntries.push({ recordId, reason: "invalid_json" })
          continue
        }
        const record = parsePendingCommandJson(JSON.stringify(raw))
        if (!record) {
          invalidEntries.push({ recordId, reason: "schema" })
          continue
        }
        parsedCandidates.push({
          recordId,
          record,
          hashMatches: pendingRecordId(record.idempotencyKey) === recordId,
        })
      } catch (error) {
        invalidEntries.push({
          recordId,
          reason: classifySecureFileError(error),
        })
      }
    }

    const keyCounts = new Map<string, number>()
    for (const candidate of parsedCandidates) {
      keyCounts.set(
        candidate.record.idempotencyKey,
        (keyCounts.get(candidate.record.idempotencyKey) ?? 0) + 1
      )
    }
    for (const candidate of parsedCandidates) {
      if ((keyCounts.get(candidate.record.idempotencyKey) ?? 0) > 1) {
        invalidEntries.push({
          recordId: candidate.recordId,
          reason: "duplicate_key",
        })
      } else if (!candidate.hashMatches) {
        invalidEntries.push({
          recordId: candidate.recordId,
          reason: "hash_mismatch",
        })
      } else {
        records.push({
          recordId: candidate.recordId,
          record: candidate.record,
        })
      }
    }
    return {
      records,
      invalidEntries: invalidEntries.sort((left, right) =>
        (left.recordId ?? "").localeCompare(right.recordId ?? "")
      ),
    }
  }

  async read(idempotencyKey: string): Promise<PendingCommandReadResult> {
    const recordId = pendingRecordId(idempotencyKey)
    const path = this.recordPath(idempotencyKey)
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
      const record = parsePendingCommandJson(JSON.stringify(raw))
      if (!record) {
        return {
          kind: "unsafe",
          recordId,
          invalidEntry: { recordId, reason: "schema" },
        }
      }
      if (pendingRecordId(record.idempotencyKey) !== recordId) {
        return {
          kind: "unsafe",
          recordId,
          invalidEntry: { recordId, reason: "hash_mismatch" },
        }
      }
      return { kind: "found", recordId, record }
    } catch (error) {
      return {
        kind: "unsafe",
        recordId,
        invalidEntry: { recordId, reason: classifySecureFileError(error) },
      }
    }
  }

  async prepare(
    input: NewPendingCommandRecord
  ): Promise<PendingCommandPrepareResult> {
    const candidate = createPreparedPendingCommand(input)
    const lockPath = this.resourceLockPath(candidate)
    return this.withContendedLock(lockPath, async () => {
      const scan = await this.scan()
      if (scan.invalidEntries.length > 0) return { kind: "unsafe", scan }
      const scope: PendingCredentialScope = candidate
      const byKey = scan.records.find(
        (entry) => entry.record.idempotencyKey === candidate.idempotencyKey
      )
      if (byKey) {
        return this.classifyExisting(byKey, scope, candidate.intent, true)
      }

      const sameResource = scan.records.find(
        ({ record }) =>
          record.issuerOrigin === candidate.issuerOrigin &&
          record.teamId === candidate.teamId &&
          record.intent.advId === candidate.intent.advId &&
          record.intent.campaignId === candidate.intent.campaignId
      )
      if (sameResource) {
        return this.classifyExisting(
          sameResource,
          scope,
          candidate.intent,
          false
        )
      }

      const result = await this.fileSystem.atomicCreate(
        this.recordPath(candidate.idempotencyKey),
        serializePendingCommand(candidate)
      )
      if (result === "created") {
        return {
          kind: "created" as const,
          recordId: pendingRecordId(candidate.idempotencyKey),
          record: candidate,
        }
      }
      const raced = await this.read(candidate.idempotencyKey)
      if (raced.kind !== "found") {
        return {
          kind: "unsafe" as const,
          scan: {
            records: scan.records,
            invalidEntries: [
              raced.kind === "unsafe"
                ? raced.invalidEntry
                : {
                    recordId: pendingRecordId(candidate.idempotencyKey),
                    reason: "schema" as const,
                  },
            ],
          },
        }
      }
      return this.classifyExisting(raced, scope, candidate.intent, true)
    })
  }

  async replaceExact(
    expected: PendingCommandRecord,
    next: PendingCommandRecord
  ): Promise<void> {
    if (
      !pendingRecordsHaveSameIdentity(expected, next) ||
      !parsePendingCommandJson(serializePendingCommand(next))
    ) {
      throw new PendingCommandChangedError()
    }
    await this.withContendedLock(
      this.keyLockPath(expected.idempotencyKey),
      async () => {
        const current = await this.read(expected.idempotencyKey)
        if (
          current.kind !== "found" ||
          !recordsExactlyEqual(current.record, expected)
        ) {
          throw new PendingCommandChangedError()
        }
        await this.fileSystem.atomicWrite(
          this.recordPath(expected.idempotencyKey),
          serializePendingCommand(next)
        )
      }
    )
  }

  async removeExact(expected: PendingCommandRecord): Promise<boolean> {
    return this.withContendedLock(
      this.keyLockPath(expected.idempotencyKey),
      async () => {
        const current = await this.read(expected.idempotencyKey)
        if (current.kind === "missing") return false
        if (
          current.kind !== "found" ||
          !recordsExactlyEqual(current.record, expected)
        ) {
          throw new PendingCommandChangedError()
        }
        return this.fileSystem.removeSecureFile(
          this.recordPath(expected.idempotencyKey)
        )
      }
    )
  }

  private classifyExisting(
    entry: PendingCommandRecordEntry,
    scope: PendingCredentialScope,
    intent: PendingCommandIntent,
    sameKey: boolean
  ): Exclude<PendingCommandPrepareResult, { kind: "created" | "unsafe" }> {
    if (!pendingCredentialScopeMatches(entry.record, scope)) {
      return {
        kind: sameKey
          ? "credential_mismatch"
          : entry.record.issuerOrigin === scope.issuerOrigin &&
              entry.record.teamId === scope.teamId
            ? "prior_credential"
            : "credential_mismatch",
        ...entry,
      }
    }
    if (pendingIntentsEqual(entry.record.intent, intent)) {
      return { kind: "existing_same_intent", ...entry }
    }
    return {
      kind: sameKey ? "idempotency_conflict" : "resource_intent_conflict",
      ...entry,
    }
  }

  private async withContendedLock<T>(
    lockPath: string,
    action: () => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        return await this.fileSystem.withLock(lockPath, action)
      } catch (error) {
        if (
          (!(error instanceof SecureFileLockBusyError) &&
            !isTransientMissingLock(error)) ||
          attempt === 49
        ) {
          throw error
        }
        await delay(10)
      }
    }
    throw new SecureFileLockBusyError()
  }
}
