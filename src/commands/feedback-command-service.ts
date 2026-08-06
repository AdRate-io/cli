import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import {
  CLI_VERSION,
  DEADLINES_MS,
  EXIT_CODE,
  IDEMPOTENCY_KEY_PATTERN,
  REQUEST_ID_PATTERN,
} from "../constants.js"
import { decodeFeedbackReceipt } from "../contracts/feedback.js"
import {
  CliFailure,
  authenticationFailure,
  dependencyFailure,
  usageFailure,
} from "../errors.js"
import { HttpTransportError } from "../http/client.js"
import { outcomeFromEnvelope } from "../output.js"
import type { LocalCredentialCoordinator } from "../auth/local-credentials.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { CliOutcome } from "../errors.js"
import type { PublicHttpClient } from "../http/client.js"

const FEEDBACK_CATEGORIES = new Set([
  "blocked",
  "bug",
  "suggestion",
  "other",
] as const)
const MESSAGE_MAX_CODE_POINTS = 4_000
const MESSAGE_MAX_UTF8_BYTES = 16 * 1024

export type FeedbackCategory = "blocked" | "bug" | "suggestion" | "other"

export interface FeedbackCommandInput {
  category?: string
  message?: string
  messageStdin: boolean
  idempotencyKey?: string
  requestId?: string
}

interface ValidatedFeedbackInput {
  category: FeedbackCategory
  message: string
  idempotencyKey: string
  requestId?: string
}

interface FeedbackClientMetadata {
  cliVersion: string
  platform: string
  nodeVersion: string
}

export interface FeedbackCommandServiceOptions {
  readStdin?: () => Promise<string>
  generateIdempotencyKey?: () => string
  environment?: NodeJS.ProcessEnv
  clientMetadata?: FeedbackClientMetadata
}

function countCodePoints(value: string): number {
  let count = 0
  for (const _character of value) count += 1
  return count
}

function validateMessage(value: string): string {
  if (
    value.trim().length === 0 ||
    countCodePoints(value) > MESSAGE_MAX_CODE_POINTS ||
    Buffer.byteLength(value, "utf8") > MESSAGE_MAX_UTF8_BYTES
  ) {
    throw usageFailure(
      "Feedback message must contain 1 to 4000 Unicode characters and be at most 16 KiB UTF-8."
    )
  }
  return value
}

function feedbackRetryWarning(idempotencyKey: string): string {
  return `Feedback retry key: ${idempotencyKey}. Retry only the same category and message with this key.`
}

function scopeMissingWarning(envelope: CliEnvelope): string | null {
  if (
    envelope.ok ||
    envelope.error.code !== "CAPABILITY_DENIED" ||
    envelope.error.details.unavailableReason !== "credential_scope_missing"
  ) {
    return null
  }
  return "This Session lacks feedback.write. Recover any commands pending work, then run auth logout, auth login, and auth whoami."
}

function withRetryKey(error: unknown, idempotencyKey: string): CliFailure {
  const warning = feedbackRetryWarning(idempotencyKey)
  if (error instanceof CliFailure) {
    return new CliFailure(error.message, error.exitCode, error.envelope, [
      ...error.warnings,
      warning,
    ])
  }
  if (error instanceof HttpTransportError) {
    return new CliFailure(
      "The feedback response could not be confirmed. No success was reported.",
      EXIT_CODE.retryable,
      dependencyFailure(
        "The feedback response could not be confirmed. No success was reported.",
        EXIT_CODE.retryable,
        { failureKind: error.kind }
      ).envelope,
      [warning]
    )
  }
  return new CliFailure(
    "The feedback response could not be confirmed. No success was reported.",
    EXIT_CODE.retryable,
    dependencyFailure(
      "The feedback response could not be confirmed. No success was reported."
    ).envelope,
    [warning]
  )
}

/** 从 stdin 有界读取 UTF-8，不把自由文本经过 shell 重新解析。 */
export async function readFeedbackStdin(
  stream: AsyncIterable<unknown> = process.stdin
): Promise<string> {
  const chunks: Array<Buffer> = []
  let total = 0
  try {
    for await (const raw of stream) {
      if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
        throw dependencyFailure("Feedback stdin could not be read safely.")
      }
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8")
      total += chunk.byteLength
      if (total > MESSAGE_MAX_UTF8_BYTES) {
        throw usageFailure("Feedback stdin exceeds the 16 KiB UTF-8 limit.")
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof CliFailure) throw error
    throw dependencyFailure("Feedback stdin could not be read safely.")
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, total)
    )
  } catch {
    throw usageFailure("Feedback stdin must be valid UTF-8.")
  }
}

export class FeedbackCommandService {
  private readonly readStdin: () => Promise<string>
  private readonly generateIdempotencyKey: () => string
  private readonly environment: NodeJS.ProcessEnv
  private readonly clientMetadata: FeedbackClientMetadata

  constructor(
    private readonly http: PublicHttpClient,
    private readonly local: LocalCredentialCoordinator,
    options: FeedbackCommandServiceOptions = {}
  ) {
    this.readStdin = options.readStdin ?? (() => readFeedbackStdin())
    this.generateIdempotencyKey =
      options.generateIdempotencyKey ?? (() => `feedback_${randomUUID()}`)
    this.environment = options.environment ?? process.env
    this.clientMetadata =
      options.clientMetadata ??
      Object.freeze({
        cliVersion: CLI_VERSION,
        platform: `${process.platform}-${process.arch}`,
        nodeVersion: process.version,
      })
  }

  async submit(input: FeedbackCommandInput): Promise<CliOutcome<CliEnvelope>> {
    const validated = await this.validateInput(input)
    try {
      const located = await this.local.requireLocated()
      if (!located.credentials) {
        throw authenticationFailure(
          "The credential has not completed /me activation. Run auth whoami."
        )
      }
      const result = await this.http.requestPublic({
        method: "POST",
        issuerOrigin: located.index.issuerOrigin,
        path: "/public/v1/feedback",
        token: located.token,
        idempotencyKey: validated.idempotencyKey,
        json: {
          category: validated.category,
          message: validated.message,
          cliVersion: this.clientMetadata.cliVersion,
          platform: this.clientMetadata.platform,
          nodeVersion: this.clientMetadata.nodeVersion,
        },
        ...(validated.requestId === undefined
          ? {}
          : { requestId: validated.requestId }),
        deadlineMs: DEADLINES_MS.standard,
      })

      if (!result.envelope.ok) {
        const outcome = outcomeFromEnvelope(result.envelope, this.environment)
        const scopeWarning = scopeMissingWarning(result.envelope)
        return {
          ...outcome,
          warnings: [
            ...outcome.warnings,
            ...(scopeWarning === null ? [] : [scopeWarning]),
            feedbackRetryWarning(validated.idempotencyKey),
          ],
        }
      }
      const receipt = decodeFeedbackReceipt(result.envelope)
      if (result.response.status !== 200 || receipt === null) {
        throw dependencyFailure(
          "The server returned an invalid feedback receipt. No success was reported."
        )
      }
      const outcome = outcomeFromEnvelope(result.envelope, this.environment)
      return {
        ...outcome,
        humanLines: [
          `Feedback received: ${receipt.feedbackId}`,
          ...(receipt.duplicate
            ? [
                "This feedback was already received; no duplicate row was created.",
              ]
            : []),
          ...(receipt.redactionApplied
            ? ["Sensitive-looking content was redacted before storage."]
            : []),
        ],
      }
    } catch (error) {
      throw withRetryKey(error, validated.idempotencyKey)
    }
  }

  private async validateInput(
    input: FeedbackCommandInput
  ): Promise<ValidatedFeedbackInput> {
    if (
      !input.category ||
      !FEEDBACK_CATEGORIES.has(input.category as FeedbackCategory)
    ) {
      throw usageFailure(
        "--category must be blocked, bug, suggestion, or other."
      )
    }
    const hasMessage = input.message !== undefined
    if (hasMessage === input.messageStdin) {
      throw usageFailure(
        "Exactly one of --message or --message-stdin is required."
      )
    }
    const message = validateMessage(
      input.messageStdin ? await this.readStdin() : input.message!
    )
    const idempotencyKey = input.idempotencyKey ?? this.generateIdempotencyKey()
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw usageFailure("--idempotency-key must match ^[A-Za-z0-9_-]{1,128}$.")
    }
    if (
      input.requestId !== undefined &&
      !REQUEST_ID_PATTERN.test(input.requestId)
    ) {
      throw usageFailure("--request-id must match ^[A-Za-z0-9_-]{1,128}$.")
    }
    return {
      category: input.category as FeedbackCategory,
      message,
      idempotencyKey,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    }
  }
}
