import { CLI_VERSION, EXIT_CODE } from "../constants.js"
import { createLocalError, createLocalSuccess } from "../contracts/envelope.js"
import { CliFailure, localRequestId, usageFailure } from "../errors.js"
import { compareSemver } from "./skill-contract.js"
import {
  BundledSkillCorruptError,
  UnknownSkillError,
  UnknownSkillPathError,
} from "./skill-catalog.js"
import { SkillPathUnsafeError } from "./skill-path-reader.js"
import type { SkillCatalog } from "./skill-catalog.js"
import type { SkillInstallFact, SkillsNotifier } from "./skills-notifier.js"
import type { CliOutcome } from "../errors.js"
import type { CliEnvelope } from "../contracts/envelope.js"
import type { JsonObject } from "../contracts/json.js"

function localSafetyFailure(message: string): CliFailure<CliEnvelope> {
  return new CliFailure<CliEnvelope>(
    message,
    EXIT_CODE.business,
    createLocalError(localRequestId(), "LOCAL_STATE_UNSAFE", message, false, {})
  )
}

function table(
  rows: ReadonlyArray<{
    name: string
    version: string
    minCliVersion: string
    description: string
  }>
): string {
  const headers = ["NAME", "VERSION", "MIN CLI", "DESCRIPTION"] as const
  const keys = ["name", "version", "minCliVersion", "description"] as const
  const widths = keys.map((key, index) => {
    const header = headers[index] ?? ""
    return Math.max(header.length, ...rows.map((row) => row[key].length))
  })
  const render = (values: ReadonlyArray<string>): string =>
    values
      .map((value, index) =>
        index === values.length - 1 ? value : value.padEnd(widths[index]!)
      )
      .join("  ")
  return [
    render(headers),
    ...rows.map((row) => render(keys.map((key) => row[key]))),
  ].join("\n")
}

function statusTable(rows: ReadonlyArray<SkillStatusRow>): string {
  const headers = ["NAME", "BUNDLED", "INSTALLED", "STATE"] as const
  const cells = rows.map((row) => [
    row.name,
    row.bundledVersion,
    row.installedVersion ?? "-",
    row.cliCompatible === false
      ? `${row.state} (requires CLI ${row.installedMinCliVersion ?? "?"})`
      : row.state,
  ])
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...cells.map((cell) => cell[index]!.length))
  )
  const render = (values: ReadonlyArray<string>): string =>
    values
      .map((value, index) =>
        index === values.length - 1 ? value : value.padEnd(widths[index]!)
      )
      .join("  ")
  return [render(headers), ...cells.map(render)].join("\n")
}

interface SkillStatusRow extends SkillInstallFact {
  /** 当前 CLI 是否满足已安装壳的 minCliVersion；未安装时为 null */
  cliCompatible: boolean | null
}

export class SkillsService {
  constructor(
    private readonly catalog: SkillCatalog,
    private readonly options: {
      inspector: Pick<SkillsNotifier, "facts">
      installedSkillsRoot: string
    }
  ) {}

  /**
   * `adrate skills status`：只读诊断，不安装、不升级、不读凭据、不受
   * ADRATE_NO_SKILLS_NOTIFIER 影响（显式命令）。安装判定与 notifier 共用 facts()。
   */
  async status(): Promise<CliOutcome<CliEnvelope>> {
    let facts: ReadonlyArray<SkillInstallFact>
    try {
      facts = await this.options.inspector.facts()
    } catch (error) {
      if (error instanceof BundledSkillCorruptError) {
        throw localSafetyFailure(
          "The bundled Skills failed local integrity validation. Reinstall the AdRate CLI."
        )
      }
      throw error
    }
    const rows: Array<SkillStatusRow> = facts.map((fact) => ({
      ...fact,
      cliCompatible:
        fact.installedMinCliVersion === null
          ? null
          : compareSemver(fact.installedMinCliVersion, CLI_VERSION) <= 0,
    }))
    const needsInstall = rows.some(
      (row) => row.state === "missing" || row.state === "outdated"
    )
    const data = {
      installedSkillsRoot: this.options.installedSkillsRoot,
      skills: rows,
      suggestedAction: needsInstall ? "install_skills" : null,
      command: needsInstall ? "adrate skills install" : null,
    } as unknown as JsonObject
    const hint = needsInstall ? "\nRun: adrate skills install" : ""
    return {
      exitCode: EXIT_CODE.success,
      envelope: createLocalSuccess(localRequestId(), data, {
        cliVersion: CLI_VERSION,
      }),
      warnings: [],
      humanOutput: {
        stream: "stdout",
        mode: "line",
        value: `${statusTable(rows)}${hint}`,
      },
    }
  }

  async list(): Promise<CliOutcome<CliEnvelope>> {
    try {
      const skills = await this.catalog.list()
      const data = { skills } as unknown as JsonObject
      return {
        exitCode: EXIT_CODE.success,
        envelope: createLocalSuccess(localRequestId(), data, {
          cliVersion: CLI_VERSION,
        }),
        warnings: [],
        humanOutput: {
          stream: "stdout",
          mode: "line",
          value: table(skills),
        },
      }
    } catch (error) {
      if (error instanceof BundledSkillCorruptError) {
        throw localSafetyFailure(
          "The bundled Skills failed local integrity validation. Reinstall the AdRate CLI."
        )
      }
      throw error
    }
  }

  async read(input: {
    name?: string
    path?: string
  }): Promise<CliOutcome<CliEnvelope>> {
    if (!input.name) throw usageFailure("A Skill name is required.")
    try {
      const file = await this.catalog.read(input.name, input.path)
      const data = {
        name: file.name,
        version: file.version,
        path: file.path,
        content: file.content,
        sha256: file.sha256,
      }
      return {
        exitCode: EXIT_CODE.success,
        envelope: createLocalSuccess(localRequestId(), data, {
          cliVersion: CLI_VERSION,
        }),
        warnings: [],
        humanOutput: {
          stream: "stdout",
          mode: "raw",
          value: file.content,
        },
      }
    } catch (error) {
      if (error instanceof UnknownSkillError) {
        throw usageFailure("Unknown Skill name.")
      }
      if (error instanceof UnknownSkillPathError) {
        throw usageFailure("Unknown Skill path.")
      }
      if (
        error instanceof SkillPathUnsafeError ||
        error instanceof BundledSkillCorruptError
      ) {
        throw localSafetyFailure(
          error instanceof BundledSkillCorruptError
            ? "The bundled Skill failed local integrity validation. Reinstall the AdRate CLI."
            : "The requested Skill path failed local safety validation."
        )
      }
      throw error
    }
  }
}
