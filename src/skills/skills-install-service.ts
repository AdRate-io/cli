import { constants } from "node:fs"
import { chmod, lstat, mkdir, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { CLI_VERSION, EXIT_CODE } from "../constants.js"
import { createLocalError, createLocalSuccess } from "../contracts/envelope.js"
import { CliFailure, localRequestId } from "../errors.js"
import {
  SKILL_NAMES,
  compareSemver,
  parseOpenAiConfig,
  parseSkillFrontmatter,
  parseSkillManifest,
  shellMatchesManifest,
} from "./skill-contract.js"
import {
  SkillPathMissingError,
  SkillPathReader,
  SkillPathUnsafeError,
} from "./skill-path-reader.js"
import { BundledSkillCorruptError } from "./skill-catalog.js"
import { activeSkillsRoots } from "./skills-roots.js"
import type { SkillCatalog } from "./skill-catalog.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { CliOutcome } from "../errors.js"
import type { JsonObject } from "../contracts/json.js"
import type { SkillName } from "./skill-contract.js"
import type { ReadSkillFile } from "./skill-path-reader.js"
import type { SkillsRootSpec } from "./skills-roots.js"

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const ALLOWED_SKILL_FILES = Object.freeze([
  "SKILL.md",
  "skill-manifest.json",
  "agents/openai.yaml",
] as const)

type AllowedSkillFile = (typeof ALLOWED_SKILL_FILES)[number]

/**
 * 写盘顺序：带版本号的两份文件最后写，`skill-manifest.json` 收尾充当提交标记。
 * 安装状态只由 SKILL.md 与 manifest 的版本判定（任一落后即 outdated），中途写失败时
 * manifest 仍是旧版本 → 保持 outdated，下次命令继续升级，不会把半安装报成升级成功。
 */
const SKILL_FILE_WRITE_ORDER: ReadonlyArray<AllowedSkillFile> = Object.freeze([
  "agents/openai.yaml",
  "SKILL.md",
  "skill-manifest.json",
])
type ValidatedSourceFiles = Readonly<Record<AllowedSkillFile, ReadSkillFile>>

export interface InstallResult {
  name: string
  version: string
  status: "installed" | "updated" | "unchanged"
}

/** 单个安装根目录的结果；error 非 null 表示该目录未装完（其余目录照常处理） */
interface InstallTarget {
  root: string
  skills: Array<InstallResult>
  error: string | null
}

function describeInstallError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ExistingSkillStatus {
  version: string
  status: InstallResult["status"]
}

function installFailure(message: string): CliFailure<CliEnvelope> {
  return new CliFailure<CliEnvelope>(
    message,
    EXIT_CODE.business,
    createLocalError(localRequestId(), "LOCAL_STATE_UNSAFE", message, false, {})
  )
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

async function assertSafeInstallTarget(targetRoot: string): Promise<void> {
  if (!isAbsolute(targetRoot)) {
    throw installFailure(
      "The install target directory must be an absolute path."
    )
  }
  try {
    const info = await lstat(targetRoot)
    if (info.isSymbolicLink()) {
      throw installFailure(
        `The install target directory ${targetRoot} is a symbolic link.`
      )
    }
    if (!info.isDirectory()) {
      throw installFailure(
        `The install target path ${targetRoot} exists but is not a directory.`
      )
    }
  } catch (error) {
    if (error instanceof CliFailure) throw error
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return
    }
    throw error
  }
}

async function ensureDirectorySecure(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE, recursive: false })
    if (process.platform !== "win32") await chmod(path, DIRECTORY_MODE)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw installFailure(
          `Cannot create directory at ${path}: path exists and is not a directory.`
        )
      }
      if (process.platform !== "win32") await chmod(path, DIRECTORY_MODE)
      return
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await ensureDirectorySecure(dirname(path))
      await ensureDirectorySecure(path)
      return
    }
    throw error
  }
}

async function writeFileSecure(
  targetPath: string,
  content: string
): Promise<void> {
  const { open } = await import("node:fs/promises")
  const { randomBytes } = await import("node:crypto")
  const tempSuffix = randomBytes(8).toString("hex")
  const tempPath = `${targetPath}.${tempSuffix}.tmp`
  const flags =
    process.platform === "win32"
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      : constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW
  let renamed = false
  const handle = await open(tempPath, flags, FILE_MODE)
  try {
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    if (process.platform !== "win32") await chmod(tempPath, FILE_MODE)
    await rename(tempPath, targetPath)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        await handle.close()
      } catch {
        /* 可能已关闭 */
      }
      try {
        await unlink(tempPath)
      } catch {
        /* best effort */
      }
    }
  }
}

/** 路径存在且是真实目录（非 symlink）才返回 true；ENOENT 返回 false，其余错误上抛 */
async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

async function assertDirectoryNotReplaced(dirPath: string): Promise<void> {
  const info = await lstat(dirPath)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw installFailure(
      "The target directory was replaced during installation."
    )
  }
}

/** 同一 Skill 在多个根目录的结果合并为一条：installed > updated > unchanged */
const INSTALL_STATUS_RANK: Readonly<Record<InstallResult["status"], number>> = {
  installed: 0,
  updated: 1,
  unchanged: 2,
}

function mergeInstallResults(
  perRoot: ReadonlyArray<ReadonlyArray<InstallResult>>
): Array<InstallResult> {
  return SKILL_NAMES.flatMap((name) => {
    const candidates = perRoot
      .flatMap((results) => results)
      .filter((result) => result.name === name)
      .sort(
        (a, b) => INSTALL_STATUS_RANK[a.status] - INSTALL_STATUS_RANK[b.status]
      )
    return candidates[0] ? [candidates[0]] : []
  })
}

function installSummary(results: ReadonlyArray<InstallResult>): string {
  const newlyInstalled = results.filter((r) => r.status === "installed")
  const updated = results.filter((r) => r.status === "updated")
  const parts: Array<string> = []
  if (newlyInstalled.length > 0) {
    parts.push(
      `Installed: ${newlyInstalled.map((r) => `${r.name}@${r.version}`).join(", ")}`
    )
  }
  if (updated.length > 0) {
    parts.push(
      `Updated: ${updated.map((r) => `${r.name}@${r.version}`).join(", ")}`
    )
  }
  return parts.length === 0
    ? "All Agent Skills are already up to date."
    : `${parts.join(". ")}.`
}

/**
 * 启用的安装根目录（见 skills-roots.ts）逐个写入，每个根目录独立执行同一套
 * 白名单、摘要校验、原子写入与「不降级更高版本」规则。
 * 根目录之间互相隔离：一个目录异常（如被做成软链）不挡其他目录，最后汇总报告。
 */
export class SkillsInstallService {
  constructor(
    private readonly catalog: SkillCatalog,
    private readonly options: {
      packageRoot: string
      installedSkillsRoots: ReadonlyArray<SkillsRootSpec>
    }
  ) {}

  async install(): Promise<CliOutcome<CliEnvelope>> {
    const targets: Array<InstallTarget> = []
    for (const root of await activeSkillsRoots(
      this.options.installedSkillsRoots
    )) {
      const skills: Array<InstallResult> = []
      try {
        await assertSafeInstallTarget(root)
        await ensureDirectorySecure(root)
        for (const name of SKILL_NAMES) {
          skills.push(await this.installSkill(root, name))
        }
        targets.push({ root, skills, error: null })
      } catch (error) {
        targets.push({ root, skills, error: describeInstallError(error) })
      }
    }

    const failed = targets.filter((target) => target.error !== null)
    if (failed.length > 0) {
      // 任一目录未装完即非 0 退出；已写成功的目录同时列出，重跑会补齐（已装的返回 unchanged）
      const lines = targets.map((target) =>
        target.error === null
          ? `${target.root}: ${installSummary(target.skills)}`
          : `${target.root}: FAILED - ${target.error}`
      )
      const message = `Agent Skills were not installed in every directory.\n${lines.join("\n")}`
      throw new CliFailure<CliEnvelope>(
        message,
        EXIT_CODE.business,
        createLocalError(localRequestId(), "LOCAL_STATE_UNSAFE", message, false, {
          targets,
        } as unknown as JsonObject)
      )
    }

    // skills 保持「每个 Skill 一条」的既有形态；逐目录明细在 targets
    const data = {
      skills: mergeInstallResults(targets.map((target) => target.skills)),
      targets,
    } as unknown as JsonObject
    const summary =
      targets.length === 1
        ? installSummary(targets[0]!.skills)
        : targets
            .map((target) => `${target.root}: ${installSummary(target.skills)}`)
            .join("\n")

    return {
      exitCode: EXIT_CODE.success,
      envelope: createLocalSuccess(localRequestId(), data, {
        cliVersion: CLI_VERSION,
      }),
      warnings: [],
      humanOutput: {
        stream: "stdout",
        mode: "line",
        value: summary,
      },
    }
  }

  /**
   * 自动升级入口（SkillsNotifier 在检测到 outdated 时调用）：只处理「已安装」的 Skill。
   *
   * 首次安装必须由用户显式执行 `adrate skills install`（不悄悄往用户 home 写新目录），
   * 所以安装根目录或某个 Skill 目录不存在时直接跳过，绝不创建。
   * 其余校验、原子写入与「不降级更高版本」完全复用 installSkill。
   * 按「根目录 × Skill」逐个隔离失败：某处异常只跳过该处，调用方重读后
   * 仍是 outdated 的会回落为显式提示。传入的 names 按 Skill 名过滤，
   * 某目录里已是 current 的同名 Skill 也会走一遍校验（结果 unchanged，无副作用）。
   */
  async upgradeInstalled(
    names: ReadonlyArray<SkillName>
  ): Promise<ReadonlyArray<InstallResult>> {
    const results: Array<InstallResult> = []
    for (const root of await activeSkillsRoots(
      this.options.installedSkillsRoots
    )) {
      try {
        if (!(await isExistingDirectory(root))) continue
        await assertSafeInstallTarget(root)
      } catch {
        continue
      }
      for (const name of SKILL_NAMES) {
        if (!names.includes(name)) continue
        try {
          if (!(await isExistingDirectory(join(root, name)))) continue
          results.push(await this.installSkill(root, name))
        } catch {
          // 该目录的该 Skill 升级失败，不影响其他目录与 Skill
        }
      }
    }
    return results
  }

  private async installSkill(
    installedSkillsRoot: string,
    name: SkillName
  ): Promise<InstallResult> {
    const sourceShellDir = join(this.options.packageRoot, "skills", name)
    const sourceReader = new SkillPathReader(sourceShellDir)

    let shellFile, manifestFile
    try {
      ;[shellFile, manifestFile] = await Promise.all([
        sourceReader.read("SKILL.md"),
        sourceReader.read("skill-manifest.json"),
      ])
    } catch (error) {
      if (
        error instanceof SkillPathUnsafeError ||
        error instanceof SkillPathMissingError
      ) {
        throw installFailure(
          `Bundled Skill "${name}" is missing or unsafe. Reinstall the AdRate CLI.`
        )
      }
      throw error
    }
    const manifest = parseSkillManifest(manifestFile.content, name)
    const shell = parseSkillFrontmatter(shellFile.content)
    if (
      !manifest ||
      !shell ||
      !shellMatchesManifest({ shell, shellSha256: shellFile.sha256, manifest })
    ) {
      throw installFailure(
        `Bundled Skill "${name}" failed integrity validation. Reinstall the AdRate CLI.`
      )
    }

    let openAiFile
    try {
      openAiFile = await sourceReader.read("agents/openai.yaml")
    } catch (error) {
      if (
        error instanceof SkillPathUnsafeError ||
        error instanceof SkillPathMissingError
      ) {
        throw installFailure(
          `Bundled Skill "${name}/agents/openai.yaml" is missing or unsafe. Reinstall the AdRate CLI.`
        )
      }
      throw error
    }
    const openAiConfig = parseOpenAiConfig(openAiFile.content)
    if (!openAiConfig || !openAiConfig.defaultPrompt.includes(`$${name}`)) {
      throw installFailure(
        `Bundled Skill "${name}/agents/openai.yaml" failed integrity validation. Reinstall the AdRate CLI.`
      )
    }

    try {
      await this.catalog.read(name)
    } catch (error) {
      if (error instanceof BundledSkillCorruptError) {
        throw installFailure(
          `Bundled Skill "${name}" content failed SHA verification. Reinstall the AdRate CLI.`
        )
      }
      throw error
    }

    // 后续比较与写入只使用这一份已通过内部一致性校验的快照。
    const sourceFiles: ValidatedSourceFiles = {
      "SKILL.md": shellFile,
      "skill-manifest.json": manifestFile,
      "agents/openai.yaml": openAiFile,
    }

    const targetDir = join(installedSkillsRoot, name)
    const resolved = resolve(targetDir)
    if (!contained(resolve(installedSkillsRoot), resolved)) {
      throw installFailure(
        `Skill name "${name}" resolves outside the install directory.`
      )
    }

    const existing = await this.checkExisting(
      name,
      targetDir,
      manifest.version,
      sourceFiles
    )
    await ensureDirectorySecure(targetDir)
    await ensureDirectorySecure(join(targetDir, "agents"))
    if (existing.status === "unchanged") {
      return { name, version: existing.version, status: "unchanged" }
    }

    for (const relativePath of SKILL_FILE_WRITE_ORDER) {
      const fileContent = sourceFiles[relativePath]
      const targetPath = join(targetDir, ...relativePath.split("/"))
      const resolvedTarget = resolve(targetPath)
      if (!contained(resolved, resolvedTarget)) {
        throw installFailure(
          `Skill file "${relativePath}" resolves outside the target directory.`
        )
      }
      const parentDir = dirname(resolvedTarget)
      if (parentDir !== resolved) {
        await ensureDirectorySecure(parentDir)
      }
      await assertDirectoryNotReplaced(resolved)
      await writeFileSecure(resolvedTarget, fileContent.content)
    }

    return { name, version: manifest.version, status: existing.status }
  }

  private async checkExisting(
    name: SkillName,
    targetDir: string,
    expectedVersion: string,
    sourceFiles: ValidatedSourceFiles
  ): Promise<ExistingSkillStatus> {
    try {
      const info = await lstat(targetDir)
      if (info.isSymbolicLink()) {
        throw installFailure(
          `Target "${targetDir}" is a symbolic link. Remove it manually and retry.`
        )
      }
      if (!info.isDirectory()) {
        throw installFailure(
          `Target "${targetDir}" exists but is not a directory. Remove it manually and retry.`
        )
      }
    } catch (error) {
      if (error instanceof CliFailure) throw error
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { version: expectedVersion, status: "installed" }
      }
      throw error
    }
    try {
      const reader = new SkillPathReader(targetDir)
      const [existingShell, existingManifest, existingOpenAi] =
        await Promise.all([
          reader.read("SKILL.md"),
          reader.read("skill-manifest.json"),
          reader.read("agents/openai.yaml"),
        ])
      const shell = parseSkillFrontmatter(existingShell.content)
      const manifest = parseSkillManifest(existingManifest.content, name)
      const openAi = parseOpenAiConfig(existingOpenAi.content)
      if (
        !shell ||
        !manifest ||
        !openAi ||
        !openAi.defaultPrompt.includes(`$${name}`) ||
        manifest.name !== name ||
        !shellMatchesManifest({
          shell,
          shellSha256: existingShell.sha256,
          manifest,
        })
      ) {
        return { version: expectedVersion, status: "updated" }
      }
      if (compareSemver(manifest.version, expectedVersion) > 0) {
        return { version: manifest.version, status: "unchanged" }
      }
      if (manifest.version !== expectedVersion) {
        return { version: expectedVersion, status: "updated" }
      }
      const installedFiles: ValidatedSourceFiles = {
        "SKILL.md": existingShell,
        "skill-manifest.json": existingManifest,
        "agents/openai.yaml": existingOpenAi,
      }
      // 逐文件 SHA 比对：白名单内源文件与已安装文件必须一致
      for (const relativePath of ALLOWED_SKILL_FILES) {
        const sourceFile = sourceFiles[relativePath]
        const installedFile = installedFiles[relativePath]
        if (sourceFile.sha256 !== installedFile.sha256) {
          return { version: expectedVersion, status: "updated" }
        }
        if (process.platform !== "win32") {
          const installedPath = join(targetDir, ...relativePath.split("/"))
          const info = await lstat(installedPath)
          if (
            info.isSymbolicLink() ||
            !info.isFile() ||
            (info.mode & 0o7777) !== FILE_MODE
          ) {
            return { version: expectedVersion, status: "updated" }
          }
        }
      }
      return { version: manifest.version, status: "unchanged" }
    } catch {
      // 读取失败意味着需要重新安装
    }
    return { version: expectedVersion, status: "updated" }
  }
}
