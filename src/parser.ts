import { IDEMPOTENCY_KEY_PATTERN, REQUEST_ID_PATTERN } from "./constants.js"
import { usageFailure } from "./errors.js"
import { validateAuthLoginInput } from "./auth/auth-command-support.js"

export interface GlobalOptions {
  json: boolean
  noInput: boolean
  requestId?: string
  idempotencyKey?: string
  verbose: boolean
  test: boolean
}

export type ParsedCommand =
  | {
      kind: "auth.login"
      noWait: boolean
      resume: boolean
      device: boolean
      deviceName?: string
    }
  | { kind: "auth.status" }
  | { kind: "auth.whoami" }
  | { kind: "auth.logout" }
  | { kind: "capabilities" }
  | { kind: "schema"; capabilityId: string }
  | { kind: "ads.advertisers" }
  | {
      kind: "ads.campaigns.list"
      advId?: string
      authId?: string
      page?: string
      pageSize?: string
    }
  | {
      kind: "ads.campaigns.get"
      advId?: string
      campaignId?: string
      authId?: string
    }
  | {
      kind: "ads.campaigns.status"
      advId?: string
      campaignId?: string
      desiredStatus?: string
      authId?: string
    }
  | {
      kind: "ads.report.campaigns"
      advId?: string
      authId?: string
      startDate?: string
      endDate?: string
      groupBy?: string
      page?: string
      pageSize?: string
    }
  | { kind: "ads.copy.submit"; file?: string }
  | { kind: "ads.copy.preview"; file?: string }
  | {
      kind: "ads.copy.tasks.list"
      status?: string
      page?: string
      pageSize?: string
    }
  | { kind: "ads.copy.tasks.get"; taskId?: string }
  | { kind: "commands.get"; commandId?: string }
  | { kind: "commands.pending" }
  | { kind: "commands.resume" }
  | {
      kind: "feedback.submit"
      category?: string
      message?: string
      messageStdin: boolean
    }
  | {
      kind: "rules.options"
      ruleType?: string
      scope?: string
    }
  | {
      kind: "rules.list"
      ruleType?: string
      keyword?: string
      page?: string
      pageSize?: string
    }
  | { kind: "rules.get"; ruleId?: string }
  | { kind: "rules.create"; file?: string; stdin: boolean }
  | { kind: "rules.update"; ruleId?: string; file?: string }
  | { kind: "rules.enable"; ruleId?: string }
  | { kind: "rules.disable"; ruleId?: string }
  | { kind: "rules.delete"; ruleId?: string }
  | {
      kind: "rules.dryrun"
      ruleId?: string
      advId?: string
      shopId?: string
      campaignId?: string
    }
  | {
      kind: "rules.executions.list"
      ruleId?: string
      scopeId?: string
      result?: string
      from?: string
      to?: string
      page?: string
      pageSize?: string
    }
  | { kind: "rules.executions.get"; executionId?: string }
  | {
      kind: "ads.campaigns.budget"
      advId?: string
      campaignId?: string
      mode?: string
      value?: string
      authId?: string
    }
  | { kind: "gmvmax.stores"; advId?: string; authId?: string }
  | {
      kind: "gmvmax.campaigns.list"
      advId?: string
      storeId?: string
      promotionType?: string
      from?: string
      to?: string
      includeTrend: boolean
      authId?: string
    }
  | {
      kind: "gmvmax.campaigns.get"
      advId?: string
      campaignId?: string
      storeId?: string
      authId?: string
    }
  | {
      kind: "gmvmax.campaigns.status"
      advId?: string
      campaignId?: string
      desiredStatus?: string
      authId?: string
    }
  | {
      kind: "gmvmax.campaigns.budget" | "gmvmax.campaigns.roas"
      advId?: string
      campaignId?: string
      mode?: string
      value?: string
      authId?: string
    }
  | { kind: "skills.list" }
  | { kind: "skills.install" }
  | { kind: "skills.read"; name?: string; path?: string }

export type ReadCommand = Extract<
  ParsedCommand,
  {
    kind:
      | "capabilities"
      | "schema"
      | "ads.advertisers"
      | "ads.campaigns.list"
      | "ads.campaigns.get"
      | "ads.report.campaigns"
      | "ads.copy.tasks.list"
      | "ads.copy.tasks.get"
      | "gmvmax.stores"
      | "gmvmax.campaigns.list"
      | "gmvmax.campaigns.get"
      | "rules.options"
      | "rules.list"
      | "rules.get"
      | "rules.executions.list"
      | "rules.executions.get"
  }
>

export interface ParsedInvocation {
  global: GlobalOptions
  command: ParsedCommand | null
  help: boolean
  version: boolean
  helpTopic: string
}

// ---------------------------------------------------------------------------
// 命令注册表：每条命令声明自己的 flags、positional 约束、解析逻辑、帮助文本
// 和全局帮助描述行。BOOLEAN_FLAGS / VALUE_FLAGS / FIXED_POSITIONAL_SHAPES /
// COMMAND_HELP / GLOBAL_HELP Commands 列表全部从此注册表派生，消灭五处同步枚举。
// ---------------------------------------------------------------------------

interface ParseContext {
  flags: Map<string, string | true>
  help: boolean
  global: GlobalOptions
  positionals: ReadonlyArray<string>
}

interface CommandRegistration {
  /** commandKey（positionals join " "），即注册表的键 */
  key: string
  /** 命令级 boolean flags（不含全局） */
  booleanFlags?: ReadonlyArray<string>
  /** 命令级 value flags（不含全局） */
  valueFlags?: ReadonlyArray<string>
  /** 额外允许的全局 flag（如 --test 只有 auth login 接受） */
  optInGlobalFlags?: ReadonlyArray<"--test">
  /** positional 前缀 + 最大 positional 数 */
  positional: { prefix: ReadonlyArray<string>; maximum: number }
  /** 解析 flags → ParsedCommand */
  parse: (ctx: ParseContext) => ParsedCommand
  /** 帮助文本的 topic 键（通常等于 key，schema 和 skills read 例外） */
  helpTopic: string
  /** 命令帮助正文 */
  helpText: string
  /** 全局帮助的 Commands 区段中的单行描述（含左侧命令名对齐） */
  globalHelpLine: string
}

const GLOBAL_BOOLEAN_FLAGS: ReadonlyArray<string> = [
  "--json",
  "--no-input",
  "--verbose",
  "--test",
  "--help",
  "--version",
]
const GLOBAL_VALUE_FLAGS: ReadonlyArray<string> = [
  "--request-id",
  "--idempotency-key",
]

// 注册表条目按命令组组织
const COMMAND_REGISTRY_ENTRIES: ReadonlyArray<CommandRegistration> = [
  // === auth 组 ===
  {
    key: "auth login",
    booleanFlags: ["--no-wait", "--resume", "--device"],
    valueFlags: ["--device-name"],
    optInGlobalFlags: ["--test"],
    positional: { prefix: ["auth", "login"], maximum: 2 },
    parse: (ctx) => {
      const command: ParsedCommand = {
        kind: "auth.login",
        noWait: ctx.flags.has("--no-wait"),
        resume: ctx.flags.has("--resume"),
        device: ctx.flags.has("--device"),
        ...(stringFlag(ctx.flags, "--device-name")
          ? { deviceName: stringFlag(ctx.flags, "--device-name") }
          : {}),
      }
      validateAuthLoginInput({ global: ctx.global, ...command })
      return command
    },
    helpTopic: "auth login",
    helpText: `Usage: adrate auth login [--no-wait|--resume|--device] [--device-name <name>]

Creates or resumes the fixed CLI capability scope Device Authorization flow. --no-wait
returns the browser URL without waiting. --resume uses the protected local
Device state. --device emits a single JSON line with device-code fields on
stdout then continues polling until approval or expiry (for machine consumers
such as Accio Work). With --json, the final envelope is a second JSON line.
--no-input never waits. A delivery-unknown Token exchange exits 5 and must not
be blindly restarted.`,
    globalHelpLine:
      "  auth login [--no-wait|--resume|--device]  Authorize this device",
  },
  {
    key: "auth status",
    positional: { prefix: ["auth", "status"], maximum: 2 },
    parse: () => ({ kind: "auth.status" }),
    helpTopic: "auth status",
    helpText: `Usage: adrate auth status

Returns not_authenticated, local_incomplete, active, or remote_invalid.
When a Token exists, exactly one /me request verifies and may activate it.
/public/v1/me is the only endpoint that can activate a new Session.`,
    globalHelpLine:
      "  auth status                      Diagnose local and remote auth state",
  },
  {
    key: "auth whoami",
    positional: { prefix: ["auth", "whoami"], maximum: 2 },
    parse: () => ({ kind: "auth.whoami" }),
    helpTopic: "auth whoami",
    helpText: `Usage: adrate auth whoami

Calls /public/v1/me to verify identity and may activate a newly issued Owner CLI
Session. auth status and auth whoami both call this endpoint when a Token exists.`,
    globalHelpLine:
      "  auth whoami                      Show and activate the current identity",
  },
  {
    key: "auth logout",
    positional: { prefix: ["auth", "logout"], maximum: 2 },
    parse: () => ({ kind: "auth.logout" }),
    helpTopic: "auth logout",
    helpText: `Usage: adrate auth logout

Revokes only the current credential. Pending Command evidence is preserved.
An unknown remote revoke exits 5 and must be checked on the official Web page.`,
    globalHelpLine:
      "  auth logout                      Revoke and remove the current credential",
  },

  // === capabilities / schema ===
  {
    key: "capabilities",
    positional: { prefix: ["capabilities"], maximum: 1 },
    parse: () => ({ kind: "capabilities" }),
    helpTopic: "capabilities",
    helpText: `Usage: adrate capabilities

Reads the server-published Capability list. The CLI does not embed a schema copy.`,
    globalHelpLine:
      "  capabilities                     List server-published capabilities",
  },
  // schema 通过 parseArguments 中的 positional 分支解析（schema <capabilityId>），
  // 帮助文本和全局帮助行由下方 SCHEMA_* 常量提供

  // === ads 组 ===
  {
    key: "ads advertisers",
    positional: { prefix: ["ads", "advertisers"], maximum: 2 },
    parse: () => ({ kind: "ads.advertisers" }),
    helpTopic: "ads advertisers",
    helpText: `Usage: adrate ads advertisers

Lists connected advertisers and TikTok authorization candidates.`,
    globalHelpLine:
      "  ads advertisers                  List connected advertisers",
  },
  {
    key: "ads campaigns list",
    valueFlags: ["--adv-id", "--auth-id", "--page", "--page-size"],
    positional: { prefix: ["ads", "campaigns", "list"], maximum: 3 },
    parse: (ctx) => ({
      kind: "ads.campaigns.list",
      advId: stringFlag(ctx.flags, "--adv-id"),
      authId: stringFlag(ctx.flags, "--auth-id"),
      page: stringFlag(ctx.flags, "--page"),
      pageSize: stringFlag(ctx.flags, "--page-size"),
    }),
    helpTopic: "ads campaigns list",
    helpText: `Usage: adrate ads campaigns list --adv-id <id> [--auth-id <id>] [--page <n>] [--page-size <1..1000>]

Reads exactly one page. Multiple authorization candidates require --auth-id;
the CLI never chooses one or follows pagination automatically.`,
    globalHelpLine: "  ads campaigns list               Read one Campaign page",
  },
  {
    key: "ads campaigns get",
    valueFlags: ["--adv-id", "--campaign-id", "--auth-id"],
    positional: { prefix: ["ads", "campaigns", "get"], maximum: 3 },
    parse: (ctx) => ({
      kind: "ads.campaigns.get",
      advId: stringFlag(ctx.flags, "--adv-id"),
      campaignId: stringFlag(ctx.flags, "--campaign-id"),
      authId: stringFlag(ctx.flags, "--auth-id"),
    }),
    helpTopic: "ads campaigns get",
    helpText: `Usage: adrate ads campaigns get --adv-id <id> --campaign-id <id> [--auth-id <id>]

Reads fresh Current State. Opaque IDs remain strings and must satisfy the CLI
raw-path transport boundary. If the server returns TIKTOK_AUTH_ID_REQUIRED,
repeat the request with one of its candidate --auth-id values; the CLI never
chooses an authorization.`,
    globalHelpLine:
      "  ads campaigns get                Read fresh Campaign state",
  },
  {
    key: "ads campaigns status",
    valueFlags: ["--adv-id", "--campaign-id", "--set", "--auth-id"],
    positional: { prefix: ["ads", "campaigns", "status"], maximum: 3 },
    parse: (ctx) => {
      const advId = stringFlag(ctx.flags, "--adv-id")
      const campaignId = stringFlag(ctx.flags, "--campaign-id")
      const desiredStatus = stringFlag(ctx.flags, "--set")
      if (!ctx.help) {
        if (advId === undefined) throw usageFailure("--adv-id is required.")
        if (campaignId === undefined) {
          throw usageFailure("--campaign-id is required.")
        }
        if (desiredStatus === undefined) {
          throw usageFailure("--set is required.")
        }
        if (desiredStatus !== "enable" && desiredStatus !== "disable") {
          throw usageFailure("--set must be enable or disable.")
        }
      }
      return {
        kind: "ads.campaigns.status",
        advId,
        campaignId,
        desiredStatus,
        authId: stringFlag(ctx.flags, "--auth-id"),
      }
    },
    helpTopic: "ads campaigns status",
    helpText: `Usage: adrate ads campaigns status --adv-id <id> --campaign-id <id> --set enable|disable [--auth-id <id>] [--idempotency-key <key>]

Persists the exact intent before sending at most one Status POST. An omitted key
is generated once and retained locally. A response-loss exit 5 must be recovered
with commands get/pending/resume; the CLI never retries the POST automatically
or issues a new key for the same intent.
Multiple authorization candidates require --auth-id; the CLI never chooses one.
This command changes one Campaign status only. Campaign Copy is available under
ads copy; Campaign creation and Adgroup/Ad writes are not provided by this CLI.`,
    globalHelpLine:
      "  ads campaigns status             Set one Campaign status safely",
  },
  {
    key: "ads report campaigns",
    valueFlags: [
      "--adv-id",
      "--auth-id",
      "--start-date",
      "--end-date",
      "--group-by",
      "--page",
      "--page-size",
    ],
    positional: { prefix: ["ads", "report", "campaigns"], maximum: 3 },
    parse: (ctx) => ({
      kind: "ads.report.campaigns",
      advId: stringFlag(ctx.flags, "--adv-id"),
      authId: stringFlag(ctx.flags, "--auth-id"),
      startDate: stringFlag(ctx.flags, "--start-date"),
      endDate: stringFlag(ctx.flags, "--end-date"),
      groupBy: stringFlag(ctx.flags, "--group-by"),
      page: stringFlag(ctx.flags, "--page"),
      pageSize: stringFlag(ctx.flags, "--page-size"),
    }),
    helpTopic: "ads report campaigns",
    helpText: `Usage: adrate ads report campaigns --adv-id <id> --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD> [--group-by none|day|hour] [--auth-id <id>] [--page <n>] [--page-size <1..1000>]

Reads one basic_v1 page without aggregation or automatic pagination. null metrics
mean N/A, not zero. If the server returns TIKTOK_AUTH_ID_REQUIRED, repeat the
request with one of its candidate --auth-id values; the CLI never chooses an
authorization.`,
    globalHelpLine:
      "  ads report campaigns             Read one basic_v1 report page",
  },
  {
    key: "ads campaigns budget",
    valueFlags: ["--adv-id", "--campaign-id", "--mode", "--value", "--auth-id"],
    positional: { prefix: ["ads", "campaigns", "budget"], maximum: 3 },
    parse: (ctx) => {
      const advId = stringFlag(ctx.flags, "--adv-id")
      const campaignId = stringFlag(ctx.flags, "--campaign-id")
      const mode = stringFlag(ctx.flags, "--mode")
      const value = stringFlag(ctx.flags, "--value")
      if (!ctx.help) {
        if (advId === undefined) throw usageFailure("--adv-id is required.")
        if (campaignId === undefined) {
          throw usageFailure("--campaign-id is required.")
        }
        if (mode === undefined) throw usageFailure("--mode is required.")
        if (
          mode !== "set" &&
          mode !== "increase_amount" &&
          mode !== "decrease_amount" &&
          mode !== "increase_percent" &&
          mode !== "decrease_percent"
        ) {
          throw usageFailure(
            "--mode must be set, increase_amount, decrease_amount, increase_percent, or decrease_percent."
          )
        }
        if (value === undefined) throw usageFailure("--value is required.")
      }
      return {
        kind: "ads.campaigns.budget",
        advId,
        campaignId,
        mode,
        value,
        authId: stringFlag(ctx.flags, "--auth-id"),
      }
    },
    helpTopic: "ads campaigns budget",
    helpText: `Usage: adrate ads campaigns budget --adv-id <id> --campaign-id <id> --mode <mode> --value <number> [--auth-id <id>] [--idempotency-key <key>]

Adjusts one Campaign daily budget. Modes: set (absolute), increase_amount,
decrease_amount, increase_percent, decrease_percent. The value must be positive.
Relative adjustments (increase/decrease) are applied exactly once: the target is
locked after the first GET-before and never recalculated on retry or resume.
The same exit-code and recovery semantics as ads campaigns status apply (exit 5
means remote outcome unknown; recover with commands get/pending/resume).
Multiple authorization candidates require --auth-id; the CLI never chooses one.`,
    globalHelpLine:
      "  ads campaigns budget             Adjust one Campaign daily budget",
  },
  {
    key: "ads copy submit",
    valueFlags: ["--file"],
    positional: { prefix: ["ads", "copy", "submit"], maximum: 3 },
    parse: (ctx) => {
      const file = stringFlag(ctx.flags, "--file")
      if (!ctx.help && file === undefined) {
        throw usageFailure("--file is required.")
      }
      return { kind: "ads.copy.submit", file }
    },
    helpTopic: "ads copy submit",
    helpText: `Usage: adrate ads copy submit --file <copy.json> [--idempotency-key <key>]

Sends one 45-second submit request. Exit 0 means the copy task was accepted,
not completed. Poll ads copy tasks get for the final completed, failed, or
partial result. If the response is unknown, replay the exact file content with
the printed original key; do not generate a new key.`,
    globalHelpLine:
      "  ads copy submit                  Accept one Campaign Copy task",
  },
  {
    key: "ads copy preview",
    valueFlags: ["--file"],
    positional: { prefix: ["ads", "copy", "preview"], maximum: 3 },
    parse: (ctx) => {
      const file = stringFlag(ctx.flags, "--file")
      if (ctx.global.idempotencyKey !== undefined) {
        throw usageFailure(
          "--idempotency-key is not valid for ads copy preview."
        )
      }
      if (!ctx.help && file === undefined) {
        throw usageFailure("--file is required.")
      }
      return { kind: "ads.copy.preview", file }
    },
    helpTopic: "ads copy preview",
    helpText: `Usage: adrate ads copy preview --file <copy.json>

Performs one shallow 45-second preview without an idempotency key, receipt, or
local pending state. Quick-copy target names are examples. Review unsupported
and oversized Campaigns before submit.`,
    globalHelpLine:
      "  ads copy preview                 Preview Campaign Copy input",
  },
  {
    key: "ads copy tasks",
    valueFlags: ["--status", "--page", "--page-size"],
    positional: { prefix: ["ads", "copy", "tasks"], maximum: 4 },
    parse: (ctx) => ({
      kind: "ads.copy.tasks.list",
      status: stringFlag(ctx.flags, "--status"),
      page: stringFlag(ctx.flags, "--page"),
      pageSize: stringFlag(ctx.flags, "--page-size"),
    }),
    helpTopic: "ads copy tasks",
    helpText: `Usage: adrate ads copy tasks [--status <status>] [--page <n>] [--page-size <1..100>]

Reads exactly one copy-task page. Status is pending, processing, completed,
failed, partial, or cancelled. The CLI does not follow pagination or poll.`,
    globalHelpLine:
      "  ads copy tasks                   Read one Copy task page",
  },
  {
    key: "ads copy tasks get",
    valueFlags: ["--task-id"],
    positional: { prefix: ["ads", "copy", "tasks", "get"], maximum: 4 },
    parse: (ctx) => {
      const taskId = stringFlag(ctx.flags, "--task-id")
      if (!ctx.help && taskId === undefined) {
        throw usageFailure("--task-id is required.")
      }
      return { kind: "ads.copy.tasks.get", taskId }
    },
    helpTopic: "ads copy tasks get",
    helpText: `Usage: adrate ads copy tasks get --task-id <id>

Reads one copy task detail. This command does not poll; repeat it with a bounded
interval until the server reports a terminal status. Partial is a terminal
result and must be reviewed item by item.`,
    globalHelpLine:
      "  ads copy tasks get               Read one Copy task detail",
  },

  // === gmvmax 组 ===
  {
    key: "gmvmax stores",
    valueFlags: ["--adv-id", "--auth-id"],
    positional: { prefix: ["gmvmax", "stores"], maximum: 2 },
    parse: (ctx) => ({
      kind: "gmvmax.stores",
      advId: stringFlag(ctx.flags, "--adv-id"),
      authId: stringFlag(ctx.flags, "--auth-id"),
    }),
    helpTopic: "gmvmax stores",
    helpText: `Usage: adrate gmvmax stores --adv-id <id> [--auth-id <id>]

Lists TikTok Shop stores available to one advertiser. Multiple authorization
candidates require --auth-id; the CLI never chooses one.`,
    globalHelpLine:
      "  gmvmax stores                    List available TikTok Shop stores",
  },
  {
    key: "gmvmax campaigns list",
    booleanFlags: ["--include-trend"],
    valueFlags: [
      "--adv-id",
      "--store-id",
      "--promotion-type",
      "--from",
      "--to",
      "--auth-id",
    ],
    positional: { prefix: ["gmvmax", "campaigns", "list"], maximum: 3 },
    parse: (ctx) => ({
      kind: "gmvmax.campaigns.list",
      advId: stringFlag(ctx.flags, "--adv-id"),
      storeId: stringFlag(ctx.flags, "--store-id"),
      promotionType: stringFlag(ctx.flags, "--promotion-type"),
      from: stringFlag(ctx.flags, "--from"),
      to: stringFlag(ctx.flags, "--to"),
      includeTrend: ctx.flags.has("--include-trend"),
      authId: stringFlag(ctx.flags, "--auth-id"),
    }),
    helpTopic: "gmvmax campaigns list",
    helpText: `Usage: adrate gmvmax campaigns list --adv-id <id> --store-id <id> --promotion-type product|live [--from <YYYY-MM-DD> --to <YYYY-MM-DD>] [--include-trend] [--auth-id <id>]

Reads one GMV Max Campaign list. --from and --to must be supplied together and
span at most 30 inclusive calendar days. Omitted dates use the server default.`,
    globalHelpLine: "  gmvmax campaigns list            List GMV Max Campaigns",
  },
  {
    key: "gmvmax campaigns get",
    valueFlags: ["--adv-id", "--campaign-id", "--store-id", "--auth-id"],
    positional: { prefix: ["gmvmax", "campaigns", "get"], maximum: 3 },
    parse: (ctx) => ({
      kind: "gmvmax.campaigns.get",
      advId: stringFlag(ctx.flags, "--adv-id"),
      campaignId: stringFlag(ctx.flags, "--campaign-id"),
      storeId: stringFlag(ctx.flags, "--store-id"),
      authId: stringFlag(ctx.flags, "--auth-id"),
    }),
    helpTopic: "gmvmax campaigns get",
    helpText: `Usage: adrate gmvmax campaigns get --adv-id <id> --campaign-id <id> --store-id <id> [--auth-id <id>]

Reads fresh GMV Max Campaign state. Opaque resource IDs must satisfy the CLI
raw-path transport boundary.`,
    globalHelpLine:
      "  gmvmax campaigns get             Read fresh GMV Max Campaign state",
  },
  {
    key: "gmvmax campaigns status",
    valueFlags: ["--adv-id", "--campaign-id", "--set", "--auth-id"],
    positional: { prefix: ["gmvmax", "campaigns", "status"], maximum: 3 },
    parse: (ctx) => {
      const advId = stringFlag(ctx.flags, "--adv-id")
      const campaignId = stringFlag(ctx.flags, "--campaign-id")
      const desiredStatus = stringFlag(ctx.flags, "--set")
      const authId = stringFlag(ctx.flags, "--auth-id")
      if (!ctx.help) {
        if (advId === undefined) throw usageFailure("--adv-id is required.")
        if (campaignId === undefined) {
          throw usageFailure("--campaign-id is required.")
        }
        if (desiredStatus === undefined)
          throw usageFailure("--set is required.")
        if (desiredStatus !== "enable" && desiredStatus !== "disable") {
          throw usageFailure("--set must be enable or disable.")
        }
        if (authId === undefined) throw usageFailure("--auth-id is required.")
      }
      return {
        kind: "gmvmax.campaigns.status",
        advId,
        campaignId,
        desiredStatus,
        authId,
      }
    },
    helpTopic: "gmvmax campaigns status",
    helpText: `Usage: adrate gmvmax campaigns status --adv-id <id> --campaign-id <id> --set enable|disable --auth-id <id> [--idempotency-key <key>]

Changes one GMV Max Campaign status. --auth-id is required. An omitted key is
generated once and retained locally. Exit 5 means the remote outcome is unknown;
recover with commands get/pending/resume and never retry with a new key.`,
    globalHelpLine:
      "  gmvmax campaigns status          Set one GMV Max Campaign status",
  },
  ...(["budget", "roas"] as const).map((operation) => ({
    key: `gmvmax campaigns ${operation}`,
    valueFlags: ["--adv-id", "--campaign-id", "--mode", "--value", "--auth-id"],
    positional: {
      prefix: ["gmvmax", "campaigns", operation],
      maximum: 3,
    },
    parse: (ctx: ParseContext): ParsedCommand => {
      const advId = stringFlag(ctx.flags, "--adv-id")
      const campaignId = stringFlag(ctx.flags, "--campaign-id")
      const mode = stringFlag(ctx.flags, "--mode")
      const value = stringFlag(ctx.flags, "--value")
      const authId = stringFlag(ctx.flags, "--auth-id")
      if (!ctx.help) {
        if (advId === undefined) throw usageFailure("--adv-id is required.")
        if (campaignId === undefined) {
          throw usageFailure("--campaign-id is required.")
        }
        if (mode === undefined) throw usageFailure("--mode is required.")
        if (!isAdjustmentMode(mode)) {
          throw usageFailure(
            "--mode must be set, increase_amount, decrease_amount, increase_percent, or decrease_percent."
          )
        }
        if (value === undefined) throw usageFailure("--value is required.")
        if (authId === undefined) throw usageFailure("--auth-id is required.")
      }
      return {
        kind: `gmvmax.campaigns.${operation}`,
        advId,
        campaignId,
        mode,
        value,
        authId,
      }
    },
    helpTopic: `gmvmax campaigns ${operation}`,
    helpText: `Usage: adrate gmvmax campaigns ${operation} --adv-id <id> --campaign-id <id> --mode <mode> --value <number> --auth-id <id> [--idempotency-key <key>]

Adjusts one GMV Max Campaign ${operation === "budget" ? "budget" : "ROAS"}. Modes: set,
increase_amount, decrease_amount, increase_percent, decrease_percent. The value
must be positive with at most ${operation === "budget" ? "2" : "1"} decimal place${operation === "budget" ? "s" : ""}; decrease_percent must be below 100.
--auth-id is required. Exit 5 must be recovered with commands get/pending/resume
using the retained key.`,
    globalHelpLine: `  gmvmax campaigns ${operation.padEnd(15)} Adjust one GMV Max Campaign ${operation === "budget" ? "budget" : "ROAS"}`,
  })),

  // === rules 组 ===
  {
    key: "rules options",
    valueFlags: ["--rule-type", "--scope"],
    positional: { prefix: ["rules", "options"], maximum: 2 },
    parse: (ctx) => {
      const ruleType = stringFlag(ctx.flags, "--rule-type")
      const scope = stringFlag(ctx.flags, "--scope")
      if (!ctx.help) {
        if (ruleType === undefined) {
          throw usageFailure("--rule-type is required.")
        }
        if (
          ruleType !== "ads" &&
          ruleType !== "gmv_max_product" &&
          ruleType !== "gmv_max_live"
        ) {
          throw usageFailure(
            "--rule-type must be ads, gmv_max_product, or gmv_max_live."
          )
        }
        if (scope === undefined) {
          throw usageFailure("--scope is required.")
        }
      }
      return {
        kind: "rules.options",
        ruleType,
        scope,
      }
    },
    helpTopic: "rules options",
    helpText: `Usage: adrate rules options --rule-type ads|gmv_max_product|gmv_max_live --scope <scope>

Returns the available metrics, actions, operators, time windows, and constraints
for the given rule type and scope (e.g. campaign, adgroup, ad for Ads rules).
The response is structured metadata without human-language labels; metric keys
are self-descriptive.`,
    globalHelpLine:
      "  rules options                    Read rule capability metadata",
  },
  {
    key: "rules list",
    valueFlags: ["--rule-type", "--keyword", "--page", "--page-size"],
    positional: { prefix: ["rules", "list"], maximum: 2 },
    parse: (ctx) => ({
      kind: "rules.list",
      ruleType: stringFlag(ctx.flags, "--rule-type"),
      keyword: stringFlag(ctx.flags, "--keyword"),
      page: stringFlag(ctx.flags, "--page"),
      pageSize: stringFlag(ctx.flags, "--page-size"),
    }),
    helpTopic: "rules list",
    helpText: `Usage: adrate rules list [--rule-type ads|gmv_max_product|gmv_max_live] [--keyword <text>] [--page <n>] [--page-size <1..100>]

Lists automation rules with optional filters. Both Ads and GMV Max rule types
are supported. The response includes recent execution statistics.`,
    globalHelpLine: "  rules list                       List automation rules",
  },
  {
    key: "rules get",
    valueFlags: ["--rule-id"],
    positional: { prefix: ["rules", "get"], maximum: 2 },
    parse: (ctx) => {
      const ruleId = stringFlag(ctx.flags, "--rule-id")
      if (!ctx.help && ruleId === undefined) {
        throw usageFailure("--rule-id is required.")
      }
      return { kind: "rules.get", ruleId }
    },
    helpTopic: "rules get",
    helpText: `Usage: adrate rules get --rule-id <id>

Reads one automation rule with full pipeline, condition, and action detail.`,
    globalHelpLine: "  rules get                        Read one rule detail",
  },
  {
    key: "rules create",
    booleanFlags: ["--stdin"],
    valueFlags: ["--file"],
    positional: { prefix: ["rules", "create"], maximum: 2 },
    parse: (ctx) => {
      const file = stringFlag(ctx.flags, "--file")
      const stdin = ctx.flags.has("--stdin")
      if (!ctx.help && (file !== undefined) === stdin) {
        throw usageFailure("Exactly one of --file or --stdin is required.")
      }
      return { kind: "rules.create", file, stdin }
    },
    helpTopic: "rules create",
    helpText: `Usage: adrate rules create (--file <rule.json> | --stdin) [--idempotency-key <key>]

Creates one disabled automation rule from a JSON object. The CLI checks only valid JSON
and a top-level object; the server is the rule-schema source of truth. An omitted
key is generated with a rule-create prefix. The CLI sends at most one 15-second
POST, never writes pending Command state, and never retries automatically.
If the response is unknown, replay the exact input with the printed original key.`,
    globalHelpLine:
      "  rules create                     Create one disabled automation rule",
  },
  {
    key: "rules update",
    valueFlags: ["--rule-id", "--file"],
    positional: { prefix: ["rules", "update"], maximum: 2 },
    parse: (ctx) => {
      const ruleId = stringFlag(ctx.flags, "--rule-id")
      const file = stringFlag(ctx.flags, "--file")
      if (!ctx.help) {
        if (ruleId === undefined) throw usageFailure("--rule-id is required.")
        if (file === undefined) throw usageFailure("--file is required.")
      }
      return { kind: "rules.update", ruleId, file }
    },
    helpTopic: "rules update",
    helpText: `Usage: adrate rules update --rule-id <id> --file <patch.json> [--idempotency-key <key>]

Applies one top-level JSON object as a rule patch. The server owns structural
validation. The CLI sends at most one 15-second POST and does not use the pending
Command journal. Unknown outcomes must be replayed with the original printed key.`,
    globalHelpLine: "  rules update                     Update one automation rule",
  },
  {
    key: "rules enable",
    valueFlags: ["--rule-id"],
    positional: { prefix: ["rules", "enable"], maximum: 2 },
    parse: (ctx) => {
      const ruleId = stringFlag(ctx.flags, "--rule-id")
      if (!ctx.help && ruleId === undefined) {
        throw usageFailure("--rule-id is required.")
      }
      return { kind: "rules.enable", ruleId }
    },
    helpTopic: "rules enable",
    helpText: `Usage: adrate rules enable --rule-id <id> [--idempotency-key <key>]

Enables one rule with a completely bodyless POST. The CLI sends at most one
request, never retries automatically, and never stores pending Command state.`,
    globalHelpLine: "  rules enable                     Enable one automation rule",
  },
  {
    key: "rules disable",
    valueFlags: ["--rule-id"],
    positional: { prefix: ["rules", "disable"], maximum: 2 },
    parse: (ctx) => {
      const ruleId = stringFlag(ctx.flags, "--rule-id")
      if (!ctx.help && ruleId === undefined) {
        throw usageFailure("--rule-id is required.")
      }
      return { kind: "rules.disable", ruleId }
    },
    helpTopic: "rules disable",
    helpText: `Usage: adrate rules disable --rule-id <id> [--idempotency-key <key>]

Disables one rule with a completely bodyless POST. Frozen teams may use this
stop-loss operation. Unknown outcomes must be replayed with the original key.`,
    globalHelpLine: "  rules disable                    Disable one automation rule",
  },
  {
    key: "rules delete",
    valueFlags: ["--rule-id"],
    positional: { prefix: ["rules", "delete"], maximum: 2 },
    parse: (ctx) => {
      const ruleId = stringFlag(ctx.flags, "--rule-id")
      if (!ctx.help && ruleId === undefined) {
        throw usageFailure("--rule-id is required.")
      }
      return { kind: "rules.delete", ruleId }
    },
    helpTopic: "rules delete",
    helpText: `Usage: adrate rules delete --rule-id <id> [--idempotency-key <key>]

Soft-deletes one rule with a completely bodyless POST. Confirm destructive
intent before running it. Frozen teams may use this stop-loss operation.`,
    globalHelpLine: "  rules delete                     Delete one automation rule",
  },
  {
    key: "rules dryrun",
    valueFlags: ["--rule-id", "--adv-id", "--shop-id", "--campaign-id"],
    positional: { prefix: ["rules", "dryrun"], maximum: 2 },
    parse: (ctx) => {
      const ruleId = stringFlag(ctx.flags, "--rule-id")
      const advId = stringFlag(ctx.flags, "--adv-id")
      const shopId = stringFlag(ctx.flags, "--shop-id")
      const campaignId = stringFlag(ctx.flags, "--campaign-id")
      if (ctx.global.idempotencyKey !== undefined) {
        throw usageFailure("--idempotency-key is not valid for rules dryrun.")
      }
      if (!ctx.help) {
        if (ruleId === undefined) throw usageFailure("--rule-id is required.")
        if (advId === undefined) throw usageFailure("--adv-id is required.")
        if ((shopId === undefined) !== (campaignId === undefined)) {
          throw usageFailure(
            "--shop-id and --campaign-id must be supplied together."
          )
        }
      }
      return { kind: "rules.dryrun", ruleId, advId, shopId, campaignId }
    },
    helpTopic: "rules dryrun",
    helpText: `Usage: adrate rules dryrun --rule-id <id> --adv-id <adv> [--shop-id <id>] [--campaign-id <id>]

Evaluates one Ads or GMV Max rule without executing actions. GMV Max rules pass
both --shop-id and --campaign-id; the two flags must be supplied together.
This is a narrow non-idempotent 60-second JSON POST with no Idempotency-Key.
Human output prints one target per line; --json preserves the complete envelope.`,
    globalHelpLine:
      "  rules dryrun                     Evaluate one rule without actions",
  },
  {
    key: "rules executions list",
    valueFlags: [
      "--rule-id",
      "--scope-id",
      "--result",
      "--from",
      "--to",
      "--page",
      "--page-size",
    ],
    positional: { prefix: ["rules", "executions", "list"], maximum: 3 },
    parse: (ctx) => {
      const ruleId = stringFlag(ctx.flags, "--rule-id")
      const scopeId = stringFlag(ctx.flags, "--scope-id")
      if (!ctx.help && ruleId === undefined && scopeId === undefined) {
        throw usageFailure(
          "At least one of --rule-id or --scope-id is required."
        )
      }
      return {
        kind: "rules.executions.list",
        ruleId,
        scopeId,
        result: stringFlag(ctx.flags, "--result"),
        from: stringFlag(ctx.flags, "--from"),
        to: stringFlag(ctx.flags, "--to"),
        page: stringFlag(ctx.flags, "--page"),
        pageSize: stringFlag(ctx.flags, "--page-size"),
      }
    },
    helpTopic: "rules executions list",
    helpText: `Usage: adrate rules executions list (--rule-id <id> | --scope-id <id>) [--result success|failed|partial|skipped] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--page <n>] [--page-size <1..100>]

Lists execution records for automation rules. At least one filter (--rule-id or
--scope-id) is required; the server rejects unfiltered queries. Results include
per-action status and value changes.`,
    globalHelpLine:
      "  rules executions list            List rule execution records",
  },
  {
    key: "rules executions get",
    valueFlags: ["--execution-id"],
    positional: { prefix: ["rules", "executions", "get"], maximum: 3 },
    parse: (ctx) => {
      const executionId = stringFlag(ctx.flags, "--execution-id")
      if (!ctx.help && executionId === undefined) {
        throw usageFailure("--execution-id is required.")
      }
      return { kind: "rules.executions.get", executionId }
    },
    helpTopic: "rules executions get",
    helpText: `Usage: adrate rules executions get --execution-id <id>

Reads one execution record with full condition evaluation detail, including
each metric's threshold, actual value, time window, and result.`,
    globalHelpLine:
      "  rules executions get             Read one execution detail",
  },

  // === commands 组 ===
  {
    key: "commands get",
    valueFlags: ["--command-id"],
    positional: { prefix: ["commands", "get"], maximum: 2 },
    parse: (ctx) => {
      const commandId = stringFlag(ctx.flags, "--command-id")
      if (commandId !== undefined && ctx.global.idempotencyKey !== undefined) {
        throw usageFailure(
          "Exactly one of --command-id or --idempotency-key is required."
        )
      }
      if (
        !ctx.help &&
        commandId === undefined &&
        ctx.global.idempotencyKey === undefined
      ) {
        throw usageFailure(
          "Exactly one of --command-id or --idempotency-key is required."
        )
      }
      return { kind: "commands.get", commandId }
    },
    helpTopic: "commands get",
    helpText: `Usage: adrate commands get (--command-id <uuid> | --idempotency-key <key>)

Queries exactly one Command and never sends a Status POST. Supply exactly one
selector. pending, executing, unknown, and final Command results are HTTP 200
successes; inspect command.status and command.isFinal.`,
    globalHelpLine:
      "  commands get                      Query one server Command",
  },
  {
    key: "commands pending",
    positional: { prefix: ["commands", "pending"], maximum: 2 },
    parse: () => ({ kind: "commands.pending" }),
    helpTopic: "commands pending",
    helpText: `Usage: adrate commands pending

Reads only the protected local pending-command directory and performs no network
or Keychain secret access. Unsafe or ambiguous evidence fails loudly and is
never deleted.`,
    globalHelpLine:
      "  commands pending                  List local recovery evidence",
  },
  {
    key: "commands resume",
    positional: { prefix: ["commands", "resume"], maximum: 2 },
    parse: (ctx) => {
      if (!ctx.help && ctx.global.idempotencyKey === undefined) {
        throw usageFailure("--idempotency-key is required.")
      }
      return { kind: "commands.resume" }
    },
    helpTopic: "commands resume",
    helpText: `Usage: adrate commands resume --idempotency-key <key>

Explicitly queries the original Command first. It may repeat the exact original
Status POST only when the server proves no Command exists or returns pending.
It never posts for executing, unknown, final, expired, or prior-credential state.`,
    globalHelpLine:
      "  commands resume                   Explicitly recover one pending write",
  },

  // === feedback ===
  {
    key: "feedback",
    booleanFlags: ["--message-stdin"],
    valueFlags: ["--category", "--message"],
    positional: { prefix: ["feedback"], maximum: 1 },
    parse: (ctx) => {
      const category = stringFlag(ctx.flags, "--category")
      const message = stringFlag(ctx.flags, "--message")
      const messageStdin = ctx.flags.has("--message-stdin")
      if (
        category !== undefined &&
        category !== "blocked" &&
        category !== "bug" &&
        category !== "suggestion" &&
        category !== "other"
      ) {
        throw usageFailure(
          "--category must be blocked, bug, suggestion, or other."
        )
      }
      if (message !== undefined && messageStdin) {
        throw usageFailure(
          "Exactly one of --message or --message-stdin is required."
        )
      }
      if (!ctx.help) {
        if (category === undefined)
          throw usageFailure("--category is required.")
        if (message === undefined && !messageStdin) {
          throw usageFailure(
            "Exactly one of --message or --message-stdin is required."
          )
        }
      }
      return {
        kind: "feedback.submit",
        category,
        message,
        messageStdin,
      }
    },
    helpTopic: "feedback",
    helpText: `Usage: adrate feedback --category blocked|bug|suggestion|other (--message <text> | --message-stdin) [--idempotency-key <key>]

Submits one explicit feedback message. Free text should use --message-stdin or a
single --message=<text> argv token, never shell string concatenation. Text that
starts with -- must use the equals form. The CLI sends at most one
15-second POST and never retries or stores feedback pending state automatically.
If the response is not confirmed, reuse the printed key only with the exact same
category and message.

Before submission, remove Tokens, Authorization/Cookie values, passwords, device
codes, TikTok access tokens, personal information, full ad payloads, environment
variables, logs, and stack traces. --message may remain in shell history or argv;
prefer stdin. The CLI attaches only its version, platform-architecture, and Node
version, never hostname, cwd, paths, shell history, or environment variables.
Server redaction is only a fallback and cannot prove that a message is safe.`,
    globalHelpLine:
      "  feedback                          Submit explicit Agent or user feedback",
  },

  // === skills 组 ===
  {
    key: "skills install",
    positional: { prefix: ["skills", "install"], maximum: 2 },
    parse: () => ({ kind: "skills.install" }),
    helpTopic: "skills install",
    helpText: `Usage: adrate skills install

Copies both bundled AdRate CLI Agent Skills from the installed npm package to
~/.agents/skills/<name>/. Zero network, zero git. Existing files are overwritten
only when version or content differs. Safe to run repeatedly.`,
    globalHelpLine:
      "  skills install                    Install Agent Skills locally (no git)",
  },
  {
    key: "skills list",
    positional: { prefix: ["skills", "list"], maximum: 2 },
    parse: () => ({ kind: "skills.list" }),
    helpTopic: "skills list",
    helpText: `Usage: adrate skills list

Lists the two bundled AdRate CLI Agent Skills in stable name order. This local command
does not read credentials.`,
    globalHelpLine:
      "  skills list                       List bundled Agent Skills",
  },
  {
    key: "skills read",
    positional: { prefix: ["skills", "read"], maximum: 4 },
    parse: (ctx) => {
      if (!ctx.help) throw usageFailure("A Skill name is required.")
      return { kind: "skills.read" }
    },
    helpTopic: "skills read",
    helpText: `Usage: adrate skills read <name> [path]

Reads one UTF-8 file from a known bundled Skill root. The default path is
SKILL.md. Paths must be relative and contained by that root. Human output is the
raw normalized file on stdout; notices and diagnostics remain on stderr.`,
    globalHelpLine:
      "  skills read <name> [path]         Read bundled Skill content",
  },
]

// schema 通过 positional 参数解析（不在 commandKey switch 中匹配），
// 但需要注册 positional 约束、帮助文本和全局帮助行。
// 在全局帮助的 Commands 列表中，schema 位于 capabilities 之后，
// 需要保持原始顺序——通过 GLOBAL_HELP_LINES 有序数组实现。
const SCHEMA_POSITIONAL = {
  prefix: ["schema"] as ReadonlyArray<string>,
  maximum: 2,
}
const SCHEMA_HELP_TOPIC = "schema"
const SCHEMA_HELP_TEXT = `Usage: adrate schema <capabilityId>

Reads the server-published capability description and operation input schemas.`
const SCHEMA_GLOBAL_HELP_LINE =
  "  schema <capabilityId>            Read a capability operation schema"

// 全局帮助 Commands 区段的有序行——与原始 GLOBAL_HELP 的顺序一一对应。
// schema 在 capabilities 之后、ads 之前插入。
const SCHEMA_INSERT_AFTER = COMMAND_REGISTRY_ENTRIES.findIndex(
  (e) => e.key === "capabilities"
)
const GLOBAL_HELP_LINES: ReadonlyArray<string> = [
  ...COMMAND_REGISTRY_ENTRIES.slice(0, SCHEMA_INSERT_AFTER + 1).map(
    (e) => e.globalHelpLine
  ),
  SCHEMA_GLOBAL_HELP_LINE,
  ...COMMAND_REGISTRY_ENTRIES.slice(SCHEMA_INSERT_AFTER + 1).map(
    (e) => e.globalHelpLine
  ),
]

// ── 从注册表派生五个集合 ──

const COMMAND_REGISTRY = new Map<string, CommandRegistration>()
for (const entry of COMMAND_REGISTRY_ENTRIES) {
  COMMAND_REGISTRY.set(entry.key, entry)
}

const BOOLEAN_FLAGS = new Set<string>(GLOBAL_BOOLEAN_FLAGS)
const VALUE_FLAGS = new Set<string>(GLOBAL_VALUE_FLAGS)
for (const entry of COMMAND_REGISTRY_ENTRIES) {
  if (entry.booleanFlags) {
    for (const flag of entry.booleanFlags) BOOLEAN_FLAGS.add(flag)
  }
  if (entry.valueFlags) {
    for (const flag of entry.valueFlags) VALUE_FLAGS.add(flag)
  }
}

const FIXED_POSITIONAL_SHAPES: ReadonlyArray<{
  prefix: ReadonlyArray<string>
  maximum: number
}> = [...COMMAND_REGISTRY_ENTRIES.map((e) => e.positional), SCHEMA_POSITIONAL]

const COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([
    ...COMMAND_REGISTRY_ENTRIES.map((e) => [e.helpTopic, e.helpText]),
    [SCHEMA_HELP_TOPIC, SCHEMA_HELP_TEXT],
  ])
)

interface TokenizedArguments {
  positionals: Array<string>
  flags: Map<string, string | true>
}

function tokenize(argv: ReadonlyArray<string>): TokenizedArguments {
  const positionals: Array<string> = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token) continue
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf("=")
    const name = equals === -1 ? token : token.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1)
    if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
      throw usageFailure(`Unknown option: ${name}`)
    }
    if (flags.has(name)) {
      throw usageFailure(`Option may only be specified once: ${name}`)
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        throw usageFailure(`Option does not accept a value: ${name}`)
      }
      flags.set(name, true)
      continue
    }
    const value = inlineValue ?? argv[index + 1]
    if (
      value === undefined ||
      value.length === 0 ||
      (inlineValue === undefined && value.startsWith("--"))
    ) {
      throw usageFailure(`Option requires a value: ${name}`)
    }
    if (inlineValue === undefined) index += 1
    flags.set(name, value)
  }
  return { positionals, flags }
}

function stringFlag(
  flags: Map<string, string | true>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

function isAdjustmentMode(value: string): boolean {
  return (
    value === "set" ||
    value === "increase_amount" ||
    value === "decrease_amount" ||
    value === "increase_percent" ||
    value === "decrease_percent"
  )
}

// --test 是全局 tokenizer 识别的 boolean flag，但只有显式 opt-in 的命令
// 才允许使用（仅 auth login）。assertOnlyFlags 的"全局允许"不含 --test。
const ALWAYS_ALLOWED_GLOBAL_FLAGS = new Set([
  "--json",
  "--no-input",
  "--request-id",
  "--idempotency-key",
  "--verbose",
  "--help",
  "--version",
])

function assertOnlyFlags(
  flags: Map<string, string | true>,
  commandFlags: ReadonlyArray<string>,
  optInGlobalFlags: ReadonlyArray<"--test"> = []
): void {
  const allowed = new Set([
    ...ALWAYS_ALLOWED_GLOBAL_FLAGS,
    ...optInGlobalFlags,
    ...commandFlags,
  ])
  for (const name of flags.keys()) {
    if (!allowed.has(name)) {
      throw usageFailure(`Option ${name} is not valid for this command.`)
    }
  }
}

function assertOnlyFlagsFromRegistration(
  flags: Map<string, string | true>,
  registration: CommandRegistration
): void {
  assertOnlyFlags(
    flags,
    [...(registration.booleanFlags ?? []), ...(registration.valueFlags ?? [])],
    registration.optInGlobalFlags
  )
}

function commandKey(positionals: ReadonlyArray<string>): string {
  return positionals.join(" ")
}

function assertNoExtraPositionals(positionals: ReadonlyArray<string>): void {
  for (const shape of FIXED_POSITIONAL_SHAPES) {
    if (
      positionals.length > shape.maximum &&
      shape.prefix.every((value, index) => positionals[index] === value)
    ) {
      throw usageFailure("Unexpected positional arguments for this command.")
    }
  }
}

export function parseArguments(argv: ReadonlyArray<string>): ParsedInvocation {
  const { positionals, flags } = tokenize(argv)
  assertNoExtraPositionals(positionals)
  const global: GlobalOptions = {
    json: flags.has("--json"),
    noInput: flags.has("--no-input"),
    verbose: flags.has("--verbose"),
    test: flags.has("--test"),
    ...(stringFlag(flags, "--request-id")
      ? { requestId: stringFlag(flags, "--request-id") }
      : {}),
    ...(stringFlag(flags, "--idempotency-key")
      ? { idempotencyKey: stringFlag(flags, "--idempotency-key") }
      : {}),
  }
  if (global.requestId && !REQUEST_ID_PATTERN.test(global.requestId)) {
    throw usageFailure("--request-id must match ^[A-Za-z0-9_-]{1,128}$.")
  }
  if (
    global.idempotencyKey &&
    !IDEMPOTENCY_KEY_PATTERN.test(global.idempotencyKey)
  ) {
    throw usageFailure("--idempotency-key must match ^[A-Za-z0-9_-]{1,128}$.")
  }
  const help = flags.has("--help")
  const version = flags.has("--version")
  if (version && positionals.length > 0) {
    throw usageFailure("--version cannot be combined with a command.")
  }
  if (version) {
    assertOnlyFlags(flags, [])
    return { global, command: null, help, version, helpTopic: "" }
  }
  const key = commandKey(positionals)
  let command: ParsedCommand | null = null

  const registration = COMMAND_REGISTRY.get(key)
  if (registration) {
    assertOnlyFlagsFromRegistration(flags, registration)
    command = registration.parse({ flags, help, global, positionals })
  } else if (key === "") {
    assertOnlyFlags(flags, [])
  } else if (positionals[0] === "schema" && positionals.length === 2) {
    assertOnlyFlags(flags, [])
    command = { kind: "schema", capabilityId: positionals[1]! }
  } else if (
    positionals[0] === "skills" &&
    positionals[1] === "read" &&
    (positionals.length === 3 || positionals.length === 4)
  ) {
    assertOnlyFlags(flags, [])
    command = {
      kind: "skills.read",
      name: positionals[2],
      ...(positionals[3] ? { path: positionals[3] } : {}),
    }
  } else if (help) {
    return {
      global,
      command: null,
      help,
      version,
      helpTopic: key,
    }
  } else {
    throw usageFailure(
      key.length > 0
        ? "Unknown command. Run adrate --help for supported commands."
        : "A command is required."
    )
  }

  return {
    global,
    command,
    help,
    version,
    helpTopic:
      command?.kind === "schema"
        ? "schema"
        : command?.kind === "skills.read"
          ? "skills read"
          : (registration?.helpTopic ?? key),
  }
}

const GLOBAL_HELP = `AdRate CLI

Usage:
  adrate <command> [options]

Commands:
${GLOBAL_HELP_LINES.join("\n")}

Global options:
  --json                 Emit one JSON envelope on stdout; auth login --device
                         first emits its separate device-code JSON line
  --no-input             Never prompt or wait implicitly
  --request-id <id>      Set the trace request ID
  --idempotency-key <k>  Write replay or Command recovery selector
  --verbose              Emit sanitized diagnostics on stderr
  --test                 Select test only when issuing a new Device flow
  --help                 Show help
  --version              Show CLI version

Exit codes: 0 success, 1 business failure, 2 usage, 3 authentication,
4 retryable wait, 5 remote outcome unknown. The CLI does not support base-url,
development issuers, team switching, automatic pagination, or arbitrary bulk mutation.`

const SHARED_COMMAND_HELP = `Shared exit codes:
  0 success
  1 non-retryable business failure
  2 usage or request correction, including missing authId
  3 authentication or credential failure
  4 the same request may succeed after waiting
  5 an irreversible or one-time remote outcome is unknown; do not retry blindly

CLI capability boundary: production/test issuers only. No team switching, automatic
pagination, multi-account aggregation, arbitrary bulk mutation, arbitrary base
URL, or development issuer.`

const INSTALL_HELP = `Install CLI and Agent Skills (both steps are required):
  npm install -g @adrate/cli
  adrate skills install`

export function helpText(topic: string): string {
  const command = COMMAND_HELP[topic]
  const help = command ? `${command}\n\n${SHARED_COMMAND_HELP}` : GLOBAL_HELP
  return `${help}\n\n${INSTALL_HELP}`
}
