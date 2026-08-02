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
    }
  }
}
