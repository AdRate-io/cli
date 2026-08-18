import { Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import {
  RuleCommandService,
  readRuleStdin,
} from "../src/commands/rule-command-service.js"
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

function successEnvelope(data: JsonObject = {}): PublicEnvelope {
  return {
    ok: true,
    data: {
      ruleId: 42,
      name: "Rule",
      enabled: false,
      duplicate: false,
      ...data,
    },
    meta: { requestId: "rule-response", apiVersion: "v1" },
  }
}

function malformedSuccessEnvelope(data: JsonObject): PublicEnvelope {
  return {
    ok: true,
    data,
    meta: { requestId: "malformed-rule-response", apiVersion: "v1" },
  }
}

function errorEnvelope(
  code: string,
  retryable: boolean,
  details: JsonObject = {}
): PublicEnvelope {
  return {
    ok: false,
    error: { code, message: "Rule request rejected.", retryable, details },
    meta: { requestId: "rule-error", apiVersion: "v1" },
  }
}

function harness(
  options: {
    result?: PublicResponse
    failure?: unknown
    readFile?: (path: string) => Promise<string>
    readStdin?: () => Promise<string>
    credentials?: boolean
  } = {}
) {
  const local = {
    requireLocated: vi.fn(() =>
      Promise.resolve({
        index: { issuerOrigin: "https://api.adrate.io" },
        token: "owner-token",
        credentials: options.credentials === false ? null : { teamId: 42 },
      })
    ),
  }
  const requestPublic = options.failure
    ? vi.fn((_input: unknown) => Promise.reject(options.failure))
    : vi.fn((_input: unknown) =>
        Promise.resolve(options.result ?? response(successEnvelope()))
      )
  const service = new RuleCommandService(
    { requestPublic } as unknown as PublicHttpClient,
    local as unknown as LocalCredentialCoordinator,
    {
      environment: { ADRATE_NO_CREDENTIAL_NOTIFIER: "1" },
      generateIdempotencyKeySuffix: () => "generated_suffix",
      readFile: options.readFile ?? (() => Promise.resolve('{"name":"rule"}')),
      readStdin:
        options.readStdin ?? (() => Promise.resolve('{"name":"stdin"}')),
    }
  )
  return { service, local, requestPublic }
}

describe("RuleCommandService writes", () => {
  it("create 只校验 JSON object，使用前缀 Key 且只发一次 15 秒 POST", async () => {
    const readFile = vi.fn(() => Promise.resolve('{"future":{"field":true}}'))
    const value = harness({
      readFile,
      result: response(successEnvelope({ duplicate: true })),
    })
    const outcome = await value.service.create({
      file: "rule.json",
      stdin: false,
      requestId: "rule-create-request",
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.humanLines?.join("\n")).toContain("Duplicate replay: yes")
    expect(readFile).toHaveBeenCalledWith("rule.json")
    expect(value.requestPublic).toHaveBeenCalledTimes(1)
    expect(value.requestPublic).toHaveBeenCalledWith({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/rules/create",
      token: "owner-token",
      idempotencyKey: "rule-create-generated_suffix",
      json: { future: { field: true } },
      requestId: "rule-create-request",
      deadlineMs: 15_000,
    })
  })

  it("create stdin 与 update file 原样传递对象，显式 Key 覆盖生成值", async () => {
    const materialCreate = {
      ruleType: "ads",
      scope: "material",
      targets: [
        {
          scopeId: "smart-plus-creative-1",
          targetId: "smart-plus-creative-1",
          futureTargetField: { retained: true },
        },
      ],
      futureCreateField: { retained: true },
    }
    const materialPatch = {
      pipelines: [
        {
          actions: [{ kind: "basic", type: "DISABLE" }],
          futurePipelineField: { retained: true },
        },
      ],
      futurePatchField: { retained: true },
    }
    const value = harness({
      readStdin: () => Promise.resolve(JSON.stringify(materialCreate)),
      readFile: () => Promise.resolve(JSON.stringify(materialPatch)),
    })
    await value.service.create({
      stdin: true,
      idempotencyKey: "explicit_create_key",
    })
    await value.service.update({
      ruleId: "7",
      file: "patch.json",
      idempotencyKey: "explicit_update_key",
    })

    expect(value.requestPublic).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        path: "/public/v1/rules/create",
        idempotencyKey: "explicit_create_key",
        json: materialCreate,
      })
    )
    expect(value.requestPublic).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: "/public/v1/rules/7/update",
        idempotencyKey: "explicit_update_key",
        json: materialPatch,
      })
    )
  })

  it.each(["enable", "disable", "delete"] as const)(
    "%s 是完全无 body 的 POST 并使用对应 Key 前缀",
    async (operation) => {
      const value = harness({
        result: response(
          successEnvelope(
            operation === "enable"
              ? { enabled: true }
              : operation === "delete"
                ? { deleted: true }
                : { enabled: false }
          )
        ),
      })
      await value.service[operation]({ ruleId: "42" })

      expect(value.requestPublic).toHaveBeenCalledTimes(1)
      const request = value.requestPublic.mock.calls[0]?.[0]
      expect(request).toEqual({
        method: "POST",
        issuerOrigin: "https://api.adrate.io",
        path: `/public/v1/rules/42/${operation}`,
        token: "owner-token",
        idempotencyKey: `rule-${operation}-generated_suffix`,
        deadlineMs: 15_000,
      })
      expect(request).not.toHaveProperty("json")
    }
  )

  it("network/timeout 未知结果不自动重试，退出 5 并要求原 Key 重放", async () => {
    for (const kind of ["network", "timeout"] as const) {
      const value = harness({
        failure: new HttpTransportError(kind, "lost response"),
      })
      await expect(
        value.service.enable({
          ruleId: "42",
          idempotencyKey: "original_rule_key",
        })
      ).rejects.toMatchObject({
        exitCode: 5,
        warnings: [
          expect.stringContaining("--idempotency-key original_rule_key"),
        ],
      })
      expect(value.requestPublic).toHaveBeenCalledTimes(1)
    }
  })

  it("不可解析回执也按 unknown 处理，显示原 Key", async () => {
    const value = harness({ failure: new Error("invalid envelope") })
    await expect(
      value.service.delete({ ruleId: "42", idempotencyKey: "delete_same_key" })
    ).rejects.toMatchObject({
      exitCode: 5,
      warnings: [expect.stringContaining("delete_same_key")],
    })
  })

  it("成功回执缺少当前操作的最小证据时退出 5", async () => {
    const cases = [
      ["create", { duplicate: false }],
      ["update", { ruleId: 42, name: "Rule", duplicate: false }],
      ["enable", { ruleId: 42, enabled: false, duplicate: false }],
      ["disable", { ruleId: 42, enabled: true, duplicate: false }],
      ["delete", { ruleId: 42, deleted: false, duplicate: false }],
    ] as const
    for (const [operation, data] of cases) {
      const value = harness({
        result: response(malformedSuccessEnvelope(data)),
      })
      const execute =
        operation === "create"
          ? value.service.create({ file: "rule.json", stdin: false })
          : operation === "update"
            ? value.service.update({ ruleId: "42", file: "patch.json" })
            : value.service[operation]({ ruleId: "42" })
      await expect(execute).rejects.toMatchObject({ exitCode: 5 })
      expect(value.requestPublic).toHaveBeenCalledTimes(1)
    }
  })

  it("明确业务失败按 retryable 区分原 Key 和新 Key，duplicate 显式输出", async () => {
    const retryable = harness({
      result: response(errorEnvelope("RATE_LIMITED", true), 429),
    })
    const retryableOutcome = await retryable.service.update({
      ruleId: "42",
      file: "patch.json",
      idempotencyKey: "retry_same_key",
    })
    expect(retryableOutcome.warnings.join("\n")).toContain("this key")
    expect(retryableOutcome.warnings.join("\n")).toContain("retry_same_key")

    const rejected = harness({
      result: response(errorEnvelope("INVALID_REQUEST", false), 400),
    })
    const rejectedOutcome = await rejected.service.create({
      file: "rule.json",
      stdin: false,
      idempotencyKey: "rejected_key",
    })
    expect(rejectedOutcome.warnings.join("\n")).toContain("new key")
    expect(rejectedOutcome.warnings.join("\n")).toContain("rejected_key")
  })

  it("日额度耗尽要求等 UTC 换日并保留原 Key，不误导立即换 Key", async () => {
    const value = harness({
      result: response(errorEnvelope("DAILY_QUOTA_EXCEEDED", false), 429),
    })
    const outcome = await value.service.create({
      file: "rule.json",
      stdin: false,
      idempotencyKey: "daily-rule-key",
    })
    const warnings = outcome.warnings.join("\n")
    expect(warnings).toContain("UTC day rolls over")
    expect(warnings).toContain("this key")
    expect(warnings).not.toContain("new key")
  })

  it("IDEMPOTENCY_CONFLICT 保留原 Key，不误导换新 Key 重放", async () => {
    const value = harness({
      result: response(errorEnvelope("IDEMPOTENCY_CONFLICT", false), 409),
    })
    const outcome = await value.service.create({
      file: "rule.json",
      stdin: false,
      idempotencyKey: "conflicted-rule-key",
    })
    const warnings = outcome.warnings.join("\n")
    expect(outcome.exitCode).not.toBe(0)
    expect(warnings).toContain("original idempotency key conflicted-rule-key")
    expect(warnings).toContain("did not prove the write was never applied")
    expect(warnings).not.toContain("retry with a new key")
    expect(value.requestPublic).toHaveBeenCalledTimes(1)
  })

  it("旧 Session scope 不足时只提示重新登录，不迁移", async () => {
    const value = harness({
      result: response(
        errorEnvelope("CAPABILITY_DENIED", false, {
          unavailableReason: "credential_scope_missing",
        }),
        403
      ),
    })
    const outcome = await value.service.disable({ ruleId: "42" })
    const warnings = outcome.warnings.join("\n")
    expect(warnings).toContain("auth logout, auth login, and auth whoami")
    expect(warnings).toContain("not migrated automatically")
    expect(warnings).toContain("restore the rules.write capability")
    expect(warnings).toContain("do not generate a new key")
    expect(warnings).not.toContain("retry with a new key")
  })

  it("无效 JSON/非对象在凭据和网络之前拒绝", async () => {
    for (const text of ["not-json", "[]", "null", "1"]) {
      const value = harness({ readFile: () => Promise.resolve(text) })
      await expect(
        value.service.create({ file: "rule.json", stdin: false })
      ).rejects.toMatchObject({ exitCode: 2 })
      expect(value.local.requireLocated).not.toHaveBeenCalled()
      expect(value.requestPublic).not.toHaveBeenCalled()
    }
  })
})

describe("RuleCommandService dryrun", () => {
  it("material dryrun 仅传 Ads 上下文，human 展示 target 且 JSON 原样保留未来字段", async () => {
    const data = {
      items: [
        {
          targetId: "smart-plus-creative-1",
          targetName: "Smart+ Creative One",
          hit: true,
          materialMapping: {
            smartPlusCreativeId: "smart-plus-creative-1",
            smartPlusAdId: "smart-plus-ad-1",
            adMaterialId: "ad-material-1",
            materialOperationStatus: "ENABLE",
            futureMappingField: { retained: true },
          },
          pipelines: [
            {
              evaluation: [
                {
                  metric: "cost",
                  operator: ">",
                  threshold: 100,
                  actual: 120,
                  result: true,
                  futureEvaluationField: { retained: true },
                },
              ],
            },
          ],
          futureItemField: { retained: true },
        },
        {
          targetId: "smart-plus-creative-2",
          hit: false,
          noData: true,
        },
      ],
      futureDryRunField: { retained: true },
    }
    const value = harness({
      result: response(successEnvelope(data)),
    })
    const outcome = await value.service.dryRun({
      ruleId: "42",
      advId: "account-A_1",
      requestId: "dryrun-request",
    })

    expect(outcome.humanLines).toHaveLength(2)
    expect(outcome.humanLines?.[0]).toContain(
      'target="Smart+ Creative One" hit=yes'
    )
    expect(outcome.humanLines?.[1]).toContain(
      'target="smart-plus-creative-2" hit=no noData=yes'
    )
    expect(outcome.envelope.data).toStrictEqual({
      ruleId: 42,
      name: "Rule",
      enabled: false,
      duplicate: false,
      ...data,
    })
    const request = value.requestPublic.mock.calls[0]?.[0]
    expect(request).toEqual({
      method: "POST",
      issuerOrigin: "https://api.adrate.io",
      path: "/public/v1/rules/42/dryrun",
      token: "owner-token",
      json: { advId: "account-A_1" },
      requestId: "dryrun-request",
      deadlineMs: 60_000,
    })
    expect(request).not.toHaveProperty("idempotencyKey")
  })

  it("target_limit_exceeded 不误称服务端返回了有效部分集", async () => {
    const value = harness({
      result: response(
        successEnvelope({ items: [], notice: "target_limit_exceeded" })
      ),
    })
    const outcome = await value.service.dryRun({
      ruleId: "42",
      advId: "70001",
    })

    const human = outcome.humanLines?.join("\n") ?? ""
    expect(human).toContain("server reported target_limit_exceeded")
    expect(human).not.toContain("bounded target subset")
  })

  it("非法 GMV 上下文在读取凭据和联网前拒绝", async () => {
    const value = harness()
    await expect(
      value.service.dryRun({
        ruleId: "42",
        advId: "70001",
        shopId: "shop/1",
        campaignId: "80001",
      })
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "--shop-id cannot be transported by the CLI raw-path contract.",
    })
    expect(value.local.requireLocated).not.toHaveBeenCalled()
    expect(value.requestPublic).not.toHaveBeenCalled()
  })

  it.each([{ shopId: "shop-1" }, { campaignId: "80001" }])(
    "GMV 上下文缺少配对字段时在读取凭据和联网前拒绝",
    async (context) => {
      const value = harness()
      await expect(
        value.service.dryRun({
          ruleId: "42",
          advId: "70001",
          ...context,
        })
      ).rejects.toMatchObject({
        exitCode: 2,
        message: "--shop-id and --campaign-id must be supplied together.",
      })
      expect(value.local.requireLocated).not.toHaveBeenCalled()
      expect(value.requestPublic).not.toHaveBeenCalled()
    }
  )

  it("rules.dryrun scope 不足提示重新登录", async () => {
    const value = harness({
      result: response(
        errorEnvelope("CAPABILITY_DENIED", false, {
          unavailableReason: "credential_scope_missing",
        }),
        403
      ),
    })
    const outcome = await value.service.dryRun({ ruleId: "42", advId: "70001" })
    expect(outcome.warnings.join("\n")).toContain("rules.dryrun")
    expect(outcome.warnings.join("\n")).toContain("auth login")
  })
})

describe("readRuleStdin", () => {
  it("保留合法 UTF-8 字面值，拒绝非法 UTF-8", async () => {
    await expect(
      readRuleStdin(Readable.from([Buffer.from('{"value":"$()"}')]))
    ).resolves.toBe('{"value":"$()"}')
    await expect(
      readRuleStdin(Readable.from([Buffer.from([0xff])]))
    ).rejects.toMatchObject({ exitCode: 2 })
  })
})
