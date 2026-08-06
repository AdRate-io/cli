import { join } from "node:path"
import { replaceLocalNotice } from "../notices/notice-merge.js"
import {
  SKILL_NAMES,
  compareSemver,
  parseSkillFrontmatter,
  parseSkillManifest,
} from "./skill-contract.js"
import { SkillPathReader } from "./skill-path-reader.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { SkillCatalog } from "./skill-catalog.js"
import type {
  SkillFrontmatter,
  SkillManifest,
  SkillName,
} from "./skill-contract.js"

export type SkillsIssueCode = "missing" | "outdated"

export interface SkillsNoticeIssue {
  name: string
  code: SkillsIssueCode
  installedVersion: string | null
}

export interface SkillsNoticeRequired {
  name: string
  version: string
  minCliVersion: string
}

export interface SkillsNotice {
  level: "warning"
  required: Array<SkillsNoticeRequired>
  issues: Array<SkillsNoticeIssue>
  suggestedAction: "install_skills"
  command: "adrate skills install"
}

export interface SkillsNotifierInspection {
  notice: SkillsNotice | null
  warning: string | null
}

interface InstalledSkill {
  shell: SkillFrontmatter
  manifest: SkillManifest
}

function asNoticeObject(notice: SkillsNotice): JsonObject {
  return notice as unknown as JsonObject
}

export function withSkillsNotifierInspection<TEnvelope extends CliEnvelope>(
  outcome: CliOutcome<TEnvelope>,
  inspection: SkillsNotifierInspection
): CliOutcome<CliEnvelope> {
  return {
    ...outcome,
    envelope: replaceLocalNotice(
      outcome.envelope,
      "skills",
      inspection.notice ? asNoticeObject(inspection.notice) : null
    ),
    warnings: inspection.warning
      ? [...outcome.warnings, inspection.warning]
      : outcome.warnings,
  }
}

export class SkillsNotifier {
  constructor(
    private readonly options: {
      catalog: SkillCatalog
      installedSkillsRoot: string
      environment: NodeJS.ProcessEnv
    }
  ) {}

  private async installed(name: SkillName): Promise<InstalledSkill | null> {
    try {
      const reader = new SkillPathReader(
        join(this.options.installedSkillsRoot, name)
      )
      const [shellFile, manifestFile] = await Promise.all([
        reader.read("SKILL.md"),
        reader.read("skill-manifest.json"),
      ])
      const shell = parseSkillFrontmatter(shellFile.content)
      const manifest = parseSkillManifest(manifestFile.content, name)
      if (!shell || !manifest || shell.name !== name) return null
      return { shell, manifest }
    } catch {
      return null
    }
  }

  private issueFor(
    expected: SkillManifest,
    installed: InstalledSkill | null
  ): SkillsNoticeIssue | null {
    if (!installed) {
      return { name: expected.name, code: "missing", installedVersion: null }
    }
    const installedVersion = installed.shell.metadata.version
    if (
      compareSemver(installedVersion, expected.version) < 0 ||
      compareSemver(installed.manifest.version, expected.version) < 0
    ) {
      return { name: expected.name, code: "outdated", installedVersion }
    }
    return null
  }

  async inspect(): Promise<SkillsNotifierInspection> {
    if (this.options.environment.ADRATE_NO_SKILLS_NOTIFIER === "1") {
      return { notice: null, warning: null }
    }
    try {
      const manifests = await this.options.catalog.requiredManifests()
      const byName = new Map(
        manifests.map((manifest) => [manifest.name, manifest])
      )
      const required: Array<SkillsNoticeRequired> = []
      const issues: Array<SkillsNoticeIssue> = []
      for (const name of SKILL_NAMES) {
        const expected = byName.get(name)
        if (!expected) return { notice: null, warning: null }
        required.push({
          name: expected.name,
          version: expected.version,
          minCliVersion: expected.minCliVersion,
        })
        const issue = this.issueFor(expected, await this.installed(name))
        if (issue) issues.push(issue)
      }
      if (issues.length === 0) return { notice: null, warning: null }
      const notice: SkillsNotice = {
        level: "warning",
        required,
        issues,
        suggestedAction: "install_skills",
        command: "adrate skills install",
      }
      return {
        notice,
        warning: `AdRate Agent Skills need attention (${issues
          .map((issue) => `${issue.name}: ${issue.code}`)
          .join(", ")}). Run: ${notice.command}`,
      }
    } catch {
      return { notice: null, warning: null }
    }
  }
}
