import { describe, expect, it } from "vitest"
import {
  exitCodeForEnvelope,
  outcomeFromEnvelope,
  renderOutcome,
  warningsForEnvelope,
} from "../src/output.js"
import { oauthWaitOutcome } from "../src/auth/auth-command-support.js"
import type { CliOutcome } from "../src/errors.js"
import type {
  PublicEnvelope,
  PublicErrorCode,
  PublicErrorEnvelope,
  PublicSuccessEnvelope,
} from "../src/contracts/envelope.js"
import type { JsonObject } from "../src/contracts/json.js"

function usage(
  operationUnitsCharged: 0 | 1 | 2 | 3 | null
): PublicEnvelope["meta"]["usage"] {
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
  charged: 0 | 1 | 2 | 3 | null = 0,
  notice?: JsonObject
): PublicSuccessEnvelope {
  return {
    ok: true,
    data: {
      rows: [],
    },
    meta: {
      requestId: "output-request-1",
      apiVersion: "v1",
      usage: usage(charged),
      ...(notice ? { _notice: notice } : {}),
    },
  }
}

function errorEnvelope(
  code: PublicErrorCode,
  retryable: boolean
): PublicErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message: `Failure ${code}`,
      retryable,
      details: {
        suggestedAction: null,
        resolutionUrl: null,
      },
    },
    meta: {
      requestId: "output-error-1",
      apiVersion: "v1",
    },
  }
}

function captureStream(): {
  stream: Pick<NodeJS.WriteStream, "write">
  read: () => string
} {
  let output = ""
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        output +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8")
        return true
      },
    } as Pick<NodeJS.WriteStream, "write">,
    read: () => output,
  }
}

describe("exitCodeForEnvelope", () => {
  it("成功信封只以 ok=true 判成功", () => {
    const envelope = successEnvelope()
    envelope.data.code = 99999
    expect(exitCodeForEnvelope(envelope)).toBe(0)
  })

  it.each([
    ["INVALID_REQUEST", false, 2],
    ["TIKTOK_AUTH_ID_REQUIRED", false, 2],
    ["TIKTOK_AUTH_INVALID_FOR_ACCOUNT", false, 2],
    ["INVALID_CREDENTIAL", false, 3],
    ["CREDENTIAL_EXPIRED", false, 3],
    ["USER_DISABLED", false, 3],
    ["OWNER_REQUIRED", false, 3],
    ["RATE_LIMITED", true, 4],
    ["UPSTREAM_RATE_LIMITED", true, 4],
    ["RESOURCE_BUSY", true, 4],
    ["DEPENDENCY_UNAVAILABLE", true, 4],
    ["DAILY_QUOTA_EXCEEDED", false, 1],
    ["TIKTOK_AUTH_UNAVAILABLE", false, 1],
    ["CAPABILITY_DENIED", false, 1],
    ["RESOURCE_NOT_FOUND", false, 1],
    ["UPSTREAM_ERROR", false, 1],
    ["UPSTREAM_ERROR", true, 1],
    ["RATE_LIMITED", false, 1],
  ] as const)("%s retryable=%s 映射退出码 %s", (code, retryable, expected) => {
    expect(exitCodeForEnvelope(errorEnvelope(code, retryable))).toBe(expected)
  })
})

describe("warningsForEnvelope", () => {
  it("operationUnitsCharged=null 明确提示可能已扣且重试可能重复扣费", () => {
    const warnings = warningsForEnvelope(successEnvelope(null), {})
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("may already have been charged")
    expect(warnings[0]).toContain("retry may charge again")
  })

  it.each([0, 1, 2, 3] as const)(
    "确定 charged=%s 不生成扣费未知 warning",
    (charged) => {
      expect(warningsForEnvelope(successEnvelope(charged), {})).toEqual([])
    }
  )

  it("credential notifier 只受自己的环境变量抑制", () => {
    const envelope = successEnvelope(0, {
      credential: {
        message: "Credential expires soon.",
        resolutionUrl: "https://app.adrate.io/settings/security",
      },
    })
    expect(
      warningsForEnvelope(envelope, {
        ADRATE_NO_UPDATE_NOTIFIER: "1",
        ADRATE_NO_SKILLS_NOTIFIER: "1",
      })
    ).toEqual(["Credential expires soon."])
    expect(
      warningsForEnvelope(envelope, {
        ADRATE_NO_CREDENTIAL_NOTIFIER: "1",
      })
    ).toEqual([])
  })

  it("JSON envelope 中的 credential 到期字段不受 notifier 抑制", () => {
    const envelope = successEnvelope()
    envelope.data.credential = {
      absoluteExpiresAt: "2026-10-01T00:00:00.000Z",
    }
    const outcome = outcomeFromEnvelope(envelope, {
      ADRATE_NO_CREDENTIAL_NOTIFIER: "1",
    })
    expect(outcome.envelope.data).toEqual(envelope.data)
    expect(outcome.warnings).toEqual([])
  })

  it("Retry-After 同时进入 CliOutcome 与 human warning", () => {
    const envelope = errorEnvelope("UPSTREAM_RATE_LIMITED", true)
    envelope.meta.retryAfterSeconds = 17
    const outcome = outcomeFromEnvelope(envelope, {})

    expect(outcome.retryAfterSeconds).toBe(17)
    expect(outcome.envelope.meta.retryAfterSeconds).toBe(17)
    expect(outcome.warnings).toContain(
      "Retry after 17 second(s) before repeating this request."
    )
  })
})

describe("renderOutcome", () => {
  it.each([
    ["authorization_pending", 5],
    ["slow_down", 12],
  ] as const)(
    "local OAuth %s exposes exact retry seconds without writing stdout",
    (oauthError, retryAfterSeconds) => {
      const stdout = captureStream()
      const stderr = captureStream()
      const outcome = oauthWaitOutcome(
        "local_retry_wait",
        oauthError,
        retryAfterSeconds
      )

      renderOutcome(
        outcome,
        { json: false, verbose: false },
        { stdout: stdout.stream, stderr: stderr.stream }
      )

      expect(outcome.retryAfterSeconds).toBe(retryAfterSeconds)
      expect(outcome.envelope.meta.retryAfterSeconds).toBe(retryAfterSeconds)
      expect(stdout.read()).toBe("")
      expect(stderr.read()).toContain(
        `Warning: Retry after ${retryAfterSeconds} second(s) before repeating this request.`
      )
      expect(stderr.read()).not.toContain("suggestedAction")
      expect(stderr.read()).not.toContain("oauthError")
    }
  )

  it("--json stdout 恰好一个单行 JSON 对象，warning/verbose 只进 stderr", () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const envelope = successEnvelope(null, {
      credential: {
        message: "Credential expires soon.",
      },
    })
    const outcome = outcomeFromEnvelope(envelope, {})

    renderOutcome(
      outcome,
      { json: true, verbose: true },
      { stdout: stdout.stream, stderr: stderr.stream }
    )

    expect(stdout.read().split("\n")).toHaveLength(2)
    expect(stdout.read().endsWith("\n")).toBe(true)
    expect(JSON.parse(stdout.read().trim())).toEqual(envelope)
    expect(stdout.read()).not.toContain("Warning:")
    expect(stderr.read()).toContain("Warning:")
    expect(stderr.read()).toContain("charging is unknown")
    expect(stderr.read()).toContain("Credential expires soon.")
    expect(stderr.read()).toContain("requestId=output-request-1 exitCode=0")
  })

  it("human 成功复用同一 DTO，stdout 保持为空", () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const outcome: CliOutcome = {
      exitCode: 0,
      envelope: successEnvelope(),
      warnings: [],
      humanLines: ["Campaign page loaded.", "Rows: 0"],
    }

    renderOutcome(
      outcome,
      { json: false, verbose: false },
      { stdout: stdout.stream, stderr: stderr.stream }
    )

    expect(stdout.read()).toBe("")
    expect(stderr.read()).toBe("Campaign page loaded.\nRows: 0\n")
  })

  it("human 错误只写 stderr，并保留 retryable 提示", () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const envelope = errorEnvelope("DEPENDENCY_UNAVAILABLE", true)
    const outcome = outcomeFromEnvelope(envelope)

    renderOutcome(
      outcome,
      { json: false, verbose: false },
      { stdout: stdout.stream, stderr: stderr.stream }
    )

    expect(stdout.read()).toBe("")
    expect(stderr.read()).toBe(
      "DEPENDENCY_UNAVAILABLE: Failure DEPENDENCY_UNAVAILABLE The request may succeed later.\n"
    )
  })

  it("human 错误只展示严格白名单的授权候选和恢复动作", () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const envelope = errorEnvelope("TIKTOK_AUTH_ID_REQUIRED", false)
    envelope.error.details = {
      availableAuthorizations: [
        {
          authId: 9,
          displayName: "Boss Ads",
          status: "active",
          lastSyncedAt: "2026-07-31T08:00:00.000Z",
        },
      ],
      suggestedAction: "choose_auth",
      resolutionUrl: "https://app.adrate.io/tiktok/auth",
      unknownDetail: "MUST_NOT_LEAK",
      nested: { token: "adr_owner_MUST_NOT_LEAK" },
    }

    renderOutcome(
      outcomeFromEnvelope(envelope),
      { json: false, verbose: false },
      { stdout: stdout.stream, stderr: stderr.stream }
    )

    expect(stdout.read()).toBe("")
    expect(stderr.read()).toContain("Available authorizations:\n")
    expect(stderr.read()).toContain(
      '- authId=9 displayName="Boss Ads" status=active lastSyncedAt=2026-07-31T08:00:00.000Z\n'
    )
    expect(stderr.read()).toContain("Suggested action: choose_auth\n")
    expect(stderr.read()).toContain(
      "Resolution URL: https://app.adrate.io/tiktok/auth\n"
    )
    expect(stderr.read()).not.toContain("unknownDetail")
    expect(stderr.read()).not.toContain("MUST_NOT_LEAK")
    expect(stderr.read()).not.toContain("adr_owner_")
  })

  it("human 错误拒绝恶意候选、未知动作和非 canonical 跳转", () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const envelope = errorEnvelope("TIKTOK_AUTH_ID_REQUIRED", false)
    envelope.error.details = {
      availableAuthorizations: [
        {
          authId: 9,
          displayName: "Injected\u001b[31m",
          status: "active",
          lastSyncedAt: "2026-07-31T08:00:00.000Z",
        },
      ],
      suggestedAction: "print_every_detail",
      resolutionUrl: "https://attacker.example/collect",
      secret: "MALICIOUS_DETAIL",
    }

    renderOutcome(
      outcomeFromEnvelope(envelope),
      { json: false, verbose: false },
      { stdout: stdout.stream, stderr: stderr.stream }
    )

    expect(stdout.read()).toBe("")
    expect(stderr.read()).toBe(
      "TIKTOK_AUTH_ID_REQUIRED: Failure TIKTOK_AUTH_ID_REQUIRED\n"
    )
    expect(stderr.read()).not.toContain("Injected")
    expect(stderr.read()).not.toContain("attacker.example")
    expect(stderr.read()).not.toContain("print_every_detail")
    expect(stderr.read()).not.toContain("MALICIOUS_DETAIL")
  })

  it("JSON 错误仍保持一个机读信封，不混入 human 文案", () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const envelope = errorEnvelope("INVALID_REQUEST", false)
    const outcome = outcomeFromEnvelope(envelope)

    renderOutcome(
      outcome,
      { json: true, verbose: false },
      { stdout: stdout.stream, stderr: stderr.stream }
    )

    expect(JSON.parse(stdout.read())).toEqual(envelope)
    expect(stderr.read()).toBe("")
  })
})
