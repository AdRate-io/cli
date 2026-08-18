import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { DEADLINES_MS, EXIT_CODE } from "../constants.js"
import { isPlainObject } from "../contracts/json.js"
import {
  parsePositiveInteger,
  requireTransportableResourceId,
} from "../contracts/resource-input.js"
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
import type { PublicHttpClient } from "../http/client.js"

type RuleWriteOperation = "create" | "update" | "enable" | "disable" | "delete"

export interface RuleCreateCommandInput {
  file?: string
  stdin: boolean
  idempotencyKey?: string
  requestId?: string
}

export interface RuleUpdateCommandInput {
  ruleId?: string
  file?: string
  idempotencyKey?: string
  requestId?: string
}

export interface RuleMutationCommandInput {
  ruleId?: string
  idempotencyKey?: string
  requestId?: string
}

export interface RuleDryRunCommandInput {
  ruleId?: string
  advId?: string
  shopId?: string
  campaignId?: string
  requestId?: string
}

export interface RuleCommandServiceOptions {
  environment?: NodeJS.ProcessEnv
  readFile?: (path: string) => Promise<string>
  readStdin?: () => Promise<string>
  generateIdempotencyKeySuffix?: () => string
}

interface RuleWriteRequest {
  operation: RuleWriteOperation
  path: string
  idempotencyKey?: string
  requestId?: string
  body?: JsonObject
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw usageFailure(`${flag} is required.`)
  return value
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw usageFailure(`${label} must be valid UTF-8.`)
  }
}

async function readRuleFile(path: string): Promise<string> {
  return decodeUtf8(await readFile(path), "Rule JSON file")
}

export async function readRuleStdin(
  stream: AsyncIterable<unknown> = process.stdin
): Promise<string> {
  const chunks: Array<Buffer> = []
  try {
    for await (const raw of stream) {
      if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
        throw dependencyFailure("Rule JSON stdin could not be read safely.")
      }
      chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8"))
    }
  } catch (error) {
    if (error instanceof CliFailure) throw error
    throw dependencyFailure("Rule JSON stdin could not be read safely.")
  }
  return decodeUtf8(Buffer.concat(chunks), "Rule JSON stdin")
}

function parseRuleJsonObject(text: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw usageFailure(
      "Rule input must be valid JSON with an object at the top level."
    )
  }
  if (!isPlainObject(parsed)) {
    throw usageFailure(
      "Rule input must be valid JSON with an object at the top level."
    )
  }
  return parsed as JsonObject
}

function ruleScopeWarning(
  envelope: PublicEnvelope,
  capability: "rules.write" | "rules.dryrun"
): string | null {
  if (
    envelope.ok ||
    envelope.error.code !== "CAPABILITY_DENIED" ||
    envelope.error.details.unavailableReason !== "credential_scope_missing"
  ) {
    return null
  }
  return `This Session lacks ${capability}. Recover any pending Campaign commands, then run auth logout, auth login, and auth whoami. Existing Sessions are not migrated automatically.`
}

function confirmedFailureWarning(
  envelope: Extract<PublicEnvelope, { ok: false }>,
  idempotencyKey: string
): string {
  if (envelope.error.code === "DAILY_QUOTA_EXCEEDED") {
    return `Rule write key: ${idempotencyKey}. Daily quota exceeded; stop until the UTC day rolls over, then retry the exact request with this key.`
  }
  if (envelope.error.code === "CAPABILITY_DENIED") {
    return `Rule write key: ${idempotencyKey}. Stop and restore the rules.write capability before retrying; do not generate a new key.`
  }
  if (
    envelope.error.code === "INVALID_REQUEST" ||
    envelope.error.code === "PLAN_LIMIT_EXCEEDED"
  ) {
    return `Rule write key: ${idempotencyKey}. The server rejected this request; correct the input or plan limit and retry with a new key.`
  }
  return envelope.error.retryable
    ? `Rule write key: ${idempotencyKey}. Retry the exact request with this key after waiting.`
    : unprovenWriteReplayWarning(idempotencyKey)
}

function unknownWriteFailure(
  error: unknown,
  idempotencyKey: string
): CliFailure {
  const failureKind =
    error instanceof HttpTransportError ? error.kind : "invalid_response"
  const warning = `Remote outcome unknown. Replay the exact request with --idempotency-key ${idempotencyKey}; do not generate a new key.`
  const failure = outcomeUnknownFailure(
    "The rule write response could not be confirmed. No success was reported.",
    { failureKind }
  )
  return new CliFailure(failure.message, failure.exitCode, failure.envelope, [
    ...failure.warnings,
    warning,
  ])
}

function writeHumanLines(
  operation: RuleWriteOperation,
  envelope: Extract<PublicEnvelope, { ok: true }>
): Array<string> {
  const data = envelope.data
  const hasCommonReceipt =
    typeof data.duplicate === "boolean" &&
    typeof data.ruleId === "number" &&
    Number.isSafeInteger(data.ruleId) &&
    data.ruleId > 0
  const hasOperationEvidence =
    operation === "create"
      ? typeof data.name === "string" &&
        data.name.length > 0 &&
        data.enabled === false
      : operation === "update"
        ? typeof data.name === "string" &&
          data.name.length > 0 &&
          typeof data.enabled === "boolean"
        : operation === "enable"
          ? data.enabled === true
          : operation === "disable"
            ? data.enabled === false
            : data.deleted === true
  if (!hasCommonReceipt || !hasOperationEvidence) {
    throw dependencyFailure(
      "The server returned an invalid rule write receipt.",
      EXIT_CODE.outcomeUnknown
    )
  }
  const label =
    operation === "create"
      ? "created"
      : operation === "update"
        ? "updated"
        : operation === "enable"
          ? "enabled"
          : operation === "disable"
            ? "disabled"
            : "deleted"
  return [
    `Rule ${label}.`,
    data.duplicate
      ? "Duplicate replay: yes; the original receipt was returned and no new mutation ran."
      : "Duplicate replay: no.",
    JSON.stringify(data, null, 2),
  ]
}

function safeInline(value: unknown, maximum = 160): string {
  let text: string
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    text = String(value)
  } else {
    text = "?"
  }
  const characters = [...text]
  const bounded =
    characters.length <= maximum
      ? text
      : `${characters.slice(0, maximum).join("")}...`
  return JSON.stringify(bounded)
}

function evaluationSummary(item: Record<string, unknown>): string {
  const evaluations: Array<Record<string, unknown>> = []
  if (Array.isArray(item.pipelines)) {
    for (const pipeline of item.pipelines) {
      if (!isPlainObject(pipeline) || !Array.isArray(pipeline.evaluation)) {
        continue
      }
      for (const evaluation of pipeline.evaluation) {
        if (isPlainObject(evaluation)) evaluations.push(evaluation)
      }
    }
  }
  if (evaluations.length === 0) return "evaluation=none"
  const preview = evaluations
    .slice(0, 3)
    .map(
      (evaluation) =>
        `${safeInline(evaluation.metric)} ${safeInline(evaluation.operator)} ${safeInline(evaluation.threshold)} actual=${safeInline(evaluation.actual)} result=${safeInline(evaluation.result)}`
    )
  return `evaluation=${preview.join("; ")}${evaluations.length > preview.length ? `; +${evaluations.length - preview.length} more` : ""}`
}

function dryRunHumanLines(data: JsonObject): Array<string> {
  if (!Array.isArray(data.items)) {
    throw dependencyFailure(
      "The server returned an invalid rule dry-run result."
    )
  }
  const lines = data.items.map((raw, index) => {
    const item = isPlainObject(raw) ? raw : {}
    const targetName =
      typeof item.targetName === "string"
        ? item.targetName
        : typeof item.targetId === "string"
          ? item.targetId
          : `target-${index + 1}`
    const hit =
      item.hit === true ? "yes" : item.hit === false ? "no" : "unknown"
    const noData = item.noData === true ? " noData=yes" : ""
    return `target=${safeInline(targetName)} hit=${hit}${noData} ${evaluationSummary(item)}`
  })
  if (lines.length === 0) lines.push("No dry-run targets were returned.")
  if (data.notice === "busy") {
    lines.push("Notice: upstream data was busy; retry the dry run later.")
  } else if (data.notice === "target_limit_exceeded") {
    lines.push(
      "Notice: the server reported target_limit_exceeded; inspect the complete JSON response before relying on the result."
    )
  }
  if (data.outsideEffectiveWindow === true) {
    lines.push("Notice: the rule is outside its effective window.")
  }
  return lines
}

export class RuleCommandService {
  private readonly environment: NodeJS.ProcessEnv
  private readonly readFileText: (path: string) => Promise<string>
  private readonly readStdinText: () => Promise<string>
  private readonly generateIdempotencyKeySuffix: () => string

  constructor(
    private readonly http: PublicHttpClient,
    private readonly local: LocalCredentialCoordinator,
    options: RuleCommandServiceOptions = {}
  ) {
    this.environment = options.environment ?? process.env
    this.readFileText = options.readFile ?? readRuleFile
    this.readStdinText = options.readStdin ?? (() => readRuleStdin())
    this.generateIdempotencyKeySuffix =
      options.generateIdempotencyKeySuffix ?? randomUUID
  }

  async create(
    input: RuleCreateCommandInput
  ): Promise<CliOutcome<CliEnvelope>> {
    if ((input.file !== undefined) === input.stdin) {
      throw usageFailure("Exactly one of --file or --stdin is required.")
    }
    const body = input.stdin
      ? parseRuleJsonObject(await this.readStdinText())
      : await this.readJsonFile(input.file!)
    return this.write({
      operation: "create",
      path: "/public/v1/rules/create",
      body,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
    })
  }

  async update(
    input: RuleUpdateCommandInput
  ): Promise<CliOutcome<CliEnvelope>> {
    const ruleId = parsePositiveInteger(
      required(input.ruleId, "--rule-id"),
      "--rule-id"
    )
    const body = await this.readJsonFile(required(input.file, "--file"))
    return this.write({
      operation: "update",
      path: `/public/v1/rules/${ruleId}/update`,
      body,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
    })
  }

  enable(input: RuleMutationCommandInput): Promise<CliOutcome<CliEnvelope>> {
    return this.mutate("enable", input)
  }

  disable(input: RuleMutationCommandInput): Promise<CliOutcome<CliEnvelope>> {
    return this.mutate("disable", input)
  }

  delete(input: RuleMutationCommandInput): Promise<CliOutcome<CliEnvelope>> {
    return this.mutate("delete", input)
  }

  async dryRun(
    input: RuleDryRunCommandInput
  ): Promise<CliOutcome<CliEnvelope>> {
    const ruleId = parsePositiveInteger(
      required(input.ruleId, "--rule-id"),
      "--rule-id"
    )
    const advId = requireTransportableResourceId(
      required(input.advId, "--adv-id"),
      "advId"
    )
    if ((input.shopId === undefined) !== (input.campaignId === undefined)) {
      throw usageFailure(
        "--shop-id and --campaign-id must be supplied together."
      )
    }
    const shopId =
      input.shopId === undefined
        ? undefined
        : requireTransportableResourceId(input.shopId, "storeId", "--shop-id")
    const campaignId =
      input.campaignId === undefined
        ? undefined
        : requireTransportableResourceId(input.campaignId, "campaignId")
    const located = await this.local.requireLocated()
    if (!located.credentials) {
      throw authenticationFailure(
        "The credential has not completed /me activation. Run auth whoami."
      )
    }
    try {
      const result = await this.http.requestPublic({
        method: "POST",
        issuerOrigin: located.index.issuerOrigin,
        path: `/public/v1/rules/${ruleId}/dryrun`,
        token: located.token,
        json: {
          advId,
          ...(shopId === undefined ? {} : { shopId }),
          ...(campaignId === undefined ? {} : { campaignId }),
        },
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        deadlineMs: DEADLINES_MS.ruleDryRun,
      })
      const outcome = outcomeFromEnvelope(result.envelope, this.environment)
      if (!result.envelope.ok) {
        const scopeWarning = ruleScopeWarning(result.envelope, "rules.dryrun")
        return {
          ...outcome,
          warnings: [
            ...outcome.warnings,
            ...(scopeWarning === null ? [] : [scopeWarning]),
          ],
        }
      }
      return {
        ...outcome,
        humanLines: dryRunHumanLines(result.envelope.data),
      }
    } catch (error) {
      if (error instanceof CliFailure) throw error
      if (error instanceof HttpTransportError) {
        throw dependencyFailure(
          "The rule dry-run request could not be completed. It may be retried with a bounded backoff.",
          EXIT_CODE.retryable,
          { failureKind: error.kind }
        )
      }
      throw dependencyFailure(
        "The rule dry-run request could not be completed."
      )
    }
  }

  private mutate(
    operation: "enable" | "disable" | "delete",
    input: RuleMutationCommandInput
  ): Promise<CliOutcome<CliEnvelope>> {
    const ruleId = parsePositiveInteger(
      required(input.ruleId, "--rule-id"),
      "--rule-id"
    )
    return this.write({
      operation,
      path: `/public/v1/rules/${ruleId}/${operation}`,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
    })
  }

  private async readJsonFile(path: string): Promise<JsonObject> {
    try {
      return parseRuleJsonObject(await this.readFileText(path))
    } catch (error) {
      if (error instanceof CliFailure) throw error
      throw usageFailure("Rule JSON file could not be read.")
    }
  }

  private async write(
    input: RuleWriteRequest
  ): Promise<CliOutcome<CliEnvelope>> {
    const idempotencyKey =
      input.idempotencyKey ??
      `rule-${input.operation}-${this.generateIdempotencyKeySuffix()}`
    const located = await this.local.requireLocated()
    if (!located.credentials) {
      throw authenticationFailure(
        "The credential has not completed /me activation. Run auth whoami."
      )
    }
    try {
      const request = {
        method: "POST" as const,
        issuerOrigin: located.index.issuerOrigin,
        path: input.path,
        token: located.token,
        idempotencyKey,
        ...(input.body === undefined ? {} : { json: input.body }),
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        deadlineMs: DEADLINES_MS.standard,
      }
      const result = await this.http.requestPublic(request)
      if (!result.envelope.ok) {
        const outcome = outcomeFromEnvelope(result.envelope, this.environment)
        const scopeWarning = ruleScopeWarning(result.envelope, "rules.write")
        return {
          ...outcome,
          warnings: [
            ...outcome.warnings,
            ...(scopeWarning === null ? [] : [scopeWarning]),
            confirmedFailureWarning(result.envelope, idempotencyKey),
          ],
        }
      }
      if (result.response.status !== 200) {
        throw dependencyFailure(
          "The server returned an invalid rule write receipt.",
          EXIT_CODE.outcomeUnknown
        )
      }
      const outcome = outcomeFromEnvelope(result.envelope, this.environment)
      return {
        ...outcome,
        humanLines: writeHumanLines(input.operation, result.envelope),
      }
    } catch (error) {
      throw unknownWriteFailure(error, idempotencyKey)
    }
  }
}
