import { createCliApplication } from "./runtime.js"
import { runCli } from "./runner.js"

const application = createCliApplication()
process.exitCode = await runCli(application, process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
})
