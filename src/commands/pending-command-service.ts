import { CLI_VERSION, EXIT_CODE } from "../constants.js"
import { createLocalError, createLocalSuccess } from "../contracts/envelope.js"
import { CliFailure, localRequestId } from "../errors.js"
import { pendingCredentialScopeMatches } from "./pending-command-contract.js"
import type { CliStateStore } from "../storage/state-store.js"
import type {
  CliConfig,
  CredentialMetadata,
  TokenIndex,
} from "../storage/schemas.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { LocalErrorEnvelope } from "../contracts/envelope.js"
import type {
  PendingCommandLastResponse,
  PendingCommandLocalState,
  PendingCommandRecord,
  PendingCredentialScope,
} from "./pending-command-contract.js"
import type {
  PendingCommandInvalidEntry,
  PendingCommandRepository,
} from "./pending-command-repository.js"

export type PendingCommandResumeMode =
  | "query"
  | "post_if_server_missing"
  | "blocked"

export type PendingCommandBlockedReason =
  | "expired_unsubmitted"
  | "orphaned_credential"
  | "credential_mismatch"
  | null

export interface PendingCommandIntentView extends JsonObject {
  advId: string
  campaignId: string
  desiredStatus: "ENABLE" | "DISABLE"
  authId: number | null
}

export interface PendingCommandLastResponseView extends JsonObject {
  requestId: string | null
  httpStatus: number | null
  errorCode: string | null
}

export interface PendingCommandView extends JsonObject {
  recordId: string
  idempotencyKey: string
  capabilityId: "ads.campaign.status.write"
  credentialKind: "owner_cli_session"
  credentialId: string
  issuerOrigin: string
  teamId: number
  intent: PendingCommandIntentView
  localState: PendingCommandLocalState
  commandId: string | null
  createdAt: string
  updatedAt: string
  ageSeconds: number
  resumeMode: PendingCommandResumeMode
  blockedReason: PendingCommandBlockedReason
  lastResponse: PendingCommandLastResponseView | null
}

interface PendingCommandCounts extends JsonObject {
  total: number
  query: number
  postIfServerMissing: number
  blocked: number
}

interface ControlledInvalidEntry extends JsonObject {
  recordId: string | null
  reason: PendingCommandInvalidEntry["reason"]
}

function metadataMatchesIndex(
  config: CliConfig,
  index: TokenIndex,
  credentials: CredentialMetadata
): boolean {
  return (
    index.state === "stored" &&
    config.environment === index.environment &&
    config.issuerOrigin === index.issuerOrigin &&
    config.clientInstanceId === index.clientInstanceId &&
    credentials.credentialId === index.credentialId &&
    credentials.issuerOrigin === index.issuerOrigin &&
    credentials.clientInstanceId === index.clientInstanceId &&
    credentials.loggedInAt === index.tokenReceivedAt &&
    credentials.deviceName === index.deviceName
  )
}

async function readCurrentScope(
  state: CliStateStore
): Promise<PendingCredentialScope | null> {
  try {
    return await state.withAuthLock(async () => {
      // pending 只需本地 credential scope：故意不读 Keychain secret，
      // 也不调用会恢复或改写 auth 状态的 credential coordinator。
      const [config, index, credentials] = await Promise.all([
        state.readConfig(),
        state.readTokenIndex(),
        state.readCredentials(),
      ])
      if (
        config === null ||
        index === null ||
        credentials === null ||
        !metadataMatchesIndex(config, index, credentials)
      ) {
        return null
      }
      return {
        credentialId: index.credentialId,
        issuerOrigin: index.issuerOrigin,
        teamId: credentials.teamId,
      }
    })
  } catch {
    // auth 元数据无法安全形成完整 scope 时采用最保守结果：
    // 证据仍可盘点，但所有非终态记录均禁止恢复。
    return null
  }
}

function recoveryClassification(
  record: PendingCommandRecord,
  scope: PendingCredentialScope | null
): Pick<PendingCommandView, "resumeMode" | "blockedReason"> {
  if (record.localState === "expired_unsubmitted") {
    return {
      resumeMode: "blocked",
      blockedReason: "expired_unsubmitted",
    }
  }
  if (record.localState === "orphaned_credential") {
    return {
      resumeMode: "blocked",
      blockedReason: "orphaned_credential",
    }
  }
  if (scope === null || !pendingCredentialScopeMatches(record, scope)) {
    return { resumeMode: "blocked", blockedReason: "credential_mismatch" }
  }
  return record.localState === "command_known"
    ? { resumeMode: "query", blockedReason: null }
    : { resumeMode: "post_if_server_missing", blockedReason: null }
}

function mapLastResponse(
  value: PendingCommandLastResponse | null
): PendingCommandLastResponseView | null {
  return value === null
    ? null
    : {
        requestId: value.requestId,
        httpStatus: value.httpStatus,
        errorCode: value.errorCode,
      }
}

function mapRecord(
  recordId: string,
  record: PendingCommandRecord,
  scope: PendingCredentialScope | null,
  nowMilliseconds: number
): PendingCommandView | null {
  const createdAtMilliseconds = Date.parse(record.createdAt)
  if (
    !Number.isFinite(createdAtMilliseconds) ||
    createdAtMilliseconds > nowMilliseconds
  ) {
    return null
  }
  const recovery = recoveryClassification(record, scope)
  return {
    recordId,
    idempotencyKey: record.idempotencyKey,
    capabilityId: record.capabilityId,
    credentialKind: record.credentialKind,
    credentialId: record.credentialId,
    issuerOrigin: record.issuerOrigin,
    teamId: record.teamId,
    intent: {
      advId: record.intent.advId,
      campaignId: record.intent.campaignId,
      desiredStatus: record.intent.desiredStatus,
      authId: record.intent.authId,
    },
    localState: record.localState,
    commandId: record.commandId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ageSeconds: Math.floor((nowMilliseconds - createdAtMilliseconds) / 1_000),
    ...recovery,
    lastResponse: mapLastResponse(record.lastResponse),
  }
}

function compareViews(left: PendingCommandView, right: PendingCommandView) {
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt)
  return byCreatedAt !== 0
    ? byCreatedAt
    : left.recordId.localeCompare(right.recordId)
}

function compareInvalidEntries(
  left: ControlledInvalidEntry,
  right: ControlledInvalidEntry
) {
  const byRecordId = (left.recordId ?? "").localeCompare(right.recordId ?? "")
  return byRecordId !== 0 ? byRecordId : left.reason.localeCompare(right.reason)
}

function countsFor(records: Array<PendingCommandView>): PendingCommandCounts {
  return {
    total: records.length,
    query: records.filter((record) => record.resumeMode === "query").length,
    postIfServerMissing: records.filter(
      (record) => record.resumeMode === "post_if_server_missing"
    ).length,
    blocked: records.filter((record) => record.resumeMode === "blocked").length,
  }
}

function unsafeFailure(
  validRecords: Array<PendingCommandView>,
  invalidEntries: Array<ControlledInvalidEntry>
): CliFailure<LocalErrorEnvelope> {
  const message =
    "Pending Command evidence is unsafe; no evidence was modified."
  return new CliFailure(
    message,
    EXIT_CODE.business,
    createLocalError(localRequestId(), "LOCAL_STATE_UNSAFE", message, false, {
      validRecords,
      invalidEntries,
    })
  )
}

export class PendingCommandService {
  private readonly now: () => Date

  constructor(
    private readonly repository: PendingCommandRepository,
    private readonly state: CliStateStore,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async pending(): Promise<CliOutcome> {
    const scan = await this.repository.scan()
    const scope = await readCurrentScope(this.state)
    let nowMilliseconds = Number.NaN
    try {
      nowMilliseconds = this.now().getTime()
    } catch {
      // 与非法 Date 统一走下方的 fail-loud 证据路径。
    }

    const validRecords: Array<PendingCommandView> = []
    const invalidEntries: Array<ControlledInvalidEntry> =
      scan.invalidEntries.map((entry) => ({
        recordId: entry.recordId,
        reason: entry.reason,
      }))

    if (!Number.isFinite(nowMilliseconds)) {
      invalidEntries.push({ recordId: null, reason: "schema" })
    } else {
      for (const entry of scan.records) {
        const view = mapRecord(
          entry.recordId,
          entry.record,
          scope,
          nowMilliseconds
        )
        if (view === null) {
          invalidEntries.push({ recordId: entry.recordId, reason: "schema" })
        } else {
          validRecords.push(view)
        }
      }
    }

    validRecords.sort(compareViews)
    invalidEntries.sort(compareInvalidEntries)
    if (invalidEntries.length > 0) {
      throw unsafeFailure(validRecords, invalidEntries)
    }

    return {
      exitCode: EXIT_CODE.success,
      envelope: createLocalSuccess(
        localRequestId(),
        { records: validRecords, counts: countsFor(validRecords) },
        { cliVersion: CLI_VERSION }
      ),
      warnings: [],
    }
  }
}
