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
import type { SkillCatalog } from "./skill-catalog.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { CliOutcome } from "../errors.js"
import type { JsonObject } from "../contracts/json.js"
import type { SkillName } from "./skill-contract.js"
import type { ReadSkillFile } from "./skill-path-reader.js"

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const ALLOWED_SKILL_FILES = Object.freeze([
  "SKILL.md",
  "skill-manifest.json",
  "agents/openai.yaml",
] as const)

type AllowedSkillFile = (typeof ALLOWED_SKILL_FILES)[number]
type ValidatedSourceFiles = Readonly<Record<AllowedSkillFile, ReadSkillFile>>

interface InstallResult {
  name: string
  version: string
  status: "installed" | "updated" | "unchanged"
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
      throw installFailure("The install target directory is a symbolic link.")
    }
    if (!info.isDirectory()) {
      throw installFailure(
        "The install target path exists but is not a directory."
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

async function assertDirectoryNotReplaced(dirPath: string): Promise<void> {
  const info = await lstat(dirPath)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw installFailure(
      "The target directory was replaced during installation."
    )
  }
}

export class SkillsInstallService {
  constructor(
    private readonly catalog: SkillCatalog,
    private readonly options: {
      packageRoot: string
      installedSkillsRoot: string
    }
  ) {}

  async install(): Promise<CliOutcome<CliEnvelope>> {
    await assertSafeInstallTarget(this.options.installedSkillsRoot)
    await ensureDirectorySecure(this.options.installedSkillsRoot)

    const results: Array<InstallResult> = []
    for (const name of SKILL_NAMES) {
      results.push(await this.installSkill(name))
    }

    const data = { skills: results } as unknown as JsonObject
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
    const summary =
      parts.length === 0
        ? "All Agent Skills are already up to date."
        : `${parts.join(". ")}.`

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

  private async installSkill(name: SkillName): Promise<InstallResult> {
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

    const targetDir = join(this.options.installedSkillsRoot, name)
    const resolved = resolve(targetDir)
    if (!contained(resolve(this.options.installedSkillsRoot), resolved)) {
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

    for (const relativePath of ALLOWED_SKILL_FILES) {
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
