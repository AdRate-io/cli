import {
  pendingRecordsHaveSameIdentity,
  serializePendingCommand,
} from "./pending-command-contract.js"
import { PendingCommandChangedError } from "./pending-command-repository.js"
import type {
  PendingCommandLastResponse,
  PendingCommandRecord,
} from "./pending-command-contract.js"
import type { PendingCommandRepository } from "./pending-command-repository.js"

const MAX_SETTLEMENT_ATTEMPTS = 8

export type PendingCommandSettlement =
  | {
      kind: "final"
      commandId: string
    }
  | {
      kind: "not_created"
    }
  | {
      kind: "command_known"
      commandId: string
      updatedAt: string
      lastResponse: PendingCommandLastResponse
    }
  | {
      kind: "response_unknown"
      updatedAt: string
      lastResponse: PendingCommandLastResponse | null
    }

export type PendingCommandSettlementResult =
  | "applied"
  | "already_converged"
  | "terminal_missing"
  | "stronger_evidence_preserved"

export class PendingCommandSettlementConflictError extends Error {
  constructor() {
    super("Pending Command evidence could not be converged safely.")
    this.name = "PendingCommandSettlementConflictError"
  }
}

function recordsExactlyEqual(
  left: PendingCommandRecord,
  right: PendingCommandRecord
): boolean {
  return serializePendingCommand(left) === serializePendingCommand(right)
}

function assertCompatibleIdentity(
  expected: PendingCommandRecord,
  current: PendingCommandRecord
): void {
  if (!pendingRecordsHaveSameIdentity(expected, current)) {
    throw new PendingCommandSettlementConflictError()
  }
}

function monotonicUpdatedAt(
  current: PendingCommandRecord,
  next: string
): string {
  return new Date(
    Math.max(Date.parse(current.updatedAt), Date.parse(next))
  ).toISOString()
}

function isBlocked(record: PendingCommandRecord): boolean {
  return (
    record.localState === "expired_unsubmitted" ||
    record.localState === "orphaned_credential"
  )
}

/**
 * 把一次已完成的远端事实收敛到 pending journal。
 *
 * 每次 mutation 都委托给 repository 的短 key lock + exact CAS；本函数
 * 只在 CAS loser 时重读并做有界重试，绝不覆盖不同 identity、重建已删
 * 记录或把 command_known 降级为 response_unknown。
 */
export async function settlePendingCommand(
  repository: PendingCommandRepository,
  expected: PendingCommandRecord,
  settlement: PendingCommandSettlement,
  options: { attemptOwnerToken?: string } = {}
): Promise<PendingCommandSettlementResult> {
  const removeTerminalExact = (record: PendingCommandRecord) =>
    options.attemptOwnerToken === undefined
      ? repository.removeExact(record, options)
      : repository.removeTerminalExact(record, options.attemptOwnerToken)

  // `commandCreated=false` 只证明当前请求没有创建 Command。若兄弟请求已
  // 推进同 Key 证据，不能用该弱事实删除它，因此这里保留 exact-only 语义。
  if (settlement.kind === "not_created") {
    // Resume 的 GET 可能已先证明 commandId。随后 POST 即使回传
    // commandCreated=false，也不能把已知 Command 当成未创建而删除。
    if (expected.commandId !== null) {
      throw new PendingCommandSettlementConflictError()
    }
    try {
      return (await removeTerminalExact(expected))
        ? "applied"
        : "terminal_missing"
    } catch (error) {
      if (!(error instanceof PendingCommandChangedError)) throw error
      const current = await repository.read(expected.idempotencyKey)
      if (current.kind === "missing") return "terminal_missing"
      if (current.kind !== "found") {
        throw new PendingCommandSettlementConflictError()
      }
      assertCompatibleIdentity(expected, current.record)
      return "stronger_evidence_preserved"
    }
  }

  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const current = await repository.read(expected.idempotencyKey)
    if (current.kind === "missing") return "terminal_missing"
    if (current.kind !== "found") {
      throw new PendingCommandSettlementConflictError()
    }
    assertCompatibleIdentity(expected, current.record)

    if (settlement.kind === "final") {
      const exactSnapshot = recordsExactlyEqual(expected, current.record)
      const sameKnownCommand =
        current.record.localState === "command_known" &&
        current.record.commandId === settlement.commandId
      if (!exactSnapshot && !sameKnownCommand) {
        throw new PendingCommandSettlementConflictError()
      }
      try {
        return (await removeTerminalExact(current.record))
          ? "applied"
          : "terminal_missing"
      } catch (error) {
        if (error instanceof PendingCommandChangedError) continue
        throw error
      }
    }

    if (isBlocked(current.record)) {
      throw new PendingCommandSettlementConflictError()
    }

    if (settlement.kind === "command_known") {
      if (current.record.localState === "command_known") {
        if (current.record.commandId !== settlement.commandId) {
          throw new PendingCommandSettlementConflictError()
        }
        return "already_converged"
      }
      const next: PendingCommandRecord = {
        ...current.record,
        localState: "command_known",
        commandId: settlement.commandId,
        updatedAt: monotonicUpdatedAt(current.record, settlement.updatedAt),
        lastResponse: settlement.lastResponse,
      }
      try {
        await repository.replaceExact(current.record, next, options)
        return "applied"
      } catch (error) {
        if (error instanceof PendingCommandChangedError) continue
        throw error
      }
    }

    if (current.record.localState === "command_known") {
      return "stronger_evidence_preserved"
    }
    if (current.record.localState === "response_unknown") {
      return "already_converged"
    }
    const next: PendingCommandRecord = {
      ...current.record,
      localState: "response_unknown",
      updatedAt: monotonicUpdatedAt(current.record, settlement.updatedAt),
      lastResponse: settlement.lastResponse,
    }
    try {
      await repository.replaceExact(current.record, next, options)
      return "applied"
    } catch (error) {
      if (error instanceof PendingCommandChangedError) continue
      throw error
    }
  }

  throw new PendingCommandSettlementConflictError()
}
