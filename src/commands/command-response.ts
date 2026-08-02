import { EXIT_CODE } from "../constants.js"
import {
  decodePublicCommandData,
  decodePublicCommandDto,
} from "../contracts/command.js"
import { exitCodeForEnvelope } from "../output.js"
import type { PublicCommandDto } from "../contracts/command.js"
import type {
  PublicEnvelope,
  PublicErrorEnvelope,
} from "../contracts/envelope.js"
import type { PendingCommandIntent } from "./pending-command-contract.js"
import type { CliExitCode } from "../constants.js"

export interface ExpectedCommandIdentity {
  commandId?: string
  idempotencyKey?: string
  intent?: PendingCommandIntent
}

export type CommandResponseEvidence =
  | {
      kind: "command"
      source: "success" | "error"
      command: PublicCommandDto
    }
  | { kind: "not_created" }
  | { kind: "error_without_command" }
  | {
      kind: "invalid"
      reason:
        | "command_schema"
        | "command_identity"
        | "command_error_incompatible"
        | "command_creation_evidence"
        | "unexpected_get_evidence"
    }

export type PendingCommandDecision =
  | {
      action: "remove"
      exitCode: CliExitCode
      command: PublicCommandDto | null
      contractViolation: "unexpected_status_for_command" | null
    }
  | {
      action: "retain_command"
      exitCode: CliExitCode
      command: PublicCommandDto
      contractViolation: "unexpected_status_for_command" | null
    }
  | {
      action: "retain"
      exitCode: CliExitCode
      command: null
      contractViolation: null
    }
  | {
      action: "retain_unknown"
      exitCode: CliExitCode
      command: null
      contractViolation: "invalid_command_response" | null
    }

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function commandMatchesExpected(
  command: PublicCommandDto,
  expected: ExpectedCommandIdentity
): boolean {
  if (
    expected.commandId !== undefined &&
    command.commandId !== expected.commandId
  ) {
    return false
  }
  if (
    expected.idempotencyKey !== undefined &&
    command.idempotencyKey !== expected.idempotencyKey
  ) {
    return false
  }
  const intent = expected.intent
  return (
    intent === undefined ||
    (command.target.advertiserId === intent.advId &&
      command.target.campaignId === intent.campaignId &&
      command.target.desiredStatus === intent.desiredStatus)
  )
}

function decodeExpectedCommand(
  value: unknown,
  expected: ExpectedCommandIdentity
): CommandResponseEvidence {
  const command = decodePublicCommandDto(value)
  if (!command) return { kind: "invalid", reason: "command_schema" }
  if (!commandMatchesExpected(command, expected)) {
    return { kind: "invalid", reason: "command_identity" }
  }
  return { kind: "command", source: "success", command }
}

function errorCommandIsCompatible(
  envelope: PublicErrorEnvelope,
  command: PublicCommandDto
): boolean {
  return envelope.error.retryable
    ? command.status === "pending" && !command.isFinal
    : command.status === "failed" && command.isFinal
}

/** 严格解码 Status POST 的 Command 创建证据，不按 HTTP/error code 猜测。 */
export function decodeStatusCommandResponse(
  envelope: PublicEnvelope,
  expected: ExpectedCommandIdentity
): CommandResponseEvidence {
  if (envelope.ok) {
    const data = decodePublicCommandData(envelope.data)
    if (!data) return { kind: "invalid", reason: "command_schema" }
    if (!commandMatchesExpected(data.command, expected)) {
      return { kind: "invalid", reason: "command_identity" }
    }
    return { kind: "command", source: "success", command: data.command }
  }

  const details = envelope.error.details
  const hasCreated = hasOwn(details, "commandCreated")
  const hasCommand = hasOwn(details, "command")
  if (details.commandCreated === false && hasCreated && !hasCommand) {
    return { kind: "not_created" }
  }
  if (details.commandCreated !== true || !hasCreated || !hasCommand) {
    return { kind: "invalid", reason: "command_creation_evidence" }
  }
  const decoded = decodeExpectedCommand(details.command, expected)
  if (decoded.kind !== "command") return decoded
  if (!errorCommandIsCompatible(envelope, decoded.command)) {
    return { kind: "invalid", reason: "command_error_incompatible" }
  }
  return { ...decoded, source: "error" }
}

/** Command GET 成功必须是精确 `{ command }`，错误不允许夹带 Status 证据。 */
export function decodeCommandGetResponse(
  envelope: PublicEnvelope,
  expected: ExpectedCommandIdentity
): CommandResponseEvidence {
  if (!envelope.ok) {
    const details = envelope.error.details
    if (hasOwn(details, "command") || hasOwn(details, "commandCreated")) {
      return { kind: "invalid", reason: "unexpected_get_evidence" }
    }
    return { kind: "error_without_command" }
  }
  const data = decodePublicCommandData(envelope.data)
  if (!data) return { kind: "invalid", reason: "command_schema" }
  if (!commandMatchesExpected(data.command, expected)) {
    return { kind: "invalid", reason: "command_identity" }
  }
  return { kind: "command", source: "success", command: data.command }
}

function statusContractViolation(
  httpStatus: number,
  command: PublicCommandDto
): "unexpected_status_for_command" | null {
  const expectedStatus = command.isFinal ? 200 : 202
  return httpStatus === expectedStatus ? null : "unexpected_status_for_command"
}

function hasUnknownOperationCharge(envelope: PublicEnvelope): boolean {
  return !envelope.ok && envelope.meta.usage?.operationUnitsCharged === null
}

/**
 * Status 本地证据的唯一清理决策。无可信 Command 且缺少
 * `commandCreated=false` 时始终保留；日单位预留结果未知时退出 4。
 */
export function decideStatusPendingCommand(
  envelope: PublicEnvelope,
  httpStatus: number,
  expected: ExpectedCommandIdentity
): PendingCommandDecision {
  const evidence = decodeStatusCommandResponse(envelope, expected)
  if (hasUnknownOperationCharge(envelope)) {
    if (evidence.kind === "command" && !evidence.command.isFinal) {
      return {
        action: "retain_command",
        exitCode: EXIT_CODE.retryable,
        command: evidence.command,
        contractViolation: null,
      }
    }
    return {
      action: "retain_unknown",
      exitCode: EXIT_CODE.retryable,
      command: null,
      contractViolation:
        evidence.kind === "invalid" ||
        (evidence.kind === "command" && evidence.command.isFinal) ||
        evidence.kind === "not_created"
          ? "invalid_command_response"
          : null,
    }
  }
  if (evidence.kind === "command") {
    const contractViolation =
      evidence.source === "success"
        ? statusContractViolation(httpStatus, evidence.command)
        : null
    if (evidence.command.isFinal) {
      return {
        action: "remove",
        exitCode: exitCodeForEnvelope(envelope),
        command: evidence.command,
        contractViolation,
      }
    }
    return {
      action: "retain_command",
      exitCode: envelope.ok ? EXIT_CODE.success : EXIT_CODE.retryable,
      command: evidence.command,
      contractViolation,
    }
  }
  if (evidence.kind === "not_created") {
    return {
      action: "remove",
      exitCode: exitCodeForEnvelope(envelope),
      command: null,
      contractViolation: null,
    }
  }
  return {
    action: "retain_unknown",
    exitCode: EXIT_CODE.outcomeUnknown,
    command: null,
    contractViolation: "invalid_command_response",
  }
}

/** Command GET 永不转成 POST 决策；错误保留，终态成功才清理。 */
export function decideCommandGetPendingCommand(
  envelope: PublicEnvelope,
  expected: ExpectedCommandIdentity
): PendingCommandDecision {
  const evidence = decodeCommandGetResponse(envelope, expected)
  if (evidence.kind === "command") {
    return evidence.command.isFinal
      ? {
          action: "remove",
          exitCode: EXIT_CODE.success,
          command: evidence.command,
          contractViolation: null,
        }
      : {
          action: "retain_command",
          exitCode: EXIT_CODE.success,
          command: evidence.command,
          contractViolation: null,
        }
  }
  if (evidence.kind === "error_without_command") {
    return {
      action: "retain",
      exitCode: exitCodeForEnvelope(envelope),
      command: null,
      contractViolation: null,
    }
  }
  return {
    action: "retain_unknown",
    exitCode: EXIT_CODE.outcomeUnknown,
    command: null,
    contractViolation: "invalid_command_response",
  }
}
