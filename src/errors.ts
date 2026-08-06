import { randomUUID } from "node:crypto"
import { EXIT_CODE } from "./constants.js"
import { createLocalError } from "./contracts/envelope.js"
import type {
  CliEnvelope,
  GeneratedPublicErrorCode,
  PublicEnvelope,
} from "./contracts/envelope.js"
import type { CliExitCode } from "./constants.js"
import type { JsonObject } from "./contracts/json.js"

export interface CliHumanOutput {
  stream: "stdout" | "stderr"
  mode: "line" | "raw"
  value: string
}

export interface CliOutcome<TEnvelope extends CliEnvelope = PublicEnvelope> {
  exitCode: CliExitCode
  envelope: TEnvelope
  warnings: Array<string>
  retryAfterSeconds?: number
  humanLines?: Array<string>
  humanOutput?: CliHumanOutput
}

export class CliFailure<
  TEnvelope extends CliEnvelope = PublicEnvelope,
> extends Error {
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    readonly exitCode: CliExitCode,
    readonly envelope: TEnvelope,
    readonly warnings: Array<string> = []
  ) {
    super(message)
    this.name = "CliFailure"
    if (envelope.meta.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = envelope.meta.retryAfterSeconds
    }
  }
}

export function retryAfterWarning(seconds: number): string {
  return `Retry after ${seconds} second(s) before repeating this request.`
}

export function localRequestId(): string {
  return `local_${randomUUID().replaceAll("-", "")}`
}

export function usageFailure(
  message: string,
  details: JsonObject = {}
): CliFailure {
  return new CliFailure(
    message,
    EXIT_CODE.usage,
    createLocalError(
      localRequestId(),
      "INVALID_REQUEST",
      message,
      false,
      details
    )
  )
}

export function authenticationFailure(
  message: string,
  code: Extract<
    GeneratedPublicErrorCode,
    "INVALID_CREDENTIAL" | "CREDENTIAL_EXPIRED" | "USER_DISABLED"
  > = "INVALID_CREDENTIAL",
  details: JsonObject = {}
): CliFailure {
  return new CliFailure(
    message,
    EXIT_CODE.authentication,
    createLocalError(localRequestId(), code, message, false, details)
  )
}

export function dependencyFailure(
  message: string,
  exitCode: CliExitCode = EXIT_CODE.retryable,
  details: JsonObject = {}
): CliFailure {
  const retryAfterSeconds = details.retryAfterSeconds
  const hasRetryAfter =
    typeof retryAfterSeconds === "number" &&
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 1 &&
    retryAfterSeconds <= 86_400
  const envelope = createLocalError(
    localRequestId(),
    "DEPENDENCY_UNAVAILABLE",
    message,
    exitCode === EXIT_CODE.retryable,
    details
  )
  return new CliFailure(
    message,
    exitCode,
    hasRetryAfter
      ? {
          ...envelope,
          meta: { ...envelope.meta, retryAfterSeconds },
        }
      : envelope,
    hasRetryAfter ? [retryAfterWarning(retryAfterSeconds)] : []
  )
}

export function outcomeUnknownFailure(
  message: string,
  details: JsonObject = {}
): CliFailure {
  return dependencyFailure(message, EXIT_CODE.outcomeUnknown, details)
}

export function prependFailureWarning(
  error: unknown,
  warning: string | null
): unknown {
  if (!(error instanceof CliFailure) || warning === null) return error
  return new CliFailure(error.message, error.exitCode, error.envelope, [
    warning,
    ...error.warnings,
  ])
}
