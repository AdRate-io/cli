import { EXIT_CODE } from "../constants.js"
import {
  decodePublicCommandData,
  decodePublicCommandDto,
} from "../contracts/command.js"
import { exitCodeForEnvelope } from "../output.js"
import { getCliCommandFamily } from "./command-families.js"
import type { PublicCommandDto } from "../contracts/command.js"
import type {
  PublicEnvelope,
  PublicErrorEnvelope,
} from "../contracts/envelope.js"
import type { PendingCommandIntent } from "./command-families.js"
import type { CliExitCode } from "../constants.js"

export interface ExpectedCommandIdentity {
  commandId?: string
  idempotencyKey?: string
  capabilityId?: string
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
  if (
    expected.capabilityId !== undefined &&
    command.capabilityId !== expected.capabilityId
  ) {
    return false
  }
  const intent = expected.intent
  if (intent === undefined) return true
  const target = command.target
  if (
    target.advertiserId !== intent.advId ||
    target.campaignId !== intent.campaignId
  ) {
    return false
  }
  const family = getCliCommandFamily(intent.capabilityId)
  if (!family) return false
  return family.matchesIntentTarget(intent.familyPayload, target)
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
  if (command.status === "succeeded") return false
  return envelope.error.retryable
    ? !command.isFinal
    : command.isFinal &&
        (command.status === "failed" || command.status === "unknown")
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

/** Command GET 成功必须包含可解码 command，错误不允许夹带 Status 证据。 */
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

export function hasPositiveCommandSuccess(
  command: PublicCommandDto
): boolean {
  if (command.status !== "succeeded" || !command.isFinal) return false
  const family = getCliCommandFamily(command.capabilityId)
  if (!family) return false
  return family.isNoOp(command) || family.isTargetReached(command)
}

export function exitCodeForCommand(command: PublicCommandDto): CliExitCode {
  if (hasPositiveCommandSuccess(command)) return EXIT_CODE.success
  if (command.status === "failed" && command.isFinal) {
    return EXIT_CODE.business
  }
  if (
    !command.isFinal &&
    (command.status === "pending" || command.status === "executing")
  ) {
    return EXIT_CODE.retryable
  }
  return EXIT_CODE.outcomeUnknown
}

/**
 * Status 本地证据的唯一清理决策。额度可见性只产生提示，
 * 不覆盖可信 Command 终态或成功证据。
 */
export function decideStatusPendingCommand(
  envelope: PublicEnvelope,
  httpStatus: number,
  expected: ExpectedCommandIdentity
): PendingCommandDecision {
  const evidence = decodeStatusCommandResponse(envelope, expected)
  if (evidence.kind === "command") {
    const contractViolation =
      evidence.source === "success"
        ? statusContractViolation(httpStatus, evidence.command)
        : null
    if (hasPositiveCommandSuccess(evidence.command)) {
      return {
        action: "remove",
        exitCode: EXIT_CODE.success,
        command: evidence.command,
        contractViolation,
      }
    }
    if (
      evidence.command.isFinal &&
      (evidence.command.status === "failed" ||
        evidence.command.status === "unknown")
    ) {
      return {
        action: "remove",
        exitCode: exitCodeForCommand(evidence.command),
        command: evidence.command,
        contractViolation,
      }
    }
    if (
      !evidence.command.isFinal &&
      (evidence.command.status === "pending" ||
        evidence.command.status === "executing" ||
        evidence.command.status === "unknown")
    ) {
      return {
        action: "retain_command",
        exitCode: exitCodeForCommand(evidence.command),
        command: evidence.command,
        contractViolation,
      }
    }
    return {
      action: "retain_unknown",
      exitCode: EXIT_CODE.outcomeUnknown,
      command: null,
      contractViolation: "invalid_command_response",
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

/** Command GET 永不转成 POST 决策；只有已知终态清理本地 pending。 */
export function decideCommandGetPendingCommand(
  envelope: PublicEnvelope,
  expected: ExpectedCommandIdentity
): PendingCommandDecision {
  const evidence = decodeCommandGetResponse(envelope, expected)
  if (evidence.kind === "command") {
    if (hasPositiveCommandSuccess(evidence.command)) {
      return {
        action: "remove",
        exitCode: EXIT_CODE.success,
        command: evidence.command,
        contractViolation: null,
      }
    }
    if (
      evidence.command.isFinal &&
      (evidence.command.status === "failed" ||
        evidence.command.status === "unknown")
    ) {
      return {
        action: "remove",
        exitCode: exitCodeForCommand(evidence.command),
        command: evidence.command,
        contractViolation: null,
      }
    }
    if (
      !evidence.command.isFinal &&
      (evidence.command.status === "pending" ||
        evidence.command.status === "executing" ||
        evidence.command.status === "unknown")
    ) {
      return {
        action: "retain_command",
        exitCode: exitCodeForCommand(evidence.command),
        command: evidence.command,
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
