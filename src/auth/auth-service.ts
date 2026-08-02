import { EXIT_CODE } from "../constants.js"
import { createLocalSuccess } from "../contracts/envelope.js"
import { dependencyFailure, localRequestId } from "../errors.js"
import { validateAuthLoginInput } from "./auth-command-support.js"
import { createAuthContext } from "./auth-context.js"
import { DeviceAuthorizationService } from "./device-authorization-service.js"
import { DevicePollCoordinator } from "./device-poll-coordinator.js"
import { LogoutDeliveryJournalCoordinator } from "./logout-delivery-journal.js"
import { LogoutRecoveryService } from "./logout-recovery-service.js"
import { SessionIdentityService } from "./session-identity-service.js"
import type { AuthLoginInput } from "./auth-command-support.js"
import type { AuthServiceDependencies } from "./auth-context.js"
import type { CliOutcome } from "../errors.js"
import type { LogoutCliOutcome } from "./logout-delivery-journal.js"
import type { GlobalOptions } from "../parser.js"

export type { AuthServiceDependencies } from "./auth-context.js"

/**
 * 认证命令的稳定门面。协议轮询、身份验证和撤销恢复由独立服务负责，
 * 这里仅构造共享 coordinator 并保持 application 层调用面不变。
 */
export class AuthService {
  private readonly deviceAuthorization: DeviceAuthorizationService
  private readonly devicePoll: DevicePollCoordinator
  private readonly sessionIdentity: SessionIdentityService
  private readonly logoutRecovery: LogoutRecoveryService
  private readonly logoutDelivery: LogoutDeliveryJournalCoordinator

  constructor(dependencies: AuthServiceDependencies) {
    const context = createAuthContext(dependencies)
    this.devicePoll = new DevicePollCoordinator(context.local, context.now)
    this.logoutDelivery = new LogoutDeliveryJournalCoordinator(context)
    this.sessionIdentity = new SessionIdentityService(context)
    this.deviceAuthorization = new DeviceAuthorizationService(
      context,
      this.devicePoll,
      this.sessionIdentity
    )
    this.logoutRecovery = new LogoutRecoveryService(context, this.devicePoll)
  }

  private async finalizeAcknowledgedLogoutOutput(): Promise<void> {
    if (!(await this.logoutDelivery.finalizeAcknowledgedOutput())) return
    throw dependencyFailure(
      "A previous logout output acknowledgement was finalized locally. Retry the requested command.",
      EXIT_CODE.retryable,
      {
        logoutDeliveryFinalized: true,
        suggestedAction: "retry_command",
      }
    )
  }

  async login(input: AuthLoginInput): Promise<CliOutcome> {
    const validated = validateAuthLoginInput(input)
    await this.finalizeAcknowledgedLogoutOutput()
    const recovered = await this.devicePoll.recoverAcknowledgedResponse()
    await this.logoutDelivery.assertNoPending("login")
    return this.deviceAuthorization.login(validated, recovered)
  }

  async status(global: GlobalOptions): Promise<CliOutcome> {
    await this.finalizeAcknowledgedLogoutOutput()
    await this.devicePoll.recoverAcknowledgedResponse()
    const journal = await this.logoutDelivery.read()
    if (journal) {
      if (journal.phase === "output_acknowledged") {
        await this.finalizeAcknowledgedLogoutOutput()
      }
      return {
        exitCode: EXIT_CODE.success,
        envelope: createLocalSuccess(localRequestId(), {
          status: "local_incomplete",
          authenticated: false,
          issuerOrigin: null,
          credentialKind: null,
          credentialId: null,
          team: null,
          credential: null,
          reason: "metadata_mismatch",
        }),
        warnings: [
          "A previous logout result is waiting for delivery acknowledgement. Run auth logout before other authenticated commands.",
        ],
      }
    }
    return this.sessionIdentity.status(global)
  }

  async whoami(global: GlobalOptions): Promise<CliOutcome> {
    await this.finalizeAcknowledgedLogoutOutput()
    await this.devicePoll.recoverAcknowledgedResponse()
    await this.logoutDelivery.assertNoPending("whoami")
    return this.sessionIdentity.whoami(global)
  }

  async logout(global: GlobalOptions): Promise<LogoutCliOutcome> {
    await this.finalizeAcknowledgedLogoutOutput()
    await this.devicePoll.recoverAcknowledgedResponse()
    return this.logoutRecovery.logout(global)
  }
}
