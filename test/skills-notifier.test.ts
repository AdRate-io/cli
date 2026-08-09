import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLocalSuccess } from "../src/contracts/envelope.js"
import { renderOutcome } from "../src/output.js"
import { SkillCatalog } from "../src/skills/skill-catalog.js"
import { sha256SkillText } from "../src/skills/skill-contract.js"
import { BUNDLED_SKILL_MIN_CLI_VERSION } from "./helpers.js"
import {
  SkillsNotifier,
  withSkillsNotifierInspection,
} from "../src/skills/skills-notifier.js"
import { replaceLocalNotice } from "../src/notices/notice-merge.js"
import type { CliOutcome } from "../src/errors.js"
import type { JsonObject } from "../src/contracts/json.js"

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url))
const NAMES = ["adrate-shared", "adrate-ads"] as const
const roots: Array<string> = []

async function fixture(): Promise<{ root: string; installed: string }> {
  const root = await mkdtemp(join(tmpdir(), "adrate-skills-notifier-"))
  roots.push(root)
  const installed = join(root, "installed")
  await mkdir(installed)
  return { root, installed }
}

async function install(installed: string, name: (typeof NAMES)[number]) {
  await cp(join(CLI_ROOT, "skills", name), join(installed, name), {
    recursive: true,
  })
}

async function installAll(installed: string) {
  for (const name of NAMES) await install(installed, name)
}

function notifier(installed: string, environment: NodeJS.ProcessEnv = {}) {
  return new SkillsNotifier({
    catalog: new SkillCatalog(CLI_ROOT),
    installedSkillsRoot: installed,
    environment,
  })
}

async function changeVersion(
  installed: string,
  name: (typeof NAMES)[number],
  version: string,
  contentSha256?: string
) {
  const shellPath = join(installed, name, "SKILL.md")
  const manifestPath = join(installed, name, "skill-manifest.json")
  const shell = (await readFile(shellPath, "utf8")).replace(
    /version: "[^"]+"/,
    `version: "${version}"`
  )
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: string
    shellSha256: string
    contentSha256: string
  }
  manifest.version = version
  manifest.shellSha256 = sha256SkillText(shell)
  if (contentSha256) manifest.contentSha256 = contentSha256
  await writeFile(shellPath, shell)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("SkillsNotifier", () => {
  it("preserves dangerous server notice keys as data after local merge", () => {
    const serverNotice = JSON.parse(
      '{"credential":{"message":"keep"},"__proto__":{"polluted":true},"constructor":{"kind":"data"},"prototype":{"kind":"data"}}'
    ) as JsonObject
    const base = createLocalSuccess(
      "prototype_safe_notice",
      { value: true },
      { _notice: serverNotice }
    )

    const withSkills = replaceLocalNotice(base, "skills", {
      level: "warning",
    })
    const notice = withSkills.meta._notice as Record<string, unknown>

    expect(Object.getPrototypeOf(notice)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(notice, "__proto__")).toBe(true)
    expect(notice["__proto__"]).toStrictEqual({ polluted: true })
    expect(notice.constructor).toStrictEqual({ kind: "data" })
    expect(notice.prototype).toStrictEqual({ kind: "data" })
    expect(notice.credential).toStrictEqual({ message: "keep" })
    expect(notice.skills).toStrictEqual({ level: "warning" })
    const expected = JSON.parse(
      '{"credential":{"message":"keep"},"__proto__":{"polluted":true},"constructor":{"kind":"data"},"prototype":{"kind":"data"},"skills":{"level":"warning"}}'
    )
    expect(JSON.stringify(notice)).toBe(JSON.stringify(expected))
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it("emits the exact required and missing issue order without scanning other Skills", async () => {
    const { installed } = await fixture()
    await mkdir(join(installed, "unrelated-skill"))
    await writeFile(
      join(installed, "unrelated-skill", "SKILL.md"),
      "must never be parsed"
    )

    const inspection = await notifier(installed).inspect()

    expect(inspection.notice).toStrictEqual({
      level: "warning",
      required: [
        {
          name: "adrate-shared",
          version: "1.4.0",
          minCliVersion: BUNDLED_SKILL_MIN_CLI_VERSION,
        },
        {
          name: "adrate-ads",
          version: "1.4.0",
          minCliVersion: BUNDLED_SKILL_MIN_CLI_VERSION,
        },
      ],
      issues: [
        {
          name: "adrate-shared",
          code: "missing",
          installedVersion: null,
        },
        {
          name: "adrate-ads",
          code: "missing",
          installedVersion: null,
        },
      ],
      suggestedAction: "install_skills",
      command: "adrate skills install",
    })
    expect(inspection.warning).toContain("adrate-shared: missing")
    expect(inspection.warning).toContain("adrate-ads: missing")
    expect(JSON.stringify(inspection)).not.toContain("must never be parsed")
  })

  it("omits the notice completely when both installed packages match", async () => {
    const { installed } = await fixture()
    await installAll(installed)
    const inspection = await notifier(installed).inspect()
    expect(inspection).toStrictEqual({
      notice: null,
      warning: null,
    })
    const merged = withSkillsNotifierInspection(
      {
        exitCode: 0,
        envelope: createLocalSuccess("no_notice", { value: true }),
        warnings: [],
      },
      inspection
    )
    expect(merged.envelope.meta).not.toHaveProperty("_notice")
  })

  it("reports only outdated when installed version is below required", async () => {
    const { installed } = await fixture()
    await installAll(installed)
    await changeVersion(installed, "adrate-shared", "0.9.0", "f".repeat(64))
    await writeFile(
      join(installed, "adrate-ads", "SKILL.md"),
      `${await readFile(join(installed, "adrate-ads", "SKILL.md"), "utf8")}drift\n`
    )

    const inspection = await notifier(installed).inspect()
    expect(inspection.notice?.issues).toStrictEqual([
      {
        name: "adrate-shared",
        code: "outdated",
        installedVersion: "0.9.0",
      },
    ])
  })

  it("maps unreadable or invalid shell/manifest facts to missing with null version", async () => {
    const { installed } = await fixture()
    await installAll(installed)
    const sharedShell = join(installed, "adrate-shared", "SKILL.md")
    await writeFile(
      sharedShell,
      (await readFile(sharedShell, "utf8")).replace(
        'version: "1.4.0"',
        "version: true"
      )
    )
    await writeFile(
      join(installed, "adrate-ads", "skill-manifest.json"),
      "{bad-json\n"
    )

    expect((await notifier(installed).inspect()).notice?.issues).toStrictEqual([
      {
        name: "adrate-shared",
        code: "missing",
        installedVersion: null,
      },
      {
        name: "adrate-ads",
        code: "missing",
        installedVersion: null,
      },
    ])
  })

  it("accepts a newer self-consistent package without comparing its digest to the bundled version", async () => {
    const { installed } = await fixture()
    await installAll(installed)
    await changeVersion(installed, "adrate-shared", "2.0.0", "a".repeat(64))
    const openAiPath = join(installed, "adrate-shared", "agents", "openai.yaml")
    await writeFile(
      openAiPath,
      (await readFile(openAiPath, "utf8"))
        .replace(
          'display_name: "AdRate Shared Safety"',
          'display_name: "AdRate Shared Safety v2"'
        )
        .replace(
          'short_description: "Safe authentication, feedback, recovery, and CLI operation"',
          'short_description: "Safe v2 authentication and CLI operation"'
        )
        .replace(
          'default_prompt: "Use $adrate-shared to operate AdRate CLI safely, submit explicit feedback, and recover ambiguous results."',
          'default_prompt: "Use $adrate-shared to operate the v2 AdRate CLI safely."'
        )
    )

    await expect(notifier(installed).inspect()).resolves.toStrictEqual({
      notice: null,
      warning: null,
    })
  })

  it("accepts a newer package even when shell and manifest disagree internally", async () => {
    const { installed } = await fixture()
    await installAll(installed)
    await changeVersion(installed, "adrate-shared", "2.0.0")
    const shellPath = join(installed, "adrate-shared", "SKILL.md")
    await writeFile(
      shellPath,
      `${await readFile(shellPath, "utf8")}unmanifested change\n`
    )

    await expect(notifier(installed).inspect()).resolves.toStrictEqual({
      notice: null,
      warning: null,
    })
  })

  it("suppresses only Skills and strips an untrusted existing skills key", async () => {
    const { installed } = await fixture()
    const suppressed = await notifier(installed, {
      ADRATE_NO_SKILLS_NOTIFIER: "1",
      ADRATE_NO_CREDENTIAL_NOTIFIER: "0",
    }).inspect()
    expect(suppressed).toStrictEqual({ notice: null, warning: null })

    const base: CliOutcome = {
      exitCode: 0,
      envelope: createLocalSuccess(
        "notice_merge",
        { value: true },
        {
          _notice: {
            credential: { message: "credential-warning" },
            update: { version: "0.2.0" },
            skills: { level: "server-controlled" },
          },
        }
      ),
      warnings: ["credential-warning"],
    }
    const merged = withSkillsNotifierInspection(base, suppressed)
    expect(merged.envelope.meta._notice).toStrictEqual({
      credential: { message: "credential-warning" },
      update: { version: "0.2.0" },
    })
    expect(merged.warnings).toStrictEqual(["credential-warning"])

    const requiredManifests = vi.fn(() => {
      throw new Error("suppressed checker must not run")
    })
    const directlySuppressed = await new SkillsNotifier({
      catalog: { requiredManifests } as unknown as SkillCatalog,
      installedSkillsRoot: installed,
      environment: { ADRATE_NO_SKILLS_NOTIFIER: "1" },
    }).inspect()
    expect(directlySuppressed).toStrictEqual({ notice: null, warning: null })
    expect(requiredManifests).not.toHaveBeenCalled()
  })

  it("merges local Skills beside credential/update and warns only on stderr", async () => {
    const { installed } = await fixture()
    const inspection = await notifier(installed).inspect()
    const base: CliOutcome = {
      exitCode: 0,
      envelope: createLocalSuccess(
        "notice_merge",
        { value: true },
        {
          _notice: {
            credential: { message: "credential-warning" },
            update: { version: "0.2.0" },
          },
        }
      ),
      warnings: [],
      humanOutput: { stream: "stdout", mode: "raw", value: "body\n" },
    }
    const merged = withSkillsNotifierInspection(base, inspection)
    expect(merged.exitCode).toBe(0)
    expect(merged.envelope.meta._notice).toMatchObject({
      credential: { message: "credential-warning" },
      update: { version: "0.2.0" },
      skills: { level: "warning" },
    })

    let stdout = ""
    let stderr = ""
    renderOutcome(
      merged,
      { json: false, verbose: false },
      {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
      }
    )
    expect(stdout).toBe("body\n")
    expect(stderr).toContain("Warning: AdRate Agent Skills need attention")
    expect(stderr).not.toContain("# AdRate")

    stdout = ""
    stderr = ""
    renderOutcome(
      merged,
      { json: true, verbose: false },
      {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
      }
    )
    expect(stdout.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(stdout)).toMatchObject({
      meta: { _notice: { skills: { level: "warning" } } },
    })
    expect(stdout).not.toContain("# AdRate")
    expect(stderr).toContain("Warning: AdRate Agent Skills need attention")
  })

  it("turns an unexpected checker failure into no notice without changing outcome", async () => {
    const { installed } = await fixture()
    const brokenCatalog = {
      requiredManifests: () =>
        Promise.reject(new Error("secret checker crash")),
    } as unknown as SkillCatalog
    const inspection = await new SkillsNotifier({
      catalog: brokenCatalog,
      installedSkillsRoot: installed,
      environment: {},
    }).inspect()
    expect(inspection).toStrictEqual({ notice: null, warning: null })
  })
})
