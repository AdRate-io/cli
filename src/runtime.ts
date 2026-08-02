import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AuthService } from "./auth/auth-service.js"
import { LocalCredentialCoordinator } from "./auth/local-credentials.js"
import { DefaultProcessIdentityProbe } from "./auth/process-identity.js"
import { CliApplication } from "./application.js"
import { CommandQueryService } from "./commands/command-query-service.js"
import { CommandResumeService } from "./commands/command-resume-service.js"
import { PendingCommandRepository } from "./commands/pending-command-repository.js"
import { PendingCommandService } from "./commands/pending-command-service.js"
import { ReadCommandService } from "./commands/read-service.js"
import { StatusCommandDispatcher } from "./commands/status-command-dispatcher.js"
import { StatusCommandService } from "./commands/status-command-service.js"
import { PublicHttpClient } from "./http/client.js"
import {
  CredentialStore,
  FallbackFileCredentialBackend,
  KeytarCredentialBackend,
} from "./storage/credential-backend.js"
import { createCliPaths } from "./storage/paths.js"
import { DefaultNativeProcessRunner } from "./storage/native-process.js"
import { SecureFileSystem, hardenProcessUmask } from "./storage/secure-files.js"
import { CliStateStore } from "./storage/state-store.js"
import { SkillCatalog } from "./skills/skill-catalog.js"
import { SkillsService } from "./skills/skills-service.js"
import { SkillsNotifier } from "./skills/skills-notifier.js"
import { UpdateNotifier } from "./notices/update-notifier.js"
import {
  PowerShellWindowsAclController,
  trustedWindowsPowerShellPath,
} from "./storage/windows-acl.js"
import type { ProcessIdentityProbe } from "./auth/process-identity.js"
import type { HttpTransport } from "./http/client.js"
import type { UpdateRegistryTransport } from "./notices/update-notifier.js"

export interface CliRuntimeOptions {
  root?: string
  transport?: HttpTransport
  credentialStore?: CredentialStore
  processIdentity?: ProcessIdentityProbe
  environment?: NodeJS.ProcessEnv
  now?: () => Date
  generateIdempotencyKey?: () => string
  progress?: (message: string) => void
  packageRoot?: string
  installedSkillsRoot?: string
  updateTransport?: UpdateRegistryTransport
}

/**
 * 生产组合根。所有认证、只读和 Command 服务共享同一 HTTP client、
 * 本地凭证协调器与安全状态；Status 与 Resume 共享唯一 Dispatcher，
 * 避免两套 POST 决策或本地 journal 收敛矩阵。
 */
export interface CliRuntime {
  application: CliApplication
  auth: AuthService
  reads: ReadCommandService
  campaignStatus: StatusCommandService
  commandQuery: CommandQueryService
  pendingCommands: PendingCommandService
  commandResume: CommandResumeService
  dispatcher: StatusCommandDispatcher
  pendingRepository: PendingCommandRepository
  http: PublicHttpClient
  local: LocalCredentialCoordinator
  state: CliStateStore
  fileSystem: SecureFileSystem
  skills: SkillsService
  skillsNotifier: SkillsNotifier
  updateNotifier: UpdateNotifier
}

const DEFAULT_PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))

export function createCliRuntime(options: CliRuntimeOptions = {}): CliRuntime {
  hardenProcessUmask()
  const paths = createCliPaths(options.root)
  const windowsAcl =
    process.platform === "win32"
      ? new PowerShellWindowsAclController(
          new DefaultNativeProcessRunner(),
          trustedWindowsPowerShellPath()
        )
      : undefined
  const processIdentity =
    options.processIdentity ?? new DefaultProcessIdentityProbe()
  const fileSystem = new SecureFileSystem({
    root: paths.root,
    processIdentity,
    ...(windowsAcl ? { windowsAcl } : {}),
  })
  const state = new CliStateStore(fileSystem, paths)
  const credentials =
    options.credentialStore ??
    new CredentialStore(
      new KeytarCredentialBackend(),
      new FallbackFileCredentialBackend(fileSystem, paths)
    )
  const local = new LocalCredentialCoordinator(state, credentials, {
    processIdentity,
    ...(options.now ? { now: options.now } : {}),
  })
  const http = new PublicHttpClient(options.transport)
  const environment = options.environment ?? process.env
  const auth = new AuthService({
    http,
    local,
    environment,
    ...(options.now ? { now: options.now } : {}),
    progress:
      options.progress ??
      ((message) => {
        process.stderr.write(`${message}\n`)
      }),
  })
  const reads = new ReadCommandService(http, local, environment)
  const pendingRepository = new PendingCommandRepository(fileSystem, paths, {
    processIdentity,
    ...(options.now ? { now: options.now } : {}),
  })
  const dispatcher = new StatusCommandDispatcher(
    http,
    pendingRepository,
    local,
    {
      environment,
      ...(options.now ? { now: options.now } : {}),
    }
  )
  const commandQuery = new CommandQueryService(http, local, pendingRepository, {
    environment,
    ...(options.now ? { now: options.now } : {}),
  })
  const campaignStatus = new StatusCommandService(
    http,
    local,
    pendingRepository,
    {
      environment,
      dispatcher,
      ...(options.now ? { now: options.now } : {}),
      ...(options.generateIdempotencyKey
        ? { generateIdempotencyKey: options.generateIdempotencyKey }
        : {}),
    }
  )
  const pendingCommands = new PendingCommandService(
    pendingRepository,
    state,
    options.now ? { now: options.now } : {}
  )
  const commandResume = new CommandResumeService(local, pendingRepository, {
    query: commandQuery,
    dispatcher,
    ...(options.now ? { now: options.now } : {}),
  })
  const skillCatalog = new SkillCatalog(
    options.packageRoot ?? DEFAULT_PACKAGE_ROOT
  )
  const skills = new SkillsService(skillCatalog)
  const skillsNotifier = new SkillsNotifier({
    catalog: skillCatalog,
    installedSkillsRoot:
      options.installedSkillsRoot ?? join(homedir(), ".agents", "skills"),
    environment,
  })
  const updateNotifier = new UpdateNotifier({
    fileSystem,
    paths,
    environment,
    ...(options.now ? { now: options.now } : {}),
    ...(options.updateTransport ? { transport: options.updateTransport } : {}),
  })
  const application = new CliApplication(
    auth,
    reads,
    {
      campaignStatus,
      commandQuery,
      pendingCommands,
      commandResume,
      skills,
    },
    skillsNotifier,
    updateNotifier
  )

  return {
    application,
    auth,
    reads,
    campaignStatus,
    commandQuery,
    pendingCommands,
    commandResume,
    dispatcher,
    pendingRepository,
    http,
    local,
    state,
    fileSystem,
    skills,
    skillsNotifier,
    updateNotifier,
  }
}

export function createCliApplication(
  options: CliRuntimeOptions = {}
): CliApplication {
  return createCliRuntime(options).application
}
