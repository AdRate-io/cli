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
  | { kind: "commands.get"; commandId?: string }
  | { kind: "commands.pending" }
  | { kind: "commands.resume" }
  | {
      kind: "feedback.submit"
      category?: string
      message?: string
      messageStdin: boolean
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
  }
>

export interface ParsedInvocation {
  global: GlobalOptions
  command: ParsedCommand | null
  help: boolean
  version: boolean
  helpTopic: string
}

const BOOLEAN_FLAGS = new Set([
  "--json",
  "--no-input",
  "--verbose",
  "--test",
  "--help",
  "--version",
  "--no-wait",
  "--resume",
  "--device",
  "--message-stdin",
])
const VALUE_FLAGS = new Set([
  "--request-id",
  "--idempotency-key",
  "--device-name",
  "--adv-id",
  "--campaign-id",
  "--command-id",
  "--auth-id",
  "--set",
  "--page",
  "--page-size",
  "--start-date",
  "--end-date",
  "--group-by",
  "--category",
  "--message",
])

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

function assertOnlyFlags(
  flags: Map<string, string | true>,
  commandFlags: ReadonlyArray<string>,
  optInGlobalFlags: ReadonlyArray<"--test"> = []
): void {
  const global = new Set([
    "--json",
    "--no-input",
    "--request-id",
    "--idempotency-key",
    "--verbose",
    "--help",
    "--version",
    ...optInGlobalFlags,
  ])
  const allowed = new Set([...global, ...commandFlags])
  for (const name of flags.keys()) {
    if (!allowed.has(name)) {
      throw usageFailure(`Option ${name} is not valid for this command.`)
    }
  }
}

function commandKey(positionals: ReadonlyArray<string>): string {
  return positionals.join(" ")
}

const FIXED_POSITIONAL_SHAPES: ReadonlyArray<{
  prefix: ReadonlyArray<string>
  maximum: number
}> = [
  { prefix: ["auth", "login"], maximum: 2 },
  { prefix: ["auth", "status"], maximum: 2 },
  { prefix: ["auth", "whoami"], maximum: 2 },
  { prefix: ["auth", "logout"], maximum: 2 },
  { prefix: ["capabilities"], maximum: 1 },
  { prefix: ["schema"], maximum: 2 },
  { prefix: ["ads", "advertisers"], maximum: 2 },
  { prefix: ["ads", "campaigns", "list"], maximum: 3 },
  { prefix: ["ads", "campaigns", "get"], maximum: 3 },
  { prefix: ["ads", "campaigns", "status"], maximum: 3 },
  { prefix: ["ads", "report", "campaigns"], maximum: 3 },
  { prefix: ["commands", "get"], maximum: 2 },
  { prefix: ["commands", "pending"], maximum: 2 },
  { prefix: ["commands", "resume"], maximum: 2 },
  { prefix: ["feedback"], maximum: 1 },
  { prefix: ["skills", "install"], maximum: 2 },
  { prefix: ["skills", "list"], maximum: 2 },
  { prefix: ["skills", "read"], maximum: 4 },
]

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
  switch (key) {
    case "":
      assertOnlyFlags(flags, [])
      break
    case "auth login":
      assertOnlyFlags(
        flags,
        ["--no-wait", "--resume", "--device", "--device-name"],
        ["--test"]
      )
      command = {
        kind: "auth.login",
        noWait: flags.has("--no-wait"),
        resume: flags.has("--resume"),
        device: flags.has("--device"),
        ...(stringFlag(flags, "--device-name")
          ? { deviceName: stringFlag(flags, "--device-name") }
          : {}),
      }
      validateAuthLoginInput({ global, ...command })
      break
    case "auth status":
      assertOnlyFlags(flags, [])
      command = { kind: "auth.status" }
      break
    case "auth whoami":
      assertOnlyFlags(flags, [])
      command = { kind: "auth.whoami" }
      break
    case "auth logout":
      assertOnlyFlags(flags, [])
      command = { kind: "auth.logout" }
      break
    case "capabilities":
      assertOnlyFlags(flags, [])
      command = { kind: "capabilities" }
      break
    case "ads advertisers":
      assertOnlyFlags(flags, [])
      command = { kind: "ads.advertisers" }
      break
    case "ads campaigns list":
      assertOnlyFlags(flags, ["--adv-id", "--auth-id", "--page", "--page-size"])
      command = {
        kind: "ads.campaigns.list",
        advId: stringFlag(flags, "--adv-id"),
        authId: stringFlag(flags, "--auth-id"),
        page: stringFlag(flags, "--page"),
        pageSize: stringFlag(flags, "--page-size"),
      }
      break
    case "ads campaigns get":
      assertOnlyFlags(flags, ["--adv-id", "--campaign-id", "--auth-id"])
      command = {
        kind: "ads.campaigns.get",
        advId: stringFlag(flags, "--adv-id"),
        campaignId: stringFlag(flags, "--campaign-id"),
        authId: stringFlag(flags, "--auth-id"),
      }
      break
    case "ads campaigns status":
      assertOnlyFlags(flags, [
        "--adv-id",
        "--campaign-id",
        "--set",
        "--auth-id",
      ])
      {
        const advId = stringFlag(flags, "--adv-id")
        const campaignId = stringFlag(flags, "--campaign-id")
        const desiredStatus = stringFlag(flags, "--set")
        if (!help) {
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
        command = {
          kind: "ads.campaigns.status",
          advId,
          campaignId,
          desiredStatus,
          authId: stringFlag(flags, "--auth-id"),
        }
      }
      break
    case "ads report campaigns":
      assertOnlyFlags(flags, [
        "--adv-id",
        "--auth-id",
        "--start-date",
        "--end-date",
        "--group-by",
        "--page",
        "--page-size",
      ])
      command = {
        kind: "ads.report.campaigns",
        advId: stringFlag(flags, "--adv-id"),
        authId: stringFlag(flags, "--auth-id"),
        startDate: stringFlag(flags, "--start-date"),
        endDate: stringFlag(flags, "--end-date"),
        groupBy: stringFlag(flags, "--group-by"),
        page: stringFlag(flags, "--page"),
        pageSize: stringFlag(flags, "--page-size"),
      }
      break
    case "commands get": {
      assertOnlyFlags(flags, ["--command-id"])
      const commandId = stringFlag(flags, "--command-id")
      if (commandId !== undefined && global.idempotencyKey !== undefined) {
        throw usageFailure(
          "Exactly one of --command-id or --idempotency-key is required."
        )
      }
      if (
        !help &&
        commandId === undefined &&
        global.idempotencyKey === undefined
      ) {
        throw usageFailure(
          "Exactly one of --command-id or --idempotency-key is required."
        )
      }
      command = { kind: "commands.get", commandId }
      break
    }
    case "commands pending":
      assertOnlyFlags(flags, [])
      command = { kind: "commands.pending" }
      break
    case "commands resume":
      assertOnlyFlags(flags, [])
      if (!help && global.idempotencyKey === undefined) {
        throw usageFailure("--idempotency-key is required.")
      }
      command = { kind: "commands.resume" }
      break
    case "feedback": {
      assertOnlyFlags(flags, ["--category", "--message", "--message-stdin"])
      const category = stringFlag(flags, "--category")
      const message = stringFlag(flags, "--message")
      const messageStdin = flags.has("--message-stdin")
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
      if (!help) {
        if (category === undefined) throw usageFailure("--category is required.")
        if (message === undefined && !messageStdin) {
          throw usageFailure(
            "Exactly one of --message or --message-stdin is required."
          )
        }
      }
      command = {
        kind: "feedback.submit",
        category,
        message,
        messageStdin,
      }
      break
    }
    case "skills install":
      assertOnlyFlags(flags, [])
      command = { kind: "skills.install" }
      break
    case "skills list":
      assertOnlyFlags(flags, [])
      command = { kind: "skills.list" }
      break
    case "skills read":
      assertOnlyFlags(flags, [])
      if (!help) throw usageFailure("A Skill name is required.")
      command = { kind: "skills.read" }
      break
    default: {
      if (positionals[0] === "schema" && positionals.length === 2) {
        assertOnlyFlags(flags, [])
        command = { kind: "schema", capabilityId: positionals[1]! }
        break
      }
      if (
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
        break
      }
      if (help) {
        return {
          global,
          command: null,
          help,
          version,
          helpTopic: key,
        }
      }
      throw usageFailure(
        key.length > 0
          ? "Unknown command. Run adrate --help for supported commands."
          : "A command is required."
      )
    }
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
          : key,
  }
}

const GLOBAL_HELP = `AdRate CLI

Usage:
  adrate <command> [options]

Commands:
  auth login [--no-wait|--resume|--device]  Authorize this device
  auth status                      Diagnose local and remote auth state
  auth whoami                      Show and activate the current identity
  auth logout                      Revoke and remove the current credential
  capabilities                     List server-published capabilities
  schema <capabilityId>            Read a capability operation schema
  ads advertisers                  List connected advertisers
  ads campaigns list               Read one Campaign page
  ads campaigns get                Read fresh Campaign state
  ads campaigns status             Set one Campaign status safely
  ads report campaigns             Read one basic_v1 report page
  commands get                      Query one server Command
  commands pending                  List local recovery evidence
  commands resume                   Explicitly recover one pending write
  feedback                          Submit explicit Agent or user feedback
  skills install                    Install Agent Skills locally (no git)
  skills list                       List bundled Agent Skills
  skills read <name> [path]         Read bundled Skill content

Global options:
  --json                 Emit one JSON envelope on stdout; auth login --device
                         first emits its separate device-code JSON line
  --no-input             Never prompt or wait implicitly
  --request-id <id>      Set the trace request ID
  --idempotency-key <k>  Write retry or Command recovery selector
  --verbose              Emit sanitized diagnostics on stderr
  --test                 Select test only when issuing a new Device flow
  --help                 Show help
  --version              Show CLI version

Exit codes: 0 success, 1 business failure, 2 usage, 3 authentication,
4 retryable wait, 5 remote outcome unknown. M0 does not support base-url,
development issuers, team switching, automatic pagination, or batch writes.`

const COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze({
  "auth login": `Usage: adrate auth login [--no-wait|--resume|--device] [--device-name <name>]

Creates or resumes the fixed M0-scope Device Authorization flow. --no-wait
returns the browser URL without waiting. --resume uses the protected local
Device state. --device emits a single JSON line with device-code fields on
stdout then continues polling until approval or expiry (for machine consumers
such as Accio Work). With --json, the final envelope is a second JSON line.
--no-input never waits. A delivery-unknown Token exchange exits 5 and must not
be blindly restarted.`,
  "auth status": `Usage: adrate auth status

Returns not_authenticated, local_incomplete, active, or remote_invalid.
When a Token exists, exactly one /me request verifies and may activate it.
/public/v1/me is the only endpoint that can activate a new Session.`,
  "auth whoami": `Usage: adrate auth whoami

Calls /public/v1/me to verify identity and may activate a newly issued Owner CLI
Session. auth status and auth whoami both call this endpoint when a Token exists.`,
  "auth logout": `Usage: adrate auth logout

Revokes only the current credential. Pending Command evidence is preserved.
An unknown remote revoke exits 5 and must be checked on the official Web page.`,
  capabilities: `Usage: adrate capabilities

Reads the server-published Capability list. The CLI does not embed a schema copy.`,
  schema: `Usage: adrate schema <capabilityId>

Reads the server-published capability description and operation input schemas.`,
  "ads advertisers": `Usage: adrate ads advertisers

Lists connected advertisers and TikTok authorization candidates.`,
  "ads campaigns list": `Usage: adrate ads campaigns list --adv-id <id> [--auth-id <id>] [--page <n>] [--page-size <1..1000>]

Reads exactly one page. Multiple authorization candidates require --auth-id;
the CLI never chooses one or follows pagination automatically.`,
  "ads campaigns get": `Usage: adrate ads campaigns get --adv-id <id> --campaign-id <id> [--auth-id <id>]

Reads fresh Current State. Opaque IDs remain strings and must satisfy the M0
raw-path transport boundary. If the server returns TIKTOK_AUTH_ID_REQUIRED,
repeat the request with one of its candidate --auth-id values; the CLI never
chooses an authorization.`,
  "ads campaigns status": `Usage: adrate ads campaigns status --adv-id <id> --campaign-id <id> --set enable|disable [--auth-id <id>] [--idempotency-key <key>]

Persists the exact intent before sending at most one Status POST. An omitted key
is generated once and retained locally. A response-loss exit 5 must be recovered
with commands get/pending/resume; the CLI never retries the POST automatically
or issues a new key for the same intent.
Multiple authorization candidates require --auth-id; the CLI never chooses one.
M0 supports only one Campaign ENABLE/DISABLE per command; no batch, budget, bid,
create, Adgroup, Ad, rules, copy, or GMV Max writes.`,
  "ads report campaigns": `Usage: adrate ads report campaigns --adv-id <id> --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD> [--group-by none|day|hour] [--auth-id <id>] [--page <n>] [--page-size <1..1000>]

Reads one basic_v1 page without aggregation or automatic pagination. null metrics
mean N/A, not zero. If the server returns TIKTOK_AUTH_ID_REQUIRED, repeat the
request with one of its candidate --auth-id values; the CLI never chooses an
authorization.`,
  "commands get": `Usage: adrate commands get (--command-id <uuid> | --idempotency-key <key>)

Queries exactly one Command and never sends a Status POST. Supply exactly one
selector. pending, executing, unknown, and final Command results are HTTP 200
successes; inspect command.status and command.isFinal.`,
  "commands pending": `Usage: adrate commands pending

Reads only the protected local pending-command directory and performs no network
or Keychain secret access. Unsafe or ambiguous evidence fails loudly and is
never deleted.`,
  "commands resume": `Usage: adrate commands resume --idempotency-key <key>

Explicitly queries the original Command first. It may repeat the exact original
Status POST only when the server proves no Command exists or returns pending.
It never posts for executing, unknown, final, expired, or prior-credential state.`,
  feedback: `Usage: adrate feedback --category blocked|bug|suggestion|other (--message <text> | --message-stdin) [--idempotency-key <key>]

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
  "skills install": `Usage: adrate skills install

Copies both bundled M0 Agent Skills from the installed npm package to
~/.agents/skills/<name>/. Zero network, zero git. Existing files are overwritten
only when version or content differs. Safe to run repeatedly.`,
  "skills list": `Usage: adrate skills list

Lists the two bundled M0 Agent Skills in stable name order. This local command
does not read credentials.`,
  "skills read": `Usage: adrate skills read <name> [path]

Reads one UTF-8 file from a known bundled Skill root. The default path is
SKILL.md. Paths must be relative and contained by that root. Human output is the
raw normalized file on stdout; notices and diagnostics remain on stderr.`,
})

const SHARED_COMMAND_HELP = `Shared exit codes:
  0 success
  1 non-retryable business failure
  2 usage or request correction, including missing authId
  3 authentication or credential failure
  4 the same request may succeed after waiting
  5 an irreversible or one-time remote outcome is unknown; do not retry blindly

M0 boundary: production/test issuers only. No team switching, automatic
pagination, multi-account aggregation, batch writes, arbitrary base URL, or
development issuer.`

const INSTALL_HELP = `Install CLI and Agent Skills (both steps are required):
  npm install -g @adrate/cli
  adrate skills install`

export function helpText(topic: string): string {
  const command = COMMAND_HELP[topic]
  const help = command ? `${command}\n\n${SHARED_COMMAND_HELP}` : GLOBAL_HELP
  return `${help}\n\n${INSTALL_HELP}`
}
