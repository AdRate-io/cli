import { execFile } from "node:child_process"
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { validateSkillAssets } from "../scripts/validate-skill-assets.mjs"
import { sha256SkillText } from "../src/skills/skill-contract.js"

const execFileAsync = promisify(execFile)
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url))
const VALIDATOR = join(CLI_ROOT, "scripts", "validate-skill-assets.mjs")
const RESEALER = join(CLI_ROOT, "scripts", "reseal-skill-assets.mjs")
const roots: Array<string> = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adrate-skill-validator-"))
  roots.push(root)
  await cp(join(CLI_ROOT, "skills"), join(root, "skills"), { recursive: true })
  await cp(join(CLI_ROOT, "skills-content"), join(root, "skills-content"), {
    recursive: true,
  })
  return root
}

async function runValidator(root: string) {
  return execFileAsync(process.execPath, [VALIDATOR, root], { cwd: root })
}

async function expectValidatorFailure(root: string) {
  await expect(runValidator(root)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Skills asset validation failed:"),
  })
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("build-time Skills asset validator", () => {
  it("accepts the complete canonical publication assets", async () => {
    const root = await fixture()
    const result = await runValidator(root)
    expect(result.stdout).toBe("Skills asset validation PASS.\n")
    expect(result.stderr).toBe("")
  })

  it("rejects an oversized asset before issuing any unbounded read", async () => {
    const root = await fixture()
    const relativePath = "skills-content/adrate-ads/SKILL.md"
    await writeFile(
      join(root, relativePath),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)
    )
    const requests: Array<{ relativePath: string; length: number }> = []

    await expect(
      validateSkillAssets(root, {
        onReadRequest(path, length) {
          requests.push({ relativePath: path, length })
        },
      })
    ).rejects.toThrow("required asset is not a bounded regular file")
    expect(
      requests.filter((request) => request.relativePath === relativePath)
    ).toStrictEqual([])
    expect(
      requests.every((request) => request.length <= 2 * 1024 * 1024 + 1)
    ).toBe(true)
  })

  it.each([
    [
      "shell",
      async (root: string) => {
        const path = join(root, "skills", "adrate-shared", "SKILL.md")
        await writeFile(path, `${await readFile(path, "utf8")}drift\n`)
      },
    ],
    [
      "content",
      async (root: string) => {
        const path = join(root, "skills-content", "adrate-ads", "SKILL.md")
        await writeFile(path, `${await readFile(path, "utf8")}drift\n`)
      },
    ],
    [
      "manifest",
      async (root: string) => {
        const path = join(
          root,
          "skills",
          "adrate-shared",
          "skill-manifest.json"
        )
        const manifest = JSON.parse(await readFile(path, "utf8")) as {
          description: string
        }
        manifest.description = `${manifest.description} drift`
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
      },
    ],
    [
      "openai.yaml",
      async (root: string) => {
        const path = join(
          root,
          "skills",
          "adrate-shared",
          "agents",
          "openai.yaml"
        )
        await writeFile(path, "invalid\n")
      },
    ],
  ] as const)("rejects %s drift", async (_label, mutate) => {
    const root = await fixture()
    await mutate(root)
    await expectValidatorFailure(root)
  })

  it("accepts valid OpenAI metadata without a compiled prose copy", async () => {
    const root = await fixture()
    const path = join(root, "skills", "adrate-shared", "agents", "openai.yaml")
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "Safe authentication, feedback, recovery, and CLI operation",
        "Updated authentication and CLI operation"
      )
    )
    await expect(validateSkillAssets(root)).resolves.toBeUndefined()
  })

  it("reseals changed author assets deterministically", async () => {
    const root = await fixture()
    const shellPath = join(root, "skills", "adrate-ads", "SKILL.md")
    const contentPath = join(root, "skills-content", "adrate-ads", "SKILL.md")
    const manifestPath = join(
      root,
      "skills",
      "adrate-ads",
      "skill-manifest.json"
    )
    const shell = (await readFile(shellPath, "utf8")).replace(
      'version: "1.5.0"',
      'version: "1.5.1"'
    )
    const content = `${(await readFile(contentPath, "utf8")).trimEnd()}\n\nNew guidance.\n`
    await writeFile(shellPath, shell)
    await writeFile(contentPath, content)

    const firstRun = await execFileAsync(process.execPath, [RESEALER, root])
    expect(firstRun.stdout).toBe("Skills asset manifests resealed.\n")
    await expect(validateSkillAssets(root)).resolves.toBeUndefined()

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string
      shellSha256: string
      contentSha256: string
    }
    expect(manifest.version).toBe("1.5.1")
    expect(manifest.shellSha256).toBe(sha256SkillText(shell))
    expect(manifest.contentSha256).toBe(sha256SkillText(content))
    const firstManifest = await readFile(manifestPath, "utf8")
    await execFileAsync(process.execPath, [RESEALER, root])
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(firstManifest)
  })

  it("blocks the real pnpm build script before tsup when assets drift", async () => {
    const root = await fixture()
    await cp(join(CLI_ROOT, "scripts"), join(root, "scripts"), {
      recursive: true,
    })
    await cp(join(CLI_ROOT, "package.json"), join(root, "package.json"))
    const shellPath = join(root, "skills", "adrate-shared", "SKILL.md")
    await writeFile(shellPath, `${await readFile(shellPath, "utf8")}drift\n`)

    try {
      await execFileAsync("pnpm", ["run", "build"], { cwd: root })
      throw new Error("Expected the real build gate to fail")
    } catch (error) {
      const result = error as {
        code?: unknown
        stdout?: string
        stderr?: string
      }
      expect(result.code).toBe(1)
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
      expect(output).toContain("Skills asset validation failed:")
      expect(output).not.toContain("CLI Building entry")
      expect(output).not.toContain("tsup v")
    }
    await expect(access(join(root, "dist"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
