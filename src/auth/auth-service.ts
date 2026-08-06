import { validateAuthLoginInput } from "./auth-command-support.js"
import { createAuthContext } from "./auth-context.js"
import { DeviceAuthorizationService } from "./device-authorization-service.js"
import { DevicePollCoordinator } from "./device-poll-coordinator.js"
import { LogoutRecoveryService } from "./logout-recovery-service.js"
import { SessionIdentityService } from "./session-identity-service.js"
import type { AuthLoginInput } from "./auth-command-support.js"
import type { AuthServiceDependencies } from "./auth-context.js"
import type { CliOutcome } from "../errors.js"
import type { GlobalOptions } from "../parser.js"

export type { AuthServiceDependencies } from "./auth-context.js"

/**
 * 认证命令的稳定门面。协议轮询、身份验证和撤销恢复由独立服务负责，
 * 这里仅构造共享 coordinator 并保持 application 层调用面不变。
 */
export class AuthService {
  private readonly deviceAuthorization: DeviceAuthorizationService
  private readonly sessionIdentity: SessionIdentityService
  private readonly logoutRecovery: LogoutRecoveryService

  constructor(dependencies: AuthServiceDependencies) {
    const context = createAuthContext(dependencies)
    const devicePoll = new DevicePollCoordinator(context.local, context.now)
    this.sessionIdentity = new SessionIdentityService(context)
    this.logoutRecovery = new LogoutRecoveryService(context, devicePoll)
    this.deviceAuthorization = new DeviceAuthorizationService(
      context,
      devicePoll,
      this.sessionIdentity,
      this.logoutRecovery
    )
  }

  login(
    input: AuthLoginInput,
    emitDeviceCodeLine?: (line: string) => void
  ): Promise<CliOutcome> {
    try {
      return this.deviceAuthorization.login(
        validateAuthLoginInput(input),
        emitDeviceCodeLine
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  status(global: GlobalOptions): Promise<CliOutcome> {
    return this.sessionIdentity.status(global)
  }

  whoami(global: GlobalOptions): Promise<CliOutcome> {
    return this.sessionIdentity.whoami(global)
  }

  logout(global: GlobalOptions): Promise<CliOutcome> {
    return this.logoutRecovery.logout(global)
  }
}
