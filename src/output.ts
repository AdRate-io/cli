import {
  EXIT_CODE,
  PRODUCTION_BROWSER_ORIGIN,
  TEST_BROWSER_ORIGIN,
} from "./constants.js"
import {
  hasKeys,
  isCanonicalUtcIso,
  isPlainObject,
  isSafeIntegerInRange,
} from "./contracts/json.js"
import { retryAfterWarning } from "./errors.js"
import type { CliOutcome } from "./errors.js"
import type { CliEnvelope, CliErrorEnvelope } from "./contracts/envelope.js"

const AUTHENTICATION_CODES = new Set([
  "INVALID_CREDENTIAL",
  "CREDENTIAL_EXPIRED",
  "USER_DISABLED",
  "OWNER_REQUIRED",
])
const USAGE_CODES = new Set([
  "INVALID_REQUEST",
  "TIKTOK_AUTH_ID_REQUIRED",
  "TIKTOK_AUTH_INVALID_FOR_ACCOUNT",
])
const BROWSER_ORIGINS = new Set([
  PRODUCTION_BROWSER_ORIGIN,
  TEST_BROWSER_ORIGIN,
])

interface HumanAuthorizationCandidate {
  authId: number
  displayName: string | null
  status: "active"
  lastSyncedAt: string
}

interface HumanValidationError {
  path: string
  code: string
  message: string
}

const HUMAN_VALIDATION_ERROR_LIMIT = 50

export function exitCodeForEnvelope(envelope: CliEnvelope): 0 | 1 | 2 | 3 | 4 {
  if (envelope.ok) return EXIT_CODE.success
  if (USAGE_CODES.has(envelope.error.code)) return EXIT_CODE.usage
  if (AUTHENTICATION_CODES.has(envelope.error.code)) {
    return EXIT_CODE.authentication
  }
  if (envelope.error.retryable) return EXIT_CODE.retryable
  return EXIT_CODE.business
}

function credentialNoticeWarning(envelope: CliEnvelope): string | null {
  const notice = envelope.meta._notice?.credential
  if (
    !notice ||
    typeof notice !== "object" ||
    Array.isArray(notice) ||
    typeof notice.message !== "string"
  ) {
    return null
  }
  return notice.message
}

export function warningsForEnvelope(
  envelope: CliEnvelope,
  environment: NodeJS.ProcessEnv = process.env
): Array<string> {
  const warnings: Array<string> = []
  if (envelope.meta.retryAfterSeconds !== undefined) {
    warnings.push(retryAfterWarning(envelope.meta.retryAfterSeconds))
  }
  if (envelope.meta.usage?.operationUnitsCharged === null) {
    warnings.push(
      "TikTok operation-unit charging is unknown; units may already have been charged and a retry may charge again."
    )
  }
  if (environment.ADRATE_NO_CREDENTIAL_NOTIFIER !== "1") {
    const credential = credentialNoticeWarning(envelope)
    if (credential) warnings.push(credential)
  }
  return warnings
}

export function outcomeFromEnvelope<TEnvelope extends CliEnvelope>(
  envelope: TEnvelope,
  environment: NodeJS.ProcessEnv = process.env
): CliOutcome<TEnvelope> {
  return {
    exitCode: exitCodeForEnvelope(envelope),
    envelope,
    warnings: warningsForEnvelope(envelope, environment),
    ...(envelope.meta.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: envelope.meta.retryAfterSeconds }),
  }
}

export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "write">
  stderr: Pick<NodeJS.WriteStream, "write">
}

function line(stream: Pick<NodeJS.WriteStream, "write">, value: string): void {
  stream.write(value.endsWith("\n") ? value : `${value}\n`)
}

function terminatedLine(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`
}

function hasAsciiControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code <= 0x1f || code === 0x7f)
  })
}

function safeAuthorizationCandidates(
  value: unknown
): Array<HumanAuthorizationCandidate> | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const candidates: Array<HumanAuthorizationCandidate> = []
  for (const item of value) {
    if (
      !isPlainObject(item) ||
      !hasKeys(item, ["authId", "displayName", "status", "lastSyncedAt"]) ||
      !isSafeIntegerInRange(item.authId, 1) ||
      !(
        item.displayName === null ||
        (typeof item.displayName === "string" &&
          item.displayName.length <= 256 &&
          !hasAsciiControlCharacters(item.displayName))
      ) ||
      item.status !== "active" ||
      !isCanonicalUtcIso(item.lastSyncedAt)
    ) {
      continue
    }
    candidates.push({
      authId: item.authId,
      displayName: item.displayName,
      status: "active",
      lastSyncedAt: item.lastSyncedAt,
    })
  }
  return candidates.length > 0 || value.length === 0 ? candidates : null
}

function safeResolutionUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null
  try {
    const parsed = new URL(value)
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      !BROWSER_ORIGINS.has(parsed.origin)
    ) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function safeValidationErrors(value: unknown): {
  errors: Array<HumanValidationError>
  omitted: number
} | null {
  if (!Array.isArray(value)) return null
  const errors: Array<HumanValidationError> = []
  for (const item of value.slice(0, HUMAN_VALIDATION_ERROR_LIMIT)) {
    if (
      !isPlainObject(item) ||
      typeof item.path !== "string" ||
      item.path.length > 512 ||
      typeof item.code !== "string" ||
      item.code.length > 64 ||
      typeof item.message !== "string" ||
      item.message.length > 512
    ) {
      continue
    }
    errors.push({
      path: item.path,
      code: item.code,
      message: item.message,
    })
  }
  return errors.length > 0
    ? {
        errors,
        omitted: Math.max(0, value.length - HUMAN_VALIDATION_ERROR_LIMIT),
      }
    : null
}

function humanError(error: CliErrorEnvelope): Array<string> {
  const retry =
    error.error.retryable === true ? " The request may succeed later." : ""
  const lines = [`${error.error.code}: ${error.error.message}${retry}`]
  const candidates = safeAuthorizationCandidates(
    error.error.details.availableAuthorizations
  )
  if (candidates) {
    lines.push(
      candidates.length === 0
        ? "Available authorizations: none."
        : "Available authorizations:"
    )
    for (const candidate of candidates) {
      lines.push(
        `- authId=${candidate.authId} displayName=${JSON.stringify(candidate.displayName)} status=${candidate.status} lastSyncedAt=${candidate.lastSyncedAt}`
      )
    }
  }
  const validation = safeValidationErrors(error.error.details.validationErrors)
  if (validation) {
    lines.push("Validation errors:")
    for (const item of validation.errors) {
      lines.push(
        `- path=${JSON.stringify(item.path)} code=${JSON.stringify(item.code)} message=${JSON.stringify(item.message)}`
      )
    }
    if (validation.omitted > 0) {
      lines.push(
        `- ${validation.omitted} additional validation error(s) omitted.`
      )
    }
  }
  const suggestedAction = error.error.details.suggestedAction
  if (typeof suggestedAction === "string" && suggestedAction.length > 0) {
    lines.push(`Suggested action: ${suggestedAction}`)
  }
  const resolutionUrl = safeResolutionUrl(error.error.details.resolutionUrl)
  if (resolutionUrl) lines.push(`Resolution URL: ${resolutionUrl}`)
  return lines
}

export function renderOutcome(
  outcome: CliOutcome<CliEnvelope>,
  options: { json: boolean; verbose: boolean },
  streams: OutputStreams
): void {
  for (const output of outcomeChunks(outcome, options)) {
    if (output.mode === "raw") {
      streams[output.stream].write(output.value)
    } else {
      line(streams[output.stream], output.value)
    }
  }
}

interface OutcomeChunk {
  stream: "stdout" | "stderr"
  mode: "line" | "raw"
  value: string
}

function outcomeChunks(
  outcome: CliOutcome<CliEnvelope>,
  options: { json: boolean; verbose: boolean }
): Array<OutcomeChunk> {
  const chunks: Array<OutcomeChunk> = []
  if (options.json) {
    chunks.push({
      stream: "stdout",
      mode: "line",
      value: JSON.stringify(outcome.envelope),
    })
  } else if (outcome.envelope.ok) {
    if (outcome.humanOutput) {
      chunks.push(outcome.humanOutput)
    } else {
      for (const value of outcome.humanLines ?? [
        JSON.stringify(outcome.envelope.data, null, 2),
      ]) {
        chunks.push({ stream: "stderr", mode: "line", value })
      }
    }
  } else {
    for (const value of humanError(outcome.envelope)) {
      chunks.push({ stream: "stderr", mode: "line", value })
    }
  }
  for (const warning of outcome.warnings) {
    chunks.push({
      stream: "stderr",
      mode: "line",
      value: `Warning: ${warning}`,
    })
  }
  if (options.verbose) {
    chunks.push({
      stream: "stderr",
      mode: "line",
      value: `requestId=${outcome.envelope.meta.requestId} exitCode=${outcome.exitCode}`,
    })
  }
  return chunks
}
