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
    [
      [
        "ads",
        "campaigns",
        "budget",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--mode",
        "set",
        "--value",
        "300",
      ],
      "ads.campaigns.budget",
    ],
    [["gmvmax", "stores"], "gmvmax.stores"],
    [["gmvmax", "campaigns", "list"], "gmvmax.campaigns.list"],
    [["gmvmax", "campaigns", "get"], "gmvmax.campaigns.get"],
    [
      [
        "gmvmax",
        "campaigns",
        "status",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--set",
        "enable",
        "--auth-id",
        "9",
      ],
      "gmvmax.campaigns.status",
    ],
    [
      [
        "gmvmax",
        "campaigns",
        "budget",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--mode",
        "set",
        "--value",
        "500",
        "--auth-id",
        "9",
      ],
      "gmvmax.campaigns.budget",
    ],
    [
      [
        "gmvmax",
        "campaigns",
        "roas",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--mode",
        "set",
        "--value",
        "2.5",
        "--auth-id",
        "9",
      ],
      "gmvmax.campaigns.roas",
    ],
    [
      ["rules", "options", "--rule-type", "ads", "--scope", "campaign"],
      "rules.options",
    ],
    [["rules", "list"], "rules.list"],
    [["rules", "get", "--rule-id", "42"], "rules.get"],
    [["rules", "create", "--file", "rule.json"], "rules.create"],
    [
      ["rules", "update", "--rule-id", "42", "--file", "patch.json"],
      "rules.update",
    ],
    [["rules", "enable", "--rule-id", "42"], "rules.enable"],
    [["rules", "disable", "--rule-id", "42"], "rules.disable"],
    [["rules", "delete", "--rule-id", "42"], "rules.delete"],
    [
      ["rules", "dryrun", "--rule-id", "42", "--adv-id", "70001"],
      "rules.dryrun",
    ],
    [
      ["rules", "executions", "list", "--rule-id", "42"],
      "rules.executions.list",
    ],
    [
      ["rules", "executions", "get", "--execution-id", "99"],
      "rules.executions.get",
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

  it("解析 rules executions list 的 page-size 原始值", () => {
    expect(
      parseArguments([
        "rules",
        "executions",
        "list",
        "--rule-id",
        "42",
        "--page",
        "3",
        "--page-size",
        "50",
      ]).command
    ).toEqual({
      kind: "rules.executions.list",
      ruleId: "42",
      scopeId: undefined,
      result: undefined,
      from: undefined,
      to: undefined,
      page: "3",
      pageSize: "50",
    })
  })

  it("rules options 将 material 作为 opaque scope 原样解析", () => {
    expect(
      parseArguments([
        "rules",
        "options",
        "--rule-type",
        "ads",
        "--scope",
        "material",
      ]).command
    ).toEqual({
      kind: "rules.options",
      ruleType: "ads",
      scope: "material",
    })
  })

  it("解析 GMV Max 读取参数和成对的 dryrun GMV 上下文", () => {
    expect(
      parseArguments([
        "gmvmax",
        "campaigns",
        "list",
        "--adv-id",
        "70001",
        "--store-id",
        "shop-1",
        "--promotion-type",
        "product",
        "--from",
        "2026-08-01",
        "--to",
        "2026-08-07",
        "--include-trend",
        "--auth-id",
        "9",
      ]).command
    ).toEqual({
      kind: "gmvmax.campaigns.list",
      advId: "70001",
      storeId: "shop-1",
      promotionType: "product",
      from: "2026-08-01",
      to: "2026-08-07",
      includeTrend: true,
      authId: "9",
    })
    expect(
      parseArguments([
        "rules",
        "dryrun",
        "--rule-id",
        "43",
        "--adv-id",
        "70001",
        "--shop-id",
        "shop-1",
        "--campaign-id",
        "80001",
      ]).command
    ).toEqual({
      kind: "rules.dryrun",
      ruleId: "43",
      advId: "70001",
      shopId: "shop-1",
      campaignId: "80001",
    })
  })

  it("解析 Rule 写命令的文件/stdin 输入和全局 Key", () => {
    expect(
      parseArguments([
        "rules",
        "create",
        "--stdin",
        "--idempotency-key",
        "explicit_rule_key",
      ])
    ).toMatchObject({
      global: { idempotencyKey: "explicit_rule_key" },
      command: { kind: "rules.create", file: undefined, stdin: true },
    })
    expect(
      parseArguments([
        "rules",
        "update",
        "--rule-id",
        "42",
        "--file",
        "patch.json",
      ]).command
    ).toEqual({ kind: "rules.update", ruleId: "42", file: "patch.json" })
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
      ["feedback", "--category", "bug", "--message", "text", "--message-stdin"],
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
      // budget 必填参数拒绝
      [
        "ads",
        "campaigns",
        "budget",
        "--campaign-id",
        "80001",
        "--mode",
        "set",
        "--value",
        "300",
      ],
      [
        "ads",
        "campaigns",
        "budget",
        "--adv-id",
        "70001",
        "--mode",
        "set",
        "--value",
        "300",
      ],
      [
        "ads",
        "campaigns",
        "budget",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--value",
        "300",
      ],
      [
        "ads",
        "campaigns",
        "budget",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--mode",
        "set",
      ],
      [
        "ads",
        "campaigns",
        "budget",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--mode",
        "invalid",
        "--value",
        "300",
      ],
      // rules 必填参数拒绝
      ["rules", "options"],
      ["rules", "options", "--rule-type", "ads"],
      ["rules", "options", "--rule-type", "invalid", "--scope", "campaign"],
      ["rules", "get"],
      ["rules", "create"],
      ["rules", "create", "--file", "rule.json", "--stdin"],
      ["rules", "update", "--rule-id", "42"],
      ["rules", "update", "--file", "patch.json"],
      ["rules", "update", "--rule-id", "42", "--stdin"],
      ["rules", "enable"],
      ["rules", "disable"],
      ["rules", "delete"],
      ["rules", "dryrun", "--rule-id", "42"],
      ["rules", "dryrun", "--adv-id", "70001"],
      [
        "rules",
        "dryrun",
        "--rule-id",
        "42",
        "--adv-id",
        "70001",
        "--shop-id",
        "shop-1",
      ],
      [
        "rules",
        "dryrun",
        "--rule-id",
        "42",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
      ],
      [
        "rules",
        "dryrun",
        "--rule-id",
        "42",
        "--adv-id",
        "70001",
        "--idempotency-key",
        "not_allowed",
      ],
      ["rules", "executions", "list"],
      ["rules", "executions", "get"],
      [
        "gmvmax",
        "campaigns",
        "status",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--set",
        "enable",
      ],
      [
        "gmvmax",
        "campaigns",
        "budget",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--mode",
        "set",
        "--value",
        "500",
      ],
      [
        "gmvmax",
        "campaigns",
        "roas",
        "--adv-id",
        "70001",
        "--campaign-id",
        "80001",
        "--mode",
        "future",
        "--value",
        "2.5",
        "--auth-id",
        "9",
      ],
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
    expect(
      parseArguments(["ads", "campaigns", "budget", "--help"])
    ).toMatchObject({
      help: true,
      helpTopic: "ads campaigns budget",
    })
    expect(parseArguments(["rules", "options", "--help"])).toMatchObject({
      help: true,
      helpTopic: "rules options",
    })
    expect(parseArguments(["rules", "get", "--help"])).toMatchObject({
      help: true,
      helpTopic: "rules get",
    })
    for (const topic of [
      "create",
      "update",
      "enable",
      "disable",
      "delete",
      "dryrun",
    ] as const) {
      expect(parseArguments(["rules", topic, "--help"])).toMatchObject({
        help: true,
        helpTopic: `rules ${topic}`,
      })
    }
    expectUsageFailure([
      "rules",
      "dryrun",
      "--idempotency-key",
      "not_allowed_even_for_help",
      "--help",
    ])
    expect(
      parseArguments(["rules", "executions", "list", "--help"])
    ).toMatchObject({
      help: true,
      helpTopic: "rules executions list",
    })
    expect(
      parseArguments(["rules", "executions", "get", "--help"])
    ).toMatchObject({
      help: true,
      helpTopic: "rules executions get",
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

  it("Copy 只注册四条命令，裸 tasks 与 get 在 maximum=4 下共存", () => {
    expect(
      parseArguments(["ads", "copy", "submit", "--file", "copy.json"])
    ).toMatchObject({
      command: { kind: "ads.copy.submit", file: "copy.json" },
    })
    expect(
      parseArguments(["ads", "copy", "preview", "--file", "copy.json"])
    ).toMatchObject({
      command: { kind: "ads.copy.preview", file: "copy.json" },
    })
    expect(
      parseArguments([
        "ads",
        "copy",
        "tasks",
        "--status",
        "partial",
        "--page",
        "2",
        "--page-size",
        "50",
      ])
    ).toMatchObject({
      command: {
        kind: "ads.copy.tasks.list",
        status: "partial",
        page: "2",
        pageSize: "50",
      },
    })
    expect(
      parseArguments(["ads", "copy", "tasks", "get", "--task-id", "42"])
    ).toMatchObject({ command: { kind: "ads.copy.tasks.get", taskId: "42" } })

    for (const argv of [
      ["ads", "copy", "submit"],
      ["ads", "copy", "preview"],
      ["ads", "copy", "tasks", "get"],
      ["ads", "copy", "tasks", "foo"],
      ["ads", "copy", "tasks", "list"],
      ["ads", "copy", "tasks", "get", "extra"],
      ["ads", "copy", "submit", "--file", "copy.json", "--wait"],
      ["ads", "copy", "preview", "--stdin"],
      [
        "ads",
        "copy",
        "preview",
        "--file",
        "copy.json",
        "--idempotency-key",
        "must-not-exist",
      ],
    ]) {
      expectUsageFailure(argv)
    }

    expect(parseArguments(["ads", "copy", "submit", "--help"])).toMatchObject({
      help: true,
      command: { kind: "ads.copy.submit" },
    })
    expect(
      parseArguments(["ads", "copy", "tasks", "get", "--help"])
    ).toMatchObject({
      help: true,
      command: { kind: "ads.copy.tasks.get" },
    })
  })
})

describe("helpText", () => {
  it("全局帮助冻结命令面、公共 flags、退出码和 CLI 边界", () => {
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
      "ads campaigns budget",
      "ads copy submit",
      "ads copy preview",
      "ads copy tasks",
      "ads copy tasks get",
      "gmvmax stores",
      "gmvmax campaigns list",
      "gmvmax campaigns get",
      "gmvmax campaigns status",
      "gmvmax campaigns budget",
      "gmvmax campaigns roas",
      "rules options",
      "rules list",
      "rules get",
      "rules create",
      "rules update",
      "rules enable",
      "rules disable",
      "rules delete",
      "rules dryrun",
      "rules executions list",
      "rules executions get",
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
    expect(help).toContain("Evaluate one rule without actions")
    expect(help).not.toContain("Evaluate one Ads rule without actions")
    expect(help).toContain("Create one disabled automation rule")
    expect(help).not.toContain("Create one disabled Ads rule")
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
    ["ads campaigns budget", "--mode <mode>"],
    ["ads copy submit", "accepted"],
    ["ads copy preview", "without an idempotency key"],
    ["ads copy tasks", "does not follow pagination"],
    ["ads copy tasks get", "Partial is a terminal"],
    ["gmvmax stores", "--adv-id <id>"],
    ["gmvmax campaigns list", "--promotion-type product|live"],
    ["gmvmax campaigns get", "--store-id <id>"],
    ["gmvmax campaigns status", "--auth-id <id>"],
    ["gmvmax campaigns budget", "at most 2 decimal places"],
    ["gmvmax campaigns roas", "at most 1 decimal place"],
    ["rules options", "--rule-type"],
    ["rules list", "--rule-type"],
    ["rules get", "--rule-id <id>"],
    ["rules create", "--file <rule.json> | --stdin"],
    ["rules update", "--file <patch.json>"],
    ["rules enable", "bodyless POST"],
    ["rules disable", "bodyless POST"],
    ["rules delete", "bodyless POST"],
    ["rules dryrun", "no Idempotency-Key"],
    ["rules executions list", "--page-size <1..100>"],
    ["rules executions get", "--execution-id <id>"],
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
    expect(help).toContain("CLI capability boundary:")
    expect(help).toContain("No team switching")
    expect(help).toContain("npm install -g @adrate/cli")
    expect(help).toContain("adrate skills install")
  })

  it("Rule 帮助保留 material 的服务端合同与 dryrun 上下文", () => {
    expect(helpText("rules options")).toContain(
      "--rule-type ads --scope material"
    )
    for (const topic of ["rules create", "rules update"]) {
      const help = helpText(topic)
      expect(help).toContain(
        "separate rules options command for the Ads material"
      )
      expect(help).not.toContain("--rule-type")
      expect(help).not.toContain("--scope")
    }
    expect(helpText("rules list")).toContain("server-provided scope is material")
    expect(helpText("rules get")).toContain("scopes such as material")
    expect(helpText("rules dryrun")).toContain(
      "Ads material rules pass only --adv-id"
    )
    expect(helpText("rules dryrun")).toContain("materialMapping")
  })

  it.each([
    "ads campaigns list",
    "ads campaigns get",
    "ads campaigns status",
    "ads report campaigns",
    "ads campaigns budget",
  ])("%s 明确多授权缺 authId 的改请求语义", (topic) => {
    const help = helpText(topic)
    expect(help).toContain("--auth-id")
    expect(help).toMatch(
      /Multiple authorization candidates require|TIKTOK_AUTH_ID_REQUIRED/
    )
    expect(help).toMatch(/never\s+chooses|never choose/)
  })

  it("Status 帮助不再声称 Copy 或任意批量写不受支持", () => {
    const help = helpText("ads campaigns status")
    expect(help).toContain("never retries the POST automatically")
    expect(help).toContain("one Campaign status only")
    expect(help).toContain("Campaign Copy is available under")
    expect(help).not.toContain("no batch")
    expect(help).not.toContain("no batch writes")
    expect(help).not.toContain("budget")
    expect(help).not.toContain("rules")
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
