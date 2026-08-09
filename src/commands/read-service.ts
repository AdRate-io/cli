import { DEADLINES_MS, EXIT_CODE } from "../constants.js"
import {
  parseDateOnly,
  parsePositiveInteger,
  requireTransportableResourceId,
} from "../contracts/resource-input.js"
import {
  CliFailure,
  authenticationFailure,
  dependencyFailure,
  usageFailure,
} from "../errors.js"
import { HttpTransportError } from "../http/client.js"
import { outcomeFromEnvelope } from "../output.js"
import type { PublicHttpClient } from "../http/client.js"
import type { GlobalOptions, ReadCommand } from "../parser.js"
import type { CliOutcome } from "../errors.js"
import type { LocalCredentialCoordinator } from "../auth/local-credentials.js"

const COPY_TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "processing",
  "completed",
  "failed",
  "partial",
  "cancelled",
])

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw usageFailure(`${flag} is required.`)
  return value
}

function appendOptionalInteger(
  query: URLSearchParams,
  name: string,
  value: string | undefined,
  flag: string,
  maximum = Number.MAX_SAFE_INTEGER
): void {
  if (value === undefined) return
  query.set(name, String(parsePositiveInteger(value, flag, maximum)))
}

function withQuery(path: string, query: URLSearchParams): string {
  const value = query.toString()
  return value.length === 0 ? path : `${path}?${value}`
}

function encodeCapabilityId(value: string): string {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    value === "." ||
    value === ".." ||
    [...value].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 0x1f || code === 0x7f)
    })
  ) {
    throw usageFailure("capabilityId is not a safe path segment.")
  }
  let encoded: string
  try {
    encoded = encodeURIComponent(value)
  } catch {
    throw usageFailure("capabilityId is not a safe path segment.")
  }
  if (encoded !== value) {
    throw usageFailure(
      "capabilityId cannot be transported by the Public API raw-path contract."
    )
  }
  return encoded
}

function assertReportRange(
  startDate: string,
  endDate: string,
  groupBy: "none" | "day" | "hour"
): void {
  const start = parseDateOnly(startDate, "--start-date")
  const end = parseDateOnly(endDate, "--end-date")
  const difference = end.ordinal - start.ordinal
  const maximum = groupBy === "none" ? 365 : groupBy === "day" ? 30 : 0
  if (difference < 0 || difference > maximum) {
    throw usageFailure(`The date range is invalid for --group-by ${groupBy}.`)
  }
}

function assertGmvMaxDateRange(
  fromValue: string | undefined,
  toValue: string | undefined
): Readonly<{ from: string; to: string }> | null {
  if (fromValue === undefined && toValue === undefined) return null
  if (fromValue === undefined || toValue === undefined) {
    throw usageFailure("--from and --to must be supplied together.")
  }
  const from = parseDateOnly(fromValue, "--from")
  const to = parseDateOnly(toValue, "--to")
  const inclusiveDays = to.ordinal - from.ordinal + 1
  if (inclusiveDays < 1 || inclusiveDays > 30) {
    throw usageFailure("--from and --to must span 1 to 30 inclusive days.")
  }
  return { from: from.value, to: to.value }
}

export class ReadCommandService {
  constructor(
    private readonly http: PublicHttpClient,
    private readonly local: LocalCredentialCoordinator,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  async execute(
    command: ReadCommand,
    global: GlobalOptions
  ): Promise<CliOutcome> {
    if (global.test) {
      throw usageFailure(
        "--test is only valid when issuing a new auth login Device flow."
      )
    }
    // 参数与 URL 必须在访问 Keychain/本地凭证前完成。缺参属于纯本地用法错误，
    // 不能触发任何秘密存储访问，更不能触发网络。
    const request = this.buildRequest(command)
    const located = await this.local.requireLocated()
    if (!located.credentials) {
      throw authenticationFailure(
        "The credential has not completed /me activation. Run auth whoami."
      )
    }
    try {
      const result = await this.http.requestPublic({
        method: "GET",
        issuerOrigin: located.index.issuerOrigin,
        path: request.path,
        token: located.token,
        requestId: global.requestId,
        deadlineMs: request.deadlineMs,
      })
      return outcomeFromEnvelope(result.envelope, this.environment)
    } catch (error) {
      if (error instanceof CliFailure) throw error
      if (error instanceof HttpTransportError) {
        throw dependencyFailure(
          "The read request could not be completed. The same read may be retried with a bounded backoff.",
          EXIT_CODE.retryable,
          { failureKind: error.kind }
        )
      }
      throw dependencyFailure(
        "The read request could not be completed.",
        EXIT_CODE.retryable
      )
    }
  }

  private buildRequest(command: ReadCommand): {
    path: string
    deadlineMs: number
  } {
    switch (command.kind) {
      case "capabilities":
        return {
          path: "/public/v1/capabilities",
          deadlineMs: DEADLINES_MS.standard,
        }
      case "schema": {
        const encoded = encodeCapabilityId(command.capabilityId)
        return {
          path: `/public/v1/capabilities/${encoded}`,
          deadlineMs: DEADLINES_MS.standard,
        }
      }
      case "ads.advertisers":
        return {
          path: "/public/v1/ads/advertisers",
          deadlineMs: DEADLINES_MS.standard,
        }
      case "ads.campaigns.list": {
        const advId = requireTransportableResourceId(
          required(command.advId, "--adv-id"),
          "advId"
        )
        const query = new URLSearchParams()
        appendOptionalInteger(query, "authId", command.authId, "--auth-id")
        appendOptionalInteger(query, "page", command.page, "--page")
        appendOptionalInteger(
          query,
          "pageSize",
          command.pageSize,
          "--page-size",
          1000
        )
        return {
          path: withQuery(
            `/public/v1/ads/advertisers/${advId}/campaigns`,
            query
          ),
          deadlineMs: DEADLINES_MS.campaignRead,
        }
      }
      case "ads.campaigns.get": {
        const advId = requireTransportableResourceId(
          required(command.advId, "--adv-id"),
          "advId"
        )
        const campaignId = requireTransportableResourceId(
          required(command.campaignId, "--campaign-id"),
          "campaignId"
        )
        const query = new URLSearchParams()
        appendOptionalInteger(query, "authId", command.authId, "--auth-id")
        return {
          path: withQuery(
            `/public/v1/ads/advertisers/${advId}/campaigns/${campaignId}`,
            query
          ),
          deadlineMs: DEADLINES_MS.campaignRead,
        }
      }
      case "ads.report.campaigns": {
        const advId = requireTransportableResourceId(
          required(command.advId, "--adv-id"),
          "advId"
        )
        const startDate = required(command.startDate, "--start-date")
        const endDate = required(command.endDate, "--end-date")
        const groupBy = command.groupBy ?? "none"
        if (groupBy !== "none" && groupBy !== "day" && groupBy !== "hour") {
          throw usageFailure("--group-by must be none, day, or hour.")
        }
        assertReportRange(startDate, endDate, groupBy)
        const query = new URLSearchParams({ startDate, endDate })
        if (command.groupBy !== undefined) query.set("groupBy", groupBy)
        appendOptionalInteger(query, "authId", command.authId, "--auth-id")
        appendOptionalInteger(query, "page", command.page, "--page")
        appendOptionalInteger(
          query,
          "pageSize",
          command.pageSize,
          "--page-size",
          1000
        )
        return {
          path: withQuery(
            `/public/v1/ads/advertisers/${advId}/reports/campaigns`,
            query
          ),
          deadlineMs: DEADLINES_MS.campaignRead,
        }
      }
      case "ads.copy.tasks.list": {
        const query = new URLSearchParams()
        if (command.status !== undefined) {
          if (!COPY_TASK_STATUSES.has(command.status)) {
            throw usageFailure(
              "--status must be pending, processing, completed, failed, partial, or cancelled."
            )
          }
          query.set("status", command.status)
        }
        appendOptionalInteger(query, "page", command.page, "--page")
        appendOptionalInteger(
          query,
          "pageSize",
          command.pageSize,
          "--page-size",
          100
        )
        return {
          path: withQuery("/public/v1/ads/copy/tasks", query),
          deadlineMs: DEADLINES_MS.standard,
        }
      }
      case "ads.copy.tasks.get": {
        const taskId = parsePositiveInteger(
          required(command.taskId, "--task-id"),
          "--task-id"
        )
        return {
          path: `/public/v1/ads/copy/tasks/${taskId}`,
          deadlineMs: DEADLINES_MS.standard,
        }
      }
      case "gmvmax.stores": {
        const advId = requireTransportableResourceId(
          required(command.advId, "--adv-id"),
          "advId"
        )
        const query = new URLSearchParams({ advId })
        appendOptionalInteger(query, "authId", command.authId, "--auth-id")
        return {
          path: withQuery("/public/v1/gmvmax/stores", query),
          deadlineMs: DEADLINES_MS.gmvMaxRead,
        }
      }
      case "gmvmax.campaigns.list": {
        const advId = requireTransportableResourceId(
          required(command.advId, "--adv-id"),
          "advId"
        )
        const storeId = requireTransportableResourceId(
          required(command.storeId, "--store-id"),
          "storeId"
        )
        const promotionType = required(
          command.promotionType,
          "--promotion-type"
        )
        if (promotionType !== "product" && promotionType !== "live") {
          throw usageFailure("--promotion-type must be product or live.")
        }
        const range = assertGmvMaxDateRange(command.from, command.to)
        const query = new URLSearchParams({ storeId, promotionType })
        if (range) {
          query.set("from", range.from)
          query.set("to", range.to)
        }
        if (command.includeTrend) query.set("includeTrend", "true")
        appendOptionalInteger(query, "authId", command.authId, "--auth-id")
        return {
          path: withQuery(
            `/public/v1/gmvmax/advertisers/${advId}/campaigns`,
            query
          ),
          deadlineMs: DEADLINES_MS.gmvMaxRead,
        }
      }
      case "gmvmax.campaigns.get": {
        const advId = requireTransportableResourceId(
          required(command.advId, "--adv-id"),
          "advId"
        )
        const campaignId = requireTransportableResourceId(
          required(command.campaignId, "--campaign-id"),
          "campaignId"
        )
        const storeId = requireTransportableResourceId(
          required(command.storeId, "--store-id"),
          "storeId"
        )
        const query = new URLSearchParams({ storeId })
        appendOptionalInteger(query, "authId", command.authId, "--auth-id")
        return {
          path: withQuery(
            `/public/v1/gmvmax/advertisers/${advId}/campaigns/${campaignId}`,
            query
          ),
          deadlineMs: DEADLINES_MS.gmvMaxRead,
        }
      }

      case "rules.options": {
        const ruleType = required(command.ruleType, "--rule-type")
        const scope = required(command.scope, "--scope")
        return {
          path: withQuery(
            "/public/v1/rules/options",
            new URLSearchParams({ ruleType, scope })
          ),
          deadlineMs: DEADLINES_MS.standard,
        }
      }
      case "rules.list": {
        const query = new URLSearchParams()
        if (command.ruleType !== undefined) {
          query.set("ruleType", command.ruleType)
        }
        if (command.keyword !== undefined) {
          query.set("keyword", command.keyword)
        }
        appendOptionalInteger(query, "page", command.page, "--page")
        appendOptionalInteger(
          query,
          "pageSize",
          command.pageSize,
          "--page-size",
          100
        )
        return {
          path: withQuery("/public/v1/rules", query),
          deadlineMs: DEADLINES_MS.standard,
        }
      }
      case "rules.get": {
        const ruleId = parsePositiveInteger(
          required(command.ruleId, "--rule-id"),
          "--rule-id"
        )
        return {
          path: `/public/v1/rules/${ruleId}`,
          deadlineMs: DEADLINES_MS.standard,
        }
      }
      case "rules.executions.list": {
        const query = new URLSearchParams()
        if (command.ruleId !== undefined) {
          query.set(
            "ruleId",
            String(parsePositiveInteger(command.ruleId, "--rule-id"))
          )
        }
        if (command.scopeId !== undefined) query.set("scopeId", command.scopeId)
        if (command.result !== undefined) query.set("result", command.result)
        if (command.from !== undefined) query.set("from", command.from)
        if (command.to !== undefined) query.set("to", command.to)
        appendOptionalInteger(query, "page", command.page, "--page")
        appendOptionalInteger(
          query,
          "pageSize",
          command.pageSize,
          "--page-size",
          100
        )
        return {
          path: withQuery("/public/v1/rules/executions", query),
          deadlineMs: DEADLINES_MS.standard,
        }
      }
      case "rules.executions.get": {
        const executionId = parsePositiveInteger(
          required(command.executionId, "--execution-id"),
          "--execution-id"
        )
        return {
          path: `/public/v1/rules/executions/${executionId}`,
          deadlineMs: DEADLINES_MS.standard,
        }
      }
    }
  }
}
