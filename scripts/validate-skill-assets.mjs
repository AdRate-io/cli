import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
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

async function readCanonicalFile(root, name, relativePath, options) {
  const path = join(root, relativePath)
  let info
  try {
    info = await lstat(path)
  } catch {
    return fail(name, "required asset is missing or unreadable")
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size > MAXIMUM_ASSET_BYTES
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
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAXIMUM_ASSET_BYTES) {
      return fail(name, "required asset is not a bounded regular file")
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
    if (total !== opened.size) {
      return fail(name, "required asset changed while being read")
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

async function validateSkill(root, name, options) {
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
    !shellMatchesManifest({
      shell,
      shellSha256: sha256SkillText(shellText),
      manifest,
    }) ||
    sha256SkillText(contentText) !== manifest.contentSha256
  ) {
    return fail(name, "shell or content digest differs from the manifest")
  }
  if (!openAi.defaultPrompt.includes(`$${name}`)) {
    return fail(name, "openai.yaml does not reference its Skill")
  }
}

export async function validateSkillAssets(
  root = DEFAULT_CLI_ROOT,
  options = {}
) {
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
