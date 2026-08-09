import { randomUUID } from "node:crypto"
import {
  EXIT_CODE,
  IDEMPOTENCY_KEY_PATTERN,
  REQUEST_ID_PATTERN,
} from "../constants.js"
import { createLocalError } from "../contracts/envelope.js"
import {
  parsePositiveInteger,
  requireTransportableResourceId,
} from "../contracts/resource-input.js"
import {
  CliFailure,
  authenticationFailure,
  localRequestId,
  usageFailure,
} from "../errors.js"
import { BUDGET_MODES } from "./command-families.js"
import { StatusCommandDispatcher } from "./status-command-dispatcher.js"
import type { LocalCredentialCoordinator } from "../auth/local-credentials.js"
import type { CliExitCode } from "../constants.js"
import type { CliEnvelope, LocalErrorEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { PublicHttpClient } from "../http/client.js"
import type {
  PendingCommandPrepareResult,
  PendingCommandRepository,
} from "./pending-command-repository.js"

interface GmvMaxCommandInput {
  advId?: string
  campaignId?: string
  authId?: string
  idempotencyKey?: string
  requestId?: string
}

export interface GmvMaxStatusCommandInput extends GmvMaxCommandInput {
  desiredStatus?: string
}

export interface GmvMaxNumericCommandInput extends GmvMaxCommandInput {
  mode?: string
  value?: string
}

interface ValidatedGmvMaxCommandInput {
  capabilityId:
    | "gmvmax.campaign.status.write"
    | "gmvmax.campaign.budget.write"
    | "gmvmax.campaign.roas.write"
  advId: string
  campaignId: string
  authId: number
  idempotencyKey: string
  familyPayload: Record<string, unknown>
  requestId?: string
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw usageFailure(`${flag} is required.`)
  return value
}

function validateCommon(
  input: GmvMaxCommandInput,
  generateIdempotencyKey: () => string
): Omit<ValidatedGmvMaxCommandInput, "capabilityId" | "familyPayload"> {
  const advId = requireTransportableResourceId(
    required(input.advId, "--adv-id"),
    "advId"
  )
  const campaignId = requireTransportableResourceId(
    required(input.campaignId, "--campaign-id"),
    "campaignId"
  )
  const authId = parsePositiveInteger(
    required(input.authId, "--auth-id"),
    "--auth-id"
  )
  const idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey()
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
    advId,
    campaignId,
    authId,
    idempotencyKey,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  }
}

function validateStatus(
  input: GmvMaxStatusCommandInput,
  generateIdempotencyKey: () => string
): ValidatedGmvMaxCommandInput {
  const desiredStatus = required(input.desiredStatus, "--set")
  if (desiredStatus !== "enable" && desiredStatus !== "disable") {
    throw usageFailure("--set must be enable or disable.")
  }
  return {
    capabilityId: "gmvmax.campaign.status.write",
    ...validateCommon(input, generateIdempotencyKey),
    familyPayload: {
      desiredStatus: desiredStatus === "enable" ? "ENABLE" : "DISABLE",
    },
  }
}

function validateNumeric(
  input: GmvMaxNumericCommandInput,
  operation: "budget" | "roas",
  generateIdempotencyKey: () => string
): ValidatedGmvMaxCommandInput {
  const mode = required(input.mode, "--mode")
  if (!BUDGET_MODES.has(mode)) {
    throw usageFailure(
      "--mode must be set, increase_amount, decrease_amount, increase_percent, or decrease_percent."
    )
  }
  const value = Number(required(input.value, "--value"))
  if (!Number.isFinite(value) || value <= 0) {
    throw usageFailure("--value must be a positive number.")
  }
  const precision = operation === "budget" ? 100 : 10
  if (Math.round(value * precision) / precision !== value) {
    throw usageFailure(
      `--value must have at most ${operation === "budget" ? "two" : "one"} decimal place${operation === "budget" ? "s" : ""}.`
    )
  }
  if (mode === "decrease_percent" && value >= 100) {
    throw usageFailure("--value must be below 100 for decrease_percent.")
  }
  return {
    capabilityId: `gmvmax.campaign.${operation}.write`,
    ...validateCommon(input, generateIdempotencyKey),
    familyPayload: { mode, value },
  }
}

function localCommandFailure(
  code: LocalErrorEnvelope["error"]["code"],
  exitCode: CliExitCode,
  message: string,
  details: JsonObject = {}
): CliFailure<LocalErrorEnvelope> {
  return new CliFailure(
    message,
    exitCode,
    createLocalError(localRequestId(), code, message, false, details)
  )
}

function prepareFailure(
  result: Exclude<PendingCommandPrepareResult, { kind: "created" }>
): CliFailure<LocalErrorEnvelope> {
  switch (result.kind) {
    case "existing_same_intent":
      return localCommandFailure(
        "LOCAL_PENDING_COMMAND_EXISTS",
        EXIT_CODE.usage,
        "A matching pending Command already exists; use commands resume.",
        { recordId: result.recordId, suggestedAction: "resume_command" }
      )
    case "prior_credential":
      return localCommandFailure(
        "LOCAL_PRIOR_CREDENTIAL_PENDING",
        EXIT_CODE.authentication,
        "This resource has a pending Command owned by a prior credential.",
        { recordId: result.recordId }
      )
    case "resource_intent_conflict":
      return localCommandFailure(
        "LOCAL_RESOURCE_INTENT_CONFLICT",
        EXIT_CODE.usage,
        "This resource already has a different pending intent.",
        { recordId: result.recordId }
      )
    case "idempotency_conflict":
      return localCommandFailure(
        "LOCAL_IDEMPOTENCY_CONFLICT",
        EXIT_CODE.usage,
        "The idempotency key is already bound to a different intent.",
        { recordId: result.recordId }
      )
    case "credential_mismatch":
      return localCommandFailure(
        "LOCAL_CREDENTIAL_MISMATCH",
        EXIT_CODE.authentication,
        "The pending Command belongs to a different credential or issuer.",
        { recordId: result.recordId }
      )
    case "unsafe":
      return localCommandFailure(
        "LOCAL_STATE_UNSAFE",
        EXIT_CODE.business,
        "Pending Command evidence is unsafe; no write request was sent.",
        {
          invalidEntries: result.scan.invalidEntries.map((entry) => ({
            recordId: entry.recordId,
            reason: entry.reason,
          })),
        }
      )
  }
}

export class GmvMaxCommandService {
  private readonly now: () => Date
  private readonly generateIdempotencyKey: () => string
  private readonly dispatcher: Pick<StatusCommandDispatcher, "dispatch">

  constructor(
    http: PublicHttpClient,
    private readonly local: LocalCredentialCoordinator,
    private readonly pending: PendingCommandRepository,
    options: {
      now?: () => Date
      generateIdempotencyKey?: () => string
      environment?: NodeJS.ProcessEnv
      dispatcher?: Pick<StatusCommandDispatcher, "dispatch">
    } = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.generateIdempotencyKey =
      options.generateIdempotencyKey ?? (() => randomUUID())
    this.dispatcher =
      options.dispatcher ??
      new StatusCommandDispatcher(http, pending, local, {
        now: this.now,
        environment: options.environment ?? process.env,
      })
  }

  status(input: GmvMaxStatusCommandInput): Promise<CliOutcome<CliEnvelope>> {
    return this.execute(validateStatus(input, this.generateIdempotencyKey))
  }

  budget(input: GmvMaxNumericCommandInput): Promise<CliOutcome<CliEnvelope>> {
    return this.execute(
      validateNumeric(input, "budget", this.generateIdempotencyKey)
    )
  }

  roas(input: GmvMaxNumericCommandInput): Promise<CliOutcome<CliEnvelope>> {
    return this.execute(
      validateNumeric(input, "roas", this.generateIdempotencyKey)
    )
  }

  private async execute(
    input: ValidatedGmvMaxCommandInput
  ): Promise<CliOutcome<CliEnvelope>> {
    // 所有纯本地参数校验均已完成，只有这里才允许触碰凭证与 pending journal。
    const located = await this.local.requireLocated()
    if (!located.credentials) {
      throw authenticationFailure(
        "The credential has not completed /me activation. Run auth whoami."
      )
    }
    const prepared = await this.pending.prepare({
      idempotencyKey: input.idempotencyKey,
      capabilityId: input.capabilityId,
      credentialId: located.index.credentialId,
      issuerOrigin: located.index.issuerOrigin,
      teamId: located.credentials.teamId,
      intent: {
        capabilityId: input.capabilityId,
        advId: input.advId,
        campaignId: input.campaignId,
        authId: input.authId,
        familyPayload: input.familyPayload,
      },
      now: this.now(),
    })
    if (prepared.kind !== "created") throw prepareFailure(prepared)
    return this.dispatcher.dispatch({
      record: prepared.record,
      expectedCredential: located,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    })
  }
}
