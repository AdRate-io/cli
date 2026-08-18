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
import {
  BUNDLED_SKILL_INSTALL_COMMAND,
  BUNDLED_SKILL_MIN_CLI_VERSION,
} from "./helpers.js"

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

function sectionBody(text: string, heading: string): string {
  const marker = `## ${heading}\n\n`
  const start = text.indexOf(marker)
  if (start < 0) throw new Error(`Missing section: ${heading}`)
  const bodyStart = start + marker.length
  const next = text.indexOf("\n## ", bodyStart)
  return text.slice(bodyStart, next < 0 ? text.length : next)
}

function replaceOnce(text: string, before: string, after: string): string {
  if (!text.includes(before))
    throw new Error(`Missing mutation target: ${before}`)
  return text.replace(before, after)
}

function swapOnce(text: string, first: string, second: string): string {
  const marker = "__ADRATE_SKILL_CONTRACT_SWAP__"
  if (
    text.includes(marker) ||
    !text.includes(first) ||
    !text.includes(second)
  ) {
    throw new Error("Cannot swap Skill contract values")
  }
  return text
    .replace(first, marker)
    .replace(second, first)
    .replace(marker, second)
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
      expect(manifest?.version).toBe("1.6.0")
      expect(manifest?.minCliVersion).toBe(BUNDLED_SKILL_MIN_CLI_VERSION)
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
      // 壳正文的升级指引必须与 frontmatter 的 minCliVersion 同步，避免两处漂移。
      // 断言整句而非单独的版本号：版本号在 frontmatter 里也出现，
      // 单独 toContain(版本号) 会被 frontmatter 命中而对正文漂移恒绿。
      expect(shell).toContain(
        "reports a version older than " +
          `\`${BUNDLED_SKILL_MIN_CLI_VERSION}\`, ` +
          `run \`${BUNDLED_SKILL_INSTALL_COMMAND}\``
      )
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
          shell.replace('version: "1.6.0"', `version: ${replacement}`)
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

  it("contains all fifteen shared safety contracts and the explicit CLI boundary", async () => {
    const shared = await asset("skills-content", "adrate-shared")
    for (const heading of Array.from(
      { length: 15 },
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
      "insufficient success evidence exits 5",
      "operationUnitsCharged",
      "Never call it automatically after CLI errors",
      "same category, the exact same message, and that same key",
      "Never concatenate free text into a shell command string",
      "Authorization/Cookie values",
      "does not attach hostname, cwd, paths, shell history",
      "cannot prove that a message is safe",
      "Do not use arbitrary base URLs",
      "Device Token delivery",
      "Logout revoke",
      "either one desired Status or one Budget or ROAS mode and input value",
      "Campaign Status, Budget, or ROAS: recover with the original idempotency key",
      "A Campaign Status, Budget, or ROAS POST may return HTTP 202 only for a non-final Command",
      "Ads Campaign list/report commands and Rules list commands return one page",
      "GMV Max Campaign lists are bounded server-side aggregations",
      "inspect `truncated` and `warning`",
      "Receipt-backed Rule writes do not create a local pending journal",
      "`commands get`, `commands pending`, and `commands resume` do not apply to Rule writes",
      "Campaign Copy preview, submit, and task reads",
      "Ads and GMV Max Rule create/update/enable/disable/delete and dry run",
    ]) {
      expect(shared).toContain(required)
    }
    expect(shared).not.toContain("batch writes, rules, budget or bid changes")
  })

  it("separates Command recovery from Rule receipt replay and freezes unit semantics", async () => {
    const shared = await asset("skills-content", "adrate-shared")
    for (const required of [
      "`rule-create-*`",
      "`rule-update-*`",
      "`rule-enable-*`",
      "`rule-disable-*`",
      "`rule-delete-*`",
      "Rule dry run has no key",
      "confirmed non-retryable rejection that proves no mutation ran",
      "resolve the stated business constraint, then retry with a new key",
      "replay the exact request with the original key",
      "`duplicate: true` is the original receipt",
      "Rule writes use the `public_write` per-minute window",
      "Supported Ads Rule writes charge 0 daily TikTok operation units",
      "A GMV Max full-store create or target-changing update may charge a conditional unit",
      "other supported Rule writes charge 0 daily units",
      "`rules.write` capability therefore reports `operationUnits=1`",
      "`rules.dryrun` capability reports `operationUnits=2`",
      "`operationUnitsCharged=0` is neither success evidence",
      "writes-per-minute limit",
      "Rule disable and delete remain available",
      "create, update, and enable do not",
    ]) {
      expect(shared).toContain(required)
    }
  })

  it("freezes both Campaign conversion-rate meanings and the remaining CLI ads exclusions", async () => {
    const ads = await asset("skills-content", "adrate-ads")
    expect(ads).toContain("`conversionRate` is the click-based conversion rate")
    expect(ads).toContain(
      "`conversionRateV2` is the impression-based conversion rate"
    )
    expect(ads).toContain("Never mix the two rates")

    const assertExclusions = (text: string) => {
      const exclusions = sectionBody(text, "CLI exclusions")
      for (const exclusion of [
        "standalone Campaign creation",
        "Campaign deletion",
        "batch operations",
        "bid changes",
        "independent Adgroup writes",
        "independent Ad writes",
        "Adgroup Copy",
        "Campaign Copy task cancellation",
      ]) {
        expect(exclusions).toContain(exclusion)
      }
      expect(exclusions).not.toContain("budget changes")
      expect(exclusions).not.toContain("budget adjustments")
      expect(exclusions).not.toContain("does not support DELETE")
      expect(exclusions).not.toContain("Rules writes")
      expect(exclusions).not.toContain("GMV Max writes")
      expect(exclusions).not.toContain("or Copy.")
      expect(exclusions).not.toContain("or Campaign Copy.")
    }

    assertExclusions(ads)
    for (const mutation of [
      replaceOnce(ads, "Adgroup Copy", "Adgroup cloning"),
      replaceOnce(
        ads,
        "Campaign Copy task cancellation",
        "Campaign Copy task pausing"
      ),
    ]) {
      expect(() => assertExclusions(mutation)).toThrow()
    }
  })

  it("locks the Campaign Copy workflow and rejects contract mutations", async () => {
    const ads = await asset("skills-content", "adrate-ads")
    const copy = sectionBody(ads, "Copy Campaigns through an asynchronous task")
    const required = [
      "The server defaults `options.operationStatus` to `DISABLE`",
      "Set it to `ENABLE` only after the Owner explicitly requests that outcome",
      "adrate ads copy preview --file copy.json --json",
      "Remove each Campaign reported in `unsupported` or with `perCampaign[].oversized=true`",
      "Submit the same reviewed file",
      "do not guarantee submit acceptance or Worker success",
      "adrate ads copy submit --file copy.json --idempotency-key copy-20260808-1 --json",
      "Exit 0 means only that the Copy task was accepted, not completed",
      "There is no `--wait` mode",
      "every 30 seconds for at most 10 minutes",
      "adrate ads copy tasks get --task-id 42 --json",
      "report that it remains in progress",
      "For `partial`, report every target item",
      "`targetAdvId`, item `status`, `error`, and `resultData`",
      "include each Campaign and Adgroup result and warning",
      "adrate ads copy tasks --status partial --page 1 --page-size 20 --json",
      "never add a `list` subcommand",
      "replay the original file unchanged with the original idempotency key",
      "`INVALID_REQUEST`, `DAILY_QUOTA_EXCEEDED`, or `PLAN_LIMIT_EXCEEDED`",
      "proves that no Copy task was accepted",
      "submit the corrected file with a new key",
      "`commands get`, `commands pending`, and `commands resume` do not recover Copy submit",
    ]
    const orderedCommands = [
      "adrate ads copy preview --file copy.json --json",
      "adrate ads copy submit --file copy.json --idempotency-key copy-20260808-1 --json",
      "adrate ads copy tasks get --task-id 42 --json",
    ] as const
    const assertContract = (section: string) => {
      for (const value of required) expect(section).toContain(value)
      expect(section).not.toContain("adrate ads copy tasks list")
      let previous = -1
      for (const command of orderedCommands) {
        const current = section.indexOf(command)
        expect(current).toBeGreaterThan(previous)
        previous = current
      }
    }

    assertContract(copy)
    for (const mutation of [
      swapOnce(copy, orderedCommands[0], orderedCommands[1]),
      replaceOnce(
        copy,
        "do not guarantee submit acceptance or Worker success",
        "guarantee submit acceptance and Worker success"
      ),
      replaceOnce(
        copy,
        "Exit 0 means only that the Copy task was accepted, not completed",
        "Exit 0 means the Copy task completed"
      ),
      replaceOnce(copy, "There is no `--wait` mode", "Use `--wait` mode"),
      replaceOnce(
        copy,
        "every 30 seconds for at most 10 minutes",
        "continuously without an elapsed-time limit"
      ),
      replaceOnce(
        copy,
        "`targetAdvId`, item `status`, `error`, and `resultData`",
        "the aggregate counters"
      ),
      replaceOnce(
        copy,
        "defaults `options.operationStatus` to `DISABLE`",
        "defaults `options.operationStatus` to `ENABLE`"
      ),
      replaceOnce(
        copy,
        "adrate ads copy tasks --status partial",
        "adrate ads copy tasks list --status partial"
      ),
      replaceOnce(
        copy,
        "replay the original file unchanged with the original idempotency key",
        "retry a changed file with a new idempotency key"
      ),
      replaceOnce(
        copy,
        "`INVALID_REQUEST`, `DAILY_QUOTA_EXCEEDED`, or `PLAN_LIMIT_EXCEEDED`",
        "`INVALID_REQUEST` or `DAILY_QUOTA_EXCEEDED`"
      ),
      replaceOnce(
        copy,
        "`commands get`, `commands pending`, and `commands resume` do not recover Copy submit",
        "`commands get` recovers Copy submit"
      ),
    ]) {
      expect(() => assertContract(mutation)).toThrow()
    }

    expect(helpText("ads campaigns status")).toContain(
      "Campaign Copy is available under"
    )
  })

  it("locks Campaign Copy receipt recovery inside shared sections 6 and 7", async () => {
    const shared = await asset("skills-content", "adrate-shared")
    const section6 = sectionBody(
      shared,
      "6. Use one idempotency key for one immutable write"
    )
    const section7 = sectionBody(
      shared,
      "7. Interpret exit 5 by operation type"
    )
    const assertRecovery = (replay: string, outcome: string) => {
      for (const required of [
        "Receipt-backed Campaign Copy submit also has no Command pending journal",
        "replay the exact original file body with the original key",
        "`INVALID_REQUEST`, `DAILY_QUOTA_EXCEEDED`, or `PLAN_LIMIT_EXCEEDED`",
        "submit the corrected body with a new key",
        "`commands get`, `commands pending`, and `commands resume` do not apply to Campaign Copy submit",
      ]) {
        expect(replay).toContain(required)
      }
      expect(outcome).toContain(
        "Campaign Copy submit: replay the exact original file with the original receipt key"
      )
      expect(outcome).toContain(
        "Do not query or resume a Command and do not switch keys"
      )
    }

    assertRecovery(section6, section7)
    const mutations: Array<readonly [string, string]> = [
      [
        replaceOnce(
          section6,
          "replay the exact original file body with the original key",
          "retry a changed body with a new key"
        ),
        section7,
      ],
      [
        replaceOnce(
          section6,
          "`commands get`, `commands pending`, and `commands resume` do not apply to Campaign Copy submit",
          "`commands get` applies to Campaign Copy submit"
        ),
        section7,
      ],
      [
        replaceOnce(
          section6,
          "`INVALID_REQUEST`, `DAILY_QUOTA_EXCEEDED`, or `PLAN_LIMIT_EXCEEDED`",
          "`INVALID_REQUEST` or `DAILY_QUOTA_EXCEEDED`"
        ),
        section7,
      ],
      [
        section6,
        replaceOnce(
          section7,
          "replay the exact original file with the original receipt key",
          "retry with a new key"
        ),
      ],
    ]
    for (const [replay, outcome] of mutations) {
      expect(() => assertRecovery(replay, outcome)).toThrow()
    }
  })

  it("locks the GMV Max discovery, write, Rule, and deletion contracts", async () => {
    const ads = await asset("skills-content", "adrate-ads")
    const orderedDiscovery = [
      "adrate gmvmax stores --adv-id 70001",
      "adrate gmvmax campaigns list --adv-id 70001 --store-id shop-1 --promotion-type product",
    ]
    let previous = -1
    for (const step of orderedDiscovery) {
      const current = ads.indexOf(step)
      expect(current).toBeGreaterThan(previous)
      previous = current
    }
    for (const required of [
      "Promotion type `product` maps exactly to rule type `gmv_max_product`",
      "promotion type `live` maps exactly to `gmv_max_live`",
      "Budget accepts at most two decimal places and ROAS at most one decimal place",
      "gmvmax campaigns get` when the task needs fresh details",
      "never treat a partial result as complete",
      "Every GMV Max Campaign status, budget, or ROAS write requires an explicit `--auth-id`",
      "All three writes are Command-backed",
      "Never retry the same intent with a fresh key",
      "GMV Max Campaign deletion is not available through the CLI",
      "confirmed Rule deletion is supported",
      "Include `campaignId` for a Campaign-bound target, or omit it for a full-store target",
      "Do not send timezone",
      "GMV Max Rule budget action values accept at most two decimal places",
      "ROAS action values at most one",
      "dry run always evaluates one Campaign",
      "adrate rules dryrun --rule-id 43 --adv-id 70001 --shop-id shop-1 --campaign-id 80001 --json",
      "They cannot recover a Rule write",
    ]) {
      expect(ads).toContain(required)
    }
  })

  it("locks the Ads Rule review, confirmation, frozen, and replay workflow", async () => {
    const ads = await asset("skills-content", "adrate-ads")
    const orderedSteps = [
      "adrate rules options --rule-type ads --scope campaign --json",
      "adrate rules create --file rule.json",
      "adrate rules dryrun --rule-id 42 --adv-id 70001 --json",
      "adrate rules enable --rule-id 42",
    ]
    let previous = -1
    for (const step of orderedSteps) {
      const current = ads.indexOf(step)
      expect(current).toBeGreaterThan(previous)
      previous = current
    }
    for (const required of [
      "Creation always returns `enabled=false`",
      "Enable only after the Owner explicitly confirms the shown result",
      "apply only the requested patch",
      "Do not change its enabled state unless the Owner asked",
      "Delete a rule only after the Owner explicitly confirms deletion",
      "`rules disable` and `rules delete` remain available",
      "`rules create`, `rules update`, and `rules enable` are unavailable",
      '`availabilityMode: "mixed"`',
      "operation's own `available`, `unavailableReason`, and `idempotencyRequired`",
      "confirmed non-retryable rejection that proves no mutation ran",
      "resolve the stated business constraint, then retry with a new key",
      "replay the exact same request with the original key",
      "`duplicate: true` means the server returned the original receipt",
      "They cannot recover a Rule write",
    ]) {
      expect(ads).toContain(required)
    }
  })

  it("locks the upgraded Smart+ material Rule identity and safety workflow", async () => {
    const ads = await asset("skills-content", "adrate-ads")
    for (const required of [
      "### Manage upgraded Smart+ creative materials",
      "internal Rule scope for the UI's \"创意素材\"",
      "adrate rules options --rule-type ads --scope material --json",
      "Treat `scopeId` and `targetId` as `smart_plus_creative_id`",
      "which is the Integrated `ad_id`",
      "Keep `smartPlusAdId` and `adMaterialId` distinct",
      "when `materialMapping` is returned",
      "Use only `ENABLE` or `DISABLE`",
      "Use `day` or `lifetime` time windows and never `hour`",
      "Omit `targetStatuses` entirely",
      "Dry-run with the Ads account parameter `--adv-id` only",
      "Do not pass GMV Max `--shop-id` or `--campaign-id` context",
      "never assume an incomplete target/page/budget result is a valid partial evaluation",
      "existing preview, confirmation, idempotency-key, and receipt-replay safety chain",
    ]) {
      expect(ads).toContain(required)
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
