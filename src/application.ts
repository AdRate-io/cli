import { CLI_VERSION, EXIT_CODE } from "./constants.js"
import { createLocalSuccess } from "./contracts/envelope.js"
import {
  CliFailure,
  dependencyFailure,
  localRequestId,
  usageFailure,
} from "./errors.js"
import { helpText, parseArguments } from "./parser.js"
import { withSkillsNotifierInspection } from "./skills/skills-notifier.js"
import { withUpdateNotifierInspection } from "./notices/update-notifier.js"
import { SecureFileLockBusyError } from "./storage/secure-files.js"
import type { AuthService } from "./auth/auth-service.js"
import type { LogoutPostRenderAcknowledgement } from "./auth/logout-delivery-journal.js"
import type { ReadCommandService } from "./commands/read-service.js"
import type { CommandQueryService } from "./commands/command-query-service.js"
import type { CommandResumeService } from "./commands/command-resume-service.js"
import type { PendingCommandService } from "./commands/pending-command-service.js"
import type { StatusCommandService } from "./commands/status-command-service.js"
import type { CliEnvelope } from "./contracts/envelope.js"
import type { CliOutcome } from "./errors.js"
import type { SkillsNotifier } from "./skills/skills-notifier.js"
import type { SkillsService } from "./skills/skills-service.js"
import type { UpdateNotifier } from "./notices/update-notifier.js"

export interface CliExecution {
  outcome: CliOutcome<CliEnvelope>
  json: boolean
  verbose: boolean
  postRenderAcknowledgement?: LogoutPostRenderAcknowledgement
}

export interface CliCommandServices {
  campaignStatus: Pick<StatusCommandService, "status">
  commandQuery: Pick<CommandQueryService, "get">
  pendingCommands: Pick<PendingCommandService, "pending">
  commandResume: Pick<CommandResumeService, "resume">
  skills: Pick<SkillsService, "list" | "read">
}

interface CommandExecution extends CliExecution {
  updateNotifierEligible: boolean
}

export class CliApplication {
  constructor(
    private readonly auth: AuthService,
    private readonly reads: ReadCommandService,
    private readonly commands: CliCommandServices,
    private readonly skillsNotifier?: Pick<SkillsNotifier, "inspect">,
    private readonly updateNotifier?: Pick<UpdateNotifier, "inspect">
  ) {}

  async execute(argv: ReadonlyArray<string>): Promise<CliExecution> {
    const commandExecution = await this.executeCommand(argv)
    const { updateNotifierEligible, ...execution } = commandExecution
    let outcome = execution.outcome
    if (this.skillsNotifier) {
      try {
        outcome = withSkillsNotifierInspection(
          outcome,
          await this.skillsNotifier.inspect()
        )
      } catch {
        outcome = withSkillsNotifierInspection(outcome, {
          notice: null,
          warning: null,
        })
      }
    }
    if (this.updateNotifier) {
      try {
        outcome = withUpdateNotifierInspection(
          outcome,
          updateNotifierEligible
            ? await this.updateNotifier.inspect()
            : { notice: null, warning: null, diagnostic: null },
          execution.verbose
        )
      } catch {
        outcome = withUpdateNotifierInspection(
          outcome,
          {
            notice: null,
            warning: null,
            diagnostic: "Update check skipped after an unexpected failure.",
          },
          execution.verbose
        )
      }
    }
    return { ...execution, outcome }
  }

  private async executeCommand(
    argv: ReadonlyArray<string>
  ): Promise<CommandExecution> {
    let json = argv.includes("--json")
    let verbose = argv.includes("--verbose")
    let updateNotifierEligible = false
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
          updateNotifierEligible,
          outcome: {
            exitCode: EXIT_CODE.success,
            envelope: createLocalSuccess(localRequestId(), {
              version: CLI_VERSION,
            }),
            warnings: [],
            humanLines: [CLI_VERSION],
          },
        }
      }
      if (invocation.help || !invocation.command) {
        const text = helpText(invocation.helpTopic)
        return {
          json,
          verbose,
          updateNotifierEligible,
          outcome: {
            exitCode: EXIT_CODE.success,
            envelope: createLocalSuccess(localRequestId(), { help: text }),
            warnings: [],
            humanLines: [text],
          },
        }
      }
      updateNotifierEligible =
        invocation.command.kind === "auth.status" ||
        invocation.command.kind === "capabilities" ||
        invocation.command.kind === "skills.list"
      let outcome: CliOutcome<CliEnvelope>
      let postRenderAcknowledgement: LogoutPostRenderAcknowledgement | undefined
      switch (invocation.command.kind) {
        case "auth.login":
          outcome = await this.auth.login({
            global: invocation.global,
            noWait: invocation.command.noWait,
            resume: invocation.command.resume,
            deviceName: invocation.command.deviceName,
          })
          break
        case "auth.status":
          outcome = await this.auth.status(invocation.global)
          break
        case "auth.whoami":
          outcome = await this.auth.whoami(invocation.global)
          break
        case "auth.logout":
          {
            const logout = await this.auth.logout(invocation.global)
            const {
              postRenderAcknowledgement: acknowledgement,
              ...renderableOutcome
            } = logout
            postRenderAcknowledgement = acknowledgement
            outcome = renderableOutcome
          }
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
        case "skills.list":
          outcome = await this.commands.skills.list()
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
        updateNotifierEligible,
        ...(postRenderAcknowledgement ? { postRenderAcknowledgement } : {}),
      }
    } catch (error) {
      const failure =
        error instanceof CliFailure
          ? error
          : error instanceof SecureFileLockBusyError
            ? dependencyFailure(
                "Another AdRate CLI process is updating local state; retry shortly."
              )
            : dependencyFailure(
                "The CLI encountered an unexpected local failure.",
                EXIT_CODE.business
              )
      return {
        json,
        verbose,
        updateNotifierEligible,
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
