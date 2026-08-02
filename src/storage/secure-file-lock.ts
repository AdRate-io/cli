import { AsyncLocalStorage } from "node:async_hooks"
import { constants as fsConstants } from "node:fs"
import { chmod, link, lstat, open, readdir, unlink } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { TextDecoder } from "node:util"

const FILE_MODE = 0o600
const MAX_LOCAL_FILE_BYTES = 1024 * 1024
const MAX_LOCK_ACQUIRE_ATTEMPTS = 4
const LOCK_OWNER_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const RECLAIM_CLAIM_NAME_PATTERN =
  /\.reclaim-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(lock|json)$/u
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
})
const LOCAL_RECLAIM_PROCESS_FINGERPRINT = `local:${randomUUID()}`

/**
 * 调用点对跨进程锁的显式需求。`required` 表示无锁即失败，`if_held`
 * 表示只在已持锁时校验租约。没有默认值，避免再次出现隐式放行。
 */
export type LockRequirement = "required" | "if_held"

export interface SecureFileProcessIdentity {
  pid: number
  fingerprint: string
}

export interface SecureFileProcessIdentityProbe {
  current: () => Promise<SecureFileProcessIdentity>
  inspect: (
    expected: SecureFileProcessIdentity
  ) => Promise<"same_process" | "dead" | "reused" | "permission_unknown">
}

export interface SecureFileLockOperations {
  assertContained: (path: string) => string
  ensureDirectory: (path: string) => Promise<void>
  verifyFile: (path: string) => Promise<void>
  verifyDirectoryChain: (path: string) => Promise<void>
  verifyResolvedParent: (path: string) => Promise<void>
  secureCreatedFile: (path: string) => Promise<void>
  syncDirectory: (path: string) => Promise<void>
  readFileIdentity: (path: string) => Promise<FileIdentity>
  assertFileIdentity: (
    path: string,
    expected: FileIdentity | null
  ) => Promise<void>
  busyError: () => Error
}

export interface SecureFileLockCoordinatorOptions {
  now: () => number
  platform: NodeJS.Platform
  staleAfterMs: number
  processSignal: (pid: number, signal: 0) => void | Promise<void>
  processIdentity?: SecureFileProcessIdentityProbe
  operations: SecureFileLockOperations
}

/**
 * 跨进程锁与 stale claim 的唯一状态机。安全文件的权限、
 * symlink 和 inode 原语由 SecureFileSystem 注入，本模块只编排
 * acquire/activate/commit/reclaim，避免两套锁协议漂移。
 */
export class SecureFileLockCoordinator {
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private readonly staleAfterMs: number
  private readonly processSignal: (
    pid: number,
    signal: 0
  ) => void | Promise<void>
  private readonly processIdentity: SecureFileProcessIdentityProbe
  private readonly operations: SecureFileLockOperations
  private readonly lockContext = new AsyncLocalStorage<FileLockLease>()

  constructor(options: SecureFileLockCoordinatorOptions) {
    this.now = options.now
    this.platform = options.platform
    this.staleAfterMs = options.staleAfterMs
    this.processSignal = options.processSignal
    this.operations = options.operations
    this.processIdentity =
      options.processIdentity ?? this.createFailClosedProcessIdentityProbe()
  }

  /**
   * 锁归属断言。原实现是 `getStore()?.assertOwned()`，"根本没进任何
   * withLock" 会静默通过，等于对必须持锁的调用点完全没有兜底。现在要求
   * 每个调用点显式声明自己的锁需求，不再存在隐式放行：
   *
   * - `required`：无锁上下文直接 busyError。fallback Token 固定路径删除等
   *   受 ABA 威胁的写操作必须用它。
   * - `if_held`：只在持锁时校验租约。给合同显式允许的锁外写使用，例如
   *   config.json 初始化，以及 Token 200 之后位于 auth lock 之外的凭据写入。
   */
  async assertOwned(requirement: LockRequirement): Promise<void> {
    const lease = this.lockContext.getStore()
    if (!lease) {
      if (requirement === "required") throw this.operations.busyError()
      return
    }
    await lease.assertOwned()
  }

  async withLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
    const target = this.operations.assertContained(lockPath)
    await this.operations.ensureDirectory(dirname(target))
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let lease: FileLockLease | null = null
    for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
      await this.assertReclaimBarrierClear(target)
      try {
        handle = await this.openLock(target)
        break
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error
        if (!(await this.reclaimStaleLock(target))) {
          throw this.operations.busyError()
        }
      }
    }
    if (!handle) throw this.operations.busyError()
    const ownerToken = randomUUID()
    try {
      await handle.writeFile(
        JSON.stringify({
          formatVersion: 1,
          pid: process.pid,
          ownerToken,
          createdAt: new Date(this.now()).toISOString(),
        }),
        "utf8"
      )
      await handle.sync()
      const opened = await handle.stat()
      lease = new FileLockLease(
        target,
        ownerToken,
        opened.dev,
        opened.ino,
        () => this.assertReclaimBarrierClear(target),
        () => this.operations.busyError()
      )
      await lease.assertOwned()
      return await this.lockContext.run(lease, action)
    } finally {
      await handle.close().catch(() => undefined)
      if (lease && (await lease.owns())) {
        await unlink(target).catch(() => undefined)
        await this.operations
          .syncDirectory(dirname(target))
          .catch(() => undefined)
      }
    }
  }

  private async reclaimStaleLock(path: string): Promise<boolean> {
    const candidate = await this.inspectLock(path)
    if (!candidate) return false
    if (this.now() - candidate.createdAtMs < this.staleAfterMs) return false
    if (!(await this.isProcessDefinitelyDead(candidate.pid))) return false

    const claimToken = randomUUID()
    const claimPath = this.reclaimClaimPath(path, claimToken)
    const manifestPath = this.reclaimManifestPath(path, claimToken)
    let claimIdentity: FileIdentity | null = null
    let claimLinked = false
    let manifestCreated = false
    let preserveEvidence = false
    try {
      const reclaimerIdentity = await this.processIdentity.current()
      await this.createReclaimManifest(manifestPath, {
        formatVersion: 1,
        claimToken,
        reclaimerPid: reclaimerIdentity.pid,
        reclaimerProcessFingerprint: reclaimerIdentity.fingerprint,
        expectedDevice: candidate.device,
        expectedInode: candidate.inode,
        createdAt: new Date(this.now()).toISOString(),
      })
      manifestCreated = true
      try {
        // link() 原子捕获 canonical 在该时刻的 inode；后续不使用
        // rename 后检查冒充 pathname CAS。
        await link(path, claimPath)
        claimLinked = true
        try {
          // 清理身份只依赖 hard-link inode，不依赖尚可能未写完的 lock record。
          claimIdentity = await this.operations.readFileIdentity(claimPath)
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            claimLinked = false
            throw this.operations.busyError()
          }
          preserveEvidence = true
          throw this.operations.busyError()
        }
        await this.operations.syncDirectory(dirname(path))
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return true
        if (isNodeError(error) && error.code === "EEXIST") {
          preserveEvidence = true
          return false
        }
        throw this.operations.busyError()
      }
      const claimed = await this.inspectLock(claimPath)
      if (!this.sameLockGeneration(claimed, candidate)) return false

      await this.assertReclaimBarrierClear(path, claimToken)
      const singleton = await lstat(claimPath)
      if (
        !singleton.isFile() ||
        singleton.dev !== candidate.device ||
        singleton.ino !== candidate.inode ||
        singleton.nlink !== 2
      ) {
        return false
      }
      const canonical = await this.inspectLock(path)
      if (!this.sameLockGeneration(canonical, claimed)) return false
      await unlink(path)
      await this.operations.syncDirectory(dirname(path))
      // commit 后只清理 unique claim/manifest，绝不再触碰 canonical。
      return true
    } finally {
      if (claimLinked && claimIdentity) {
        await this.removeUniqueReclaimFile(claimPath, claimIdentity)
        await this.removeReclaimManifest(manifestPath)
      } else if (manifestCreated && !claimLinked && !preserveEvidence) {
        await this.removeReclaimManifest(manifestPath)
      }
    }
  }

  private async assertReclaimBarrierClear(
    path: string,
    ignoredClaimToken?: string
  ): Promise<void> {
    const prefix = `${basename(path)}.reclaim-`
    const claimTokens = new Set<string>()
    const manifestTokens = new Set<string>()
    for (const entry of await readdir(dirname(path))) {
      if (!entry.startsWith(prefix)) continue
      const match = entry.match(RECLAIM_CLAIM_NAME_PATTERN)
      if (!match || !match[1] || !match[2]) {
        throw this.operations.busyError()
      }
      if (match[2] === "lock") claimTokens.add(match[1])
      else manifestTokens.add(match[1])
    }

    for (const claimToken of claimTokens) {
      if (claimToken === ignoredClaimToken) continue
      const claimPath = this.reclaimClaimPath(path, claimToken)
      const manifestPath = this.reclaimManifestPath(path, claimToken)
      const claim = await this.inspectLock(claimPath)
      const manifest = await this.readReclaimManifest(manifestPath)
      if (
        !claim ||
        !manifest ||
        manifest.claimToken !== claimToken ||
        manifest.expectedDevice !== claim.device ||
        manifest.expectedInode !== claim.inode
      ) {
        throw this.operations.busyError()
      }
      if (
        this.now() - manifest.createdAtMs < this.staleAfterMs ||
        this.now() - claim.createdAtMs < this.staleAfterMs ||
        !(await this.isProcessDefinitelyDead(claim.pid))
      ) {
        throw this.operations.busyError()
      }
      const status = await this.processIdentity.inspect({
        pid: manifest.reclaimerPid,
        fingerprint: manifest.reclaimerProcessFingerprint,
      })
      if (status === "same_process" || status === "permission_unknown") {
        throw this.operations.busyError()
      }
      await this.removeUniqueReclaimFile(claimPath, claim)
      await this.removeReclaimManifest(manifestPath)
    }

    for (const manifestToken of manifestTokens) {
      if (
        manifestToken === ignoredClaimToken ||
        claimTokens.has(manifestToken)
      ) {
        continue
      }
      // manifest 在 hard-link 前先独立创建并 fsync；没有同 token 的 claim
      // 就没有捕获或引用 canonical inode，因此既不能阻塞当前 owner，也不能
      // 授权删除 canonical。fresh、损坏或 token 不匹配的 unique manifest
      // 原样保留；只有身份完整、已 stale 且 reclaimer 明确消失的 manifest
      // 才能按其自身 unique path 回收。
      const manifestPath = this.reclaimManifestPath(path, manifestToken)
      const manifest = await this.readReclaimManifest(manifestPath)
      if (
        !manifest ||
        manifest.claimToken !== manifestToken ||
        this.now() - manifest.createdAtMs < this.staleAfterMs
      ) {
        continue
      }
      const status = await this.processIdentity.inspect({
        pid: manifest.reclaimerPid,
        fingerprint: manifest.reclaimerProcessFingerprint,
      })
      if (status === "dead" || status === "reused") {
        await this.removeReclaimManifest(manifestPath)
      }
    }
  }

  private reclaimClaimPath(path: string, token: string): string {
    return `${path}.reclaim-${token}.lock`
  }

  private reclaimManifestPath(path: string, token: string): string {
    return `${path}.reclaim-${token}.json`
  }

  private async createReclaimManifest(
    path: string,
    manifest: ReclaimManifestRecord
  ): Promise<void> {
    const target = this.operations.assertContained(path)
    const handle = await open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        optionalFsConstant("O_NOFOLLOW"),
      FILE_MODE
    )
    try {
      await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this.operations.secureCreatedFile(target)
    await this.operations.verifyFile(target)
    await this.operations.syncDirectory(dirname(target))
  }

  private async readReclaimManifest(
    path: string
  ): Promise<ReclaimManifest | null> {
    let before: Awaited<ReturnType<typeof lstat>>
    try {
      before = await lstat(path)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null
      return null
    }
    try {
      await this.operations.verifyFile(path)
      await this.operations.verifyDirectoryChain(dirname(path))
      await this.operations.verifyResolvedParent(path)
    } catch {
      return null
    }
    const handle = await open(
      path,
      fsConstants.O_RDONLY | optionalFsConstant("O_NOFOLLOW")
    )
    let text: string
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino ||
        opened.size > MAX_LOCAL_FILE_BYTES
      ) {
        return null
      }
      text = decodeFatalUtf8(await handle.readFile())
    } catch {
      return null
    } finally {
      await handle.close()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!isReclaimManifestRecord(parsed)) return null
    const timestamp = new Date(parsed.createdAt)
    if (
      !Number.isFinite(timestamp.getTime()) ||
      timestamp.toISOString() !== parsed.createdAt ||
      timestamp.getTime() > this.now()
    ) {
      return null
    }
    return { ...parsed, createdAtMs: timestamp.getTime() }
  }

  private async removeUniqueReclaimFile(
    path: string,
    expected: FileIdentity
  ): Promise<void> {
    try {
      await this.operations.assertFileIdentity(path, expected)
      await unlink(path)
      try {
        await this.operations.syncDirectory(dirname(path))
      } catch {
        // unlink 已发生时再以 exact unique path 确认。若路径仍不存在，当前
        // 进程已完成清理，可以继续删除 manifest；若重新出现则保持二件套。
        try {
          await this.operations.readFileIdentity(path)
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") return
        }
        throw this.operations.busyError()
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return
      throw this.operations.busyError()
    }
  }

  private async removeReclaimManifest(path: string): Promise<void> {
    let identity: FileIdentity
    try {
      identity = await this.operations.readFileIdentity(path)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return
      throw this.operations.busyError()
    }
    await this.removeUniqueReclaimFile(path, identity)
  }

  private sameLockGeneration(
    current: LockInspection | null,
    expected: LockInspection
  ): current is LockInspection {
    return (
      current !== null &&
      current.device === expected.device &&
      current.inode === expected.inode &&
      current.pid === expected.pid &&
      current.ownerToken === expected.ownerToken &&
      current.createdAtMs === expected.createdAtMs
    )
  }

  private async inspectLock(path: string): Promise<LockInspection | null> {
    let before: Awaited<ReturnType<typeof lstat>>
    try {
      before = await lstat(path)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null
      throw error
    }
    await this.operations.verifyFile(path)
    await this.operations.verifyDirectoryChain(dirname(path))
    await this.operations.verifyResolvedParent(path)
    const handle = await open(
      path,
      fsConstants.O_RDONLY | optionalFsConstant("O_NOFOLLOW")
    )
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino ||
        opened.size > MAX_LOCAL_FILE_BYTES
      ) {
        return null
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(decodeFatalUtf8(await handle.readFile()))
      } catch {
        return null
      }
      if (!isLockRecord(parsed)) return null
      const timestamp = new Date(parsed.createdAt)
      if (
        !Number.isFinite(timestamp.getTime()) ||
        timestamp.toISOString() !== parsed.createdAt ||
        timestamp.getTime() > this.now()
      ) {
        return null
      }
      return {
        device: opened.dev,
        inode: opened.ino,
        linkCount: opened.nlink,
        pid: parsed.pid,
        ownerToken: parsed.ownerToken,
        createdAtMs: timestamp.getTime(),
      }
    } finally {
      await handle.close()
    }
  }

  private async openLock(
    path: string
  ): Promise<Awaited<ReturnType<typeof open>>> {
    const noFollow = optionalFsConstant("O_NOFOLLOW")
    const handle = await open(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      FILE_MODE
    )
    if (this.platform === "win32") {
      await handle.close()
      await this.operations.secureCreatedFile(path)
      return open(path, fsConstants.O_WRONLY | noFollow)
    }
    try {
      await this.operations.secureCreatedFile(path)
      return handle
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  private createFailClosedProcessIdentityProbe(): SecureFileProcessIdentityProbe {
    return {
      current: () =>
        Promise.resolve({
          pid: process.pid,
          fingerprint: LOCAL_RECLAIM_PROCESS_FINGERPRINT,
        }),
      inspect: async (expected) => {
        if (expected.pid === process.pid) {
          return expected.fingerprint === LOCAL_RECLAIM_PROCESS_FINGERPRINT
            ? "same_process"
            : "reused"
        }
        try {
          await this.processSignal(expected.pid, 0)
          return "permission_unknown"
        } catch (error) {
          return isNodeError(error) && error.code === "ESRCH"
            ? "dead"
            : "permission_unknown"
        }
      },
    }
  }

  private async isProcessDefinitelyDead(pid: number): Promise<boolean> {
    try {
      await this.processSignal(pid, 0)
      return false
    } catch (error) {
      return isNodeError(error) && error.code === "ESRCH"
    }
  }
}

class FileLockLease {
  constructor(
    private readonly path: string,
    private readonly ownerToken: string,
    private readonly device: number,
    private readonly inode: number,
    private readonly assertBarrierClear: () => Promise<void>,
    private readonly busyError: () => Error
  ) {}

  async owns(): Promise<boolean> {
    try {
      const info = await lstat(this.path)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.dev !== this.device ||
        info.ino !== this.inode
      ) {
        return false
      }
      const handle = await open(
        this.path,
        fsConstants.O_RDONLY | optionalFsConstant("O_NOFOLLOW")
      )
      let text: string
      try {
        const opened = await handle.stat()
        if (
          !opened.isFile() ||
          opened.dev !== this.device ||
          opened.ino !== this.inode ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino
        ) {
          return false
        }
        text = decodeFatalUtf8(await handle.readFile())
      } finally {
        await handle.close()
      }
      const parsed: unknown = JSON.parse(text)
      return (
        Boolean(parsed) &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { ownerToken?: unknown }).ownerToken === this.ownerToken
      )
    } catch {
      return false
    }
  }

  async assertOwned(): Promise<void> {
    await this.assertBarrierClear()
    if (!(await this.owns())) throw this.busyError()
    await this.assertBarrierClear()
    if (!(await this.owns())) throw this.busyError()
  }
}

interface FileIdentity {
  device: number
  inode: number
}

interface LockInspection extends FileIdentity {
  linkCount: number
  pid: number
  ownerToken: string
  createdAtMs: number
}

interface LockRecord {
  formatVersion: 1
  pid: number
  ownerToken: string
  createdAt: string
}

interface ReclaimManifestRecord {
  formatVersion: 1
  claimToken: string
  reclaimerPid: number
  reclaimerProcessFingerprint: string
  expectedDevice: number
  expectedInode: number
  createdAt: string
}

interface ReclaimManifest extends ReclaimManifestRecord {
  createdAtMs: number
}

function isLockRecord(value: unknown): value is LockRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    (value as { formatVersion?: unknown }).formatVersion === 1 &&
    Number.isSafeInteger((value as { pid?: unknown }).pid) &&
    Number((value as { pid: number }).pid) > 0 &&
    typeof (value as { ownerToken?: unknown }).ownerToken === "string" &&
    LOCK_OWNER_TOKEN_PATTERN.test(
      String((value as { ownerToken: string }).ownerToken)
    ) &&
    typeof (value as { createdAt?: unknown }).createdAt === "string"
  )
}

function isReclaimManifestRecord(
  value: unknown
): value is ReclaimManifestRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 7 &&
    (value as { formatVersion?: unknown }).formatVersion === 1 &&
    typeof (value as { claimToken?: unknown }).claimToken === "string" &&
    LOCK_OWNER_TOKEN_PATTERN.test(
      String((value as { claimToken: string }).claimToken)
    ) &&
    Number.isSafeInteger((value as { reclaimerPid?: unknown }).reclaimerPid) &&
    Number((value as { reclaimerPid: number }).reclaimerPid) > 0 &&
    typeof (value as { reclaimerProcessFingerprint?: unknown })
      .reclaimerProcessFingerprint === "string" &&
    isSafeProcessFingerprint(
      String(
        (value as { reclaimerProcessFingerprint: string })
          .reclaimerProcessFingerprint
      )
    ) &&
    Number.isSafeInteger(
      (value as { expectedDevice?: unknown }).expectedDevice
    ) &&
    Number((value as { expectedDevice: number }).expectedDevice) >= 0 &&
    Number.isSafeInteger(
      (value as { expectedInode?: unknown }).expectedInode
    ) &&
    Number((value as { expectedInode: number }).expectedInode) > 0 &&
    typeof (value as { createdAt?: unknown }).createdAt === "string"
  )
}

function isSafeProcessFingerprint(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 192 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code <= 0x1f || code === 0x7f)
    })
  )
}

function decodeFatalUtf8(value: Uint8Array): string {
  return STRICT_UTF8_DECODER.decode(value)
}

function optionalFsConstant(name: "O_NOFOLLOW"): number {
  const values = fsConstants as Partial<Record<"O_NOFOLLOW", number>>
  return values[name] ?? 0
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
