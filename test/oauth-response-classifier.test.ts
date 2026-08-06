import { describe, expect, it } from "vitest"
import { classifyOAuthPollResponse } from "../src/auth/oauth-response-classifier.js"

const RECEIVED_AT = "2026-07-31T08:00:00.000Z"

function classify(
  status: number,
  body: unknown,
  options: { retryAfter?: string } = {}
) {
  return classifyOAuthPollResponse({
    response: {
      status,
      text: typeof body === "string" ? body : JSON.stringify(body),
      headers:
        options.retryAfter === undefined
          ? {}
          : { "retry-after": options.retryAfter },
    },
    receivedAt: RECEIVED_AT,
    protocolIntervalSeconds: 5,
  })
}

describe("OAuth poll response classifier", () => {
  it("separates one-time Token success from invalid-success uncertainty", () => {
    expect(
      classify(200, {
        access_token: `adr_owner_11111111-1111-4111-8111-111111111111_${"A".repeat(43)}`,
        token_type: "Bearer",
        expires_in: 600,
        activation_expires_at: "2026-07-31T08:10:00.000Z",
        idle_expires_at: null,
        absolute_expires_at: "2026-10-29T08:00:00.000Z",
        credential_kind: "adrate_sliding_session",
      })
    ).toMatchObject({ kind: "token" })
    expect(classify(200, { token_type: "Bearer" })).toEqual({
      kind: "delivery_unknown",
      responseKind: "invalid_success",
    })
  })

  it("classifies pending, slow_down and terminal outcomes", () => {
    expect(classify(400, { error: "authorization_pending" })).toEqual({
      kind: "pending",
      oauthError: "authorization_pending",
      protocolIntervalSeconds: 5,
    })
    expect(classify(400, { error: "slow_down" }, { retryAfter: "18" })).toEqual(
      {
        kind: "slow_down",
        protocolIntervalSeconds: 18,
        retryAfterSeconds: 18,
      }
    )
    expect(classify(400, { error: "slow_down" })).toEqual({
      kind: "invalid_slow_down",
      protocolIntervalSeconds: 5,
    })
    expect(classify(400, { error: "expired_token" })).toEqual({
      kind: "terminal",
      oauthError: "expired_token",
    })
  })

  it("keeps temporary backoff distinct from the protocol interval", () => {
    expect(
      classify(
        503,
        { error: "temporarily_unavailable" },
        { retryAfter: "86400" }
      )
    ).toEqual({
      kind: "temporarily_unavailable",
      protocolIntervalSeconds: 5,
      nextPollDelaySeconds: 86_400,
      retryAfterSeconds: 86_400,
    })
  })

  it("distinguishes non-JSON 5xx uncertainty from a rejected OAuth error", () => {
    expect(classify(503, "gateway failure")).toEqual({
      kind: "delivery_unknown",
      responseKind: "server_non_json",
    })
    expect(classify(400, { error: "invalid_client" })).toEqual({
      kind: "invalid_error",
      oauthError: "invalid_client",
    })
  })
})
