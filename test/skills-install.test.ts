import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { CLI_VERSION } from "../src/constants.js"
import { CliFailure } from "../src/errors.js"
import { SkillCatalog } from "../src/skills/skill-catalog.js"
import { sha256SkillText } from "../src/skills/skill-contract.js"
import { SkillsInstallService } from "../src/skills/skills-install-service.js"

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url))
const roots: Array<string> = []

async function fixture(): Promise<{
  packageRoot: string
  installedRoot: string
  service: SkillsInstallService
}> {
  const root = await mkdtemp(join(tmpdir(), "adrate-skills-install-"))
  roots.push(root)
  const packageRoot = join(root, "package")
  const installedRoot = join(root, "installed")
  await cp(join(CLI_ROOT, "skills"), join(packageRoot, "skills"), {
    recursive: true,
  })
  await cp(
    join(CLI_ROOT, "skills-content"),
    join(packageRoot, "skills-content"),
    {
      recursive: true,
    }
  )
  const catalog = new SkillCatalog(packageRoot)
  const service = new SkillsInstallService(catalog, {
    packageRoot,
    installedSkillsRoot: installedRoot,
  })
  return { packageRoot, installedRoot, service }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("SkillsInstallService", () => {
  it("installs both Skills to a new directory", async () => {
    const { installedRoot, service } = await fixture()
    const outcome = await service.install()

    expect(outcome.exitCode).toBe(0)
    expect(outcome.envelope.ok).toBe(true)
    if (outcome.envelope.ok) {
      const skills = outcome.envelope.data.skills as Array<{
        name: string
        version: string
        status: string
      }>
      expect(skills).toHaveLength(2)
      expect(skills.map((s) => s.name).sort()).toEqual([
        "adrate-ads",
        "adrate-shared",
      ])
      for (const skill of skills) {
        expect(skill.status).toBe("installed")
        expect(skill.version).toBe("1.5.0")
      }
    }
    expect(outcome.humanOutput).toMatchObject({
      stream: "stdout",
      mode: "line",
      value: expect.stringContaining("Installed:"),
    })

    const sharedManifest = await readFile(
      join(installedRoot, "adrate-shared", "skill-manifest.json"),
      "utf8"
    )
    expect(JSON.parse(sharedManifest).name).toBe("adrate-shared")

    const sharedSkill = await readFile(
      join(installedRoot, "adrate-shared", "SKILL.md"),
      "utf8"
    )
    expect(sharedSkill).toContain("adrate-shared")

    const adsManifest = await readFile(
      join(installedRoot, "adrate-ads", "skill-manifest.json"),
      "utf8"
    )
    expect(JSON.parse(adsManifest).name).toBe("adrate-ads")
  })

  it("reports unchanged when already up to date", async () => {
    const { installedRoot, service } = await fixture()
    await service.install()
    const outcome = await service.install()

    expect(outcome.exitCode).toBe(0)
    if (outcome.envelope.ok) {
      const skills = outcome.envelope.data.skills as Array<{
        name: string
        status: string
        version: string
      }>
      for (const skill of skills) {
        expect(skill.status).toBe("unchanged")
      }
    }
    expect(outcome.humanOutput).toMatchObject({
      value: expect.stringContaining("already up to date"),
    })
  })

  it("does not downgrade a valid newer installed Skill", async () => {
    const { installedRoot, service } = await fixture()
    await service.install()
    const shellPath = join(installedRoot, "adrate-shared", "SKILL.md")
    const manifestPath = join(
      installedRoot,
      "adrate-shared",
      "skill-manifest.json"
    )
    const shell = (await readFile(shellPath, "utf8")).replace(
      'version: "1.5.0"',
      'version: "2.0.0"'
    )
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string
      shellSha256: string
    }
    manifest.version = "2.0.0"
    manifest.shellSha256 = sha256SkillText(shell)
    await writeFile(shellPath, shell)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const outcome = await service.install()
    expect(outcome.exitCode).toBe(0)
    if (outcome.envelope.ok) {
      const skills = outcome.envelope.data.skills as Array<{
        name: string
        status: string
        version: string
      }>
      expect(
        skills.find((skill) => skill.name === "adrate-shared")?.status
      ).toBe("unchanged")
      expect(
        skills.find((skill) => skill.name === "adrate-shared")?.version
      ).toBe("2.0.0")
    }
    await expect(readFile(shellPath, "utf8")).resolves.toContain(
      'version: "2.0.0"'
    )
  })

  it("reports updated when content has drifted", async () => {
    const { installedRoot, service } = await fixture()
    await service.install()

    await writeFile(
      join(installedRoot, "adrate-shared", "skill-manifest.json"),
      JSON.stringify({
        formatVersion: 1,
        name: "adrate-shared",
        version: "0.0.1",
      }),
      "utf8"
    )

    const outcome = await service.install()
    expect(outcome.exitCode).toBe(0)
    if (outcome.envelope.ok) {
      const skills = outcome.envelope.data.skills as Array<{
        name: string
        status: string
      }>
      const shared = skills.find((s) => s.name === "adrate-shared")
      expect(shared?.status).toBe("updated")
    }
  })

  it("reports updated when openai.yaml content has drifted", async () => {
    const { installedRoot, service } = await fixture()
    await service.install()

    await writeFile(
      join(installedRoot, "adrate-shared", "agents", "openai.yaml"),
      "tampered content",
      "utf8"
    )

    const outcome = await service.install()
    expect(outcome.exitCode).toBe(0)
    if (outcome.envelope.ok) {
      const skills = outcome.envelope.data.skills as Array<{
        name: string
        status: string
      }>
      const shared = skills.find((s) => s.name === "adrate-shared")
      expect(shared?.status).toBe("updated")
    }
  })

  it("reports updated when openai.yaml is missing", async () => {
    const { installedRoot, service } = await fixture()
    await service.install()

    await rm(join(installedRoot, "adrate-shared", "agents", "openai.yaml"))

    const outcome = await service.install()
    expect(outcome.exitCode).toBe(0)
    if (outcome.envelope.ok) {
      const skills = outcome.envelope.data.skills as Array<{
        name: string
        status: string
      }>
      const shared = skills.find((s) => s.name === "adrate-shared")
      expect(shared?.status).toBe("updated")
    }
  })

  it("rejects if target root is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "adrate-skills-install-symlink-"))
    roots.push(root)
    const packageRoot = join(root, "package")
    const realTarget = join(root, "real-target")
    const symlinkTarget = join(root, "symlink-target")
    await cp(join(CLI_ROOT, "skills"), join(packageRoot, "skills"), {
      recursive: true,
    })
    await cp(
      join(CLI_ROOT, "skills-content"),
      join(packageRoot, "skills-content"),
      {
        recursive: true,
      }
    )
    await mkdir(realTarget)
    await symlink(realTarget, symlinkTarget)

    const catalog = new SkillCatalog(packageRoot)
    const service = new SkillsInstallService(catalog, {
      packageRoot,
      installedSkillsRoot: symlinkTarget,
    })
    await expect(service.install()).rejects.toThrow(CliFailure)
    try {
      await service.install()
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailure)
      const failure = error as CliFailure
      expect(failure.exitCode).toBe(1)
    }
  })

  it("rejects if target skill directory is a symlink", async () => {
    const { installedRoot, service, packageRoot } = await fixture()
    await mkdir(installedRoot, { recursive: true })
    const realSkillDir = join(installedRoot, "real-shared")
    await mkdir(realSkillDir)
    await symlink(realSkillDir, join(installedRoot, "adrate-shared"))

    await expect(service.install()).rejects.toThrow(CliFailure)
  })

  it("sets restrictive file permissions on POSIX", async () => {
    if (process.platform === "win32") return
    const { installedRoot, service } = await fixture()
    await service.install()

    const dirStat = await lstat(join(installedRoot, "adrate-shared"))
    expect((dirStat.mode & 0o777).toString(8)).toBe("700")

    const fileStat = await lstat(
      join(installedRoot, "adrate-shared", "SKILL.md")
    )
    expect((fileStat.mode & 0o777).toString(8)).toBe("600")
  })

  it("installs subdirectory files (agents/openai.yaml)", async () => {
    const { installedRoot, service } = await fixture()
    await service.install()

    const yaml = await readFile(
      join(installedRoot, "adrate-shared", "agents", "openai.yaml"),
      "utf8"
    )
    expect(yaml).toContain("display_name")
  })

  it("includes CLI version in envelope meta", async () => {
    const { service } = await fixture()
    const outcome = await service.install()

    expect(outcome.envelope.ok).toBe(true)
    if (outcome.envelope.ok) {
      expect(outcome.envelope.meta.cliVersion).toBe(CLI_VERSION)
    }
  })

  it("rejects when skills-content SKILL.md is tampered", async () => {
    const { packageRoot, service } = await fixture()
    await writeFile(
      join(packageRoot, "skills-content", "adrate-shared", "SKILL.md"),
      "tampered content",
      "utf8"
    )
    await expect(service.install()).rejects.toThrow(CliFailure)
  })

  it("rejects when bundled openai.yaml is tampered before validation", async () => {
    const { packageRoot, service } = await fixture()
    await writeFile(
      join(packageRoot, "skills", "adrate-shared", "agents", "openai.yaml"),
      "tampered content\n",
      "utf8"
    )
    await expect(service.install()).rejects.toThrow(CliFailure)
  })

  it("writes the validated source snapshot if package files change later", async () => {
    const { packageRoot, installedRoot } = await fixture()
    const openAiPath = join(
      packageRoot,
      "skills",
      "adrate-shared",
      "agents",
      "openai.yaml"
    )
    const trustedContent = await readFile(openAiPath, "utf8")
    const realCatalog = new SkillCatalog(packageRoot)
    let sourceChanged = false
    const catalog = {
      read: async (name: string) => {
        const result = await realCatalog.read(name)
        if (name === "adrate-shared") {
          sourceChanged = true
          await writeFile(openAiPath, "tampered after validation\n", "utf8")
        }
        return result
      },
    } as SkillCatalog
    const service = new SkillsInstallService(catalog, {
      packageRoot,
      installedSkillsRoot: installedRoot,
    })

    await expect(service.install()).resolves.toMatchObject({ exitCode: 0 })
    expect(sourceChanged).toBe(true)
    await expect(readFile(openAiPath, "utf8")).resolves.toBe(
      "tampered after validation\n"
    )
    await expect(
      readFile(
        join(installedRoot, "adrate-shared", "agents", "openai.yaml"),
        "utf8"
      )
    ).resolves.toBe(trustedContent)
  })

  it("does not copy injected files from source directory", async () => {
    const { packageRoot, installedRoot, service } = await fixture()
    await writeFile(
      join(packageRoot, "skills", "adrate-shared", "injected.md"),
      "malicious payload",
      "utf8"
    )
    await service.install()

    const { access } = await import("node:fs/promises")
    await expect(
      access(join(installedRoot, "adrate-shared", "injected.md"))
    ).rejects.toThrow()
  })

  it("does not overwrite an external file through a hardlink", async () => {
    if (process.platform === "win32") return
    const { installedRoot, service } = await fixture()
    await service.install()

    const externalFile = join(installedRoot, "external-secret.txt")
    const originalContent = "sensitive external data"
    await writeFile(externalFile, originalContent, "utf8")

    const targetFile = join(installedRoot, "adrate-shared", "SKILL.md")
    await rm(targetFile)
    await link(externalFile, targetFile)

    await service.install()

    const externalContent = await readFile(externalFile, "utf8")
    expect(externalContent).toBe(originalContent)

    const installedStat = await lstat(targetFile)
    const externalStat = await lstat(externalFile)
    expect(installedStat.ino).not.toBe(externalStat.ino)
  })

  it("repairs unsafe existing POSIX file and directory modes", async () => {
    if (process.platform === "win32") return
    const { installedRoot, service } = await fixture()
    await service.install()

    const sharedDir = join(installedRoot, "adrate-shared")
    const agentsDir = join(sharedDir, "agents")
    const shellPath = join(sharedDir, "SKILL.md")
    await chmod(installedRoot, 0o777)
    await chmod(sharedDir, 0o777)
    await chmod(agentsDir, 0o777)
    await chmod(shellPath, 0o666)

    const outcome = await service.install()
    expect(outcome.exitCode).toBe(0)
    if (outcome.envelope.ok) {
      const skills = outcome.envelope.data.skills as Array<{
        name: string
        status: string
      }>
      expect(
        skills.find((skill) => skill.name === "adrate-shared")?.status
      ).toBe("updated")
    }

    for (const path of [installedRoot, sharedDir, agentsDir]) {
      expect((await lstat(path)).mode & 0o7777).toBe(0o700)
    }
    expect((await lstat(shellPath)).mode & 0o7777).toBe(0o600)
  })

  it("cleans up temp file when rename fails on a directory target", async () => {
    const { installedRoot, service } = await fixture()
    await service.install()

    const openAiPath = join(
      installedRoot,
      "adrate-shared",
      "agents",
      "openai.yaml"
    )
    await rm(openAiPath)
    await mkdir(openAiPath)

    await expect(service.install()).rejects.toThrow()

    const { readdir: listDir } = await import("node:fs/promises")
    const sharedDir = join(installedRoot, "adrate-shared")
    const files = await listDir(sharedDir, { recursive: true })
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"))
    expect(tmpFiles).toHaveLength(0)
  })
})
