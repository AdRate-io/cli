import { describe, expect, it, vi } from "vitest"
import { CopyCommandService } from "../src/commands/copy-command-service.js"
import { HttpTransportError } from "../src/http/client.js"
import type { LocalCredentialCoordinator } from "../src/auth/local-credentials.js"
import type { PublicEnvelope } from "../src/contracts/envelope.js"
import type { JsonObject } from "../src/contracts/json.js"
import type { PublicHttpClient, PublicResponse } from "../src/http/client.js"

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

function submitSuccess(data: JsonObject = {}): PublicEnvelope {
  return {
    ok: true,
    data: {
      taskId: 42,
      itemCount: 2,
      duplicate: false,
      snapshotSummary: { campaigns: 3, adgroups: 4, ads: 5 },
      ...data,
    },
    meta: { requestId: "copy-submit-response", apiVersion: "v1" },
  }
}

function previewSuccess(data: JsonObject): PublicEnvelope {
  return {
    ok: true,
    data,
    meta: { requestId: "copy-preview-response", apiVersion: "v1" },
  }
}

function errorEnvelope(code: string, retryable: boolean): PublicEnvelope {
  return {
    ok: false,
    error: {
      code,
      message: "Copy request rejected.",
      retryable,
      details: {},
    },
    meta: { requestId: "copy-error", apiVersion: "v1" },
  }
}

function harness(
  options: {
    result?: PublicResponse
    failure?: unknown
    fileText?: string | Uint8Array
    fileFailure?: unknown
    credentials?: boolean
  } = {}
) {
  const requireLocated = vi.fn(() =>
    Promise.resolve({
      index: { issuerOrigin: "https://api.adrate.io" },
      token: "owner-token",
      credentials: options.credentials === false ? null : { teamId: 42 },
    })
  )
  const requestPublic = options.failure
    ? vi.fn((_input: unknown) => Promise.reject(options.failure))
    : vi.fn((_input: unknown) =>
        Promise.resolve(options.result ?? response(submitSuccess()))
      )
  const readFile = options.fileFailure
    ? vi.fn((_path: string) => Promise.reject(options.fileFailure))
    : vi.fn((_path: string) =>
        Promise.resolve(
          options.fileText ?? '{"sourceAdvId":"70001","future":{"value":true}}'
        )
      )
  const service = new CopyCommandService(
    { requestPublic } as unknown as PublicHttpClient,
    { requireLocated } as unknown as LocalCredentialCoordinator,
    {
      environment: { ADRATE_NO_CREDENTIAL_NOTIFIER: "1" },
      readFile,
      generateIdempotencyKey: () => "copy-submit-generated-key",
    }
  )
  return { service, requestPublic, requireLocated, readFile }
}

describe("CopyCommandService submit", () => {
  it("只校验 JSON plain object，原样单次发送 45 秒 keyed POST", async () => {
    const value = harness()
    const outcome = await value.service.submit({
      file: "copy.json",
      requestId: "copy-submit-request",
    })

    expect(value.readFile).toHaveBeenCalledWith("copy.json")
    expect(value.requestPublic).toHaveBeenCalledTimes(1)
    expect(value.requestPublic).toHaveBeenCalledWith({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/ads/copy/submit",
      token: "owner-token",
      idempotencyKey: "copy-submit-generated-key",
      json: { sourceAdvId: "70001", future: { value: true } },
      requestId: "copy-submit-request",
      deadlineMs: 45_000,
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.humanLines?.join("\n")).toContain(
      "accepted, not completed: taskId=42"
    )
    expect(outcome.humanLines?.join("\n")).toContain(
      "ads copy tasks get --task-id 42"
    )
  })

  it.each([["not-json"], ["null"], ["[]"], ['"string"']])(
    "非 plain object 输入 %j 在凭证与网络前拒绝",
    async (fileText) => {
      const value = harness({ fileText })
      await expect(
        value.service.submit({ file: "copy.json" })
      ).rejects.toMatchObject({ exitCode: 2 })
      expect(value.requireLocated).not.toHaveBeenCalled()
      expect(value.requestPublic).not.toHaveBeenCalled()
    }
  )

  it("文件读取失败是本地 usage，不生成远端请求", async () => {
    const value = harness({ fileFailure: new Error("missing") })
    await expect(
      value.service.submit({ file: "missing.json" })
    ).rejects.toMatchObject({ exitCode: 2 })
    expect(value.requireLocated).not.toHaveBeenCalled()
    expect(value.requestPublic).not.toHaveBeenCalled()
  })

  it("非法 UTF-8 在凭证与网络前拒绝", async () => {
    const value = harness({
      fileText: Uint8Array.from([
        0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
      ]),
    })
    await expect(
      value.service.submit({ file: "invalid-utf8.json" })
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "Copy JSON file must be valid UTF-8.",
    })
    expect(value.requireLocated).not.toHaveBeenCalled()
    expect(value.requestPublic).not.toHaveBeenCalled()
  })

  it.each(["network", "timeout", "invalid_response"] as const)(
    "%s 只发一次且退出 5，提示原 body 与原 key 重放",
    async (kind) => {
      const value = harness({
        failure: new HttpTransportError(kind, "response lost"),
      })
      await expect(
        value.service.submit({
          file: "copy.json",
          idempotencyKey: "original-copy-key",
        })
      ).rejects.toMatchObject({
        exitCode: 5,
        warnings: [
          expect.stringMatching(/exact original JSON body.*original-copy-key/),
        ],
      })
      expect(value.requestPublic).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    {},
    { taskId: 0, itemCount: 2, duplicate: false, snapshotSummary: {} },
    { taskId: 42, itemCount: 0, duplicate: false, snapshotSummary: {} },
    {
      taskId: 42,
      itemCount: 2,
      duplicate: "false",
      snapshotSummary: { campaigns: 3, adgroups: 4, ads: 5 },
    },
    {
      taskId: 42,
      itemCount: 2,
      duplicate: false,
      snapshotSummary: { campaigns: 0, adgroups: 4, ads: 5 },
    },
    {
      taskId: 42,
      itemCount: 2,
      duplicate: false,
      snapshotSummary: { campaigns: 3, adgroups: 4, ads: -1 },
    },
    {
      taskId: "42",
      itemCount: 2,
      duplicate: false,
      snapshotSummary: { campaigns: 3, adgroups: 4, ads: 5 },
    },
    {
      taskId: 42,
      itemCount: "2",
      duplicate: false,
      snapshotSummary: { campaigns: 3, adgroups: 4, ads: 5 },
    },
    {
      taskId: 42,
      itemCount: 2,
      duplicate: false,
      snapshotSummary: { campaigns: 3, adgroups: 0.5 },
    },
  ])("正响应缺少 submit 正面证据时退出 5", async (data) => {
    const value = harness({
      result: response({
        ok: true,
        data,
        meta: { requestId: "bad-copy-receipt", apiVersion: "v1" },
      }),
    })
    await expect(
      value.service.submit({
        file: "copy.json",
        idempotencyKey: "receipt-key",
      })
    ).rejects.toMatchObject({
      exitCode: 5,
      warnings: [expect.stringContaining("receipt-key")],
    })
    expect(value.requestPublic).toHaveBeenCalledTimes(1)
  })

  it("HTTP 201 即使 envelope 成功也不是确认回执，必须退出 5 并保留原 key", async () => {
    const value = harness({ result: response(submitSuccess(), 201) })
    await expect(
      value.service.submit({
        file: "copy.json",
        idempotencyKey: "status-201-key",
      })
    ).rejects.toMatchObject({
      exitCode: 5,
      warnings: [expect.stringContaining("status-201-key")],
    })
    expect(value.requestPublic).toHaveBeenCalledTimes(1)
  })

  it("duplicate=true 仍是原任务受理回执，不得表述为执行完成", async () => {
    const value = harness({
      result: response(submitSuccess({ duplicate: true })),
    })
    const outcome = await value.service.submit({ file: "copy.json" })
    const human = outcome.humanLines?.join("\n") ?? ""
    expect(outcome.exitCode).toBe(0)
    expect(human).toContain("accepted, not completed")
    expect(human).toContain("duplicate replay: yes")
    expect(human).not.toContain("copy completed")
  })

  it.each(["INVALID_REQUEST", "PLAN_LIMIT_EXCEEDED"])(
    "%s 明确拒绝要求修复后使用新 key",
    async (code) => {
      const value = harness({
        result: response(errorEnvelope(code, false), 400),
      })
      const outcome = await value.service.submit({
        file: "copy.json",
        idempotencyKey: "rejected-copy-key",
      })
      expect(outcome.exitCode).not.toBe(0)
      expect(outcome.warnings.join("\n")).toContain("new idempotency key")
      expect(outcome.warnings.join("\n")).toContain("rejected-copy-key")
      expect(value.requestPublic).toHaveBeenCalledTimes(1)
    }
  )

  it("DAILY_QUOTA_EXCEEDED 要求等 UTC 换日并保留原 key", async () => {
    const value = harness({
      result: response(errorEnvelope("DAILY_QUOTA_EXCEEDED", false), 429),
    })
    const outcome = await value.service.submit({
      file: "copy.json",
      idempotencyKey: "daily-copy-key",
    })
    const warnings = outcome.warnings.join("\n")
    expect(outcome.exitCode).not.toBe(0)
    expect(warnings).toContain("UTC day rolls over")
    expect(warnings).toContain("daily-copy-key")
    expect(warnings).not.toContain("new idempotency key")
  })

  it("其他 nonretryable 错误保留原 key，不泛化为换新 key", async () => {
    const value = harness({
      result: response(errorEnvelope("IDEMPOTENCY_CONFLICT", false), 409),
    })
    const outcome = await value.service.submit({
      file: "copy.json",
      idempotencyKey: "conflicted-copy-key",
    })
    const warnings = outcome.warnings.join("\n")
    expect(outcome.exitCode).not.toBe(0)
    expect(warnings).toContain("original idempotency key conflicted-copy-key")
    expect(warnings).not.toContain("new idempotency key")
    expect(value.requestPublic).toHaveBeenCalledTimes(1)
  })

  it("未激活凭证不发 submit 请求", async () => {
    const value = harness({ credentials: false })
    await expect(
      value.service.submit({ file: "copy.json" })
    ).rejects.toMatchObject({ exitCode: 3 })
    expect(value.requestPublic).not.toHaveBeenCalled()
  })
})

describe("CopyCommandService preview", () => {
  it("无 key 单次发送 45 秒 POST，不重组服务端 data", async () => {
    const data = {
      perCampaign: [{ sourceCampaignId: "80001", future: true }],
      totals: { campaigns: 1 },
      unsupported: [],
      futureTopLevel: { value: 1 },
    }
    const value = harness({ result: response(previewSuccess(data)) })
    const outcome = await value.service.preview({
      file: "copy.json",
      requestId: "copy-preview-request",
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.envelope).toMatchObject({ ok: true, data })
    expect(outcome).not.toHaveProperty("humanLines")
    expect(value.requestPublic).toHaveBeenCalledTimes(1)
    expect(value.requestPublic).toHaveBeenCalledWith({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/ads/copy/preview",
      token: "owner-token",
      json: { sourceAdvId: "70001", future: { value: true } },
      requestId: "copy-preview-request",
      deadlineMs: 45_000,
    })
    expect(value.requestPublic.mock.calls[0]?.[0]).not.toHaveProperty(
      "idempotencyKey"
    )
  })

  it.each(["network", "timeout", "invalid_response"] as const)(
    "%s 只发一次并退出 4",
    async (kind) => {
      const value = harness({
        failure: new HttpTransportError(kind, "preview failed"),
      })
      await expect(
        value.service.preview({ file: "copy.json" })
      ).rejects.toMatchObject({ exitCode: 4 })
      expect(value.requestPublic).toHaveBeenCalledTimes(1)
    }
  )
})
