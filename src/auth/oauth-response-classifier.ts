import {
  decodeDeviceTokenResponse,
  decodeOAuthError,
} from "../contracts/oauth.js"
import { parseRetryAfter } from "../http/client.js"
import {
  resolveSlowDownProtocolInterval,
  resolveTemporaryUnavailablePollSchedule,
} from "./device-poll-backoff.js"
import type { DeviceTokenResponse } from "../contracts/oauth.js"
import type { HttpResponse } from "../http/client.js"

export type OAuthPollClassification =
  | { kind: "token"; token: DeviceTokenResponse }
  | {
      kind: "delivery_unknown"
      responseKind: "invalid_success" | "server_non_json"
    }
  | { kind: "invalid_error"; oauthError: string | null }
  | { kind: "terminal"; oauthError: "access_denied" | "expired_token" }
  | {
      kind: "pending"
      oauthError: "authorization_pending"
      protocolIntervalSeconds: number
    }
  | {
      kind: "slow_down"
      protocolIntervalSeconds: number
      retryAfterSeconds: number
    }
  | { kind: "invalid_slow_down"; protocolIntervalSeconds: number }
  | {
      kind: "temporarily_unavailable"
      protocolIntervalSeconds: number
      nextPollDelaySeconds: number
      retryAfterSeconds: number | null
    }

/** 纯分类器，不写本地状态、不发网络、不决定 CLI 输出。 */
export function classifyOAuthPollResponse(input: {
  response: Pick<HttpResponse, "status" | "text" | "headers">
  receivedAt: string
  protocolIntervalSeconds: number
}): OAuthPollClassification {
  const { response } = input
  if (response.status >= 200 && response.status < 300) {
    const token = decodeDeviceTokenResponse(response.text)
    return token
      ? { kind: "token", token }
      : { kind: "delivery_unknown", responseKind: "invalid_success" }
  }

  const error = decodeOAuthError(response.text)
  if (!error) {
    return response.status >= 500
      ? { kind: "delivery_unknown", responseKind: "server_non_json" }
      : { kind: "invalid_error", oauthError: null }
  }

  if (error.error === "authorization_pending") {
    return {
      kind: "pending",
      oauthError: "authorization_pending",
      protocolIntervalSeconds: input.protocolIntervalSeconds,
    }
  }
  if (error.error === "slow_down") {
    const retryAfter = parseRetryAfter(response.headers, 30)
    return retryAfter === null
      ? {
          kind: "invalid_slow_down",
          protocolIntervalSeconds: input.protocolIntervalSeconds,
        }
      : {
          kind: "slow_down",
          protocolIntervalSeconds: resolveSlowDownProtocolInterval({
            previousProtocolIntervalSeconds: input.protocolIntervalSeconds,
            retryAfterSeconds: retryAfter,
          }),
          retryAfterSeconds: retryAfter,
        }
  }
  if (error.error === "access_denied" || error.error === "expired_token") {
    return { kind: "terminal", oauthError: error.error }
  }
  if (error.error === "temporarily_unavailable") {
    const retryAfterSeconds = parseRetryAfter(response.headers)
    const schedule = resolveTemporaryUnavailablePollSchedule({
      responseReceivedAt: input.receivedAt,
      protocolIntervalSeconds: input.protocolIntervalSeconds,
      retryAfterSeconds,
    })
    return {
      kind: "temporarily_unavailable",
      protocolIntervalSeconds: schedule.protocolIntervalSeconds,
      nextPollDelaySeconds: schedule.nextPollDelaySeconds,
      retryAfterSeconds,
    }
  }
  return { kind: "invalid_error", oauthError: error.error }
}
