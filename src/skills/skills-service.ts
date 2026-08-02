import { CLI_VERSION, EXIT_CODE } from "../constants.js"
import { createLocalError, createLocalSuccess } from "../contracts/envelope.js"
import { CliFailure, localRequestId, usageFailure } from "../errors.js"
import {
  BundledSkillCorruptError,
  UnknownSkillError,
  UnknownSkillPathError,
} from "./skill-catalog.js"
import { SkillPathUnsafeError } from "./skill-path-reader.js"
import type { SkillCatalog } from "./skill-catalog.js"
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

export class SkillsService {
  constructor(private readonly catalog: SkillCatalog) {}

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
