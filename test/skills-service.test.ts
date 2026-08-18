import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { CLI_VERSION } from "../src/constants.js"
import { CliFailure } from "../src/errors.js"
import { renderOutcome } from "../src/output.js"
import { SkillCatalog } from "../src/skills/skill-catalog.js"
import { sha256SkillText } from "../src/skills/skill-contract.js"
import { SkillsService } from "../src/skills/skills-service.js"
import { BUNDLED_SKILL_MIN_CLI_VERSION } from "./helpers.js"

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url))
const roots: Array<string> = []

async function packageFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adrate-skill-package-"))
  roots.push(root)
  await cp(join(CLI_ROOT, "skills"), join(root, "skills"), { recursive: true })
  await cp(join(CLI_ROOT, "skills-content"), join(root, "skills-content"), {
    recursive: true,
  })
  return root
}

async function expectFailure(
  promise: Promise<unknown>,
  exitCode: 1 | 2,
  code: "LOCAL_STATE_UNSAFE" | "INVALID_REQUEST"
): Promise<CliFailure> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CliFailure)
    const failure = error as CliFailure
    expect(failure.exitCode).toBe(exitCode)
    expect(failure.envelope.ok).toBe(false)
    if (!failure.envelope.ok) expect(failure.envelope.error.code).toBe(code)
    return failure
  }
  throw new Error("Expected SkillsService to reject")
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("SkillsService", () => {
  it("lists only CLI Skills in stable name order with CLI version metadata", async () => {
    const root = await packageFixture()
    const outcome = await new SkillsService(new SkillCatalog(root)).list()

    expect(outcome.exitCode).toBe(0)
    expect(outcome.envelope).toStrictEqual({
      ok: true,
      data: {
        skills: [
          {
            name: "adrate-ads",
            version: "1.6.1",
            minCliVersion: BUNDLED_SKILL_MIN_CLI_VERSION,
            description: expect.any(String),
          },
          {
            name: "adrate-shared",
            version: "1.6.1",
            minCliVersion: BUNDLED_SKILL_MIN_CLI_VERSION,
            description: expect.any(String),
          },
        ],
      },
      meta: {
        cliVersion: CLI_VERSION,
        requestId: expect.stringMatching(/^local_/),
        apiVersion: "v1",
      },
    })
    expect(outcome.humanOutput).toMatchObject({
      stream: "stdout",
      mode: "line",
      value: expect.stringMatching(/^NAME\s+VERSION\s+MIN CLI\s+DESCRIPTION/m),
    })
  })

  it("returns exact read fields and raw human stdout with one trailing newline", async () => {
    const root = await packageFixture()
    const service = new SkillsService(new SkillCatalog(root))
    const outcome = await service.read({ name: "adrate-shared" })
    const expected = await readFile(
      join(root, "skills-content", "adrate-shared", "SKILL.md"),
      "utf8"
    )
    expect(outcome.envelope.ok).toBe(true)
    if (outcome.envelope.ok) {
      expect(outcome.envelope.data).toStrictEqual({
        name: "adrate-shared",
        version: "1.6.1",
        path: "SKILL.md",
        content: expected,
        sha256: sha256SkillText(expected),
      })
      expect(outcome.envelope.meta.cliVersion).toBe(CLI_VERSION)
    }

    let stdout = ""
    let stderr = ""
    renderOutcome(
      outcome,
      { json: false, verbose: false },
      {
        stdout: { write: (value) => ((stdout += String(value)), true) },
        stderr: { write: (value) => ((stderr += String(value)), true) },
      }
    )
    expect(stdout).toBe(expected)
    expect(stdout).toMatch(/[^\n]\n$/)
    expect(stderr).toBe("")
  })

  it("renders list on stdout while JSON still emits exactly one envelope", async () => {
    const root = await packageFixture()
    const outcome = await new SkillsService(new SkillCatalog(root)).list()
    for (const json of [false, true]) {
      let stdout = ""
      let stderr = ""
      renderOutcome(
        outcome,
        { json, verbose: false },
        {
          stdout: { write: (value) => ((stdout += String(value)), true) },
          stderr: { write: (value) => ((stderr += String(value)), true) },
        }
      )
      expect(stderr).toBe("")
      if (json) {
        expect(stdout.trim().split("\n")).toHaveLength(1)
        expect(JSON.parse(stdout)).toStrictEqual(outcome.envelope)
      } else {
        expect(stdout).toContain("adrate-ads")
        expect(stdout).toContain("adrate-shared")
      }
    }
  })

  it("maps unknown names and safe missing paths to usage without path disclosure", async () => {
    const root = await packageFixture()
    const service = new SkillsService(new SkillCatalog(root))
    await expectFailure(
      service.read({ name: "not-installed" }),
      2,
      "INVALID_REQUEST"
    )
    await expectFailure(
      service.read({ name: "adrate-shared", path: "missing.md" }),
      2,
      "INVALID_REQUEST"
    )
    await expectFailure(
      service.read({ name: "adrate-shared", path: "missing/child.md" }),
      2,
      "INVALID_REQUEST"
    )
  })

  it("maps absolute, traversal, Windows, UNC, and symlink escape to local safety", async () => {
    const root = await packageFixture()
    const service = new SkillsService(new SkillCatalog(root))
    const outside = join(root, "outside.md")
    const outsideDirectory = join(root, "outside-directory")
    await writeFile(outside, "outside\n")
    await cp(join(root, "skills-content", "adrate-ads"), outsideDirectory, {
      recursive: true,
    })
    await symlink(
      outside,
      join(root, "skills-content", "adrate-shared", "escape.md")
    )
    await symlink(
      join(root, "missing-target.md"),
      join(root, "skills-content", "adrate-shared", "dangling.md")
    )
    await symlink(
      outsideDirectory,
      join(root, "skills-content", "adrate-shared", "external")
    )
    for (const path of [
      "/etc/passwd",
      "../SKILL.md",
      "C:/Windows/system.ini",
      "\\\\server\\share\\file.md",
      "nested\\file.md",
      "escape.md",
      "dangling.md",
      "external/missing.md",
    ]) {
      const failure = await expectFailure(
        service.read({ name: "adrate-shared", path }),
        1,
        "LOCAL_STATE_UNSAFE"
      )
      expect(JSON.stringify(failure.envelope)).not.toContain(path)
      expect(JSON.stringify(failure.envelope)).not.toContain(root)
    }
  })

  it("accepts a shell and manifest that remain self-consistent", async () => {
    const root = await packageFixture()
    const shellPath = join(root, "skills", "adrate-shared", "SKILL.md")
    const manifestPath = join(
      root,
      "skills",
      "adrate-shared",
      "skill-manifest.json"
    )
    const shell = `${await readFile(shellPath, "utf8")}\nLocal rewrite\n`
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      shellSha256: string
    }
    manifest.shellSha256 = sha256SkillText(shell)
    await writeFile(shellPath, shell)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(
      new SkillsService(new SkillCatalog(root)).list()
    ).resolves.toMatchObject({ exitCode: 0 })
  })

  it("accepts content whose digest is resealed in its manifest", async () => {
    const root = await packageFixture()
    const contentPath = join(root, "skills-content", "adrate-ads", "SKILL.md")
    const manifestPath = join(
      root,
      "skills",
      "adrate-ads",
      "skill-manifest.json"
    )
    const content = `${await readFile(contentPath, "utf8")}\nLocal rewrite\n`
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      contentSha256: string
    }
    manifest.contentSha256 = sha256SkillText(content)
    await writeFile(contentPath, content)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const outcome = await new SkillsService(new SkillCatalog(root)).read({
      name: "adrate-ads",
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.envelope.ok && outcome.envelope.data.content).toContain(
      "Local rewrite"
    )
  })

  it("treats missing default content as bundled corruption but a missing extra file as usage", async () => {
    const root = await packageFixture()
    const service = new SkillsService(new SkillCatalog(root))
    await unlink(join(root, "skills-content", "adrate-shared", "SKILL.md"))

    await expectFailure(
      service.read({ name: "adrate-shared" }),
      1,
      "LOCAL_STATE_UNSAFE"
    )
    await expectFailure(
      service.read({ name: "adrate-shared", path: "references.md" }),
      1,
      "LOCAL_STATE_UNSAFE"
    )
    await expectFailure(
      service.read({ name: "adrate-ads", path: "references.md" }),
      2,
      "INVALID_REQUEST"
    )
  })
})
