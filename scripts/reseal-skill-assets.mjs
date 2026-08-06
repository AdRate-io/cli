#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  SKILL_NAMES,
  normalizeSkillText,
  parseOpenAiConfig,
  parseSkillFrontmatter,
  sha256SkillText,
} from "./skill-assets-contract.mjs"

const DEFAULT_CLI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

async function canonicalText(path) {
  const text = await readFile(path, "utf8")
  if (text !== normalizeSkillText(text)) {
    throw new Error(`${path} must use LF and exactly one trailing newline.`)
  }
  return text
}

async function prepareManifest(root, name) {
  const shellText = await canonicalText(
    resolve(root, "skills", name, "SKILL.md")
  )
  const contentText = await canonicalText(
    resolve(root, "skills-content", name, "SKILL.md")
  )
  const openAiText = await canonicalText(
    resolve(root, "skills", name, "agents", "openai.yaml")
  )
  const shell = parseSkillFrontmatter(shellText)
  const openAi = parseOpenAiConfig(openAiText)
  if (!shell || shell.name !== name) {
    throw new Error(`${name}: Skill frontmatter is invalid.`)
  }
  if (!openAi || !openAi.defaultPrompt.includes(`$${name}`)) {
    throw new Error(`${name}: openai.yaml is invalid.`)
  }
  return {
    path: resolve(root, "skills", name, "skill-manifest.json"),
    manifest: {
      formatVersion: 1,
      name: shell.name,
      description: shell.description,
      version: shell.metadata.version,
      minCliVersion: shell.metadata.minCliVersion,
      requiredBin: shell.metadata.requiredBin,
      cliHelp: shell.metadata.cliHelp,
      shellSha256: sha256SkillText(shellText),
      contentSha256: sha256SkillText(contentText),
    },
  }
}

async function main() {
  const root = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_CLI_ROOT
  const updates = []
  for (const name of SKILL_NAMES)
    updates.push(await prepareManifest(root, name))
  for (const update of updates) {
    await writeFile(
      update.path,
      `${JSON.stringify(update.manifest, null, 2)}\n`
    )
  }
  process.stdout.write("Skills asset manifests resealed.\n")
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure"
  process.stderr.write(`Skills reseal failed: ${message}\n`)
  process.exitCode = 1
})
