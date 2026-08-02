import { homedir } from "node:os"
import { join } from "node:path"

export interface CliPaths {
  root: string
  config: string
  tokenIndex: string
  credentials: string
  fallbackToken: string
  deviceDirectory: string
  deviceCurrent: string
  deviceIssueReservation: string
  devicePollAttempt: string
  authCleanupReservation: string
  logoutDeliveryJournal: string
  pendingCommands: string
  pendingCommandAttempts: string
  authLock: string
  cacheDirectory: string
  updateCache: string
  updateCacheLock: string
}

export function createCliPaths(root = join(homedir(), ".adrate")): CliPaths {
  return Object.freeze({
    root,
    config: join(root, "config.json"),
    tokenIndex: join(root, "token-index.json"),
    credentials: join(root, "credentials.json"),
    fallbackToken: join(root, "token"),
    deviceDirectory: join(root, "device-authorizations"),
    deviceCurrent: join(root, "device-authorizations", "current.json"),
    deviceIssueReservation: join(
      root,
      "device-authorizations",
      "issue-reservation.json"
    ),
    devicePollAttempt: join(root, "device-authorizations", "poll-attempt.json"),
    authCleanupReservation: join(root, ".auth-cleanup.json"),
    logoutDeliveryJournal: join(root, ".logout-delivery.json"),
    pendingCommands: join(root, "pending-commands"),
    pendingCommandAttempts: join(root, "pending-command-attempts"),
    authLock: join(root, ".auth.lock"),
    cacheDirectory: join(root, "cache"),
    updateCache: join(root, "cache", "update.json"),
    updateCacheLock: join(root, "cache", ".update.lock"),
  })
}
