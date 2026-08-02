import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Buffer } from "node:buffer"
import { parseOwnerSessionToken } from "../contracts/oauth.js"
import { dependencyFailure, usageFailure } from "../errors.js"
import type { SecureFileSystem } from "./secure-files.js"
import type {
  AuthCleanupCredentialLocator,
  TokenIndex,
  TokenStorageKind,
} from "./schemas.js"
import type { CliPaths } from "./paths.js"

export interface CredentialAddress {
  issuerOrigin: string
  credentialKind: "owner_cli_session"
  credentialId: string
}

export interface CredentialBackend {
  readonly kind: TokenStorageKind
  isAvailable: () => Promise<boolean>
  read: (address: CredentialAddress) => Promise<string | null>
  write: (address: CredentialAddress, token: string) => Promise<void>
  remove: (address: CredentialAddress) => Promise<void>
}

export interface KeytarApi {
  getPassword: (service: string, account: string) => Promise<string | null>
  setPassword: (
    service: string,
    account: string,
    password: string
  ) => Promise<void>
  deletePassword: (service: string, account: string) => Promise<boolean>
}

export type KeytarLoader = () => Promise<KeytarApi>

async function defaultKeytarLoader(): Promise<KeytarApi> {
  const imported = await import("@github/keytar")
  const candidate = "default" in imported ? imported.default : imported
  if (
    typeof candidate.getPassword !== "function" ||
    typeof candidate.setPassword !== "function" ||
    typeof candidate.deletePassword !== "function"
  ) {
    throw new Error("Invalid @github/keytar module")
  }
  return candidate
}

function addressParts(address: CredentialAddress): {
  service: string
  account: string
} {
  const issuer = Buffer.from(address.issuerOrigin, "utf8").toString("base64url")
  return {
    service: `io.adrate.cli:${issuer}:${address.credentialKind}`,
    account: address.credentialId,
  }
}

/**
 * 就绪探测专用 issuer 命名空间。探测地址必须能被每个后端识别并隔离到
 * 独立地址，绝不允许落到任何 canonical 凭据地址上。
 */
export const CREDENTIAL_READINESS_ORIGIN_PREFIX =
  "https://credential-readiness-"

const READINESS_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const READINESS_ORIGIN_PATTERN = new RegExp(
  `^${CREDENTIAL_READINESS_ORIGIN_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.invalid$`,
  "u"
)

/** 判断一个地址是否属于就绪探测命名空间（而非真实凭据地址）。 */
export function isCredentialReadinessAddress(
  address: CredentialAddress
): boolean {
  return READINESS_ORIGIN_PATTERN.test(address.issuerOrigin)
}

function parseSecretFile(value: string): string | null {
  const token = value.endsWith("\n") ? value.slice(0, -1) : value
  if (
    token.length === 0 ||
    token.includes("\n") ||
    token.includes("\r") ||
    token.includes("\0")
  ) {
    return null
  }
  return token
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8")
  const b = Buffer.from(right, "utf8")
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

export class KeytarCredentialBackend implements CredentialBackend {
  readonly kind = "keychain" as const
  private api: KeytarApi | null = null

  constructor(private readonly loader: KeytarLoader = defaultKeytarLoader) {}

  async isAvailable(): Promise<boolean> {
    try {
      const api = await this.load()
      await api.getPassword(
        "io.adrate.cli:availability",
        "00000000-0000-1000-8000-000000000000"
      )
      return true
    } catch {
      return false
    }
  }

  async read(address: CredentialAddress): Promise<string | null> {
    const api = await this.requireApi()
    const parts = addressParts(address)
    try {
      return await api.getPassword(parts.service, parts.account)
    } catch {
      throw dependencyFailure(
        "The operating system Keychain could not be read."
      )
    }
  }

  async write(address: CredentialAddress, token: string): Promise<void> {
    const existing = await this.read(address)
    if (existing !== null) {
      if (tokensEqual(existing, token)) return
      throw usageFailure(
        "A different credential already exists at the Keychain address."
      )
    }
    const api = await this.requireApi()
    const parts = addressParts(address)
    try {
      await api.setPassword(parts.service, parts.account, token)
    } catch {
      throw dependencyFailure(
        "The operating system Keychain could not store the credential."
      )
    }
  }

  async remove(address: CredentialAddress): Promise<void> {
    const api = await this.requireApi()
    const parts = addressParts(address)
    try {
      await api.deletePassword(parts.service, parts.account)
    } catch {
      // @github/keytar@7.10.6 在当前 macOS 原生构建上，对不存在
      // item 的 delete 可能 reject 而不是 resolve false。delete 结果不能
      // 单独区分"已经不存在"与真实后端故障，因此继续用同一
      // exact address 做 post-read，只有明确 null 才证明幂等删除完成。
    }
    try {
      if ((await api.getPassword(parts.service, parts.account)) === null) {
        return
      }
    } catch {
      // 读取无法证明不存在，与读回仍有值一样 fail-closed。
    }
    throw dependencyFailure(
      "The operating system Keychain could not remove the credential."
    )
  }

  private async requireApi(): Promise<KeytarApi> {
    try {
      return await this.load()
    } catch {
      throw dependencyFailure(
        "The configured operating system Keychain backend is unavailable."
      )
    }
  }

  private async load(): Promise<KeytarApi> {
    if (this.api) return this.api
    this.api = await this.loader()
    return this.api
  }
}

export class FallbackFileCredentialBackend implements CredentialBackend {
  readonly kind = "fallback_file" as const

  constructor(
    private readonly fileSystem: SecureFileSystem,
    private readonly paths: CliPaths,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async isAvailable(): Promise<boolean> {
    if (this.platform === "win32") return false
    try {
      await this.fileSystem.ensureRoot()
      return true
    } catch {
      return false
    }
  }

  async read(address: CredentialAddress): Promise<string | null> {
    this.assertPlatformSupported()
    const text = await this.fileSystem.readSecureFile(this.resolvePath(address))
    if (text === null) return null
    const token = parseSecretFile(text)
    if (!token || !parseOwnerSessionToken(token)) {
      throw usageFailure(
        "The fallback token file has an invalid one-line format.",
        { reason: "metadata_mismatch" }
      )
    }
    return token
  }

  async write(address: CredentialAddress, token: string): Promise<void> {
    this.assertPlatformSupported()
    if (!(await this.isAvailable())) {
      throw dependencyFailure(
        "A verifiable protected fallback credential file is unavailable."
      )
    }
    const existing = await this.read(address)
    if (existing !== null) {
      if (tokensEqual(existing, token)) return
      throw usageFailure(
        "A different fallback credential already exists. Run auth logout first."
      )
    }
    await this.fileSystem.atomicWrite(this.resolvePath(address), `${token}\n`)
  }

  async remove(address: CredentialAddress): Promise<void> {
    this.assertPlatformSupported()
    // canonical fallback Token 是全局固定路径，删除必须在 auth lock 内完成，
    // 否则旧删除者可能在 ABA 后删掉并发写入的新 Token。探测派生路径按
    // credentialId 唯一，天然不与任何其他调用者竞争，允许在锁外清理。
    await this.fileSystem.removeSecureFile(this.resolvePath(address), {
      lock: isCredentialReadinessAddress(address) ? "if_held" : "required",
    })
  }

  /**
   * 就绪探测地址解析到 `token.readiness-<credentialId>` 派生路径，其余地址
   * 才是 canonical fallback Token。忽略 address 会让随机地址隔离对文件后端
   * 静默失效，使探测的写入与清理直接作用在真实凭据上。
   */
  private resolvePath(address: CredentialAddress): string {
    if (!isCredentialReadinessAddress(address)) return this.paths.fallbackToken
    if (!READINESS_UUID_PATTERN.test(address.credentialId)) {
      throw usageFailure(
        "The credential readiness address has an unsafe identifier."
      )
    }
    return `${this.paths.fallbackToken}.readiness-${address.credentialId}`
  }

  private assertPlatformSupported(): void {
    if (this.platform === "win32") {
      throw dependencyFailure(
        "Windows fallback credential files are disabled; a verified operating system credential backend is required."
      )
    }
  }
}

export interface CredentialBackendSelection {
  backend: CredentialBackend
}

export function credentialStorageWarning(
  storageKind: TokenStorageKind
): string | null {
  return storageKind === "fallback_file"
    ? "OS Keychain is unavailable; using the protected local token file."
    : null
}

class CredentialReadinessCleanupError extends Error {
  constructor() {
    super("Credential backend readiness cleanup could not be confirmed.")
    this.name = "CredentialReadinessCleanupError"
  }
}

function readinessProbe(): {
  address: CredentialAddress
  token: string
} {
  const credentialId = randomUUID()
  return {
    address: {
      // Keychain service/account、fallback 派生文件名和 dummy secret 每次均随机。
      // 该 origin 只用于 readiness 隔离地址，不会进入 token index 或网络请求，
      // 每个后端都必须据此把探测隔离到 canonical 凭据地址之外。
      issuerOrigin: `${CREDENTIAL_READINESS_ORIGIN_PREFIX}${randomUUID()}.invalid`,
      credentialKind: "owner_cli_session",
      credentialId,
    },
    token: `adr_owner_${credentialId}_${randomBytes(32).toString("base64url")}`,
  }
}

export class CredentialStore {
  constructor(
    private readonly keychain: CredentialBackend,
    private readonly fallback: CredentialBackend
  ) {}

  async selectForNewCredential(): Promise<CredentialBackendSelection> {
    if (await this.backendIsReady(this.keychain)) {
      return { backend: this.keychain }
    }
    if (!(await this.backendIsReady(this.fallback))) {
      throw dependencyFailure(
        "No verifiable secure credential storage is available."
      )
    }
    return { backend: this.fallback }
  }

  /**
   * Device 发码前只确认至少存在一个候选后端。完整的可逆
   * set/read/compare/delete readiness 必须在 Token POST 紧前重做，
   * 并由 poll attempt 锁定其中通过的后端。
   */
  async assertCandidateAvailable(): Promise<void> {
    if (
      (await this.keychain.isAvailable()) ||
      (await this.fallback.isAvailable())
    ) {
      return
    }
    throw dependencyFailure(
      "No verifiable secure credential storage is available."
    )
  }

  backendFor(index: Pick<TokenIndex, "storageKind">): CredentialBackend {
    return index.storageKind === "keychain" ? this.keychain : this.fallback
  }

  addressFor(
    index: Pick<TokenIndex, "issuerOrigin" | "credentialId" | "credentialKind">
  ): CredentialAddress {
    return {
      issuerOrigin: index.issuerOrigin,
      credentialKind: index.credentialKind,
      credentialId: index.credentialId,
    }
  }

  async read(index: TokenIndex): Promise<string | null> {
    return this.backendFor(index).read(this.addressFor(index))
  }

  write(index: TokenIndex, token: string): Promise<void> {
    return this.backendFor(index).write(this.addressFor(index), token)
  }

  async remove(index: TokenIndex): Promise<void> {
    await this.backendFor(index).remove(this.addressFor(index))
  }

  /**
   * 认证清理只能经 credential backend 执行，禁止越层。若存在与
   * keychain index 并存的 orphan fallback，先处理 fallback：Windows
   * backend 会在任何 raw file remove 前 fail-closed，避免先删 Keychain
   * 后才发现 legacy secret 不能安全处理。
   */
  async removeAuthenticationArtifacts(
    index: TokenIndex | null,
    fallbackExists: boolean
  ): Promise<void> {
    const locator: AuthCleanupCredentialLocator | null = index
      ? {
          issuerOrigin: index.issuerOrigin,
          credentialKind: index.credentialKind,
          credentialId: index.credentialId,
          storageKind: index.storageKind,
        }
      : null
    await this.removeAuthenticationArtifactsAt(locator, fallbackExists)
  }

  /**
   * Cleanup reservation 冻结的定位信息是唯一授权来源。该方法不读取当前
   * token index，避免 secret 删除后崩溃重入时误用后来的新 generation。
   */
  async removeAuthenticationArtifactsAt(
    locator: AuthCleanupCredentialLocator | null,
    fallbackExists: boolean
  ): Promise<void> {
    await this.removeFallbackAuthenticationArtifactAt(locator, fallbackExists)
    await this.removeKeychainAuthenticationArtifactAt(locator)
  }

  /**
   * fallback 是全局固定路径，调用时必须持有 auth lock 且确保
   * cleanup reservation 仍存在，否则旧删除者可能误删 ABA 后的新 Token。
   */
  async removeFallbackAuthenticationArtifactAt(
    locator: AuthCleanupCredentialLocator | null,
    fallbackExists: boolean
  ): Promise<void> {
    if (fallbackExists || locator?.storageKind === "fallback_file") {
      await this.fallback.remove(this.fallbackCleanupAddress(locator))
    }
  }

  /** Keychain 地址含冻结 credentialId，可在 auth lock 外执行慢 I/O。 */
  async removeKeychainAuthenticationArtifactAt(
    locator: AuthCleanupCredentialLocator | null
  ): Promise<void> {
    if (locator?.storageKind === "keychain") {
      await this.keychain.remove(this.addressFor(locator))
    }
  }

  tokensEqual(left: string, right: string): boolean {
    return tokensEqual(left, right)
  }

  private async backendIsReady(backend: CredentialBackend): Promise<boolean> {
    if (!(await backend.isAvailable())) return false
    try {
      await this.verifyBackendReadiness(backend)
      return true
    } catch (error) {
      if (error instanceof CredentialReadinessCleanupError) {
        throw dependencyFailure(
          "Secure credential storage readiness cleanup could not be confirmed."
        )
      }
      return false
    }
  }

  private async verifyBackendReadiness(
    backend: CredentialBackend
  ): Promise<void> {
    const probe = readinessProbe()
    // 探测会无条件执行 write + remove，一旦地址逃出 readiness 命名空间就会
    // 作用到真实凭据上。这里对自己生成的地址再做一次 fail-closed 断言，
    // 防止将来改动 readinessProbe 时静默失去隔离。
    if (!isCredentialReadinessAddress(probe.address)) {
      throw dependencyFailure(
        "Secure credential storage readiness could not be isolated."
      )
    }
    let cleanupAllowed = false
    let operationFailure: unknown = null

    try {
      const existing = await backend.read(probe.address)
      if (existing !== null) {
        throw new Error("readiness address collision")
      }
      cleanupAllowed = true
      await backend.write(probe.address, probe.token)
      const reread = await backend.read(probe.address)
      if (reread === null || !tokensEqual(reread, probe.token)) {
        throw new Error("readiness verification mismatch")
      }
    } catch (error) {
      operationFailure = error
    }

    if (cleanupAllowed) {
      let cleanupFailure: unknown = null
      try {
        await backend.remove(probe.address)
        if ((await backend.read(probe.address)) !== null) {
          throw new Error("readiness item remained after delete")
        }
      } catch (error) {
        cleanupFailure = error
      } finally {
        // 即使主流程的 delete/read 失败，也要再做一次幂等
        // cleanup。任意 cleanup 异常都表示本地状态不再可证，不能
        // 降级另一后端后继续不可逆 Token 交付。
        try {
          await backend.remove(probe.address)
        } catch (error) {
          cleanupFailure ??= error
        }
      }
      if (cleanupFailure) throw new CredentialReadinessCleanupError()
    }

    if (operationFailure) throw operationFailure
  }

  private fallbackCleanupAddress(
    locator: AuthCleanupCredentialLocator | null
  ): CredentialAddress {
    if (locator) return this.addressFor(locator)
    return {
      issuerOrigin: "https://api.adrate.io",
      credentialKind: "owner_cli_session",
      credentialId: "00000000-0000-4000-8000-000000000000",
    }
  }
}
