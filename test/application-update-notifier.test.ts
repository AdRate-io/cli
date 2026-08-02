import { describe, expect, it, vi } from "vitest"
import { CliApplication } from "../src/application.js"
import {
  createLocalError,
  createLocalSuccess,
} from "../src/contracts/envelope.js"
import type { AuthService } from "../src/auth/auth-service.js"
import type { ReadCommandService } from "../src/commands/read-service.js"
import type { CliOutcome } from "../src/errors.js"
import type { SkillsNotifier } from "../src/skills/skills-notifier.js"
import type { UpdateNotifier } from "../src/notices/update-notifier.js"

function successOutcome(label: string): CliOutcome {
  return {
    exitCode: 0,
    envelope: createLocalSuccess(
      "update_application",
      { label },
      {
        _notice: {
          credential: { level: "warning", expiresAt: "2026-08-02" },
          skills: { level: "untrusted-server-value" },
          update: { level: "untrusted-server-value" },
        },
      }
    ),
    warnings: ["core-warning"],
  }
}

function failureOutcome(): CliOutcome {
  const envelope = createLocalError(
    "update_application_failure",
    "DEPENDENCY_UNAVAILABLE",
    "core failed",
    true
  )
  return {
    exitCode: 4,
    envelope: {
      ...envelope,
      meta: {
        ...envelope.meta,
        _notice: {
          credential: { level: "warning", expiresAt: "2026-08-02" },
        },
      },
    },
    warnings: ["core-warning"],
  }
}

function createHarness(
  options: {
    coreOutcome?: CliOutcome
    skillsInspect?: () => Promise<unknown>
    updateInspect?: () => Promise<unknown>
  } = {}
) {
  const coreOutcome = options.coreOutcome ?? successOutcome("core")
  const auth = {
    login: vi.fn(() => Promise.resolve(coreOutcome)),
    status: vi.fn(() => Promise.resolve(coreOutcome)),
    whoami: vi.fn(() => Promise.resolve(coreOutcome)),
    logout: vi.fn(() => Promise.resolve(coreOutcome)),
  }
  const reads = { execute: vi.fn(() => Promise.resolve(coreOutcome)) }
  const commands = {
    campaignStatus: { status: vi.fn(() => Promise.resolve(coreOutcome)) },
    commandQuery: { get: vi.fn(() => Promise.resolve(coreOutcome)) },
    pendingCommands: { pending: vi.fn(() => Promise.resolve(coreOutcome)) },
    commandResume: { resume: vi.fn(() => Promise.resolve(coreOutcome)) },
    skills: {
      list: vi.fn(() => Promise.resolve(coreOutcome)),
      read: vi.fn(() => Promise.resolve(coreOutcome)),
    },
  }
  const skillsInspect = vi.fn(
    options.skillsInspect ??
      (() =>
        Promise.resolve({
          notice: {
            level: "warning",
            required: [],
            issues: [],
            suggestedAction: "install_skills",
            command: "npx skills add AdRate-io/cli -g -y",
          },
          warning: "skills-warning",
        }))
  )
  const updateInspect = vi.fn(
    options.updateInspect ??
      (() =>
        Promise.resolve({
          notice: {
            level: "info",
            currentVersion: "0.1.0",
            latestVersion: "0.2.0",
            checkedAt: "2026-08-01T08:00:00.000Z",
            suggestedAction: "upgrade_cli",
            command: "npm install -g @adrate/cli",
          },
          warning: "update-warning",
          diagnostic: null,
        }))
  )
  const application = new CliApplication(
    auth as unknown as AuthService,
    reads as unknown as ReadCommandService,
    commands,
    { inspect: skillsInspect } as unknown as Pick<SkillsNotifier, "inspect">,
    { inspect: updateInspect } as unknown as Pick<UpdateNotifier, "inspect">
  )
  return {
    application,
    auth,
    reads,
    commands,
    skillsInspect,
    updateInspect,
  }
}

describe("CliApplication update notifier eligibility", () => {
  it.each([
    ["auth status", ["auth", "status"]],
    ["capabilities", ["capabilities"]],
    ["skills list", ["skills", "list"]],
  ])("runs after the core result only for %s", async (_label, argv) => {
    const order: Array<string> = []
    const harness = createHarness({
      updateInspect: () => {
        order.push("update")
        return Promise.resolve({
          notice: null,
          warning: null,
          diagnostic: null,
        })
      },
    })
    harness.auth.status.mockImplementation(() => {
      order.push("core")
      return Promise.resolve(successOutcome("status"))
    })
    harness.reads.execute.mockImplementation(() => {
      order.push("core")
      return Promise.resolve(successOutcome("capabilities"))
    })
    harness.commands.skills.list.mockImplementation(() => {
      order.push("core")
      return Promise.resolve(successOutcome("skills-list"))
    })

    await harness.application.execute(argv)

    expect(harness.updateInspect).toHaveBeenCalledOnce()
    expect(order).toStrictEqual(["core", "update"])
  })

  it.each([
    ["no args", []],
    ["help", ["--help"]],
    ["version", ["--version"]],
    ["whoami", ["auth", "whoami"]],
    ["skills read", ["skills", "read", "adrate-shared"]],
    ["schema", ["schema", "ads.campaign.list"]],
  ])(
    "does zero update inspection for non-target command %s",
    async (_label, argv) => {
      const harness = createHarness()
      const execution = await harness.application.execute(argv)

      expect(harness.updateInspect).not.toHaveBeenCalled()
      expect(execution.outcome.envelope.meta._notice?.update).toBeUndefined()
    }
  )

  it("replaces untrusted local keys and preserves credential, skills, and update independently", async () => {
    const harness = createHarness()
    const execution = await harness.application.execute(["auth", "status"])

    expect(execution.outcome.envelope.meta._notice).toStrictEqual({
      credential: { level: "warning", expiresAt: "2026-08-02" },
      skills: {
        level: "warning",
        required: [],
        issues: [],
        suggestedAction: "install_skills",
        command: "npx skills add AdRate-io/cli -g -y",
      },
      update: {
        level: "info",
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        checkedAt: "2026-08-01T08:00:00.000Z",
        suggestedAction: "upgrade_cli",
        command: "npm install -g @adrate/cli",
      },
    })
    expect(execution.outcome.warnings).toStrictEqual([
      "core-warning",
      "skills-warning",
      "update-warning",
    ])
  })

  it("suppresses only update while preserving credential and Skills", async () => {
    const harness = createHarness({
      updateInspect: () =>
        Promise.resolve({
          notice: null,
          warning: null,
          diagnostic: null,
        }),
    })
    const execution = await harness.application.execute(["skills", "list"])

    expect(execution.outcome.envelope.meta._notice).toMatchObject({
      credential: { level: "warning" },
      skills: { level: "warning" },
    })
    expect(execution.outcome.envelope.meta._notice?.update).toBeUndefined()
    expect(execution.outcome.warnings).toStrictEqual([
      "core-warning",
      "skills-warning",
    ])
  })

  it("keeps a target command failure exit, envelope, and core warnings intact", async () => {
    const harness = createHarness({ coreOutcome: failureOutcome() })
    const execution = await harness.application.execute(["auth", "status"])

    expect(execution.outcome.exitCode).toBe(4)
    expect(execution.outcome.envelope).toMatchObject({
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "core failed",
      },
      meta: {
        requestId: "update_application_failure",
        _notice: {
          credential: { level: "warning" },
          skills: { level: "warning" },
          update: { level: "info" },
        },
      },
    })
    expect(execution.outcome.warnings).toStrictEqual([
      "core-warning",
      "skills-warning",
      "update-warning",
    ])
  })

  it("contains checker failures and reveals the fixed diagnostic only with verbose", async () => {
    const quiet = createHarness({
      updateInspect: async () => Promise.reject(new Error("registry secret")),
    })
    const quietExecution = await quiet.application.execute(["auth", "status"])
    expect(quietExecution.outcome.exitCode).toBe(0)
    expect(quietExecution.outcome.warnings).toStrictEqual([
      "core-warning",
      "skills-warning",
    ])
    expect(JSON.stringify(quietExecution.outcome)).not.toContain(
      "registry secret"
    )

    const verbose = createHarness({
      updateInspect: async () => Promise.reject(new Error("registry secret")),
    })
    const verboseExecution = await verbose.application.execute([
      "auth",
      "status",
      "--verbose",
    ])
    expect(verboseExecution.outcome.exitCode).toBe(0)
    expect(verboseExecution.outcome.warnings).toContain(
      "Update check skipped after an unexpected failure."
    )
    expect(JSON.stringify(verboseExecution.outcome)).not.toContain(
      "registry secret"
    )
  })
})
