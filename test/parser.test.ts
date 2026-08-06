import { describe, expect, it } from "vitest"
import { CliFailure } from "../src/errors.js"
import { helpText, parseArguments } from "../src/parser.js"

function expectUsageFailure(argv: ReadonlyArray<string>): CliFailure {
  try {
    parseArguments(argv)
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    const failure = error as CliFailure
    expect(failure.exitCode).toBe(2)
    expect(failure.envelope.ok).toBe(false)
    if (!failure.envelope.ok) {
      expect(failure.envelope.error.code).toBe("INVALID_REQUEST")
      expect(failure.envelope.error.retryable).toBe(false)
    }
    return failure
  }
  throw new Error(`Expected usage failure for argv: ${argv.join(" ")}`)
}

describe("parseArguments", () => {
  it.each([
    [["auth", "login"], "auth.login"],
    [["auth", "status"], "auth.status"],
    [["auth", "whoami"], "auth.whoami"],
    [["auth", "logout"], "auth.logout"],
    [["capabilities"], "capabilities"],
    [["schema", "identity.read"], "schema"],
    [["ads", "advertisers"], "ads.advertisers"],
    [["ads", "campaigns", "list"], "ads.campaigns.list"],
    [["ads", "campaigns", "get"], "ads.campaigns.get"],
    [
      [
        "ads",
        "campaigns",
        "status",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--set",
        "enable",
      ],
      "ads.campaigns.status",
    ],
    [["ads", "report", "campaigns"], "ads.report.campaigns"],
    [
      [
        "commands",
        "get",
        "--command-id",
        "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
      ],
      "commands.get",
    ],
    [["commands", "pending"], "commands.pending"],
    [
      ["commands", "resume", "--idempotency-key", "resume_key"],
      "commands.resume",
    ],
    [
      ["feedback", "--category", "bug", "--message", "Something failed"],
      "feedback.submit",
    ],
  ] as const)("解析命令 %j", (argv, kind) => {
    expect(parseArguments(argv).command?.kind).toBe(kind)
  })

  it("解析任意位置的全局 flags，并保留 T10 幂等键 parser 槽位", () => {
    const invocation = parseArguments([
      "--json",
      "ads",
      "campaigns",
      "list",
      "--adv-id",
      "70001",
      "--auth-id=42",
      "--page",
      "3",
      "--page-size=1000",
      "--no-input",
      "--request-id",
      "Agent_123-ok",
      "--idempotency-key",
      "future_write_key",
      "--verbose",
    ])

    expect(invocation.global).toEqual({
      json: true,
      noInput: true,
      requestId: "Agent_123-ok",
      idempotencyKey: "future_write_key",
      verbose: true,
      test: false,
    })
    expect(invocation.command).toEqual({
      kind: "ads.campaigns.list",
      advId: "70001",
      authId: "42",
      page: "3",
      pageSize: "1000",
    })
  })

  it("解析认证 split flow 的互斥模式和设备名", () => {
    expect(
      parseArguments([
        "auth",
        "login",
        "--no-wait",
        "--device-name",
        "Boss-Mac",
        "--test",
      ])
    ).toMatchObject({
      global: { test: true },
      command: {
        kind: "auth.login",
        noWait: true,
        resume: false,
        deviceName: "Boss-Mac",
      },
    })
    expect(parseArguments(["auth", "login", "--resume"]).command).toMatchObject(
      {
        kind: "auth.login",
        noWait: false,
        resume: true,
        device: false,
      }
    )
    expect(parseArguments(["auth", "login", "--device"]).command).toMatchObject(
      {
        kind: "auth.login",
        noWait: false,
        resume: false,
        device: true,
      }
    )
    expectUsageFailure(["auth", "login", "--no-wait", "--resume"])
    expectUsageFailure(["auth", "login", "--test", "--resume"])
    expectUsageFailure(["auth", "login", "--device", "--no-wait"])
    expectUsageFailure(["auth", "login", "--device", "--resume"])
    expectUsageFailure(["auth", "login", "--no-input"])
    expectUsageFailure([
      "auth",
      "login",
      "--resume",
      "--device-name",
      "must-not-be-ignored",
    ])
  })

  it("解析 Campaign get 与 report 的冻结 flags，不改写 opaque ID", () => {
    expect(
      parseArguments([
        "ads",
        "campaigns",
        "get",
        "--adv-id",
        "00070001",
        "--campaign-id",
        "campaign-A",
        "--auth-id",
        "7",
      ]).command
    ).toEqual({
      kind: "ads.campaigns.get",
      advId: "00070001",
      campaignId: "campaign-A",
      authId: "7",
    })

    expect(
      parseArguments([
        "ads",
        "report",
        "campaigns",
        "--adv-id",
        "70001",
        "--start-date",
        "2026-07-01",
        "--end-date",
        "2026-07-31",
        "--group-by",
        "day",
        "--page",
        "2",
        "--page-size",
        "50",
      ]).command
    ).toEqual({
      kind: "ads.report.campaigns",
      advId: "70001",
      authId: undefined,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      groupBy: "day",
      page: "2",
      pageSize: "50",
    })
  })

  it("解析 Status 与 Command selector，保留原始字符串", () => {
    expect(
      parseArguments([
        "ads",
        "campaigns",
        "status",
        "--adv-id",
        "00070001",
        "--campaign-id",
        "campaign-A",
        "--set",
        "disable",
        "--auth-id",
        "9",
        "--idempotency-key",
        "abc_DEF-9",
      ])
    ).toMatchObject({
      global: { idempotencyKey: "abc_DEF-9" },
      command: {
        kind: "ads.campaigns.status",
        advId: "00070001",
        campaignId: "campaign-A",
        desiredStatus: "disable",
        authId: "9",
      },
    })

    expect(
      parseArguments(["commands", "get", "--idempotency-key", "abc_DEF-9"])
    ).toMatchObject({
      global: { idempotencyKey: "abc_DEF-9" },
      command: { kind: "commands.get", commandId: undefined },
    })
  })

  it("解析反馈 argv/stdin 互斥输入，前导 -- 文本通过等号形态保持字面值", () => {
    expect(
      parseArguments([
        "feedback",
        "--category",
        "blocked",
        "--message=--leading quote '$()'\nnext",
        "--idempotency-key",
        "feedback_key",
      ])
    ).toMatchObject({
      global: { idempotencyKey: "feedback_key" },
      command: {
        kind: "feedback.submit",
        category: "blocked",
        message: "--leading quote '$()'\nnext",
        messageStdin: false,
      },
    })
    expect(
      parseArguments([
        "feedback",
        "--category",
        "suggestion",
        "--message-stdin",
      ]).command
    ).toEqual({
      kind: "feedback.submit",
      category: "suggestion",
      message: undefined,
      messageStdin: true,
    })

    for (const argv of [
      ["feedback", "--message", "missing category"],
      ["feedback", "--category", "future", "--message", "text"],
      ["feedback", "--category", "bug"],
      [
        "feedback",
        "--category",
        "bug",
        "--message",
        "text",
        "--message-stdin",
      ],
      ["feedback", "extra", "--category", "bug", "--message", "text"],
    ]) {
      expectUsageFailure(argv)
    }
  })

  it("T10 必填、selector 冲突、多余 positional 和 --test 全部本地拒绝", () => {
    for (const argv of [
      [
        "ads",
        "campaigns",
        "status",
        "--campaign-id",
        "80001",
        "--set",
        "enable",
      ],
      ["ads", "campaigns", "status", "--adv-id", "70001", "--set", "enable"],
      [
        "ads",
        "campaigns",
        "status",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
      ],
      [
        "ads",
        "campaigns",
        "status",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--set",
        "ENABLE",
      ],
      ["commands", "get"],
      [
        "commands",
        "get",
        "--command-id",
        "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
        "--idempotency-key",
        "same_key",
      ],
      ["commands", "resume"],
      ["commands", "pending", "extra"],
      ["commands", "get", "extra", "--help"],
      ["commands", "pending", "--set", "enable"],
      ["commands", "pending", "--test"],
    ]) {
      expectUsageFailure(argv)
    }
  })

  it("T10 help 不要求业务参数，但仍拒绝显式冲突", () => {
    expect(
      parseArguments(["ads", "campaigns", "status", "--help"])
    ).toMatchObject({
      help: true,
      helpTopic: "ads campaigns status",
    })
    expect(parseArguments(["commands", "get", "--help"])).toMatchObject({
      help: true,
      helpTopic: "commands get",
    })
    expect(parseArguments(["commands", "resume", "--help"])).toMatchObject({
      help: true,
      helpTopic: "commands resume",
    })
    expect(parseArguments(["feedback", "--help"])).toMatchObject({
      help: true,
      helpTopic: "feedback",
    })
    expectUsageFailure([
      "commands",
      "get",
      "--command-id",
      "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
      "--idempotency-key",
      "same_key",
      "--help",
    ])
  })

  it("严格校验 request-id、idempotency-key、重复 flag 和缺值", () => {
    expectUsageFailure(["capabilities", "--request-id", "bad request"])
    expectUsageFailure(["capabilities", "--idempotency-key", "contains.dot"])
    expectUsageFailure(["capabilities", "--json", "--json"])
    expectUsageFailure(["ads", "campaigns", "list", "--adv-id"])
    expectUsageFailure(["capabilities", "--json=true"])
  })

  it("拒绝不属于命令的 flag、额外 positional 和未知命令", () => {
    expectUsageFailure(["auth", "status", "--page", "1"])
    expectUsageFailure(["schema", "identity.read", "extra"])
    expectUsageFailure(["ads", "campaigns"])
  })

  it.each([
    [["capabilities", "--token", "secret-token"], "secret-token"],
    [["auth", "login", "--device-code", "secret-device"], "secret-device"],
    [
      ["capabilities", "--base-url", "https://attacker.example"],
      "https://attacker.example",
    ],
    [["capabilities", "--dev"], ""],
    [["capabilities", "--insecure"], ""],
    [["ads", "campaigns", "list", "--advertiser", "70001"], "70001"],
    [["ads", "campaigns", "get", "--campaign", "80001"], "80001"],
  ] as const)("拒绝秘密注入、开发后门和旧 flag %j", (argv, secret) => {
    const failure = expectUsageFailure(argv)
    if (secret.length > 0) {
      expect(failure.message).not.toContain(secret)
      expect(JSON.stringify(failure.envelope)).not.toContain(secret)
    }
  })

  it("支持全局及命令 help/version，version 不与命令混用", () => {
    expect(parseArguments([])).toMatchObject({
      command: null,
      help: false,
      version: false,
    })
    expect(parseArguments(["--help"])).toMatchObject({
      command: null,
      help: true,
      helpTopic: "",
    })
    expect(
      parseArguments(["ads", "campaigns", "list", "--help"])
    ).toMatchObject({
      help: true,
      helpTopic: "ads campaigns list",
      command: { kind: "ads.campaigns.list" },
    })
    expect(parseArguments(["schema", "identity.read", "--help"])).toMatchObject(
      {
        help: true,
        helpTopic: "schema",
        command: { kind: "schema", capabilityId: "identity.read" },
      }
    )
    expect(parseArguments(["--version"])).toMatchObject({
      command: null,
      version: true,
    })
    expectUsageFailure(["capabilities", "--version"])
  })
})

describe("helpText", () => {
  it("全局帮助冻结命令面、公共 flags、退出码和 M0 边界", () => {
    const help = helpText("")
    for (const command of [
      "auth login",
      "auth status",
      "auth whoami",
      "auth logout",
      "capabilities",
      "schema <capabilityId>",
      "ads advertisers",
      "ads campaigns list",
      "ads campaigns get",
      "ads campaigns status",
      "ads report campaigns",
      "commands get",
      "commands pending",
      "commands resume",
      "feedback",
    ]) {
      expect(help).toContain(command)
    }
    for (const flag of [
      "--json",
      "--no-input",
      "--request-id",
      "--idempotency-key",
      "--verbose",
      "--test",
    ]) {
      expect(help).toContain(flag)
    }
    expect(help).toContain("Exit codes: 0 success")
    expect(help).toContain("automatic pagination")
    expect(help).not.toContain("--base-url")
    expect(help).not.toContain("--token")
    expect(help).toContain("npm install -g @adrate/cli")
    expect(help).toContain("adrate skills install")
  })

  it.each([
    ["auth login", "--no-wait|--resume|--device"],
    ["auth status", "local_incomplete"],
    ["auth whoami", "/public/v1/me"],
    ["auth logout", "Pending Command evidence is preserved"],
    ["capabilities", "server-published"],
    ["schema", "<capabilityId>"],
    ["ads advertisers", "authorization candidates"],
    ["ads campaigns list", "--adv-id <id>"],
    ["ads campaigns get", "--campaign-id <id>"],
    ["ads campaigns status", "--set enable|disable"],
    ["ads report campaigns", "--start-date <YYYY-MM-DD>"],
    ["commands get", "--command-id <uuid>"],
    ["commands pending", "protected local pending-command directory"],
    ["commands resume", "only when the server proves no Command exists"],
    ["feedback", "--message-stdin"],
  ])("命令帮助 %s 包含必要合同", (topic, expected) => {
    const help = helpText(topic)
    expect(help).toContain("Usage:")
    expect(help).toContain(expected)
    expect(help).toContain("Shared exit codes:")
    expect(help).toContain("5 an irreversible or one-time remote outcome")
    expect(help).toContain("M0 boundary:")
    expect(help).toContain("No team switching")
    expect(help).toContain("npm install -g @adrate/cli")
    expect(help).toContain("adrate skills install")
  })

  it.each([
    "ads campaigns list",
    "ads campaigns get",
    "ads campaigns status",
    "ads report campaigns",
  ])("%s 明确多授权缺 authId 的改请求语义", (topic) => {
    const help = helpText(topic)
    expect(help).toContain("--auth-id")
    expect(help).toMatch(
      /Multiple authorization candidates require|TIKTOK_AUTH_ID_REQUIRED/
    )
    expect(help).toMatch(/never\s+chooses|never choose/)
  })

  it("Status 帮助冻结单目标、零自动重试与 M0 非目标", () => {
    const help = helpText("ads campaigns status")
    expect(help).toContain("never retries the POST automatically")
    for (const unsupported of [
      "batch",
      "budget",
      "bid",
      "create",
      "Adgroup",
      "Ad",
      "rules",
      "copy",
      "GMV Max",
    ]) {
      expect(help).toContain(unsupported)
    }
  })

  it("反馈帮助冻结隐私边界、自动元数据与服务端清洗局限", () => {
    const help = helpText("feedback")
    for (const required of [
      "Authorization/Cookie",
      "TikTok access tokens",
      "shell history or argv",
      "platform-architecture",
      "never hostname, cwd, paths",
      "cannot prove that a message is safe",
    ]) {
      expect(help).toContain(required)
    }
  })
})
