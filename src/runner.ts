import { renderOutcome } from "./output.js"
import type { CliApplication } from "./application.js"
import type { CliExitCode } from "./constants.js"
import type { OutputStreams } from "./output.js"

export async function runCli(
  application: Pick<CliApplication, "execute">,
  argv: ReadonlyArray<string>,
  streams: OutputStreams
): Promise<CliExitCode> {
  const execution = await application.execute(argv, {
    emitStdoutLine(line) {
      streams.stdout.write(`${line}\n`)
    },
  })
  renderOutcome(
    execution.outcome,
    { json: execution.json, verbose: execution.verbose },
    streams
  )
  return execution.outcome.exitCode
}
