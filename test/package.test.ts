import { execFile } from "node:child_process"
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { collectMirrorSource } from "../scripts/public-mirror.mjs"
import { CLI_VERSION } from "../src/constants.js"

const execFileAsync = promisify(execFile)
const CLI_ROOT = new URL("..", import.meta.url)
const CLI_ROOT_PATH = fileURLToPath(CLI_ROOT)

interface CliPackageMetadata {
  version: string
  files: Array<string>
  scripts: Record<string, string>
  bin: Record<string, string>
  engines: Record<string, string>
  exports: Record<string, never>
}

async function readPackageMetadata(): Promise<CliPackageMetadata> {
  return JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as CliPackageMetadata
}

describe("CLI package contract", () => {
  let packageRoot = ""
  let consumerRoot = ""
  let arbitraryCwd = ""
  let notifierHome = ""
  let tarball = ""

  beforeAll(async () => {
    packageRoot = await mkdtemp(join(tmpdir(), "adrate-cli-package-"))
    const sourceRoot = join(packageRoot, "source")
    await mkdir(sourceRoot)
    for (const file of await collectMirrorSource(CLI_ROOT_PATH)) {
      const destination = join(sourceRoot, file.path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, file.content, { flag: "wx" })
    }
    await symlink(
      await realpath(join(CLI_ROOT_PATH, "node_modules")),
      join(sourceRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await execFileAsync("pnpm", ["run", "build"], {
      cwd: sourceRoot,
    })
    await rm(join(sourceRoot, "node_modules"))
    const npmCache = join(packageRoot, ".npm-cache")
    await mkdir(npmCache)
    await execFileAsync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", packageRoot],
      {
        cwd: sourceRoot,
        env: { ...process.env, npm_config_cache: npmCache },
      }
    )
    tarball = join(packageRoot, `adrate-cli-${CLI_VERSION}.tgz`)
    await execFileAsync("tar", ["-xzf", tarball, "-C", packageRoot])
    consumerRoot = join(packageRoot, "consumer")
    const consumerPackage = join(consumerRoot, "node_modules", "@adrate", "cli")
    await mkdir(dirname(consumerPackage), { recursive: true })
    await cp(join(packageRoot, "package"), consumerPackage, {
      recursive: true,
    })
    await cp(
      fileURLToPath(new URL("./node_modules/undici", CLI_ROOT)),
      join(consumerRoot, "node_modules", "undici"),
      { recursive: true }
    )
    arbitraryCwd = join(consumerRoot, "workspace", "nested")
    await mkdir(arbitraryCwd, { recursive: true })
    notifierHome = join(packageRoot, "notifier-home")
    const adrateRoot = join(notifierHome, ".adrate")
    const cacheRoot = join(adrateRoot, "cache")
    await mkdir(notifierHome, { mode: 0o700 })
    await mkdir(adrateRoot, { mode: 0o700 })
    await mkdir(cacheRoot, { mode: 0o700 })
    await writeFile(
      join(cacheRoot, "update.json"),
      `${JSON.stringify(
        {
          formatVersion: 1,
          latestVersion: "0.2.0",
          checkedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    await chmod(join(cacheRoot, "update.json"), 0o600)
  }, 30_000)

  afterAll(async () => {
    if (packageRoot) await rm(packageRoot, { recursive: true, force: true })
  })

  it("以 package.json 为版本单一真源", async () => {
    const metadata = await readPackageMetadata()
    expect(CLI_VERSION).toBe(metadata.version)
  })

  it("发布清单包含显式确认的真实 Keychain smoke 入口", async () => {
    const metadata = await readPackageMetadata()
    expect(metadata.files).toContain("scripts/keychain-smoke.mjs")
    expect(metadata.scripts["smoke:keychain"]).toBe(
      "node ./scripts/keychain-smoke.mjs"
    )
    await expect(
      access(new URL("../scripts/keychain-smoke.mjs", import.meta.url))
    ).resolves.toBeUndefined()
  })

  it("冻结唯一二进制、Node 22 和五个发布源入口", async () => {
    const metadata = await readPackageMetadata()
    expect(metadata.bin).toEqual({ adrate: "./dist/bin.js" })
    expect(metadata.engines).toEqual({ node: ">=22" })
    expect(metadata.exports).toEqual({})
    expect(metadata.files).toEqual([
      "LICENSE",
      "dist",
      "skills",
      "skills-content",
      "README.md",
      "scripts/keychain-smoke.mjs",
    ])
  })

  it("发布包禁止作为库导入，且二进制仍可执行", async () => {
    for (const specifier of [
      "@adrate/cli",
      "@adrate/cli/scripts/keychain-smoke.mjs",
    ]) {
      await expect(
        execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `await import(${JSON.stringify(specifier)})`,
          ],
          { cwd: consumerRoot }
        )
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("ERR_PACKAGE_PATH_NOT_EXPORTED"),
      })
    }

    const { stderr } = await execFileAsync(
      process.execPath,
      [
        join(consumerRoot, "node_modules", "@adrate", "cli", "dist", "bin.js"),
        "--version",
      ],
      {
        cwd: consumerRoot,
        env: { ...process.env, ADRATE_NO_SKILLS_NOTIFIER: "1" },
      }
    )
    expect(stderr.trim()).toBe(CLI_VERSION)
  })

  it("安装后的二进制可从任意 consumer cwd 解析包内 Skill 正文", async () => {
    const binary = join(
      consumerRoot,
      "node_modules",
      "@adrate",
      "cli",
      "dist",
      "bin.js"
    )
    const environment = {
      ...process.env,
      ADRATE_NO_SKILLS_NOTIFIER: "1",
      ADRATE_NO_UPDATE_NOTIFIER: "1",
    }
    await expect(access(join(arbitraryCwd, "skills"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(
      access(join(arbitraryCwd, "package.json"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    const list = await execFileAsync(
      process.execPath,
      [binary, "skills", "list", "--json"],
      { cwd: arbitraryCwd, env: environment }
    )
    const envelope = JSON.parse(list.stdout) as {
      ok: boolean
      data: { skills: Array<{ name: string }> }
    }
    expect(envelope.ok).toBe(true)
    expect(envelope.data.skills.map((skill) => skill.name)).toStrictEqual([
      "adrate-ads",
      "adrate-shared",
    ])
    expect(list.stderr).toBe("")

    const read = await execFileAsync(
      process.execPath,
      [binary, "skills", "read", "adrate-shared"],
      { cwd: arbitraryCwd, env: environment }
    )
    expect(read.stdout).toContain("# AdRate Shared Safety Contract")
    expect(read.stdout).toMatch(/[^\n]\n$/)
    expect(read.stderr).toBe("")
  })

  it("真实发布包帮助同时展示 CLI 与 Agent Skills 安装命令", async () => {
    const binary = join(
      consumerRoot,
      "node_modules",
      "@adrate",
      "cli",
      "dist",
      "bin.js"
    )
    const result = await execFileAsync(process.execPath, [binary, "--help"], {
      cwd: arbitraryCwd,
      env: {
        ...process.env,
        ADRATE_NO_SKILLS_NOTIFIER: "1",
        ADRATE_NO_UPDATE_NOTIFIER: "1",
      },
    })
    expect(`${result.stdout}${result.stderr}`).toContain(
      "npm install -g @adrate/cli"
    )
    expect(`${result.stdout}${result.stderr}`).toContain(
      "npx skills add AdRate-io/cli -g -y"
    )
  })

  it("真实发布包中 skills/update notice 四种开关组合独立生效", async () => {
    const binary = join(
      consumerRoot,
      "node_modules",
      "@adrate",
      "cli",
      "dist",
      "bin.js"
    )
    const cases = [
      { skillsDisabled: false, updateDisabled: false },
      { skillsDisabled: true, updateDisabled: false },
      { skillsDisabled: false, updateDisabled: true },
      { skillsDisabled: true, updateDisabled: true },
    ]
    for (const current of cases) {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: notifierHome,
      }
      delete environment.ADRATE_NO_SKILLS_NOTIFIER
      delete environment.ADRATE_NO_UPDATE_NOTIFIER
      if (current.skillsDisabled) {
        environment.ADRATE_NO_SKILLS_NOTIFIER = "1"
      }
      if (current.updateDisabled) {
        environment.ADRATE_NO_UPDATE_NOTIFIER = "1"
      }
      const result = await execFileAsync(
        process.execPath,
        [binary, "skills", "list", "--json"],
        { cwd: arbitraryCwd, env: environment }
      )
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean
        meta: { _notice?: Record<string, unknown> }
      }
      expect(envelope.ok).toBe(true)
      const notice = envelope.meta._notice ?? {}
      expect(Object.hasOwn(notice, "skills")).toBe(!current.skillsDisabled)
      expect(Object.hasOwn(notice, "update")).toBe(!current.updateDisabled)
    }
  })

  it("冻结真实 tarball 的 15 项发布边界", async () => {
    const { stdout } = await execFileAsync("tar", ["-tzf", tarball])
    expect(stdout.trim().split("\n").sort()).toEqual(
      [
        "package/LICENSE",
        "package/README.md",
        "package/dist/bin.d.ts",
        "package/dist/bin.js",
        "package/dist/bin.js.map",
        "package/package.json",
        "package/scripts/keychain-smoke.mjs",
        "package/skills/adrate-ads/SKILL.md",
        "package/skills/adrate-ads/agents/openai.yaml",
        "package/skills/adrate-ads/skill-manifest.json",
        "package/skills/adrate-shared/SKILL.md",
        "package/skills/adrate-shared/agents/openai.yaml",
        "package/skills/adrate-shared/skill-manifest.json",
        "package/skills-content/adrate-ads/SKILL.md",
        "package/skills-content/adrate-shared/SKILL.md",
      ].sort()
    )
  })

  it("保留 source map 但不嵌入源码正文", async () => {
    const sourceMap = JSON.parse(
      await readFile(join(packageRoot, "package", "dist", "bin.js.map"), "utf8")
    ) as Record<string, unknown>
    expect(sourceMap).not.toHaveProperty("sourcesContent")
    expect(sourceMap.sources).toBeInstanceOf(Array)
  })

  it("README 如实记录 14 项 tarball 与 Windows 未实机验证边界", async () => {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8"
    )
    for (const entry of [
      "dist/bin.js",
      "dist/bin.js.map",
      "dist/bin.d.ts",
      "package.json",
      "README.md",
      "scripts/keychain-smoke.mjs",
      "skills/adrate-shared/SKILL.md",
      "skills/adrate-shared/skill-manifest.json",
      "skills/adrate-shared/agents/openai.yaml",
      "skills/adrate-ads/SKILL.md",
      "skills/adrate-ads/skill-manifest.json",
      "skills/adrate-ads/agents/openai.yaml",
      "skills-content/adrate-shared/SKILL.md",
      "skills-content/adrate-ads/SKILL.md",
    ]) {
      expect(readme).toContain(entry)
    }
    expect(readme).toContain("不包含 SYSTEM ACE")
    expect(readme).toContain("ACL 路径请求以 Base64 JSON 通过 stdin 输入")
    expect(readme).toContain(
      "PID 则以 UTF-8 十进制文本做 Base64 后通过 stdin 输入"
    )
    expect(readme).toContain("尚未在真实 Windows 主机验证")
  })
})
