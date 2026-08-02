import { EXIT_CODE } from "./constants.js"
import { renderOutcomeAndWait, writeLineAndWait } from "./output.js"
import type { CliApplication } from "./application.js"
import type { CliExitCode } from "./constants.js"
import type { AcknowledgedOutputStreams } from "./output.js"

function deliveryFailureExitCode(exitCode: CliExitCode): CliExitCode {
  return exitCode === EXIT_CODE.success ? EXIT_CODE.business : exitCode
}

async function reportDeliveryFailure(
  streams: AcknowledgedOutputStreams,
  message: string
): Promise<void> {
  try {
    await writeLineAndWait(streams.stderr, message)
  } catch {
    // 原始 journal 必须保留；第二次输出失败不能掩盖首个投递失败。
  }
}

/**
 * CLI 真实运行边界：先等待所有 stdout/stderr write callback，再确认注销
 * outcome journal。render 失败保留 outcome 供重放；acknowledgement 先持久化
 * `output_acknowledged`，下次入口只做本地回收，不重放输出或 DELETE。
 */
export async function runCli(
  application: Pick<CliApplication, "execute">,
  argv: ReadonlyArray<string>,
  streams: AcknowledgedOutputStreams
): Promise<CliExitCode> {
  const execution = await application.execute(argv)
  try {
    await renderOutcomeAndWait(
      execution.outcome,
      { json: execution.json, verbose: execution.verbose },
      streams
    )
  } catch {
    await reportDeliveryFailure(
      streams,
      "Error: CLI output delivery failed; any pending logout result was preserved for replay."
    )
    return deliveryFailureExitCode(execution.outcome.exitCode)
  }

  if (execution.postRenderAcknowledgement) {
    try {
      await execution.postRenderAcknowledgement.acknowledge()
    } catch {
      await reportDeliveryFailure(
        streams,
        "Error: Logout output was written, but delivery acknowledgement failed. Run auth logout to recover the acknowledgement state."
      )
      return deliveryFailureExitCode(execution.outcome.exitCode)
    }
  }
  return execution.outcome.exitCode
}
