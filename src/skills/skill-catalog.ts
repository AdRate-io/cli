import { join } from "node:path"
import {
  SKILL_NAMES,
  parseSkillFrontmatter,
  parseSkillManifest,
  shellMatchesManifest,
} from "./skill-contract.js"
import {
  SkillPathMissingError,
  SkillPathReader,
  SkillPathUnsafeError,
} from "./skill-path-reader.js"
import type { SkillManifest, SkillName } from "./skill-contract.js"
import type { ReadSkillFile } from "./skill-path-reader.js"

export class UnknownSkillError extends Error {
  constructor() {
    super("The requested Skill is not in the CLI catalog.")
    this.name = "UnknownSkillError"
  }
}

export class UnknownSkillPathError extends Error {
  constructor() {
    super("The requested file does not exist in this Skill.")
    this.name = "UnknownSkillPathError"
  }
}

export class BundledSkillCorruptError extends Error {
  constructor() {
    super("The bundled Skill failed its integrity checks.")
    this.name = "BundledSkillCorruptError"
  }
}

export interface CatalogSkill {
  name: string
  version: string
  minCliVersion: string
  description: string
}

export interface CatalogSkillFile extends ReadSkillFile {
  name: string
  version: string
  path: string
}

function knownSkillName(value: string): value is SkillName {
  return (SKILL_NAMES as ReadonlyArray<string>).includes(value)
}

function sortedByName<T extends { name: string }>(values: Array<T>): Array<T> {
  return values.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )
}

export class SkillCatalog {
  constructor(private readonly packageRoot: string) {}

  private shellReader(name: SkillName): SkillPathReader {
    return new SkillPathReader(join(this.packageRoot, "skills", name))
  }

  private contentReader(name: SkillName): SkillPathReader {
    return new SkillPathReader(join(this.packageRoot, "skills-content", name))
  }

  private async definition(name: SkillName): Promise<SkillManifest> {
    try {
      const shellReader = this.shellReader(name)
      const [manifestFile, shellFile] = await Promise.all([
        shellReader.read("skill-manifest.json"),
        shellReader.read("SKILL.md"),
      ])
      const manifest = parseSkillManifest(manifestFile.content, name)
      const shell = parseSkillFrontmatter(shellFile.content)
      if (
        !manifest ||
        !shell ||
        !shellMatchesManifest({
          shell,
          shellSha256: shellFile.sha256,
          manifest,
        })
      ) {
        throw new BundledSkillCorruptError()
      }
      return manifest
    } catch (error) {
      if (error instanceof BundledSkillCorruptError) throw error
      if (
        error instanceof SkillPathMissingError ||
        error instanceof SkillPathUnsafeError
      ) {
        throw new BundledSkillCorruptError()
      }
      throw error
    }
  }

  async requiredManifests(): Promise<Array<SkillManifest>> {
    const manifests: Array<SkillManifest> = []
    for (const name of SKILL_NAMES) manifests.push(await this.definition(name))
    return manifests
  }

  async list(): Promise<Array<CatalogSkill>> {
    const manifests: Array<SkillManifest> = []
    for (const name of SKILL_NAMES) {
      manifests.push(await this.definition(name))
    }
    return sortedByName(
      manifests.map(({ name, version, minCliVersion, description }) => ({
        name,
        version,
        minCliVersion,
        description,
      }))
    )
  }

  async read(nameValue: string, path = "SKILL.md"): Promise<CatalogSkillFile> {
    if (!knownSkillName(nameValue)) throw new UnknownSkillError()
    const manifest = await this.definition(nameValue)
    const contentReader = this.contentReader(nameValue)
    let primary: ReadSkillFile
    try {
      primary = await contentReader.read("SKILL.md")
    } catch (error) {
      if (
        error instanceof SkillPathMissingError ||
        error instanceof SkillPathUnsafeError
      ) {
        throw new BundledSkillCorruptError()
      }
      throw error
    }
    if (primary.sha256 !== manifest.contentSha256) {
      throw new BundledSkillCorruptError()
    }
    let file = primary
    if (path !== "SKILL.md") {
      try {
        file = await contentReader.read(path)
      } catch (error) {
        if (error instanceof SkillPathMissingError) {
          throw new UnknownSkillPathError()
        }
        throw error
      }
    }
    return {
      name: manifest.name,
      version: manifest.version,
      path,
      content: file.content,
      sha256: file.sha256,
      size: file.size,
    }
  }
}
