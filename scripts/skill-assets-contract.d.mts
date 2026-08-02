export const SKILL_NAMES: readonly ["adrate-shared", "adrate-ads"]
export type SkillName = (typeof SKILL_NAMES)[number]

export interface SkillManifest {
  formatVersion: 1
  name: string
  description: string
  version: string
  minCliVersion: string
  requiredBin: string
  cliHelp: string
  shellSha256: string
  contentSha256: string
}

export interface SkillFrontmatter {
  name: string
  description: string
  metadata: {
    version: string
    minCliVersion: string
    requiredBin: string
    cliHelp: string
  }
}

export interface OpenAiConfig {
  displayName: string
  shortDescription: string
  defaultPrompt: string
}

export const EXPECTED_SKILL_MANIFESTS: Readonly<
  Record<SkillName, Readonly<SkillManifest>>
>
export const EXPECTED_OPENAI_CONFIGS: Readonly<
  Record<SkillName, Readonly<OpenAiConfig>>
>

export function normalizeSkillText(value: string): string
export function sha256SkillText(value: string): string
export function isValidSemver(value: unknown): value is string
export function compareSemver(left: string, right: string): -1 | 0 | 1
export function parseSkillManifest(
  text: string,
  expectedName?: string
): SkillManifest | null
export function parseSkillFrontmatter(text: string): SkillFrontmatter | null
export function parseOpenAiConfig(text: string): OpenAiConfig | null
export function shellMatchesManifest(input: {
  shell: SkillFrontmatter
  shellSha256: string
  manifest: SkillManifest
}): boolean
