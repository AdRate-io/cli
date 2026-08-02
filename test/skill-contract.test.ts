import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { helpText, parseArguments } from "../src/parser.js"
import {
  compareSemver,
  normalizeSkillText,
  parseSkillFrontmatter,
  parseSkillManifest,
  sha256SkillText,
  shellMatchesManifest,
} from "../src/skills/skill-contract.js"

const CLI_ROOT = new URL("..", import.meta.url)
const NAMES = ["adrate-shared", "adrate-ads"] as const

async function asset(kind: "skills" | "skills-content", name: string) {
  return readFile(new URL(`${kind}/${name}/SKILL.md`, CLI_ROOT), "utf8")
}

function commandExamples(text: string): Array<string> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("adrate "))
}

describe("Agent Skill publication contracts", () => {
  it.each(NAMES)(
    "validates %s shell, manifest, and normalized digests",
    async (name) => {
      const shell = await asset("skills", name)
      const content = await asset("skills-content", name)
      const manifestText = await readFile(
        new URL(`skills/${name}/skill-manifest.json`, CLI_ROOT),
        "utf8"
      )
      const frontmatter = parseSkillFrontmatter(shell)
      const manifest = parseSkillManifest(manifestText, name)

      expect(frontmatter).not.toBeNull()
      expect(manifest).not.toBeNull()
      expect(normalizeSkillText(shell)).toBe(shell)
      expect(normalizeSkillText(content)).toBe(content)
      expect(manifest?.version).toBe("1.0.0")
      expect(manifest?.minCliVersion).toBe("0.1.0")
      expect(manifest?.shellSha256).toBe(sha256SkillText(shell))
      expect(manifest?.contentSha256).toBe(sha256SkillText(content))
      expect(
        frontmatter && manifest
          ? shellMatchesManifest({
              shell: frontmatter,
              shellSha256: sha256SkillText(shell),
              manifest,
            })
          : false
      ).toBe(true)
      expect(shell).toContain("adrate --version")
      expect(shell).toContain("npm install -g @adrate/cli")
      expect(shell).toContain(`adrate skills read ${name}`)
    }
  )

  it("accepts only strict SemVer and compares prereleases without number loss", () => {
    expect(compareSemver("1.0.0-alpha.9", "1.0.0-alpha.10")).toBe(-1)
    expect(compareSemver("999999999999999999999.0.0", "2.0.0")).toBe(1)
    expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0)
    for (const invalid of ["1", "1.0", "01.0.0", "1.0.0-01", "v1.0.0"]) {
      expect(() => compareSemver(invalid, "1.0.0")).toThrow()
    }
  })

  it("rejects YAML implicit scalars and every non-canonical frontmatter shape", async () => {
    const shell = await asset("skills", "adrate-shared")
    for (const replacement of [
      "true",
      "false",
      "null",
      "~",
      "100",
      "1.5",
      "2026-08-01",
      "'1.0.0'",
    ]) {
      expect(
        parseSkillFrontmatter(
          shell.replace('version: "1.0.0"', `version: ${replacement}`)
        )
      ).toBeNull()
    }
    expect(
      parseSkillFrontmatter(
        shell.replace("metadata:\n", 'extra: "x"\nmetadata:\n')
      )
    ).toBeNull()
    expect(
      parseSkillFrontmatter(
        shell.replace(
          '  cliHelp: "adrate skills read adrate-shared"',
          '    cliHelp: "adrate skills read adrate-shared"'
        )
      )
    ).toBeNull()
  })

  it("contains all fourteen shared safety contracts and the explicit M0 boundary", async () => {
    const shared = await asset("skills-content", "adrate-shared")
    for (const heading of Array.from(
      { length: 14 },
      (_, index) => `## ${index + 1}.`
    )) {
      expect(shared).toContain(heading)
    }
    for (const required of [
      "ok === true",
      "code === 0",
      "DAILY_QUOTA_EXCEEDED",
      "isFinal=false",
      "unknown` with `isFinal=true",
      "meta.pagination",
      "pending write record is bound to the credential",
      "operationUnitsCharged=null",
      "does not support arbitrary base URLs",
      "Device Token delivery",
      "Logout revoke",
    ]) {
      expect(shared).toContain(required)
    }
  })

  it("freezes both Campaign conversion-rate meanings and every M0 ads exclusion", async () => {
    const ads = await asset("skills-content", "adrate-ads")
    expect(ads).toContain("`conversionRate` is the click-based conversion rate")
    expect(ads).toContain(
      "`conversionRateV2` is the impression-based conversion rate"
    )
    expect(ads).toContain("Never mix the two rates")
    for (const exclusion of [
      "DELETE",
      "batch operations",
      "budget changes",
      "bid changes",
      "creation",
      "Adgroup writes",
      "Ad writes",
      "Copy",
      "GMV Max",
    ]) {
      expect(ads).toContain(exclusion)
    }
  })

  it("keeps every documented adrate command parseable and represented by CLI help", async () => {
    const texts = await Promise.all(
      NAMES.flatMap((name) => [
        asset("skills", name),
        asset("skills-content", name),
      ])
    )
    const commands = [...new Set(texts.flatMap(commandExamples))]
    expect(commands.length).toBeGreaterThan(10)
    for (const command of commands) {
      const argv = command.split(/\s+/).slice(1)
      const invocation = parseArguments(argv)
      const documented = helpText(invocation.helpTopic)
      if (invocation.version) {
        expect(documented).toContain("--version")
      } else {
        expect(invocation.command).not.toBeNull()
        expect(documented).toContain(`adrate ${invocation.helpTopic}`)
      }
    }
  })

  it("contains no smart quote characters in published assets", async () => {
    const texts = await Promise.all(
      NAMES.flatMap(async (name) => [
        await asset("skills", name),
        await asset("skills-content", name),
        await readFile(
          new URL(`skills/${name}/skill-manifest.json`, CLI_ROOT),
          "utf8"
        ),
        await readFile(
          new URL(`skills/${name}/agents/openai.yaml`, CLI_ROOT),
          "utf8"
        ),
      ])
    )
    expect(texts.join("\n")).not.toMatch(/[\u2018\u2019\u201c\u201d]/)
  })

  it.each(NAMES)(
    "keeps generated openai.yaml prompt explicit for $%s",
    async (name) => {
      const yaml = await readFile(
        new URL(`skills/${name}/agents/openai.yaml`, CLI_ROOT),
        "utf8"
      )
      expect(yaml).toContain("interface:\n")
      expect(yaml).toContain(`default_prompt: "Use $${name} `)
      expect(yaml).not.toContain("TODO")
    }
  )
})
