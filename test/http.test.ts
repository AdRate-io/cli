import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEADLINES_MS } from "../src/constants.js"
import {
  DefaultHttpTransport,
  HttpTransportError,
  PublicHttpClient,
  parseRetryAfter,
} from "../src/http/client.js"
import {
  ISSUERS,
  assertIssuerPair,
  environmentForMachineOrigin,
  issuerForEnvironment,
  validateBrowserUrl,
} from "../src/config/issuer.js"
import { CliFailure } from "../src/errors.js"
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  PublicRequestInput,
} from "../src/http/client.js"

const undiciMock = vi.hoisted(() => ({
  fetch: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
  agentOptions: [] as Array<unknown>,
}))

vi.mock("undici", () => ({
  Agent: class FakeAgent {
    constructor(options: unknown) {
      undiciMock.agentOptions.push(options)
    }

    close(): Promise<void> {
      return undiciMock.close()
    }
  },
  Headers: globalThis.Headers,
  fetch: undiciMock.fetch,
}))

function publicUsage(
  operationUnitsCharged: 0 | 1 | 2 | 3 | null
): Record<string, unknown> {
  return {
    operationUnits: 2,
    operationUnitsCharged,
    minute: {
      limit: 60,
      remaining: 59,
      resetAt: "2026-07-31T08:01:00.000Z",
      burst: 10,
    },
    writeMinute: {
      limit: 10,
      remaining: 10,
      resetAt: "2026-07-31T08:01:00.000Z",
    },
    dailyTikTokUnits: {
      limit: 3000,
      remaining: 2998,
      resetAt: "2026-08-01T00:00:00.000Z",
    },
  }
}

function successEnvelope(
  requestId: string,
  meta: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    ok: true,
    data: { value: "ok" },
    meta: {
      ...meta,
      requestId,
      apiVersion: "v1",
    },
  })
}

function errorEnvelope(
  requestId: string,
  resolutionUrl: string | null
): string {
  return JSON.stringify({
    ok: false,
    error: {
      code: "INVALID_CREDENTIAL",
      message: "Credential is invalid.",
      retryable: false,
      details: {
        suggestedAction: "open_account_security",
        resolutionUrl,
      },
    },
    meta: {
      requestId,
      apiVersion: "v1",
    },
  })
}

class StaticTransport implements HttpTransport {
  readonly requests: Array<HttpRequest> = []
  private readonly response: HttpResponse

  constructor(response: HttpResponse, defaultJsonContentType = true) {
    this.response = {
      ...response,
      headers: {
        ...(defaultJsonContentType
          ? { "content-type": "application/json; charset=utf-8" }
          : {}),
        ...response.headers,
      },
    }
  }

  request(input: HttpRequest): Promise<HttpResponse> {
    this.requests.push(input)
    return Promise.resolve(this.response)
  }
}

beforeEach(() => {
  undiciMock.fetch.mockReset()
  undiciMock.close.mockClear()
  undiciMock.agentOptions.length = 0
})

describe("issuer allowlist", () => {
  it("只提供冻结的 production/test 机器面和浏览器面配对", () => {
    expect(issuerForEnvironment("production")).toEqual({
      environment: "production",
      machineOrigin: "https://api.adrate.io",
      browserOrigin: "https://app.adrate.io",
    })
    expect(issuerForEnvironment("test")).toEqual({
      environment: "test",
      machineOrigin: "https://api.test.adrate.io",
      browserOrigin: "https://test.adrate.io",
    })
    expect(Object.keys(ISSUERS).sort()).toEqual(["production", "test"])
    expect(environmentForMachineOrigin("https://api.adrate.io")).toBe(
      "production"
    )
    expect(environmentForMachineOrigin("https://api.test.adrate.io")).toBe(
      "test"
    )
    expect(environmentForMachineOrigin("http://localhost:9527")).toBeNull()
    expect(environmentForMachineOrigin("https://attacker.example")).toBeNull()
  })

  it("本地 environment 与 issuer 必须精确配对", () => {
    expect(() =>
      assertIssuerPair("production", "https://api.adrate.io")
    ).not.toThrow()
    expect(() =>
      assertIssuerPair("test", "https://api.test.adrate.io")
    ).not.toThrow()
    expect(() =>
      assertIssuerPair("production", "https://api.test.adrate.io")
    ).toThrow(CliFailure)
    expect(() =>
      assertIssuerPair("development", "https://api.adrate.io")
    ).toThrow(CliFailure)
  })

  it("浏览器 URL 必须 HTTPS、无 userinfo、同环境精确 origin", () => {
    expect(
      validateBrowserUrl(
        "https://app.adrate.io/settings/security?tab=cli",
        "https://api.adrate.io"
      )
    ).toBe("https://app.adrate.io/settings/security?tab=cli")
    expect(
      validateBrowserUrl(
        "https://test.adrate.io/cli/authorize?user_code=ABCD-EFGH",
        "https://api.test.adrate.io"
      )
    ).toBe("https://test.adrate.io/cli/authorize?user_code=ABCD-EFGH")

    for (const value of [
      "http://app.adrate.io/settings/security",
      "https://user:pass@app.adrate.io/settings/security",
      "https://test.adrate.io/settings/security",
      "https://app.adrate.io.attacker.example/settings/security",
      "not-a-url",
    ]) {
      expect(() => validateBrowserUrl(value, "https://api.adrate.io")).toThrow(
        CliFailure
      )
    }
  })
})

describe("DefaultHttpTransport", () => {
  it("固定 HTTPS issuer、CLI origin/header、Bearer、manual redirect 与连接 deadline", async () => {
    undiciMock.fetch.mockResolvedValueOnce(
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "server-request-1",
        },
      })
    )
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout")
    const transport = new DefaultHttpTransport()
    const response = await transport.request({
      method: "GET",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/me",
      deadlineMs: DEADLINES_MS.statusWrite,
      requestId: "client-request-1",
      token: "opaque-session-token",
    })

    expect(response).toMatchObject({
      status: 200,
      requestId: "server-request-1",
      text: '{"ok":true}',
    })
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = undiciMock.fetch.mock.calls[0] as [
      URL,
      {
        headers: Headers
        redirect: string
        method: string
        dispatcher: unknown
      },
    ]
    expect(url.toString()).toBe("https://api.adrate.io/public/v1/me")
    expect(init.method).toBe("GET")
    expect(init.redirect).toBe("manual")
    expect(init.headers.get("Accept")).toBe("application/json")
    expect(init.headers.get("X-AdRate-Origin")).toBe("cli")
    expect(init.headers.get("X-Request-Id")).toBe("client-request-1")
    expect(init.headers.get("Authorization")).toBe(
      "Bearer opaque-session-token"
    )
    expect(undiciMock.agentOptions).toEqual([
      { connect: { timeout: DEADLINES_MS.connect } },
    ])
    expect(timeoutSpy.mock.calls.some((call) => call[1] === 120_000)).toBe(true)
    expect(undiciMock.close).toHaveBeenCalledTimes(1)
    timeoutSpy.mockRestore()
  })

  it("OAuth form 使用严格 content type，且无 Token 时不构造 Authorization", async () => {
    undiciMock.fetch.mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "X-Request-Id": "oauth-response-1" },
      })
    )
    const form = new URLSearchParams({
      client_id: "adrate-cli",
      scope: "identity.read",
    })
    await new DefaultHttpTransport().request({
      method: "POST",
      issuerOrigin: "https://api.test.adrate.io",
      path: "/oauth/device/code",
      deadlineMs: DEADLINES_MS.standard,
      requestId: "oauth-request-1",
      form,
    })

    const [, init] = undiciMock.fetch.mock.calls[0] as [
      URL,
      { headers: Headers; body: string },
    ]
    expect(init.headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded"
    )
    expect(init.headers.has("Authorization")).toBe(false)
    expect(init.body).toBe("client_id=adrate-cli&scope=identity.read")
  })

  it("Public JSON POST 固定 120 秒并发送精确 body 与 Idempotency-Key", async () => {
    const responseRequestId = "status-response-1"
    undiciMock.fetch.mockResolvedValueOnce(
      new Response(successEnvelope(responseRequestId), {
        status: 202,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Request-Id": responseRequestId,
        },
      })
    )
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout")
    await new PublicHttpClient().requestPublic({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
      token: "opaque-session-token",
      idempotencyKey: "abc_DEF-9",
      json: { desiredStatus: "ENABLE", authId: 42 },
      requestId: "status-request-1",
      deadlineMs: 120_000,
    })

    const [url, init] = undiciMock.fetch.mock.calls[0] as [
      URL,
      { method: string; headers: Headers; body: string; redirect: string },
    ]
    expect(url.toString()).toBe(
      "https://api.adrate.io/public/v1/ads/advertisers/70001/campaigns/80001/status"
    )
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("manual")
    expect(init.headers.get("Content-Type")).toBe("application/json")
    expect(init.headers.get("Idempotency-Key")).toBe("abc_DEF-9")
    expect(init.headers.get("Authorization")).toBe(
      "Bearer opaque-session-token"
    )
    expect(init.body).toBe('{"desiredStatus":"ENABLE","authId":42}')
    expect(timeoutSpy.mock.calls.some((call) => call[1] === 120_000)).toBe(true)
    timeoutSpy.mockRestore()
  })

  it("标准 Public JSON POST 显式锁定 15 秒", async () => {
    const requestId = "feedback-response-1"
    const transport = new StaticTransport({
      status: 200,
      headers: {},
      requestId,
      text: successEnvelope(requestId),
    })
    await new PublicHttpClient(transport).requestPublic({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/feedback",
      token: "opaque-session-token",
      idempotencyKey: "feedback_key",
      json: { category: "bug", message: "literal $()" },
      deadlineMs: 15_000,
    })

    expect(transport.requests).toEqual([
      {
        method: "POST",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/feedback",
        token: "opaque-session-token",
        idempotencyKey: "feedback_key",
        json: { category: "bug", message: "literal $()" },
        deadlineMs: 15_000,
      },
    ])
  })

  it("Public JSON POST 在 fetch 前拒绝非法 Key 和非 15/120 秒 deadline", async () => {
    const client = new PublicHttpClient()
    await expect(
      client.requestPublic({
        method: "POST",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
        token: "opaque-session-token",
        idempotencyKey: "../secret",
        json: { desiredStatus: "ENABLE" },
        deadlineMs: 120_000,
      })
    ).rejects.toMatchObject({ kind: "invalid_response" })

    const wrongDeadline = {
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
      token: "opaque-session-token",
      idempotencyKey: "abc_DEF-9",
      json: { desiredStatus: "ENABLE" },
      deadlineMs: 45_000,
    } as unknown as PublicRequestInput
    await expect(client.requestPublic(wrongDeadline)).rejects.toMatchObject({
      kind: "invalid_response",
    })
    expect(undiciMock.fetch).not.toHaveBeenCalled()
  })

  it("Public JSON POST 拒绝 redirect，不跟随携带 Token 与 Key", async () => {
    undiciMock.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: {
          Location: "https://attacker.example/collect",
          "X-Request-Id": "status-redirect",
        },
      })
    )
    await expect(
      new PublicHttpClient().requestPublic({
        method: "POST",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
        token: "opaque-session-token",
        idempotencyKey: "abc_DEF-9",
        json: { desiredStatus: "ENABLE" },
        deadlineMs: 120_000,
      })
    ).rejects.toMatchObject({ kind: "invalid_response" })
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["http://api.adrate.io", "/public/v1/me"],
    ["https://api.adrate.io/path", "/public/v1/me"],
    ["https://attacker.example", "/public/v1/me"],
    ["https://api.adrate.io", "https://attacker.example/public/v1/me"],
    ["https://api.adrate.io", "//attacker.example/public/v1/me"],
  ])("在 fetch 前拒绝不安全 URL: %s %s", async (issuerOrigin, path) => {
    await expect(
      new DefaultHttpTransport().request({
        method: "GET",
        issuerOrigin,
        path,
        deadlineMs: DEADLINES_MS.standard,
      })
    ).rejects.toMatchObject({
      kind: "invalid_response",
    })
    expect(undiciMock.fetch).not.toHaveBeenCalled()
  })

  it("拒绝任何 redirect，不会携带 Authorization 跟随", async () => {
    undiciMock.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          Location: "https://attacker.example/collect",
          "X-Request-Id": "redirect-response",
        },
      })
    )
    await expect(
      new DefaultHttpTransport().request({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/me",
        token: "opaque-session-token",
        deadlineMs: DEADLINES_MS.standard,
      })
    ).rejects.toMatchObject({
      kind: "invalid_response",
    })
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1)
  })

  it("最终响应必须提供合法 X-Request-Id", async () => {
    undiciMock.fetch.mockResolvedValueOnce(new Response("{}", { status: 200 }))
    await expect(
      new DefaultHttpTransport().request({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/me",
        deadlineMs: DEADLINES_MS.standard,
      })
    ).rejects.toMatchObject({
      kind: "invalid_response",
    })
  })
})

describe("OAuth HTTP response boundary", () => {
  const deviceSuccess = JSON.stringify({
    device_code: "A".repeat(43),
    user_code: "ABCD-EFGH",
    verification_uri: "https://app.adrate.io/cli/authorize",
    verification_uri_complete:
      "https://app.adrate.io/cli/authorize?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 5,
  })
  const tokenSuccess = JSON.stringify({
    access_token: `adr_owner_11111111-1111-4111-8111-111111111111_${"A".repeat(43)}`,
    token_type: "Bearer",
    expires_in: 600,
    activation_expires_at: "2026-07-31T08:10:00.000Z",
    idle_expires_at: null,
    absolute_expires_at: "2026-10-29T08:00:00.000Z",
    credential_kind: "adrate_sliding_session",
  })
  const oauthError = JSON.stringify({
    error: "temporarily_unavailable",
  })

  it.each([
    ["/oauth/device/code", deviceSuccess],
    ["/oauth/token", tokenSuccess],
  ] as const)("接受 %s 的严格 2xx JSON 成功合同", async (path, text) => {
    const requestId = "oauth-success"
    const response = await new PublicHttpClient(
      new StaticTransport({
        status: 200,
        headers: {},
        requestId,
        text,
      })
    ).requestRaw({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path,
      deadlineMs: DEADLINES_MS.standard,
    })
    expect(response.status).toBe(200)
  })

  it.each([
    ["/oauth/device/code", 200, oauthError],
    ["/oauth/device/code", 400, deviceSuccess],
    ["/oauth/token", 200, oauthError],
    ["/oauth/token", 503, tokenSuccess],
  ] as const)(
    "拒绝 %s HTTP %s 与 OAuth body 错配",
    async (path, status, text) => {
      const requestId = "oauth-status-mismatch"
      await expect(
        new PublicHttpClient(
          new StaticTransport({
            status,
            headers: {},
            requestId,
            text,
          })
        ).requestRaw({
          method: "POST",
          issuerOrigin: "https://api.adrate.io",
          path,
          deadlineMs: DEADLINES_MS.standard,
        })
      ).rejects.toMatchObject({ kind: "invalid_response" })
    }
  )

  it("OAuth 错误必须是严格 JSON Content-Type 与错误合同", async () => {
    const requestId = "oauth-strict-error"
    const valid = await new PublicHttpClient(
      new StaticTransport({
        status: 503,
        headers: {},
        requestId,
        text: oauthError,
      })
    ).requestRaw({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/oauth/device/code",
      deadlineMs: DEADLINES_MS.standard,
    })
    expect(valid.status).toBe(503)

    for (const response of [
      new StaticTransport(
        {
          status: 503,
          headers: {},
          requestId,
          text: oauthError,
        },
        false
      ),
      new StaticTransport({
        status: 503,
        headers: { "content-type": "text/plain" },
        requestId,
        text: oauthError,
      }),
      new StaticTransport({
        status: 503,
        headers: {},
        requestId,
        text: JSON.stringify({
          error: "temporarily_unavailable",
          internal: true,
        }),
      }),
    ]) {
      await expect(
        new PublicHttpClient(response).requestRaw({
          method: "POST",
          issuerOrigin: "https://api.adrate.io",
          path: "/oauth/device/code",
          deadlineMs: DEADLINES_MS.standard,
        })
      ).rejects.toBeInstanceOf(HttpTransportError)
    }
  })
})

describe("PublicHttpClient envelope boundary", () => {
  it("Public JSON POST accepts extra top-level fields in a valid envelope", async () => {
    const requestId = "status-extra-envelope"
    const validWithExtra = new StaticTransport({
      status: 200,
      headers: {},
      requestId,
      text: JSON.stringify({
        ok: true,
        data: { command: {} },
        meta: { requestId, apiVersion: "v1" },
        internal: true,
      }),
    })
    const result = await new PublicHttpClient(validWithExtra).requestPublic({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/ads/advertisers/70001/campaigns/80001/status",
      token: "opaque-session-token",
      idempotencyKey: "abc_DEF-9",
      json: { desiredStatus: "ENABLE" },
      deadlineMs: 120_000,
    })
    expect(result.envelope.ok).toBe(true)
  })

  it.each([
    [undefined, false],
    ["text/plain", true],
  ] as const)(
    "拒绝非 JSON Content-Type: %s",
    async (contentType, defaultJsonContentType) => {
      const requestId = "invalid-content-type"
      const transport = new StaticTransport(
        {
          status: 200,
          headers:
            contentType === undefined ? {} : { "content-type": contentType },
          requestId,
          text: successEnvelope(requestId),
        },
        defaultJsonContentType
      )
      await expect(
        new PublicHttpClient(transport).requestPublic({
          method: "GET",
          issuerOrigin: "https://api.adrate.io",
          path: "/public/v1/me",
          token: "token",
          deadlineMs: DEADLINES_MS.standard,
        })
      ).rejects.toMatchObject({
        exitCode: 4,
        envelope: {
          error: {
            details: { responseKind: "invalid_content_type" },
          },
        },
      })
    }
  )

  it.each([
    "application/json; charset=latin1",
    "application/json; charset=utf-8; profile=extended",
  ])("accepts relaxed JSON Content-Type: %s", async (contentType) => {
    const requestId = "relaxed-content-type"
    const transport = new StaticTransport({
      status: 200,
      headers: { "content-type": contentType },
      requestId,
      text: successEnvelope(requestId),
    })
    const result = await new PublicHttpClient(transport).requestPublic({
      method: "GET",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/me",
      token: "token",
      deadlineMs: DEADLINES_MS.standard,
    })
    expect(result.envelope.ok).toBe(true)
  })

  it.each([
    [200, errorEnvelope("status-error-on-success", null)],
    [202, errorEnvelope("status-error-on-accepted", null)],
    [400, successEnvelope("status-success-on-error")],
    [429, successEnvelope("status-success-on-rate-limit")],
    [302, errorEnvelope("status-error-on-redirect", null)],
  ])("拒绝 HTTP %s 与 Envelope ok 状态错配", async (status, text) => {
    const parsed = JSON.parse(text) as {
      meta: { requestId: string }
    }
    const transport = new StaticTransport({
      status,
      headers: {},
      requestId: parsed.meta.requestId,
      text,
    })
    await expect(
      new PublicHttpClient(transport).requestPublic({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/me",
        token: "token",
        deadlineMs: DEADLINES_MS.standard,
      })
    ).rejects.toMatchObject({
      exitCode: 4,
      envelope: {
        error: {
          details: { responseKind: "status_envelope_mismatch" },
        },
      },
    })
  })

  it("accepts error envelope with extra top-level or error fields", async () => {
    const requestId = "relaxed-error-contract"
    for (const body of [
      {
        ...JSON.parse(errorEnvelope(requestId, null)),
        data: {},
      },
      {
        ...JSON.parse(errorEnvelope(requestId, null)),
        error: {
          ...(
            JSON.parse(errorEnvelope(requestId, null)) as {
              error: Record<string, unknown>
            }
          ).error,
          internal: "not-public",
        },
      },
    ]) {
      const transport = new StaticTransport({
        status: 401,
        headers: {},
        requestId,
        text: JSON.stringify(body),
      })
      const result = await new PublicHttpClient(transport).requestPublic({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/me",
        token: "token",
        deadlineMs: DEADLINES_MS.standard,
      })
      expect(result.envelope.ok).toBe(false)
    }
  })

  it.each([0, 1, 2, 3, null] as const)(
    "接受 operationUnitsCharged=%s",
    async (charged) => {
      const requestId = `charged-${String(charged)}`
      const transport = new StaticTransport({
        status: 200,
        headers: { "x-request-id": requestId },
        requestId,
        text: successEnvelope(requestId, {
          usage: publicUsage(charged),
        }),
      })
      const result = await new PublicHttpClient(transport).requestPublic({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/me",
        token: "token",
        deadlineMs: DEADLINES_MS.standard,
      })
      expect(result.envelope.meta.usage?.operationUnitsCharged).toBe(charged)
    }
  )

  it.each([4, -1, "2", undefined])(
    "拒绝非法 operationUnitsCharged=%s",
    async (charged) => {
      const requestId = "invalid-charged"
      const usage = publicUsage(2)
      if (charged === undefined) {
        delete usage.operationUnitsCharged
      } else {
        usage.operationUnitsCharged = charged
      }
      const transport = new StaticTransport({
        status: 200,
        headers: {},
        requestId,
        text: successEnvelope(requestId, { usage }),
      })
      await expect(
        new PublicHttpClient(transport).requestPublic({
          method: "GET",
          issuerOrigin: "https://api.adrate.io",
          path: "/public/v1/me",
          token: "token",
          deadlineMs: DEADLINES_MS.standard,
        })
      ).rejects.toBeInstanceOf(CliFailure)
    }
  )

  it("响应 Header requestId 是最终权威，必须与 Envelope 一致", async () => {
    const transport = new StaticTransport({
      status: 200,
      headers: {},
      requestId: "header-request",
      text: successEnvelope("body-request"),
    })
    await expect(
      new PublicHttpClient(transport).requestPublic({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/me",
        token: "token",
        deadlineMs: DEADLINES_MS.standard,
      })
    ).rejects.toMatchObject({
      exitCode: 4,
    })
  })

  it("Retry-After Header 进入返回值与 JSON meta，不信 body 自报", async () => {
    const requestId = "public-retry-after"
    const transport = new StaticTransport({
      status: 401,
      headers: { "retry-after": "17" },
      requestId,
      text: errorEnvelope(requestId, null),
    })
    const result = await new PublicHttpClient(transport).requestPublic({
      method: "GET",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/me",
      token: "token",
      deadlineMs: DEADLINES_MS.standard,
    })

    expect(result.retryAfterSeconds).toBe(17)
    expect(result.envelope.meta.retryAfterSeconds).toBe(17)

    const bodyReportedRetry = JSON.parse(errorEnvelope(requestId, null)) as {
      meta: Record<string, unknown>
    }
    bodyReportedRetry.meta.retryAfterSeconds = 99
    const bodyTransport = new StaticTransport({
      status: 401,
      headers: {},
      requestId,
      text: JSON.stringify(bodyReportedRetry),
    })
    await expect(
      new PublicHttpClient(bodyTransport).requestPublic({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/me",
        token: "token",
        deadlineMs: DEADLINES_MS.standard,
      })
    ).rejects.toMatchObject({ exitCode: 4 })
  })

  it("校验 error resolutionUrl 与 credential notice URL 的环境归属", async () => {
    const safeRequestId = "safe-resolution"
    const safeTransport = new StaticTransport({
      status: 401,
      headers: {},
      requestId: safeRequestId,
      text: errorEnvelope(
        safeRequestId,
        "https://app.adrate.io/settings/security"
      ),
    })
    const safe = await new PublicHttpClient(safeTransport).requestPublic({
      method: "GET",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/me",
      token: "token",
      deadlineMs: DEADLINES_MS.standard,
    })
    expect(safe.envelope.ok).toBe(false)

    for (const text of [
      errorEnvelope(
        "bad-error-resolution",
        "https://test.adrate.io/settings/security"
      ),
      successEnvelope("bad-notice-resolution", {
        _notice: {
          credential: {
            message: "Renew soon.",
            resolutionUrl: "https://attacker.example/collect",
          },
        },
      }),
    ]) {
      const parsed = JSON.parse(text) as {
        meta: { requestId: string }
      }
      const transport = new StaticTransport({
        status: 200,
        headers: {},
        requestId: parsed.meta.requestId,
        text,
      })
      await expect(
        new PublicHttpClient(transport).requestPublic({
          method: "GET",
          issuerOrigin: "https://api.adrate.io",
          path: "/public/v1/me",
          token: "token",
          deadlineMs: DEADLINES_MS.standard,
        })
      ).rejects.toMatchObject({ exitCode: 4 })
    }
  })

  it("拒绝非 JSON 和缺少 meta 的非信封响应", async () => {
    for (const text of [
      "<html>gateway error</html>",
      JSON.stringify({ ok: true, data: {}, meta: {} }),
    ]) {
      const transport = new StaticTransport({
        status: 502,
        headers: {},
        requestId: "unknown-code",
        text,
      })
      await expect(
        new PublicHttpClient(transport).requestPublic({
          method: "GET",
          issuerOrigin: "https://api.adrate.io",
          path: "/public/v1/me",
          token: "token",
          deadlineMs: DEADLINES_MS.standard,
        })
      ).rejects.toBeInstanceOf(CliFailure)
    }
  })

  it("accepts unknown error codes from the server", async () => {
    const requestId = "unknown-code"
    for (const code of ["NOT_A_PUBLIC_CODE", "LOCAL_STATE_UNSAFE", "FUTURE_ERROR"]) {
      const transport = new StaticTransport({
        status: 400,
        headers: {},
        requestId,
        text: JSON.stringify({
          ok: false,
          error: { code, message: "unknown", retryable: false, details: {} },
          meta: { requestId, apiVersion: "v1" },
        }),
      })
      const result = await new PublicHttpClient(transport).requestPublic({
        method: "GET",
        issuerOrigin: "https://api.adrate.io",
        path: "/public/v1/me",
        token: "token",
        deadlineMs: DEADLINES_MS.standard,
      })
      expect(result.envelope.ok).toBe(false)
    }
  })
})

describe("HTTP retry metadata", () => {
  it("deadline 常量覆盖 15/45/120 秒，连接上限固定 10 秒", () => {
    expect(DEADLINES_MS).toEqual({
      standard: 15_000,
      campaignRead: 45_000,
      statusWrite: 120_000,
      connect: 10_000,
    })
    expect(DEADLINES_MS.statusWrite).toBeGreaterThan(90_000)
    expect(DEADLINES_MS.statusWrite).toBeGreaterThan(110_000)
  })

  it.each([
    [{ "retry-after": "1" }, 86_400, 1],
    [{ "retry-after": "30" }, 30, 30],
    [{ "retry-after": "0" }, 86_400, null],
    [{ "retry-after": "01" }, 86_400, null],
    [{ "retry-after": "31" }, 30, null],
    [{ "retry-after": "1.5" }, 86_400, null],
    [{}, 86_400, null],
  ] as const)("严格解析 Retry-After %j", (headers, maximum, expected) => {
    expect(parseRetryAfter(headers, maximum)).toBe(expected)
  })
})
