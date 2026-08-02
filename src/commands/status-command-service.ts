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
import { StatusCommandDispatcher } from "./status-command-dispatcher.js"
import type { LocalCredentialCoordinator } from "../auth/local-credentials.js"
import type { CliExitCode } from "../constants.js"
import type { JsonObject } from "../contracts/json.js"
import type { PublicHttpClient } from "../http/client.js"
import type {
  PendingCommandPrepareResult,
  PendingCommandRepository,
} from "./pending-command-repository.js"
import type { CliOutcome } from "../errors.js"
import type {
  CliEnvelope,
  LocalErrorCode,
  LocalErrorEnvelope,
} from "../contracts/envelope.js"

export interface StatusCommandInput {
  advId?: string
  campaignId?: string
  desiredStatus?: string
  authId?: string
  idempotencyKey?: string
  requestId?: string
}

interface ValidatedStatusCommandInput {
  advId: string
  campaignId: string
  desiredStatus: "ENABLE" | "DISABLE"
  authId: number | null
  idempotencyKey: string
  requestId?: string
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw usageFailure(`${flag} is required.`)
  return value
}

function validateStatusCommandInput(
  input: StatusCommandInput,
  generateIdempotencyKey: () => string
): ValidatedStatusCommandInput {
  const advId = requireTransportableResourceId(
    required(input.advId, "--adv-id"),
    "advId"
  )
  const campaignId = requireTransportableResourceId(
    required(input.campaignId, "--campaign-id"),
    "campaignId"
  )
  const desiredStatus = required(input.desiredStatus, "--set")
  if (desiredStatus !== "enable" && desiredStatus !== "disable") {
    throw usageFailure("--set must be enable or disable.")
  }
  const authId =
    input.authId === undefined
      ? null
      : parsePositiveInteger(input.authId, "--auth-id")
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
    desiredStatus: desiredStatus === "enable" ? "ENABLE" : "DISABLE",
    authId,
    idempotencyKey,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  }
}

function localCommandFailure(
  code: LocalErrorCode,
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
        {
          recordId: result.recordId,
          suggestedAction: "resume_command",
        }
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

export class StatusCommandService {
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

  async status(input: StatusCommandInput): Promise<CliOutcome<CliEnvelope>> {
    // 这是本命令的唯一输入闸门：完成前不得读凭证、加锁或落盘。
    const validated = validateStatusCommandInput(
      input,
      this.generateIdempotencyKey
    )
    const located = await this.local.requireLocated()
    if (!located.credentials) {
      throw authenticationFailure(
        "The credential has not completed /me activation. Run auth whoami."
      )
    }
    const prepared = await this.pending.prepare({
      idempotencyKey: validated.idempotencyKey,
      credentialId: located.index.credentialId,
      issuerOrigin: located.index.issuerOrigin,
      teamId: located.credentials.teamId,
      intent: {
        advId: validated.advId,
        campaignId: validated.campaignId,
        desiredStatus: validated.desiredStatus,
        authId: validated.authId,
      },
      now: this.now(),
    })
    if (prepared.kind !== "created") throw prepareFailure(prepared)

    return this.dispatcher.dispatch({
      record: prepared.record,
      expectedCredential: located,
      ...(validated.requestId === undefined
        ? {}
        : { requestId: validated.requestId }),
    })
  }
}
