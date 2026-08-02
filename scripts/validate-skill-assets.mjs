import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  EXPECTED_OPENAI_CONFIGS,
  EXPECTED_SKILL_MANIFESTS,
  SKILL_NAMES,
  normalizeSkillText,
  parseOpenAiConfig,
  parseSkillFrontmatter,
  parseSkillManifest,
  sha256SkillText,
  shellMatchesManifest,
} from "./skill-assets-contract.mjs"

const DEFAULT_CLI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MAXIMUM_ASSET_BYTES = 2 * 1024 * 1024
const SMART_QUOTES_PATTERN = /[\u2018\u2019\u201c\u201d]/

function fail(name, reason) {
  throw new Error(`${name}: ${reason}`)
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  )
}

async function readCanonicalFile(root, name, relativePath, options) {
  const path = join(root, relativePath)
  let identity
  try {
    identity = await lstat(path, { bigint: true })
  } catch {
    return fail(name, "required asset is missing or unreadable")
  }
  if (
    identity.isSymbolicLink() ||
    !identity.isFile() ||
    identity.size > BigInt(MAXIMUM_ASSET_BYTES)
  ) {
    return fail(name, "required asset is not a bounded regular file")
  }
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW
  let handle
  try {
    handle = await open(path, flags)
  } catch {
    return fail(name, "required asset is missing or unreadable")
  }
  let buffer = null
  let failure = null
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.size > BigInt(MAXIMUM_ASSET_BYTES) ||
      !sameIdentity(identity, opened)
    ) {
      return fail(name, "required asset changed during validation")
    }
    const bounded = Buffer.allocUnsafe(MAXIMUM_ASSET_BYTES + 1)
    let total = 0
    while (total < bounded.byteLength) {
      const length = bounded.byteLength - total
      options.onReadRequest?.(relativePath, length)
      const result = await handle.read(bounded, total, length, total)
      if (result.bytesRead === 0) break
      total += result.bytesRead
      if (total > MAXIMUM_ASSET_BYTES) {
        return fail(name, "required asset exceeded the validation limit")
      }
    }
    const afterRead = await handle.stat({ bigint: true })
    if (total !== Number(opened.size) || !sameIdentity(opened, afterRead)) {
      return fail(name, "required asset changed during validation")
    }
    buffer = bounded.subarray(0, total)
  } catch (error) {
    failure = error
  }
  try {
    await handle.close()
  } catch (error) {
    failure ??= error
  }
  if (failure || !buffer) {
    return fail(name, "required asset could not be read safely")
  }
  let text
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch {
    return fail(name, "required asset is not valid UTF-8")
  }
  if (text !== normalizeSkillText(text)) {
    return fail(name, "asset must use LF and exactly one trailing newline")
  }
  if (SMART_QUOTES_PATTERN.test(text)) {
    return fail(name, "asset contains a forbidden smart quote")
  }
  return text
}

function expectedOpenAiText(value) {
  return `interface:\n  display_name: ${JSON.stringify(value.displayName)}\n  short_description: ${JSON.stringify(value.shortDescription)}\n  default_prompt: ${JSON.stringify(value.defaultPrompt)}\n`
}

async function validateSkill(root, name, options) {
  const expectedManifest = EXPECTED_SKILL_MANIFESTS[name]
  const expectedOpenAi = EXPECTED_OPENAI_CONFIGS[name]
  if (!expectedManifest || !expectedOpenAi) {
    return fail(name, "compiled trust anchor is incomplete")
  }
  const shellText = await readCanonicalFile(
    root,
    name,
    `skills/${name}/SKILL.md`,
    options
  )
  const contentText = await readCanonicalFile(
    root,
    name,
    `skills-content/${name}/SKILL.md`,
    options
  )
  const manifestText = await readCanonicalFile(
    root,
    name,
    `skills/${name}/skill-manifest.json`,
    options
  )
  const openAiText = await readCanonicalFile(
    root,
    name,
    `skills/${name}/agents/openai.yaml`,
    options
  )
  const shell = parseSkillFrontmatter(shellText)
  const manifest = parseSkillManifest(manifestText, name)
  const openAi = parseOpenAiConfig(openAiText)
  if (!shell || !manifest || !openAi) {
    return fail(name, "asset schema is invalid")
  }
  if (
    manifestText !== `${JSON.stringify(expectedManifest, null, 2)}\n` ||
    JSON.stringify(manifest) !== JSON.stringify(expectedManifest)
  ) {
    return fail(name, "manifest differs from the compiled trust anchor")
  }
  if (
    !shellMatchesManifest({
      shell,
      shellSha256: sha256SkillText(shellText),
      manifest,
    }) ||
    sha256SkillText(contentText) !== manifest.contentSha256
  ) {
    return fail(name, "shell or content digest differs from the manifest")
  }
  if (
    openAiText !== expectedOpenAiText(expectedOpenAi) ||
    JSON.stringify(openAi) !== JSON.stringify(expectedOpenAi) ||
    !openAi.defaultPrompt.includes(`$${name}`)
  ) {
    return fail(name, "openai.yaml differs from the compiled trust anchor")
  }
}

export async function validateSkillAssets(
  root = DEFAULT_CLI_ROOT,
  options = {}
) {
  if (
    SKILL_NAMES.length !== 2 ||
    new Set(SKILL_NAMES).size !== 2 ||
    SKILL_NAMES[0] !== "adrate-shared" ||
    SKILL_NAMES[1] !== "adrate-ads"
  ) {
    throw new Error("The M0 Skill catalog trust anchor is invalid.")
  }
  for (const name of SKILL_NAMES) await validateSkill(root, name, options)
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const requestedRoot = process.argv[2]
    ? resolve(process.argv[2])
    : DEFAULT_CLI_ROOT
  try {
    await validateSkillAssets(requestedRoot)
    process.stdout.write("Skills asset validation PASS.\n")
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure"
    process.stderr.write(`Skills asset validation failed: ${message}\n`)
    process.exitCode = 1
  }
}
