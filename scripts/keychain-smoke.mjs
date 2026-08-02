import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

const CONFIRMATION_ENVIRONMENT = "ADRATE_CONFIRM_REAL_KEYCHAIN_SMOKE"

if (process.env[CONFIRMATION_ENVIRONMENT] !== "1") {
  process.stderr.write(
    `SKIP: real Keychain smoke requires ${CONFIRMATION_ENVIRONMENT}=1; no Keychain call was made.\n`
  )
  process.exitCode = 2
} else {
  const runId = randomUUID()
  const service = `io.adrate.cli.smoke:${runId}`
  const account = `smoke-${runId}`
  const secret = randomBytes(32).toString("base64url")
  let keytar = null
  let failure = null
  let writeCompleted = false
  let primaryDeleteConfirmed = false

  try {
    const imported = await import("@github/keytar")
    keytar = imported.default ?? imported
    await keytar.setPassword(service, account, secret)
    writeCompleted = true
    const reread = await keytar.getPassword(service, account)
    const expected = Buffer.from(secret, "utf8")
    const actual = Buffer.from(reread ?? "", "utf8")
    if (
      expected.byteLength !== actual.byteLength ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new Error("Keychain round-trip verification failed.")
    }
    const deleted = await keytar.deletePassword(service, account)
    if (!deleted) {
      throw new Error("Keychain primary deletion was not confirmed.")
    }
    if ((await keytar.getPassword(service, account)) !== null) {
      throw new Error("Keychain item remained after primary deletion.")
    }
    primaryDeleteConfirmed = true
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error("Unknown Keychain smoke failure.")
  } finally {
    if (keytar) {
      let cleanupStage = "idempotent delete call"
      try {
        try {
          const repeatedDelete = await keytar.deletePassword(service, account)
          if (typeof repeatedDelete !== "boolean") {
            throw new Error("Keychain idempotent deletion was not confirmed.")
          }
        } catch {
          // @github/keytar@7.10.6 的当前 macOS 构建在 item 已不存在
          // 时可能 reject。该结果不被当成成功，只继续到同一
          // exact address 的 post-read；只有明确 null 才能确认清理。
        }
        cleanupStage = "idempotent post-read"
        if ((await keytar.getPassword(service, account)) !== null) {
          throw new Error(
            "Keychain smoke item remained after idempotent cleanup."
          )
        }
        if (writeCompleted && !primaryDeleteConfirmed && failure === null) {
          throw new Error("Keychain primary deletion was not confirmed.")
        }
      } catch (cleanupError) {
        const cleanupFailure = new Error(
          `Keychain smoke ${cleanupStage} could not be confirmed.`,
          { cause: cleanupError }
        )
        failure = cleanupFailure
      }
    }
  }

  if (failure) {
    process.stderr.write(`FAIL: ${failure.message}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      "PASS: real Keychain set/read/primary-delete/post-read/idempotent-cleanup smoke completed.\n"
    )
  }
}
