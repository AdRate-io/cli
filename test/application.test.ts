import { describe, expect, it, vi } from "vitest"
import { CliApplication } from "../src/application.js"
import { CLI_VERSION } from "../src/constants.js"
import { createLocalSuccess } from "../src/contracts/envelope.js"
import { dependencyFailure } from "../src/errors.js"
import { renderOutcome } from "../src/output.js"
import type { AuthService } from "../src/auth/auth-service.js"
import type { ReadCommandService } from "../src/commands/read-service.js"
import type { CliOutcome } from "../src/errors.js"

function successOutcome(label: string): CliOutcome {
  return {
    exitCode: 0,
    envelope: createLocalSuccess("stub-request", { label }),
    warnings: [],
  }
}

function createHarness() {
  const auth = {
    login: vi.fn(() => Promise.resolve(successOutcome("login"))),
    status: vi.fn(() => Promise.resolve(successOutcome("status"))),
    whoami: vi.fn(() => Promise.resolve(successOutcome("whoami"))),
    logout: vi.fn(() => Promise.resolve(successOutcome("logout"))),
  }
  const reads = {
    execute: vi.fn(() => Promise.resolve(successOutcome("read"))),
  }
  const commands = {
    campaignStatus: {
      status: vi.fn(() => Promise.resolve(successOutcome("status-write"))),
    },
    campaignBudget: {
      budget: vi.fn(() => Promise.resolve(successOutcome("budget-write"))),
    },
    gmvMax: {
      status: vi.fn(() => Promise.resolve(successOutcome("gmv-status"))),
      budget: vi.fn(() => Promise.resolve(successOutcome("gmv-budget"))),
      roas: vi.fn(() => Promise.resolve(successOutcome("gmv-roas"))),
    },
    commandQuery: {
      get: vi.fn(() => Promise.resolve(successOutcome("command-get"))),
    },
    pendingCommands: {
      pending: vi.fn(() => Promise.resolve(successOutcome("pending"))),
    },
    commandResume: {
      resume: vi.fn(() => Promise.resolve(successOutcome("resume"))),
    },
    feedback: {
      submit: vi.fn(() => Promise.resolve(successOutcome("feedback"))),
    },
    copy: {
      submit: vi.fn(() => Promise.resolve(successOutcome("copy-submit"))),
      preview: vi.fn(() => Promise.resolve(successOutcome("copy-preview"))),
    },
    rules: {
      create: vi.fn(() => Promise.resolve(successOutcome("rule-create"))),
      update: vi.fn(() => Promise.resolve(successOutcome("rule-update"))),
      enable: vi.fn(() => Promise.resolve(successOutcome("rule-enable"))),
      disable: vi.fn(() => Promise.resolve(successOutcome("rule-disable"))),
      delete: vi.fn(() => Promise.resolve(successOutcome("rule-delete"))),
      dryRun: vi.fn(() => Promise.resolve(successOutcome("rule-dryrun"))),
    },
    skills: {
      list: vi.fn(() => Promise.resolve(successOutcome("skills-list"))),
      read: vi.fn(() => Promise.resolve(successOutcome("skills-read"))),
    },
    skillsInstall: {
      install: vi.fn(() => Promise.resolve(successOutcome("skills-install"))),
    },
  }
  return {
    application: new CliApplication(
      auth as unknown as AuthService,
      reads as unknown as ReadCommandService,
      commands
    ),
    auth,
    reads,
    commands,
  }
}

describe("CliApplication local surface", () => {
  it.each([600, 86_400])(
    "preserves local OAuth retry=%s through outcome and human output",
    async (retryAfterSeconds) => {
      const harness = createHarness()
      harness.auth.login.mockRejectedValueOnce(
        dependencyFailure(
          "The authorization service is temporarily unavailable.",
          4,
          {
            retryAfterSeconds,
            oauthError: "temporarily_unavailable",
            suggestedAction: "retry_after",
          }
        )
      )
      const execution = await harness.application.execute([
        "auth",
        "login",
        "--resume",
      ])
      let stdout = ""
      let stderr = ""

      renderOutcome(
        execution.outcome,
        { json: false, verbose: false },
        {
          stdout: {
            write(value) {
              stdout += String(value)
              return true
            },
          },
          stderr: {
            write(value) {
              stderr += String(value)
              return true
            },
          },
        }
      )

      expect(execution.outcome).toMatchObject({
        exitCode: 4,
        retryAfterSeconds,
        envelope: { meta: { retryAfterSeconds } },
      })
      expect(stdout).toBe("")
      expect(stderr).toContain(
        `Warning: Retry after ${retryAfterSeconds} second(s) before repeating this request.`
      )
      expect(stderr).not.toContain("oauthError")
      expect(stderr).not.toContain("suggestedAction")
    }
  )

  it("无参数返回全局帮助且不触发认证、存储或网络服务", async () => {
    const harness = createHarness()
    const execution = await harness.application.execute([])

    expect(execution).toMatchObject({
      json: false,
      verbose: false,
      outcome: {
        exitCode: 0,
        envelope: {
          ok: true,
          data: {
            help: expect.stringContaining("AdRate CLI"),
          },
        },
      },
    })
    expect(harness.auth.login).not.toHaveBeenCalled()
    expect(harness.auth.status).not.toHaveBeenCalled()
    expect(harness.auth.whoami).not.toHaveBeenCalled()
    expect(harness.auth.logout).not.toHaveBeenCalled()
    expect(harness.reads.execute).not.toHaveBeenCalled()
  })

  it("--help/命令 --help 返回对应文本，--json 仍保持单信封输出模式", async () => {
    const harness = createHarness()
    const globalHelp = await harness.application.execute(["--json", "--help"])
    expect(globalHelp.json).toBe(true)
    expect(globalHelp.outcome.envelope.ok).toBe(true)

    const commandHelp = await harness.application.execute([
      "ads",
      "campaigns",
      "list",
      "--help",
    ])
    expect(commandHelp.outcome.envelope.ok).toBe(true)
    if (commandHelp.outcome.envelope.ok) {
      expect(commandHelp.outcome.envelope.data.help).toContain(
        "Usage: adrate ads campaigns list --adv-id <id>"
      )
    }
    expect(harness.reads.execute).not.toHaveBeenCalled()
  })

  it("--version 返回冻结 CLI 版本且不 dispatch", async () => {
    const harness = createHarness()
    const execution = await harness.application.execute(["--version", "--json"])

    expect(execution.outcome.exitCode).toBe(0)
    expect(execution.outcome.envelope.ok).toBe(true)
    if (execution.outcome.envelope.ok) {
      expect(execution.outcome.envelope.data.version).toBe(CLI_VERSION)
    }
    expect(execution.outcome.humanOutput).toEqual({
      stream: "stdout",
      mode: "line",
      value: CLI_VERSION,
    })
    expect(harness.reads.execute).not.toHaveBeenCalled()
  })

  it("认证 login 精确接收 split flow、no-input、test 与非秘密设备名", async () => {
    const harness = createHarness()
    const execution = await harness.application.execute([
      "auth",
      "login",
      "--no-wait",
      "--no-input",
      "--test",
      "--device-name",
      "Boss-Mac",
      "--request-id",
      "login-request",
      "--json",
      "--verbose",
    ])

    expect(execution).toMatchObject({
      json: true,
      verbose: true,
      outcome: { exitCode: 0 },
    })
    expect(harness.auth.login).toHaveBeenCalledWith({
      global: {
        json: true,
        noInput: true,
        requestId: "login-request",
        verbose: true,
        test: true,
      },
      noWait: true,
      resume: false,
      device: false,
      deviceName: "Boss-Mac",
    })
    expect(harness.reads.execute).not.toHaveBeenCalled()
  })

  it("只读命令通过统一 read service dispatch，并完整传入公共 flags", async () => {
    const harness = createHarness()
    await harness.application.execute([
      "ads",
      "campaigns",
      "get",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--auth-id",
      "42",
      "--request-id",
      "read-request",
      "--no-input",
    ])

    expect(harness.reads.execute).toHaveBeenCalledWith(
      {
        kind: "ads.campaigns.get",
        advId: "70001",
        campaignId: "80001",
        authId: "42",
      },
      {
        json: false,
        noInput: true,
        requestId: "read-request",
        verbose: false,
        test: false,
      }
    )
  })

  it("Copy submit/preview 只分派 file、request id 与 submit key", async () => {
    const harness = createHarness()
    await harness.application.execute([
      "ads",
      "copy",
      "submit",
      "--file",
      "copy.json",
      "--idempotency-key",
      "copy_key",
      "--request-id",
      "copy-submit-request",
    ])
    await harness.application.execute([
      "ads",
      "copy",
      "preview",
      "--file",
      "copy.json",
      "--request-id",
      "copy-preview-request",
    ])

    expect(harness.commands.copy.submit).toHaveBeenCalledWith({
      file: "copy.json",
      idempotencyKey: "copy_key",
      requestId: "copy-submit-request",
    })
    expect(harness.commands.copy.preview).toHaveBeenCalledWith({
      file: "copy.json",
      requestId: "copy-preview-request",
    })
    expect(harness.commands.pendingCommands.pending).not.toHaveBeenCalled()
    expect(harness.commands.commandResume.resume).not.toHaveBeenCalled()
    expect(harness.commands.commandQuery.get).not.toHaveBeenCalled()
    expect(harness.commands.campaignStatus.status).not.toHaveBeenCalled()
    expect(harness.commands.campaignBudget.budget).not.toHaveBeenCalled()
    expect(harness.reads.execute).not.toHaveBeenCalled()
  })

  it("Copy tasks 与 tasks get 只进入统一 ReadService，不触发 Copy 写或 Command", async () => {
    const harness = createHarness()
    await harness.application.execute([
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
    await harness.application.execute([
      "ads",
      "copy",
      "tasks",
      "get",
      "--task-id",
      "42",
    ])

    expect(harness.reads.execute).toHaveBeenNthCalledWith(
      1,
      {
        kind: "ads.copy.tasks.list",
        status: "partial",
        page: "2",
        pageSize: "50",
      },
      expect.objectContaining({ test: false })
    )
    expect(harness.reads.execute).toHaveBeenNthCalledWith(
      2,
      { kind: "ads.copy.tasks.get", taskId: "42" },
      expect.objectContaining({ test: false })
    )
    expect(harness.commands.copy.submit).not.toHaveBeenCalled()
    expect(harness.commands.copy.preview).not.toHaveBeenCalled()
    expect(harness.commands.pendingCommands.pending).not.toHaveBeenCalled()
    expect(harness.commands.commandResume.resume).not.toHaveBeenCalled()
    expect(harness.commands.commandQuery.get).not.toHaveBeenCalled()
    expect(harness.commands.campaignStatus.status).not.toHaveBeenCalled()
    expect(harness.commands.campaignBudget.budget).not.toHaveBeenCalled()
  })

  it("反馈命令只向独立服务分派显式输入和公共 Key", async () => {
    const harness = createHarness()
    await harness.application.execute([
      "feedback",
      "--category",
      "bug",
      "--message=--literal $() text",
      "--idempotency-key",
      "feedback_key",
      "--request-id",
      "feedback_request",
    ])

    expect(harness.commands.feedback.submit).toHaveBeenCalledWith({
      category: "bug",
      message: "--literal $() text",
      messageStdin: false,
      idempotencyKey: "feedback_key",
      requestId: "feedback_request",
    })
    expect(harness.commands.campaignStatus.status).not.toHaveBeenCalled()
    expect(harness.commands.pendingCommands.pending).not.toHaveBeenCalled()
    expect(harness.reads.execute).not.toHaveBeenCalled()
    expect(harness.auth.login).not.toHaveBeenCalled()
  })

  it("Rule 写命令与 dryrun 精确分派参数", async () => {
    const harness = createHarness()
    await harness.application.execute([
      "rules",
      "create",
      "--stdin",
      "--idempotency-key",
      "create_key",
      "--request-id",
      "create_request",
    ])
    expect(harness.commands.rules.create).toHaveBeenCalledWith({
      file: undefined,
      stdin: true,
      idempotencyKey: "create_key",
      requestId: "create_request",
    })

    await harness.application.execute([
      "rules",
      "update",
      "--rule-id",
      "42",
      "--file",
      "patch.json",
    ])
    expect(harness.commands.rules.update).toHaveBeenCalledWith({
      ruleId: "42",
      file: "patch.json",
      idempotencyKey: undefined,
      requestId: undefined,
    })

    for (const operation of ["enable", "disable", "delete"] as const) {
      await harness.application.execute([
        "rules",
        operation,
        "--rule-id",
        "42",
        "--idempotency-key",
        `${operation}_key`,
      ])
      expect(harness.commands.rules[operation]).toHaveBeenCalledWith({
        ruleId: "42",
        idempotencyKey: `${operation}_key`,
        requestId: undefined,
      })
    }

    await harness.application.execute([
      "rules",
      "dryrun",
      "--rule-id",
      "42",
      "--adv-id",
      "70001",
      "--shop-id",
      "shop-1",
      "--campaign-id",
      "80001",
      "--request-id",
      "dryrun_request",
    ])
    expect(harness.commands.rules.dryRun).toHaveBeenCalledWith({
      ruleId: "42",
      advId: "70001",
      shopId: "shop-1",
      campaignId: "80001",
      requestId: "dryrun_request",
    })

    await harness.application.execute([
      "rules",
      "dryrun",
      "--rule-id",
      "44",
      "--adv-id",
      "70002",
      "--request-id",
      "material_dryrun_request",
    ])
    expect(harness.commands.rules.dryRun).toHaveBeenLastCalledWith({
      ruleId: "44",
      advId: "70002",
      shopId: undefined,
      campaignId: undefined,
      requestId: "material_dryrun_request",
    })
    expect(harness.reads.execute).not.toHaveBeenCalled()
  })

  it("T10 命令显式穷尽分发，全局 Key/requestId 与命令参数无漂移", async () => {
    const harness = createHarness()

    await harness.application.execute([
      "ads",
      "campaigns",
      "status",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--set",
      "disable",
      "--auth-id",
      "42",
      "--idempotency-key",
      "status_key",
      "--request-id",
      "status_request",
    ])
    expect(harness.commands.campaignStatus.status).toHaveBeenCalledWith({
      advId: "70001",
      campaignId: "80001",
      desiredStatus: "disable",
      authId: "42",
      idempotencyKey: "status_key",
      requestId: "status_request",
    })

    await harness.application.execute([
      "commands",
      "get",
      "--command-id",
      "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
      "--request-id",
      "get_request",
    ])
    expect(harness.commands.commandQuery.get).toHaveBeenLastCalledWith({
      commandId: "018f15d1-7d8f-7ea1-a492-8b7f8271fc6e",
      idempotencyKey: undefined,
      requestId: "get_request",
    })

    await harness.application.execute([
      "commands",
      "get",
      "--idempotency-key",
      "query_key",
    ])
    expect(harness.commands.commandQuery.get).toHaveBeenLastCalledWith({
      commandId: undefined,
      idempotencyKey: "query_key",
      requestId: undefined,
    })

    await harness.application.execute(["commands", "pending"])
    expect(harness.commands.pendingCommands.pending).toHaveBeenCalledWith()

    await harness.application.execute([
      "commands",
      "resume",
      "--idempotency-key",
      "resume_key",
      "--request-id",
      "resume_request",
    ])
    expect(harness.commands.commandResume.resume).toHaveBeenCalledWith({
      idempotencyKey: "resume_key",
      requestId: "resume_request",
    })

    await harness.application.execute([
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
      "--auth-id",
      "42",
      "--idempotency-key",
      "budget_key",
      "--request-id",
      "budget_request",
    ])
    expect(harness.commands.campaignBudget.budget).toHaveBeenCalledWith({
      advId: "70001",
      campaignId: "80001",
      mode: "set",
      value: "300",
      authId: "42",
      idempotencyKey: "budget_key",
      requestId: "budget_request",
    })

    await harness.application.execute([
      "gmvmax",
      "campaigns",
      "status",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--set",
      "disable",
      "--auth-id",
      "9",
      "--idempotency-key",
      "gmv_status_key",
    ])
    expect(harness.commands.gmvMax.status).toHaveBeenCalledWith({
      advId: "70001",
      campaignId: "80001",
      desiredStatus: "disable",
      authId: "9",
      idempotencyKey: "gmv_status_key",
      requestId: undefined,
    })

    await harness.application.execute([
      "gmvmax",
      "campaigns",
      "budget",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--mode",
      "increase_amount",
      "--value",
      "25.5",
      "--auth-id",
      "9",
    ])
    expect(harness.commands.gmvMax.budget).toHaveBeenCalledWith({
      advId: "70001",
      campaignId: "80001",
      mode: "increase_amount",
      value: "25.5",
      authId: "9",
      idempotencyKey: undefined,
      requestId: undefined,
    })

    await harness.application.execute([
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
      "--request-id",
      "gmv_roas_request",
    ])
    expect(harness.commands.gmvMax.roas).toHaveBeenCalledWith({
      advId: "70001",
      campaignId: "80001",
      mode: "set",
      value: "2.5",
      authId: "9",
      idempotencyKey: undefined,
      requestId: "gmv_roas_request",
    })

    await harness.application.execute([
      "gmvmax",
      "campaigns",
      "get",
      "--adv-id",
      "70001",
      "--campaign-id",
      "80001",
      "--store-id",
      "shop-1",
    ])
    expect(harness.reads.execute).toHaveBeenLastCalledWith(
      {
        kind: "gmvmax.campaigns.get",
        advId: "70001",
        campaignId: "80001",
        storeId: "shop-1",
        authId: undefined,
      },
      expect.objectContaining({ json: false })
    )

    harness.reads.execute.mockClear()

    await harness.application.execute([
      "rules",
      "options",
      "--rule-type",
      "ads",
      "--scope",
      "material",
    ])
    expect(harness.reads.execute).toHaveBeenLastCalledWith(
      { kind: "rules.options", ruleType: "ads", scope: "material" },
      expect.objectContaining({ json: false })
    )

    await harness.application.execute([
      "rules",
      "list",
      "--rule-type",
      "ads",
      "--keyword",
      "cpa",
      "--page",
      "2",
      "--page-size",
      "50",
    ])
    expect(harness.reads.execute).toHaveBeenLastCalledWith(
      {
        kind: "rules.list",
        ruleType: "ads",
        keyword: "cpa",
        page: "2",
        pageSize: "50",
      },
      expect.objectContaining({ json: false })
    )

    await harness.application.execute(["rules", "get", "--rule-id", "42"])
    expect(harness.reads.execute).toHaveBeenLastCalledWith(
      { kind: "rules.get", ruleId: "42" },
      expect.objectContaining({ json: false })
    )

    await harness.application.execute([
      "rules",
      "executions",
      "list",
      "--rule-id",
      "42",
      "--result",
      "success",
      "--page-size",
      "50",
    ])
    expect(harness.reads.execute).toHaveBeenLastCalledWith(
      {
        kind: "rules.executions.list",
        ruleId: "42",
        scopeId: undefined,
        result: "success",
        from: undefined,
        to: undefined,
        page: undefined,
        pageSize: "50",
      },
      expect.objectContaining({ json: false })
    )

    await harness.application.execute([
      "rules",
      "executions",
      "get",
      "--execution-id",
      "99",
    ])
    expect(harness.reads.execute).toHaveBeenLastCalledWith(
      { kind: "rules.executions.get", executionId: "99" },
      expect.objectContaining({ json: false })
    )

    expect(harness.auth.login).not.toHaveBeenCalled()
    expect(harness.auth.status).not.toHaveBeenCalled()
    expect(harness.auth.whoami).not.toHaveBeenCalled()
    expect(harness.auth.logout).not.toHaveBeenCalled()
  })

  it("T10 parser 错误和 help 在任何 service 前收口", async () => {
    const helpHarness = createHarness()
    for (const argv of [
      ["ads", "campaigns", "status", "--help"],
      ["commands", "get", "--help"],
      ["commands", "pending", "--help"],
      ["commands", "resume", "--help"],
    ]) {
      const execution = await helpHarness.application.execute(argv)
      expect(execution.outcome.exitCode).toBe(0)
    }
    expect(helpHarness.commands.campaignStatus.status).not.toHaveBeenCalled()
    expect(helpHarness.commands.commandQuery.get).not.toHaveBeenCalled()
    expect(helpHarness.commands.pendingCommands.pending).not.toHaveBeenCalled()
    expect(helpHarness.commands.commandResume.resume).not.toHaveBeenCalled()
    expect(helpHarness.reads.execute).not.toHaveBeenCalled()
    expect(helpHarness.auth.login).not.toHaveBeenCalled()
    expect(helpHarness.auth.status).not.toHaveBeenCalled()
    expect(helpHarness.auth.whoami).not.toHaveBeenCalled()
    expect(helpHarness.auth.logout).not.toHaveBeenCalled()

    const harness = createHarness()
    for (const argv of [
      ["ads", "campaigns", "status", "--adv-id", "70001"],
      ["commands", "get"],
      ["commands", "resume"],
      ["commands", "pending", "--test"],
    ]) {
      const execution = await harness.application.execute(argv)
      expect(execution.outcome.exitCode).toBe(2)
    }
    expect(harness.commands.campaignStatus.status).not.toHaveBeenCalled()
    expect(harness.commands.commandQuery.get).not.toHaveBeenCalled()
    expect(harness.commands.pendingCommands.pending).not.toHaveBeenCalled()
    expect(harness.commands.commandResume.resume).not.toHaveBeenCalled()
    expect(harness.reads.execute).not.toHaveBeenCalled()
  })

  it("--test 在非新 login 命令上本地退出 2，不 dispatch", async () => {
    const harness = createHarness()
    const execution = await harness.application.execute([
      "capabilities",
      "--test",
      "--json",
    ])

    expect(execution.json).toBe(true)
    expect(execution.outcome.exitCode).toBe(2)
    expect(execution.outcome.envelope.ok).toBe(false)
    if (!execution.outcome.envelope.ok) {
      expect(execution.outcome.envelope.error.code).toBe("INVALID_REQUEST")
    }
    expect(harness.reads.execute).not.toHaveBeenCalled()
  })

  it("parser 拒绝 secret flag，错误信封不回显 secret 值", async () => {
    const harness = createHarness()
    const execution = await harness.application.execute([
      "auth",
      "whoami",
      "--token",
      "super-secret-value",
      "--json",
    ])

    expect(execution.json).toBe(true)
    expect(execution.outcome.exitCode).toBe(2)
    expect(JSON.stringify(execution.outcome.envelope)).not.toContain(
      "super-secret-value"
    )
    expect(harness.auth.whoami).not.toHaveBeenCalled()
  })

  it("未分类本地异常收敛为不可重试业务失败且不泄露原错误", async () => {
    const harness = createHarness()
    harness.reads.execute.mockRejectedValueOnce(
      new Error("internal secret implementation detail")
    )
    const execution = await harness.application.execute(["capabilities"])

    expect(execution.outcome.exitCode).toBe(1)
    expect(execution.outcome.envelope.ok).toBe(false)
    if (!execution.outcome.envelope.ok) {
      expect(execution.outcome.envelope.error).toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
        retryable: false,
      })
    }
    expect(JSON.stringify(execution.outcome.envelope)).not.toContain(
      "internal secret implementation detail"
    )
  })
})
