import { describe, expect, it } from "vitest"
import {
  OAUTH_RETRY_AFTER_MAX_SECONDS,
  resolveSlowDownProtocolInterval,
  resolveTemporaryUnavailablePollSchedule,
} from "../src/auth/device-poll-backoff.js"

const RECEIVED_AT = "2026-07-31T08:00:00.000Z"

describe("slow_down Device poll schedule", () => {
  it.each([
    [5, 2, 10],
    [5, 18, 18],
    [28, 1, 30],
    [30, 30, 30],
  ] as const)(
    "uses min(30, max(%s + 5, %s)) = %s",
    (previousProtocolIntervalSeconds, retryAfterSeconds, expected) => {
      expect(
        resolveSlowDownProtocolInterval({
          previousProtocolIntervalSeconds,
          retryAfterSeconds,
        })
      ).toBe(expected)
    }
  )
})

describe("temporarily_unavailable Device poll schedule", () => {
  it.each([
    [600, "2026-07-31T08:10:00.000Z"],
    [86_400, "2026-08-01T08:00:00.000Z"],
  ] as const)(
    "keeps protocol interval while persisting Retry-After=%s",
    (retryAfterSeconds, nextPollAt) => {
      expect(
        resolveTemporaryUnavailablePollSchedule({
          responseReceivedAt: RECEIVED_AT,
          protocolIntervalSeconds: 5,
          retryAfterSeconds,
        })
      ).toEqual({
        protocolIntervalSeconds: 5,
        nextPollDelaySeconds: retryAfterSeconds,
        nextPollAt,
      })
    }
  )

  it.each([null, 0, -1, 1.5, OAUTH_RETRY_AFTER_MAX_SECONDS + 1])(
    "falls back to protocol interval for invalid Retry-After=%s",
    (retryAfterSeconds) => {
      expect(
        resolveTemporaryUnavailablePollSchedule({
          responseReceivedAt: RECEIVED_AT,
          protocolIntervalSeconds: 12,
          retryAfterSeconds,
        })
      ).toEqual({
        protocolIntervalSeconds: 12,
        nextPollDelaySeconds: 12,
        nextPollAt: "2026-07-31T08:00:12.000Z",
      })
    }
  )

  it("never schedules earlier than the current protocol interval", () => {
    expect(
      resolveTemporaryUnavailablePollSchedule({
        responseReceivedAt: RECEIVED_AT,
        protocolIntervalSeconds: 12,
        retryAfterSeconds: 3,
      })
    ).toEqual({
      protocolIntervalSeconds: 12,
      nextPollDelaySeconds: 12,
      nextPollAt: "2026-07-31T08:00:12.000Z",
    })
  })

  it.each([
    ["invalid", 5],
    [RECEIVED_AT, 0],
    [RECEIVED_AT, 31],
  ] as const)(
    "rejects an invalid persisted scheduling base (%s, %s)",
    (responseReceivedAt, protocolIntervalSeconds) => {
      expect(() =>
        resolveTemporaryUnavailablePollSchedule({
          responseReceivedAt,
          protocolIntervalSeconds,
          retryAfterSeconds: 600,
        })
      ).toThrow(TypeError)
    }
  )
})
