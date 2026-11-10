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
import type { SkillsRootSpec } from "../src/skills/skills-roots.js"

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
    installedSkillsRoots: [{ path: installedRoot }],
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
        expect(skill.version).toBe("1.8.0")
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
      'version: "1.8.0"',
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
      installedSkillsRoots: [{ path: symlinkTarget }],
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
      installedSkillsRoots: [{ path: installedRoot }],
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

  it("keeps version files old when a write fails mid-install (manifest is written last)", async () => {
    const { installedRoot, service } = await fixture()
    await service.install()
    const skillDir = join(installedRoot, "adrate-shared")
    const shellPath = join(skillDir, "SKILL.md")
    const manifestPath = join(skillDir, "skill-manifest.json")
    // 模拟已安装旧版本
    const shell = (await readFile(shellPath, "utf8")).replace(
      'version: "1.8.0"',
      'version: "0.9.0"'
    )
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string
      shellSha256: string
    }
    manifest.version = "0.9.0"
    manifest.shellSha256 = sha256SkillText(shell)
    await writeFile(shellPath, shell)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    // openai.yaml 位置换成目录 → 该文件写入失败
    const openAiPath = join(skillDir, "agents", "openai.yaml")
    await rm(openAiPath)
    await mkdir(openAiPath)

    await expect(service.install()).rejects.toThrow()

    // 版本文件未被半途更新：状态仍判 outdated，下次命令会继续升级
    await expect(readFile(shellPath, "utf8")).resolves.toContain('version: "0.9.0"')
    const after = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string }
    expect(after.version).toBe("0.9.0")
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

  describe("multiple install roots (~/.agents/skills + ~/.claude/skills)", () => {
    async function multiRootFixture() {
      const { packageRoot, installedRoot: agentsRoot } = await fixture()
      const home = join(agentsRoot, "..", "home")
      await mkdir(home, { mode: 0o755 })
      if (process.platform !== "win32") await chmod(home, 0o755)
      const claudeRoot = join(home, ".claude", "skills")
      const service = new SkillsInstallService(new SkillCatalog(packageRoot), {
        packageRoot,
        installedSkillsRoots: [{ path: agentsRoot }, { path: claudeRoot }],
      })
      const serviceFor = (specs: Array<SkillsRootSpec>) =>
        new SkillsInstallService(new SkillCatalog(packageRoot), {
          packageRoot,
          installedSkillsRoots: specs,
        })
      return { home, agentsRoot, claudeRoot, service, serviceFor }
    }

    async function downgrade(skillDir: string, version: string) {
      const shellPath = join(skillDir, "SKILL.md")
      const manifestPath = join(skillDir, "skill-manifest.json")
      const shell = (await readFile(shellPath, "utf8")).replace(
        /version: "[^"]+"/,
        `version: "${version}"`
      )
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        version: string
        shellSha256: string
      }
      manifest.version = version
      manifest.shellSha256 = sha256SkillText(shell)
      await writeFile(shellPath, shell)
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }

    async function captureFailure(promise: Promise<unknown>) {
      try {
        await promise
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailure)
        return error as CliFailure
      }
      throw new Error("expected install to fail")
    }

    it("keeps installing other roots when one root is a symlink, then reports per-root outcome", async () => {
      const { home, agentsRoot, claudeRoot, service } = await multiRootFixture()
      const realClaudeSkills = join(home, "dotfiles-skills")
      await mkdir(realClaudeSkills)
      await mkdir(join(home, ".claude"))
      await symlink(realClaudeSkills, claudeRoot)

      const failure = await captureFailure(service.install())

      expect(failure.exitCode).toBe(1)
      expect(failure.message).toContain(`${agentsRoot}: Installed:`)
      expect(failure.message).toContain(`${claudeRoot}: FAILED`)
      const envelope = failure.envelope as unknown as {
        ok: false
        error: { details: { targets: Array<{ root: string; error: string | null }> } }
      }
      expect(envelope.error.details.targets).toMatchObject([
        { root: agentsRoot, error: null },
        { root: claudeRoot },
      ])
      expect(envelope.error.details.targets[1]!.error).toMatch(/symbolic link/)
      for (const name of ["adrate-shared", "adrate-ads"]) {
        expect(
          (await lstat(join(agentsRoot, name, "skill-manifest.json"))).isFile()
        ).toBe(true)
      }
      await expect(lstat(join(realClaudeSkills, "adrate-ads"))).rejects.toThrow()
    })

    it("still installs the second root when the first root is unusable, and a rerun converges", async () => {
      const { home, agentsRoot, claudeRoot, service } = await multiRootFixture()
      await mkdir(join(agentsRoot, ".."), { recursive: true })
      await writeFile(agentsRoot, "not a directory")

      const failure = await captureFailure(service.install())
      expect(failure.message).toContain(`${agentsRoot}: FAILED`)
      expect(
        (await lstat(join(claudeRoot, "adrate-ads", "SKILL.md"))).isFile()
      ).toBe(true)

      await rm(agentsRoot)
      const outcome = await service.install()
      expect(outcome.exitCode).toBe(0)
      if (!outcome.envelope.ok) throw new Error("expected success")
      const targets = (
        outcome.envelope.data as {
          targets: Array<{ root: string; skills: Array<{ status: string }> }>
        }
      ).targets
      expect(targets.map((t) => t.skills.map((x) => x.status))).toEqual([
        ["installed", "installed"],
        ["unchanged", "unchanged"],
      ])
      expect(home).toBeTruthy()
    })

    it("skips a client root whose client directory does not exist, and picks it up once it does", async () => {
      const { home, agentsRoot, claudeRoot, serviceFor } =
        await multiRootFixture()
      const service = serviceFor([
        { path: agentsRoot },
        { path: claudeRoot, activeWhenDirExists: join(home, ".claude") },
      ])

      const first = await service.install()
      if (!first.envelope.ok) throw new Error("expected success")
      expect(
        (first.envelope.data as { targets: Array<{ root: string }> }).targets.map(
          (t) => t.root
        )
      ).toEqual([agentsRoot])
      await expect(lstat(join(home, ".claude"))).rejects.toThrow()

      await mkdir(join(home, ".claude"))
      await service.install()
      expect(
        (await lstat(join(claudeRoot, "adrate-shared", "SKILL.md"))).isFile()
      ).toBe(true)
    })

    it("auto-upgrade isolates a broken Skill dir in one root from the other root", async () => {
      if (process.platform === "win32") return
      const { home, agentsRoot, claudeRoot, service } = await multiRootFixture()
      await mkdir(join(home, ".claude"))
      await service.install()
      // agents 根下的 adrate-ads 被换成软链（checkExisting 会抛错）
      const elsewhere = join(home, "elsewhere")
      await mkdir(elsewhere)
      await rm(join(agentsRoot, "adrate-ads"), { recursive: true })
      await symlink(elsewhere, join(agentsRoot, "adrate-ads"))
      await downgrade(join(claudeRoot, "adrate-ads"), "0.9.0")

      await service.upgradeInstalled(["adrate-ads"])

      const shell = await readFile(join(claudeRoot, "adrate-ads", "SKILL.md"), "utf8")
      expect(shell).not.toContain('version: "0.9.0"')
    })

    it("installs both Skills into every root and reports per-root targets", async () => {
      const { agentsRoot, claudeRoot, service } = await multiRootFixture()
      const outcome = await service.install()

      expect(outcome.exitCode).toBe(0)
      for (const root of [agentsRoot, claudeRoot]) {
        for (const name of ["adrate-shared", "adrate-ads"]) {
          expect(
            (await lstat(join(root, name, "skill-manifest.json"))).isFile()
          ).toBe(true)
        }
      }
      if (!outcome.envelope.ok) throw new Error("expected success")
      const data = outcome.envelope.data as {
        skills: Array<{ name: string; status: string }>
        targets: Array<{ root: string; skills: Array<{ status: string }> }>
      }
      expect(data.skills.map((s) => s.name)).toEqual([
        "adrate-shared",
        "adrate-ads",
      ])
      expect(data.targets.map((t) => t.root)).toEqual([agentsRoot, claudeRoot])
    })

    it("fills a missing root while the other is unchanged, and merges status per Skill", async () => {
      const { agentsRoot, claudeRoot, service } = await multiRootFixture()
      await new SkillsInstallService(
        new SkillCatalog(join(agentsRoot, "..", "package")),
        {
          packageRoot: join(agentsRoot, "..", "package"),
          installedSkillsRoots: [{ path: agentsRoot }],
        }
      ).install()

      const outcome = await service.install()
      if (!outcome.envelope.ok) throw new Error("expected success")
      const data = outcome.envelope.data as {
        skills: Array<{ status: string }>
        targets: Array<{ root: string; skills: Array<{ status: string }> }>
      }
      expect(data.targets[0]!.skills.map((s) => s.status)).toEqual([
        "unchanged",
        "unchanged",
      ])
      expect(data.targets[1]!.skills.map((s) => s.status)).toEqual([
        "installed",
        "installed",
      ])
      expect(data.skills.map((s) => s.status)).toEqual([
        "installed",
        "installed",
      ])
      expect(outcome.humanOutput?.value).toContain(claudeRoot)
    })

    it("never tightens permissions of pre-existing ancestors like $HOME", async () => {
      if (process.platform === "win32") return
      const { home, claudeRoot, service } = await multiRootFixture()
      await service.install()

      expect((await lstat(home)).mode & 0o7777).toBe(0o755)
      expect((await lstat(join(home, ".claude"))).mode & 0o7777).toBe(0o700)
      expect((await lstat(claudeRoot)).mode & 0o7777).toBe(0o700)
    })

    it("auto-upgrade only touches roots where the Skill already exists", async () => {
      const { claudeRoot, service } = await multiRootFixture()
      await service.upgradeInstalled(["adrate-shared", "adrate-ads"])
      await expect(lstat(join(claudeRoot, ".."))).rejects.toThrow()
    })
  })
})
