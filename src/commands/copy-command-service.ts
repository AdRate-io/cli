import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  DEADLINES_MS,
  EXIT_CODE,
  IDEMPOTENCY_KEY_PATTERN,
} from "../constants.js"
import { isPlainObject, isSafeIntegerInRange } from "../contracts/json.js"
import {
  CliFailure,
  authenticationFailure,
  dependencyFailure,
  outcomeUnknownFailure,
  usageFailure,
} from "../errors.js"
import { HttpTransportError } from "../http/client.js"
import { outcomeFromEnvelope } from "../output.js"
import { unprovenWriteReplayWarning } from "./receipt-write-guidance.js"
import type { LocalCredentialCoordinator } from "../auth/local-credentials.js"
import type { CliEnvelope, PublicEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { PublicHttpClient, PublicResponse } from "../http/client.js"

export interface CopySubmitCommandInput {
  file?: string
  idempotencyKey?: string
  requestId?: string
}

export interface CopyPreviewCommandInput {
  file?: string
  requestId?: string
}

export interface CopyCommandServiceOptions {
  environment?: NodeJS.ProcessEnv
  readFile?: (path: string) => Promise<string | Uint8Array>
  generateIdempotencyKey?: () => string
}

interface CopySubmitReceipt {
  taskId: number
  itemCount: number
  duplicate: boolean
  snapshotSummary: {
    campaigns: number
    adgroups: number
    ads: number
  }
}

/**
 * 「服务端明确拒绝且证明未执行 → 改正后换新 key」一类的错误码。
 *
 * `AD_CREATION_QUOTA_EXCEEDED` 在下方有带额度数字的专用分支（优先命中），
 * 这里同样登记只作兜底：万一专用分支被挪走或改序，它仍归入换新 key 一类，
 * 不会掉到「retryable=false 的未知码」去建议原 key 重放。
 */
const CORRECT_THEN_NEW_KEY_CODES = new Set([
  "INVALID_REQUEST",
  "PLAN_LIMIT_EXCEEDED",
  "AD_CREATION_QUOTA_EXCEEDED",
])

/** 服务端额度诊断只在四个字段都可信时才拼进提示，缺一个就整段省略数字。 */
function adCreationQuotaFigures(
  details: Record<string, unknown>
): string | null {
  const requiredUnits = details.required
  const remaining = details.remaining
  const periodEndAt = details.periodEndAt
  if (
    !Number.isSafeInteger(requiredUnits) ||
    !Number.isSafeInteger(remaining) ||
    (periodEndAt !== null && typeof periodEndAt !== "string")
  ) {
    return null
  }
  const reset =
    typeof periodEndAt === "string" ? `, resets at ${periodEndAt}` : ""
  return ` (needs ${String(requiredUnits)}, ${String(remaining)} remaining${reset})`
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw usageFailure(`${flag} is required.`)
  return value
}

function decodeCopyFile(value: string | Uint8Array): string {
  if (typeof value === "string") return value
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } catch {
    throw usageFailure("Copy JSON file must be valid UTF-8.")
  }
}

function parseCopyJsonObject(text: string): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw usageFailure(
      "Copy input must be valid JSON with an object at the top level."
    )
  }
  if (!isPlainObject(value)) {
    throw usageFailure(
      "Copy input must be valid JSON with an object at the top level."
    )
  }
  return value as JsonObject
}

function submitUnknownFailure(
  error: unknown,
  idempotencyKey: string
): CliFailure {
  const failureKind =
    error instanceof HttpTransportError ? error.kind : "invalid_response"
  const warning = `Remote outcome unknown. Replay the exact original JSON body with --idempotency-key ${idempotencyKey}; do not generate a new key.`
  const failure = outcomeUnknownFailure(
    "The Campaign Copy submit response could not be confirmed. No acceptance was reported.",
    { failureKind }
  )
  return new CliFailure(failure.message, failure.exitCode, failure.envelope, [
    ...failure.warnings,
    warning,
  ])
}

function confirmedSubmitWarning(
  envelope: Extract<PublicEnvelope, { ok: false }>,
  idempotencyKey: string
): string {
  if (envelope.error.code === "DAILY_QUOTA_EXCEEDED") {
    return `Daily quota exceeded; stop until the UTC day rolls over, then replay the exact original JSON body with idempotency key ${idempotencyKey}.`
  }
  // 创建额度是订阅周期额度，不是日额度：等下一个 UTC 日不会恢复，
  // 而且这条拒绝证明没有任务被受理，所以归入"改正后换新 key"一类。
  if (envelope.error.code === "AD_CREATION_QUOTA_EXCEEDED") {
    const figures = adCreationQuotaFigures(envelope.error.details) ?? ""
    return `Campaign creation quota exhausted for the current period${figures}; no Copy task was accepted. Add creation units or upgrade the plan, then submit with a new idempotency key; do not reuse ${idempotencyKey}.`
  }
  if (CORRECT_THEN_NEW_KEY_CODES.has(envelope.error.code)) {
    return `The server rejected this submit. Correct the validation or quota issue, then submit the corrected body with a new idempotency key; do not reuse ${idempotencyKey}.`
  }
  return envelope.error.retryable
    ? `Retry the exact original JSON body with idempotency key ${idempotencyKey} after waiting.`
    : unprovenWriteReplayWarning(idempotencyKey)
}

function decodeSubmitReceipt(result: PublicResponse): CopySubmitReceipt | null {
  if (!result.envelope.ok || result.response.status !== 200) return null
  const data = result.envelope.data
  const summary = data.snapshotSummary
  if (
    !isSafeIntegerInRange(data.taskId, 1) ||
    !isSafeIntegerInRange(data.itemCount, 1) ||
    typeof data.duplicate !== "boolean" ||
    !isPlainObject(summary) ||
    !isSafeIntegerInRange(summary.campaigns, 1) ||
    !isSafeIntegerInRange(summary.adgroups, 0) ||
    !isSafeIntegerInRange(summary.ads, 0)
  ) {
    return null
  }
  return {
    taskId: data.taskId,
    itemCount: data.itemCount,
    duplicate: data.duplicate,
    snapshotSummary: {
      campaigns: summary.campaigns,
      adgroups: summary.adgroups,
      ads: summary.ads,
    },
  }
}

function submitHumanLines(receipt: CopySubmitReceipt): Array<string> {
  return [
    `Campaign Copy task accepted, not completed: taskId=${receipt.taskId}.`,
    `Items: ${receipt.itemCount}; duplicate replay: ${receipt.duplicate ? "yes" : "no"}.`,
    `Snapshot: campaigns=${receipt.snapshotSummary.campaigns} adgroups=${receipt.snapshotSummary.adgroups} ads=${receipt.snapshotSummary.ads}.`,
    `Check progress with: adrate ads copy tasks get --task-id ${receipt.taskId}`,
  ]
}

export class CopyCommandService {
  private readonly environment: NodeJS.ProcessEnv
  private readonly readFileContent: (
    path: string
  ) => Promise<string | Uint8Array>
  private readonly generateIdempotencyKey: () => string

  constructor(
    private readonly http: PublicHttpClient,
    private readonly local: LocalCredentialCoordinator,
    options: CopyCommandServiceOptions = {}
  ) {
    this.environment = options.environment ?? process.env
    this.readFileContent = options.readFile ?? ((path) => readFile(path))
    this.generateIdempotencyKey =
      options.generateIdempotencyKey ?? (() => `copy-submit-${randomUUID()}`)
  }

  async submit(
    input: CopySubmitCommandInput
  ): Promise<CliOutcome<CliEnvelope>> {
    const body = await this.readJsonFile(required(input.file, "--file"))
    const idempotencyKey = input.idempotencyKey ?? this.generateIdempotencyKey()
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw usageFailure("--idempotency-key must match ^[A-Za-z0-9_-]{1,128}$.")
    }
    const located = await this.requireActiveCredential()
    let result: PublicResponse
    try {
      result = await this.http.requestPublic({
        method: "POST",
        issuerOrigin: located.index.issuerOrigin,
        path: "/public/v1/ads/copy/submit",
        token: located.token,
        idempotencyKey,
        json: body,
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        deadlineMs: DEADLINES_MS.campaignRead,
      })
    } catch (error) {
      throw submitUnknownFailure(error, idempotencyKey)
    }

    if (!result.envelope.ok) {
      const outcome = outcomeFromEnvelope(result.envelope, this.environment)
      return {
        ...outcome,
        warnings: [
          ...outcome.warnings,
          confirmedSubmitWarning(result.envelope, idempotencyKey),
        ],
      }
    }
    const receipt = decodeSubmitReceipt(result)
    if (!receipt)
      throw submitUnknownFailure(new Error("invalid receipt"), idempotencyKey)
    const outcome = outcomeFromEnvelope(result.envelope, this.environment)
    return { ...outcome, humanLines: submitHumanLines(receipt) }
  }

  async preview(
    input: CopyPreviewCommandInput
  ): Promise<CliOutcome<CliEnvelope>> {
    const body = await this.readJsonFile(required(input.file, "--file"))
    const located = await this.requireActiveCredential()
    try {
      const result = await this.http.requestPublic({
        method: "POST",
        issuerOrigin: located.index.issuerOrigin,
        path: "/public/v1/ads/copy/preview",
        token: located.token,
        json: body,
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        deadlineMs: DEADLINES_MS.campaignRead,
      })
      if (result.envelope.ok && result.response.status !== 200) {
        throw dependencyFailure(
          "The server returned an invalid Campaign Copy preview response."
        )
      }
      return outcomeFromEnvelope(result.envelope, this.environment)
    } catch (error) {
      if (error instanceof HttpTransportError) {
        throw dependencyFailure(
          "The Campaign Copy preview could not be completed. The same preview may be retried with a bounded backoff.",
          EXIT_CODE.retryable,
          { failureKind: error.kind }
        )
      }
      if (error instanceof CliFailure) throw error
      throw dependencyFailure(
        "The Campaign Copy preview could not be completed."
      )
    }
  }

  private async readJsonFile(path: string): Promise<JsonObject> {
    try {
      return parseCopyJsonObject(
        decodeCopyFile(await this.readFileContent(path))
      )
    } catch (error) {
      if (error instanceof CliFailure) throw error
      throw usageFailure("Copy JSON file could not be read.")
    }
  }

  private async requireActiveCredential() {
    const located = await this.local.requireLocated()
    if (!located.credentials) {
      throw authenticationFailure(
        "The credential has not completed /me activation. Run auth whoami."
      )
    }
    return located
  }
}
