import { join } from "node:path"
import { replaceLocalNotice } from "../notices/notice-merge.js"
import {
  SKILL_NAMES,
  compareSemver,
  parseSkillFrontmatter,
  parseSkillManifest,
} from "./skill-contract.js"
import { SkillPathReader } from "./skill-path-reader.js"
import { BundledSkillCorruptError } from "./skill-catalog.js"
import { activeSkillsRoots } from "./skills-roots.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"
import type { CliOutcome } from "../errors.js"
import type { SkillCatalog } from "./skill-catalog.js"
import type { SkillsInstallService } from "./skills-install-service.js"
import type { SkillsRootSpec } from "./skills-roots.js"
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

/** 自动升级器：只升级已安装的 Skill，由 SkillsInstallService 实现 */
export type SkillsAutoUpgrader = Pick<SkillsInstallService, "upgradeInstalled">

/** 单个 Skill 在某一个安装根目录下的事实 */
export interface SkillRootFact {
  root: string
  installedVersion: string | null
  state: SkillInstallFact["state"]
}

/**
 * 单个 Skill 的本地安装事实（notifier 与 `skills status` 共用的唯一判定）。
 * 多个安装根目录合并为最需要处理的那一个：missing > outdated > current > newer，
 * 任一目录缺失或过期都会提示，逐目录明细在 roots。
 */
export interface SkillInstallFact {
  name: SkillName
  bundledVersion: string
  minCliVersion: string
  /** 已安装壳的版本；未安装或不可读 / 不自洽时为 null（与 missing 同义） */
  installedVersion: string | null
  installedMinCliVersion: string | null
  /** current = 与包内一致；newer = 已安装的更高版本（由更新的 CLI 装入，不降级） */
  state: "current" | SkillsIssueCode | "newer"
  roots: Array<SkillRootFact>
}

type SingleRootFact = Omit<SkillInstallFact, "roots">

const STATE_ATTENTION_RANK: Readonly<Record<SkillInstallFact["state"], number>> =
  { missing: 0, outdated: 1, current: 2, newer: 3 }

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
      installedSkillsRoots: ReadonlyArray<SkillsRootSpec>
      environment: NodeJS.ProcessEnv
      /** 未注入时不做自动升级（只提示） */
      upgrader?: SkillsAutoUpgrader
    }
  ) {}

  private async installed(
    root: string,
    name: SkillName
  ): Promise<InstalledSkill | null> {
    try {
      const reader = new SkillPathReader(join(root, name))
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

  private factFor(
    name: SkillName,
    expected: SkillManifest,
    installed: InstalledSkill | null
  ): SingleRootFact {
    const base = {
      name,
      bundledVersion: expected.version,
      minCliVersion: expected.minCliVersion,
    }
    if (!installed) {
      return {
        ...base,
        installedVersion: null,
        installedMinCliVersion: null,
        state: "missing",
      }
    }
    const installedVersion = installed.shell.metadata.version
    const state: SkillInstallFact["state"] =
      compareSemver(installedVersion, expected.version) < 0 ||
      compareSemver(installed.manifest.version, expected.version) < 0
        ? "outdated"
        : compareSemver(installedVersion, expected.version) > 0
          ? "newer"
          : "current"
    return {
      ...base,
      installedVersion,
      installedMinCliVersion: installed.shell.metadata.minCliVersion,
      state,
    }
  }

  /**
   * 只读收集两项 Skill 的安装事实，按 SKILL_NAMES 固定顺序返回。
   * 包内 manifest 缺项时抛 BundledSkillCorruptError 由调用方决定如何表达。
   */
  async facts(): Promise<ReadonlyArray<SkillInstallFact>> {
    const manifests = await this.options.catalog.requiredManifests()
    const byName = new Map(
      manifests.map((manifest) => [manifest.name, manifest])
    )
    const roots = await activeSkillsRoots(this.options.installedSkillsRoots)
    const facts: Array<SkillInstallFact> = []
    for (const name of SKILL_NAMES) {
      const expected = byName.get(name)
      if (!expected) throw new BundledSkillCorruptError()
      const perRoot: Array<SingleRootFact & { root: string }> = []
      for (const root of roots) {
        perRoot.push({
          root,
          ...this.factFor(name, expected, await this.installed(root, name)),
        })
      }
      const [primary] = [...perRoot].sort(
        (a, b) => STATE_ATTENTION_RANK[a.state] - STATE_ATTENTION_RANK[b.state]
      )
      if (!primary) throw new Error("No installed Skills root configured.")
      const { root: _root, ...merged } = primary
      facts.push({
        ...merged,
        roots: perRoot.map((fact) => ({
          root: fact.root,
          installedVersion: fact.installedVersion,
          state: fact.state,
        })),
      })
    }
    return facts
  }

  /**
   * 每条命令执行后的本地检查：
   * - outdated（用户已同意过安装、只是版本落后）且允许自动升级 → 就地升级，stderr 附一行说明；
   *   升级后重新读取确认，确实到位的才从 issues 中移除，失败则回落为原 notice
   * - missing（首次安装）永远只提示，不自动写用户 home
   * 任何异常都不影响业务结果与退出码。
   */
  async inspect(
    options: { autoUpgrade?: boolean } = {}
  ): Promise<SkillsNotifierInspection> {
    if (this.options.environment.ADRATE_NO_SKILLS_NOTIFIER === "1") {
      return { notice: null, warning: null }
    }
    try {
      let facts = await this.facts()
      const upgraded = await this.tryUpgrade(facts, options.autoUpgrade === true)
      if (upgraded.attempted) facts = await this.facts()

      // 按「Skill × 根目录」核对：升级前 outdated、升级后重读为 current 才算升级成功
      const upgradedLines = upgraded.before
        .flatMap((before) =>
          before.roots
            .filter((root) => root.state === "outdated")
            .map((root) => {
              const after = facts
                .find((fact) => fact.name === before.name)
                ?.roots.find((candidate) => candidate.root === root.root)
              return after && after.state === "current"
                ? `${before.name} ${root.installedVersion ?? "?"} -> ${after.installedVersion ?? "?"}`
                : null
            })
        )
        .filter((line): line is string => line !== null)
      const uniqueUpgradedLines = [...new Set(upgradedLines)]
      const upgradeWarning =
        uniqueUpgradedLines.length > 0
          ? `AdRate Agent Skills were updated automatically (${uniqueUpgradedLines.join(", ")}).`
          : null

      const issues: Array<SkillsNoticeIssue> = facts
        .filter(
          (fact): fact is SkillInstallFact & { state: SkillsIssueCode } =>
            fact.state === "missing" || fact.state === "outdated"
        )
        .map((fact) => ({
          name: fact.name,
          code: fact.state,
          installedVersion: fact.installedVersion,
        }))
      if (issues.length === 0) return { notice: null, warning: upgradeWarning }
      const notice: SkillsNotice = {
        level: "warning",
        required: facts.map((fact) => ({
          name: fact.name,
          version: fact.bundledVersion,
          minCliVersion: fact.minCliVersion,
        })),
        issues,
        suggestedAction: "install_skills",
        command: "adrate skills install",
      }
      const issueWarning = `AdRate Agent Skills need attention (${issues
        .map((issue) => `${issue.name}: ${issue.code}`)
        .join(", ")}). Run: ${notice.command}`
      return {
        notice,
        warning: upgradeWarning
          ? `${upgradeWarning} ${issueWarning}`
          : issueWarning,
      }
    } catch {
      return { notice: null, warning: null }
    }
  }

  private async tryUpgrade(
    facts: ReadonlyArray<SkillInstallFact>,
    allowed: boolean
  ): Promise<{ attempted: boolean; before: ReadonlyArray<SkillInstallFact> }> {
    // 合并状态可能被另一目录的 missing 盖住，必须按逐目录状态找 outdated
    const outdated = facts.filter((fact) =>
      fact.roots.some((root) => root.state === "outdated")
    )
    const upgrader = this.options.upgrader
    if (!allowed || !upgrader || outdated.length === 0) {
      return { attempted: false, before: [] }
    }
    try {
      await upgrader.upgradeInstalled(outdated.map((fact) => fact.name))
    } catch {
      // 升级失败不影响业务；重新读取后仍是 outdated，自然回落为显式提示
    }
    return { attempted: true, before: outdated }
  }
}
