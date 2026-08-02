import type { PublicHttpClient } from "../http/client.js"
import type { LocalCredentialCoordinator } from "./local-credentials.js"

export interface AuthServiceDependencies {
  http: PublicHttpClient
  local: LocalCredentialCoordinator
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
  environment?: NodeJS.ProcessEnv
  progress?: (message: string) => void
}

export interface AuthContext {
  http: PublicHttpClient
  local: LocalCredentialCoordinator
  now: () => Date
  sleep: (milliseconds: number) => Promise<void>
  environment: NodeJS.ProcessEnv
  progress: (message: string) => void
}

export function createAuthContext(
  dependencies: AuthServiceDependencies
): AuthContext {
  return {
    http: dependencies.http,
    local: dependencies.local,
    now: dependencies.now ?? (() => new Date()),
    sleep:
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds)
        })),
    environment: dependencies.environment ?? process.env,
    progress: dependencies.progress ?? (() => undefined),
  }
}
