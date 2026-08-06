import { Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import {
  FeedbackCommandService,
  readFeedbackStdin,
} from "../src/commands/feedback-command-service.js"
import { HttpTransportError } from "../src/http/client.js"
import type { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import type { PublicEnvelope } from "../src/contracts/envelope.js"
import type { JsonObject } from "../src/contracts/json.js"
import type {
  PublicHttpClient,
  PublicResponse,
} from "../src/http/client.js"

const FEEDBACK_ID = "123e4567-e89b-42d3-a456-426614174000"
const RECEIVED_AT = "2026-08-05T08:00:00.000Z"
const KEY = "feedback_123"

function response(
  envelope: PublicEnvelope,
  status = envelope.ok ? 200 : 400
): PublicResponse {
  return {
    response: {
      status,
      headers: {},
      text: JSON.stringify(envelope),
      requestId: envelope.meta.requestId,
    },
    envelope,
    retryAfterSeconds: null,
  }
}

function successEnvelope(
  data: JsonObject = {}
): PublicEnvelope {
  return {
    ok: true,
    data: {
      feedbackId: FEEDBACK_ID,
      receivedAt: RECEIVED_AT,
      duplicate: false,
      redactionApplied: false,
      ...data,
    },
    meta: { requestId: "feedback_response", apiVersion: "v1" },
  }
}

function errorEnvelope(
  code: string,
  retryable: boolean,
  details: JsonObject = {}
): PublicEnvelope {
  return {
    ok: false,
    error: {
      code,
      message: "Feedback was rejected.",
      retryable,
      details,
    },
    meta: { requestId: "feedback_error", apiVersion: "v1" },
  }
}

function harness(options: {
  result?: PublicResponse
  failure?: unknown
  readStdin?: () => Promise<string>
} = {}) {
  const local = {
    requireLocated: vi.fn(() =>
      Promise.resolve({
        index: { issuerOrigin: "https://api.adrate.io" },
        token: "owner-token",
        credentials: { teamId: 42 },
      })
    ),
  }
  const requestPublic = options.failure
    ? vi.fn(() => Promise.reject(options.failure))
    : vi.fn(() => Promise.resolve(options.result ?? response(successEnvelope())))
  const service = new FeedbackCommandService(
    { requestPublic } as unknown as PublicHttpClient,
    local as unknown as LocalCredentialCoordinator,
    {
      generateIdempotencyKey: () => KEY,
      readStdin: options.readStdin ?? (() => Promise.resolve("stdin message")),
      environment: { ADRATE_NO_CREDENTIAL_NOTIFIER: "1" },
      clientMetadata: {
        cliVersion: "0.1.0-beta.6",
        platform: "darwin-arm64",
        nodeVersion: "v22.20.0",
      },
    }
  )
  return { service, local, requestPublic }
}

describe("FeedbackCommandService", () => {
  it("发送精确的 15 秒 POST 且只在回执完整时报告成功", async () => {
    const value = harness({
      result: response(
        successEnvelope({
          duplicate: true,
          redactionApplied: true,
          futureField: "allowed",
        })
      ),
    })
    const outcome = await value.service.submit({
      category: "bug",
      message: "quotes '$()'\n--literal",
      messageStdin: false,
      requestId: "feedback_request",
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.humanLines).toEqual([
      `Feedback received: ${FEEDBACK_ID}`,
      "This feedback was already received; no duplicate row was created.",
      "Sensitive-looking content was redacted before storage.",
    ])
    expect(value.requestPublic).toHaveBeenCalledWith({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/feedback",
      token: "owner-token",
      idempotencyKey: KEY,
      json: {
        category: "bug",
        message: "quotes '$()'\n--literal",
        cliVersion: "0.1.0-beta.6",
        platform: "darwin-arm64",
        nodeVersion: "v22.20.0",
      },
      requestId: "feedback_request",
      deadlineMs: 15_000,
    })
  })

  it("stdin 正文作为字面 body 传递，不使用 argv 正文", async () => {
    const readStdin = vi.fn(() =>
      Promise.resolve("--leading '$()'\nsecond line")
    )
    const value = harness({ readStdin })
    await value.service.submit({
      category: "blocked",
      messageStdin: true,
      idempotencyKey: "explicit_key",
    })

    expect(readStdin).toHaveBeenCalledTimes(1)
    expect(value.requestPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "explicit_key",
        json: expect.objectContaining({
          message: "--leading '$()'\nsecond line",
        }),
      })
    )
  })

  it("输入错误在凭据和网络之前收口", async () => {
    for (const input of [
      { category: "future", message: "text", messageStdin: false },
      { category: "bug", message: "   ", messageStdin: false },
      { category: "bug", message: "x".repeat(4_001), messageStdin: false },
      {
        category: "bug",
        message: "😀".repeat(4_001),
        messageStdin: false,
      },
      { category: "bug", message: "text", messageStdin: true },
    ]) {
      const value = harness()
      await expect(value.service.submit(input)).rejects.toMatchObject({
        exitCode: 2,
      })
      expect(value.local.requireLocated).not.toHaveBeenCalled()
      expect(value.requestPublic).not.toHaveBeenCalled()
    }
  })

  it.each([
    ["feedbackId", "not-a-uuid"],
    ["receivedAt", "2026-08-05 08:00:00"],
    ["duplicate", "false"],
    ["redactionApplied", null],
  ])("回执 %s 不可信时退出 4 且保留 Key", async (field, invalid) => {
    const value = harness({
      result: response(successEnvelope({ [field]: invalid })),
    })
    await expect(
      value.service.submit({
        category: "other",
        message: "text",
        messageStdin: false,
      })
    ).rejects.toMatchObject({
      exitCode: 4,
      warnings: [expect.stringContaining(KEY)],
    })
  })

  it("transport 丢失不自动重试，退出 4 并输出原 Key", async () => {
    const value = harness({
      failure: new HttpTransportError("network", "lost response"),
    })
    await expect(
      value.service.submit({
        category: "suggestion",
        message: "same intent",
        messageStdin: false,
        idempotencyKey: "same_key",
      })
    ).rejects.toMatchObject({
      exitCode: 4,
      warnings: [expect.stringContaining("same_key")],
    })
    expect(value.requestPublic).toHaveBeenCalledTimes(1)
  })

  it("scope missing 给出重新授权顺序，不进入 Command 恢复", async () => {
    const value = harness({
      result: response(
        errorEnvelope("CAPABILITY_DENIED", false, {
          unavailableReason: "credential_scope_missing",
        }),
        403
      ),
    })
    const outcome = await value.service.submit({
      category: "blocked",
      message: "old session",
      messageStdin: false,
    })

    expect(outcome.exitCode).toBe(1)
    expect(outcome.warnings.join("\n")).toContain("commands pending")
    expect(outcome.warnings.join("\n")).toContain("auth logout")
    expect(outcome.warnings.join("\n")).toContain(KEY)
  })

  it("RATE_LIMITED 保留服务端 Retry-After 和同一 Key", async () => {
    const envelope = errorEnvelope("RATE_LIMITED", true)
    const result = response(envelope, 429)
    result.envelope = {
      ...envelope,
      meta: { ...envelope.meta, retryAfterSeconds: 60 },
    }
    const value = harness({ result })
    const outcome = await value.service.submit({
      category: "other",
      message: "rate",
      messageStdin: false,
    })
    expect(outcome.exitCode).toBe(4)
    expect(outcome.warnings.join("\n")).toContain("Retry after 60")
    expect(outcome.warnings.join("\n")).toContain(KEY)
  })
})

describe("readFeedbackStdin", () => {
  it("保留合法 UTF-8 字节，拒绝超限与非法 UTF-8", async () => {
    await expect(
      readFeedbackStdin(Readable.from([Buffer.from("'$()'\n--literal")]))
    ).resolves.toBe("'$()'\n--literal")
    await expect(
      readFeedbackStdin(Readable.from([Buffer.alloc(16 * 1024 + 1, 0x61)]))
    ).rejects.toMatchObject({ exitCode: 2 })
    await expect(
      readFeedbackStdin(Readable.from([Buffer.from([0xff])]))
    ).rejects.toMatchObject({ exitCode: 2 })
  })
})
