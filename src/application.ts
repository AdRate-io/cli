import { CLI_VERSION, EXIT_CODE } from "./constants.js"
import { createLocalSuccess } from "./contracts/envelope.js"
import {
  CliFailure,
  dependencyFailure,
  localRequestId,
  usageFailure,
} from "./errors.js"
import { GLOBAL_VALUE_FLAGS, helpText, parseArguments } from "./parser.js"
import { withSkillsNotifierInspection } from "./skills/skills-notifier.js"
import {
  SecureFileChangedError,
  SecureFileError,
  SecureFileLockBusyError,
} from "./storage/secure-files.js"
import type { AuthService } from "./auth/auth-service.js"
import type { ReadCommandService } from "./commands/read-service.js"
import type { CommandQueryService } from "./commands/command-query-service.js"
import type { CommandResumeService } from "./commands/command-resume-service.js"
import type { PendingCommandService } from "./commands/pending-command-service.js"
import type { BudgetCommandService } from "./commands/budget-command-service.js"
import type { StatusCommandService } from "./commands/status-command-service.js"
import type { GmvMaxCommandService } from "./commands/gmvmax-command-service.js"
import type { FeedbackCommandService } from "./commands/feedback-command-service.js"
import type { RuleCommandService } from "./commands/rule-command-service.js"
import type { CopyCommandService } from "./commands/copy-command-service.js"
import type { CliEnvelope } from "./contracts/envelope.js"
import type { CliOutcome } from "./errors.js"
import type { SkillsNotifier } from "./skills/skills-notifier.js"
import type { SkillsInstallService } from "./skills/skills-install-service.js"
import type { SkillsService } from "./skills/skills-service.js"

export interface CliExecution {
  outcome: CliOutcome<CliEnvelope>
  json: boolean
  verbose: boolean
}

export interface CliExecutionOutput {
  emitStdoutLine: (line: string) => void
}

export interface CliCommandServices {
  campaignStatus: Pick<StatusCommandService, "status">
  campaignBudget: Pick<BudgetCommandService, "budget">
  gmvMax: Pick<GmvMaxCommandService, "status" | "budget" | "roas">
  commandQuery: Pick<CommandQueryService, "get">
  pendingCommands: Pick<PendingCommandService, "pending">
  commandResume: Pick<CommandResumeService, "resume">
  feedback: Pick<FeedbackCommandService, "submit">
  copy: Pick<CopyCommandService, "submit" | "preview">
  rules: Pick<
    RuleCommandService,
    "create" | "update" | "enable" | "disable" | "delete" | "dryRun"
  >
  skills: Pick<SkillsService, "list" | "read" | "status">
  skillsInstall: Pick<SkillsInstallService, "install">
}

export class CliApplication {
  constructor(
    private readonly auth: AuthService,
    private readonly reads: ReadCommandService,
    private readonly commands: CliCommandServices,
    private readonly skillsNotifier?: Pick<SkillsNotifier, "inspect">
  ) {}

  async execute(
    argv: ReadonlyArray<string>,
    output?: CliExecutionOutput
  ): Promise<CliExecution> {
    const execution = await this.executeCommand(
      argv,
      output
    )
    let outcome = execution.outcome
    if (this.skillsNotifier) {
      try {
        outcome = withSkillsNotifierInspection(
          outcome,
          await this.skillsNotifier.inspect({
            autoUpgrade: allowsSkillsAutoUpgrade(argv),
          })
        )
      } catch {
        outcome = withSkillsNotifierInspection(outcome, {
          notice: null,
          warning: null,
        })
      }
    }
    return { ...execution, outcome }
  }

  private async executeCommand(
    argv: ReadonlyArray<string>,
    output?: CliExecutionOutput
  ): Promise<CliExecution> {
    let json = argv.includes("--json")
    let verbose = argv.includes("--verbose")
    try {
      const invocation = parseArguments(argv)
      json = invocation.global.json
      verbose = invocation.global.verbose
      if (
        invocation.global.test &&
        (invocation.help ||
          invocation.version ||
          invocation.command?.kind !== "auth.login")
      ) {
        throw usageFailure(
          "--test is only valid for a new auth login Device flow."
        )
      }
      if (invocation.version) {
        return {
          json,
          verbose,
          outcome: {
            exitCode: EXIT_CODE.success,
            envelope: createLocalSuccess(localRequestId(), {
              version: CLI_VERSION,
            }),
            warnings: [],
            humanOutput: { stream: "stdout", mode: "line", value: CLI_VERSION },
          },
        }
      }
      if (invocation.help || !invocation.command) {
        const text = helpText(invocation.helpTopic)
        return {
          json,
          verbose,
          outcome: {
            exitCode: EXIT_CODE.success,
            envelope: createLocalSuccess(localRequestId(), { help: text }),
            warnings: [],
            humanLines: [text],
          },
        }
      }
      let outcome: CliOutcome<CliEnvelope>
      switch (invocation.command.kind) {
        case "auth.login":
          {
            const loginInput = {
              global: invocation.global,
              noWait: invocation.command.noWait,
              resume: invocation.command.resume,
              device: invocation.command.device,
              deviceName: invocation.command.deviceName,
            }
            outcome = output
              ? await this.auth.login(loginInput, output.emitStdoutLine)
              : await this.auth.login(loginInput)
          }
          break
        case "auth.status":
          outcome = await this.auth.status(invocation.global)
          break
        case "auth.whoami":
          outcome = await this.auth.whoami(invocation.global)
          break
        case "auth.logout":
          outcome = await this.auth.logout(invocation.global)
          break
        case "ads.campaigns.status":
          outcome = await this.commands.campaignStatus.status({
            advId: invocation.command.advId,
            campaignId: invocation.command.campaignId,
            desiredStatus: invocation.command.desiredStatus,
            authId: invocation.command.authId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "ads.campaigns.budget":
          outcome = await this.commands.campaignBudget.budget({
            advId: invocation.command.advId,
            campaignId: invocation.command.campaignId,
            mode: invocation.command.mode,
            value: invocation.command.value,
            authId: invocation.command.authId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "gmvmax.campaigns.status":
          outcome = await this.commands.gmvMax.status({
            advId: invocation.command.advId,
            campaignId: invocation.command.campaignId,
            desiredStatus: invocation.command.desiredStatus,
            authId: invocation.command.authId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "gmvmax.campaigns.budget":
          outcome = await this.commands.gmvMax.budget({
            advId: invocation.command.advId,
            campaignId: invocation.command.campaignId,
            mode: invocation.command.mode,
            value: invocation.command.value,
            authId: invocation.command.authId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "gmvmax.campaigns.roas":
          outcome = await this.commands.gmvMax.roas({
            advId: invocation.command.advId,
            campaignId: invocation.command.campaignId,
            mode: invocation.command.mode,
            value: invocation.command.value,
            authId: invocation.command.authId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "commands.get":
          outcome = await this.commands.commandQuery.get({
            commandId: invocation.command.commandId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "commands.pending":
          outcome = await this.commands.pendingCommands.pending()
          break
        case "commands.resume":
          outcome = await this.commands.commandResume.resume({
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "feedback.submit":
          outcome = await this.commands.feedback.submit({
            category: invocation.command.category,
            message: invocation.command.message,
            messageStdin: invocation.command.messageStdin,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "ads.copy.submit":
          outcome = await this.commands.copy.submit({
            file: invocation.command.file,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "ads.copy.preview":
          outcome = await this.commands.copy.preview({
            file: invocation.command.file,
            requestId: invocation.global.requestId,
          })
          break
        case "rules.create":
          outcome = await this.commands.rules.create({
            file: invocation.command.file,
            stdin: invocation.command.stdin,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "rules.update":
          outcome = await this.commands.rules.update({
            ruleId: invocation.command.ruleId,
            file: invocation.command.file,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "rules.enable":
          outcome = await this.commands.rules.enable({
            ruleId: invocation.command.ruleId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "rules.disable":
          outcome = await this.commands.rules.disable({
            ruleId: invocation.command.ruleId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "rules.delete":
          outcome = await this.commands.rules.delete({
            ruleId: invocation.command.ruleId,
            idempotencyKey: invocation.global.idempotencyKey,
            requestId: invocation.global.requestId,
          })
          break
        case "rules.dryrun":
          outcome = await this.commands.rules.dryRun({
            ruleId: invocation.command.ruleId,
            advId: invocation.command.advId,
            shopId: invocation.command.shopId,
            campaignId: invocation.command.campaignId,
            requestId: invocation.global.requestId,
          })
          break
        case "skills.install":
          outcome = await this.commands.skillsInstall.install()
          break
        case "skills.list":
          outcome = await this.commands.skills.list()
          break
        case "skills.status":
          outcome = await this.commands.skills.status()
          break
        case "skills.read":
          outcome = await this.commands.skills.read({
            name: invocation.command.name,
            path: invocation.command.path,
          })
          break
        case "capabilities":
        case "schema":
        case "ads.advertisers":
        case "ads.campaigns.list":
        case "ads.campaigns.get":
        case "ads.report.campaigns":
        case "ads.copy.tasks.list":
        case "ads.copy.tasks.get":
        case "gmvmax.stores":
        case "gmvmax.campaigns.list":
        case "gmvmax.campaigns.get":
        case "rules.options":
        case "rules.list":
        case "rules.get":
        case "rules.executions.list":
        case "rules.executions.get":
          outcome = await this.reads.execute(
            invocation.command,
            invocation.global
          )
          break
      }
      return {
        outcome,
        json,
        verbose,
      }
    } catch (error) {
      const failure = toLocalFailure(error)
      return {
        json,
        verbose,
        outcome: {
          exitCode: failure.exitCode,
          envelope: failure.envelope,
          warnings: failure.warnings,
          ...(failure.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: failure.retryAfterSeconds }),
        },
      }
    }
  }
}

/**
 * 命令执行后是否允许自动升级过期的已安装 Skill：
 * - `skills status` 是只读诊断，必须如实反映升级前状态，不写盘
 * - `skills install` 自身已完成安装，无需再升级
 * 其余命令（含 --version / --help / 解析失败）都允许——Skill 壳要求 Agent 先跑 `adrate --version`
 *
 * 按 argv 的命令前缀判定而非解析结果：`skills status --bogus`、`skills status --help` 这类解析失败 / 帮助路径
 * 拿不到 commandKind，但用户意图仍是只读诊断，同样不得写盘。
 */
function allowsSkillsAutoUpgrade(argv: ReadonlyArray<string>): boolean {
  const positional: Array<string> = []
  let skipValue = false
  for (const token of argv) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (token.startsWith("-")) {
      // 全局取值参数（--request-id x）跳过其值；--flag=value 形式自身已含值
      skipValue = GLOBAL_VALUE_FLAGS.includes(token)
      continue
    }
    positional.push(token)
    if (positional.length === 2) break
  }
  return !(
    positional[0] === "skills" &&
    (positional[1] === "status" || positional[1] === "install")
  )
}

/**
 * 统一异常兜底：本地状态文件错误按「重试能否改变结果」分流。
 * - 锁繁忙 / 并发改动：瞬态，可重试
 * - 其余 SecureFileError（symlink、权限、owner、过大等）：持久性，不可重试，但透出具体原因
 *   （文案均为静态字符串，不含路径或凭据）便于用户自行修复
 */
function toLocalFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error
  if (error instanceof SecureFileLockBusyError) {
    return dependencyFailure(
      "Another AdRate CLI process is updating local state; retry shortly."
    )
  }
  if (error instanceof SecureFileChangedError) {
    return dependencyFailure(
      "A local state file changed while it was being verified; retry the command."
    )
  }
  if (error instanceof SecureFileError) {
    return dependencyFailure(
      `A local state file failed a safety check: ${error.message}`,
      EXIT_CODE.business
    )
  }
  return dependencyFailure(
    "The CLI encountered an unexpected local failure.",
    EXIT_CODE.business
  )
}
