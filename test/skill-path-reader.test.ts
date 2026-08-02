import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SkillPathMissingError,
  SkillPathReader,
  SkillPathUnsafeError,
} from "../src/skills/skill-path-reader.js"
import { sha256SkillText } from "../src/skills/skill-contract.js"

const roots: Array<string> = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adrate-skill-path-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("SkillPathReader", () => {
  it("reads a contained regular UTF-8 file and canonicalizes newlines before SHA", async () => {
    const root = await fixture()
    await mkdir(join(root, "references"))
    await writeFile(
      join(root, "references", "guide.md"),
      "first\r\nsecond\r\n\r\n"
    )

    const result = await new SkillPathReader(root).read("references/guide.md")

    expect(result.content).toBe("first\nsecond\n")
    expect(result.sha256).toBe(sha256SkillText("first\nsecond\n"))
    expect(result.size).toBe(Buffer.byteLength(result.content))
  })

  it.each([
    "/etc/passwd",
    "../outside.md",
    "references/../outside.md",
    "references\\guide.md",
    "C:/Windows/system.ini",
    "C:Windows/system.ini",
    "\\\\server\\share\\file.md",
    "//server/share/file.md",
    "./SKILL.md",
    "references//guide.md",
    "bad\0name",
  ])("rejects unsafe path spelling without echoing it: %s", async (path) => {
    const root = await fixture()
    const reader = new SkillPathReader(root)
    await expect(reader.read(path)).rejects.toBeInstanceOf(SkillPathUnsafeError)
    await expect(reader.read(path)).rejects.not.toThrow(path)
  })

  it("keeps final and intermediate ordinary missing paths classified as missing", async () => {
    const root = await fixture()
    await expect(
      new SkillPathReader(root).read("missing.md")
    ).rejects.toBeInstanceOf(SkillPathMissingError)
    await expect(
      new SkillPathReader(root).read("missing/child.md")
    ).rejects.toBeInstanceOf(SkillPathMissingError)
  })

  it("rejects external symlinks identically whether their target exists or is missing", async () => {
    const root = await fixture()
    const outside = await fixture()
    await writeFile(join(outside, "secret.md"), "secret")
    await symlink(join(outside, "secret.md"), join(root, "final.md"))
    await symlink(outside, join(root, "external"))
    await symlink(join(outside, "missing.md"), join(root, "dangling.md"))
    await mkdir(join(root, "nested"))
    await symlink(outside, join(root, "nested", "external"))
    await mkdir(join(root, "directory"))

    const reader = new SkillPathReader(root)
    await expect(reader.read("final.md")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
    await expect(reader.read("external/secret.md")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
    await expect(reader.read("external/missing.md")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
    await expect(reader.read("dangling.md")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
    await expect(
      reader.read("nested/external/missing.md")
    ).rejects.toBeInstanceOf(SkillPathUnsafeError)
    await expect(reader.read("directory")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
  })

  it("allows the configured root itself to be a symlink and fixes its real identity", async () => {
    const base = await fixture()
    const realRoot = join(base, "real")
    const rootAlias = join(base, "alias")
    await mkdir(realRoot)
    await writeFile(join(realRoot, "SKILL.md"), "trusted\n")
    await symlink(realRoot, rootAlias)

    await expect(
      new SkillPathReader(rootAlias).read("SKILL.md")
    ).resolves.toMatchObject({
      content: "trusted\n",
    })
  })

  it("rejects oversized and invalid UTF-8 files", async () => {
    const root = await fixture()
    await writeFile(join(root, "large.md"), "12345")
    await writeFile(join(root, "invalid.md"), Buffer.from([0xc3, 0x28]))

    await expect(
      new SkillPathReader(root, { maximumBytes: 4 }).read("large.md")
    ).rejects.toBeInstanceOf(SkillPathUnsafeError)
    await expect(
      new SkillPathReader(root).read("invalid.md")
    ).rejects.toBeInstanceOf(SkillPathUnsafeError)
  })

  it("validates maximumBytes and accepts exactly the limit but rejects one extra byte", async () => {
    const root = await fixture()
    await writeFile(join(root, "exact.md"), "abc\n")
    await writeFile(join(root, "extra.md"), "abcd\n")
    for (const invalid of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER,
      Infinity,
      NaN,
    ]) {
      expect(
        () => new SkillPathReader(root, { maximumBytes: invalid })
      ).toThrow(RangeError)
    }
    await expect(
      new SkillPathReader(root, { maximumBytes: 4 }).read("exact.md")
    ).resolves.toMatchObject({ content: "abc\n" })
    await expect(
      new SkillPathReader(root, { maximumBytes: 4 }).read("extra.md")
    ).rejects.toBeInstanceOf(SkillPathUnsafeError)
  })

  it("reads at most maximumBytes plus one when a file grows after opened fstat", async () => {
    const root = await fixture()
    const target = join(root, "growth.md")
    await writeFile(target, "abc\n")
    const requests: Array<number> = []
    const reader = new SkillPathReader(root, {
      maximumBytes: 4,
      onOpenedFileStat: async () => {
        await appendFile(target, "x".repeat(10_000))
      },
      onReadRequest: (length) => requests.push(length),
    })

    await expect(reader.read("growth.md")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
    expect(requests).toStrictEqual([5])
  })

  it("classifies deletion after final lstat or realpath as unsafe, never missing", async () => {
    for (const hook of ["onTargetLstat", "onTargetRealpath"] as const) {
      const root = await fixture()
      const target = join(root, "SKILL.md")
      await writeFile(target, "trusted\n")
      const reader = new SkillPathReader(root, {
        [hook]: async () => unlink(target),
      })
      await expect(reader.read("SKILL.md")).rejects.toBeInstanceOf(
        SkillPathUnsafeError
      )
    }
  })

  it("detects replacement of the canonical root while walking a parent", async () => {
    const base = await fixture()
    const root = join(base, "skill")
    await mkdir(join(root, "nested"), { recursive: true })
    await writeFile(join(root, "nested", "guide.md"), "trusted\n")
    const reader = new SkillPathReader(root, {
      onDirectoryLstat: async () => {
        await rename(root, join(base, "old-skill"))
        await mkdir(join(root, "nested"), { recursive: true })
        await writeFile(join(root, "nested", "guide.md"), "replacement\n")
      },
    })

    await expect(reader.read("nested/guide.md")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
  })

  it("detects replacement of an intermediate parent after its lstat", async () => {
    const root = await fixture()
    const parent = join(root, "parent")
    await mkdir(join(parent, "nested"), { recursive: true })
    await writeFile(join(parent, "nested", "guide.md"), "trusted\n")
    const reader = new SkillPathReader(root, {
      onDirectoryLstat: async (depth) => {
        if (depth !== 1) return
        await rename(parent, join(root, "old-parent"))
        await mkdir(join(parent, "nested"), { recursive: true })
        await writeFile(join(parent, "nested", "guide.md"), "replacement\n")
      },
    })

    await expect(reader.read("parent/nested/guide.md")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
  })

  it("detects a path replacement after open instead of returning raced content", async () => {
    const root = await fixture()
    const target = join(root, "SKILL.md")
    await writeFile(target, "trusted\n")
    const reader = new SkillPathReader(root, {
      onFileOpened: async () => {
        await rename(target, join(root, "old.md"))
        await writeFile(target, "replacement\n")
      },
    })

    await expect(reader.read("SKILL.md")).rejects.toBeInstanceOf(
      SkillPathUnsafeError
    )
  })
})
