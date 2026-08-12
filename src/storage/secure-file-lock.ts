import { AsyncLocalStorage } from "node:async_hooks"
import { constants as fsConstants } from "node:fs"
import { lstat, open, unlink } from "node:fs/promises"
import { dirname } from "node:path"

const FILE_MODE = 0o600

/**
 * 孤儿锁判定阈值。锁内只允许本地文件操作（禁止网络请求等长操作），
 * 合法持锁为毫秒级，30 秒有四个数量级余量。进程被强杀（如 Windows
 * 上 taskkill /F、Agent 子任务超时）不会执行释放路径，残留的锁文件
 * 超过该年龄即判定为孤儿，允许竞争者接管删除。
 */
const STALE_LOCK_MS = 30_000

/**
 * 调用点对跨进程锁的显式需求。required 表示必须位于 withLock 内，
 * if_held 表示只有当前调用链已持锁时才校验。
 */
export type LockRequirement = "required" | "if_held"

export interface SecureFileLockOperations {
  assertContained: (path: string) => string
  ensureDirectory: (path: string) => Promise<void>
  verifyFile: (path: string) => Promise<void>
  secureCreatedFile: (path: string) => Promise<void>
  syncDirectory: (path: string) => Promise<void>
  busyError: () => Error
}

export interface SecureFileLockCoordinatorOptions {
  operations: SecureFileLockOperations
}

/**
 * 最小跨进程文件互斥：O_EXCL 原子创建，回调结束后仅删除自己创建的 inode。
 * 不持久化 owner、PID 或租约；崩溃残留靠 mtime 过期接管自愈（removeStaleLock）。
 */
export class SecureFileLockCoordinator {
  private readonly lockContext = new AsyncLocalStorage<FileLockLease>()

  constructor(private readonly options: SecureFileLockCoordinatorOptions) {}

  async assertOwned(requirement: LockRequirement): Promise<void> {
    const lease = this.lockContext.getStore()
    if (!lease) {
      if (requirement === "required") throw this.options.operations.busyError()
      return
    }
    if (!(await lease.owns())) throw this.options.operations.busyError()
  }

  async withLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
    const target = this.options.operations.assertContained(lockPath)
    await this.options.operations.ensureDirectory(dirname(target))

    let lease = await this.acquireLease(target)
    if (!lease) {
      // 路径被占用：先尝试清除崩溃残留的孤儿锁，成功后重试一次原子创建；
      // 输掉重试竞争的一方按 busy 处理，由调用方决定是否重试。
      if (!(await this.removeStaleLock(target))) {
        throw this.options.operations.busyError()
      }
      lease = await this.acquireLease(target)
      if (!lease) throw this.options.operations.busyError()
    }

    try {
      return await this.lockContext.run(lease, action)
    } finally {
      if (await lease.owns()) {
        await unlink(target).catch(() => undefined)
        await this.options.operations
          .syncDirectory(dirname(target))
          .catch(() => undefined)
      }
    }
  }

  /** O_EXCL 原子创建锁。路径已存在（EEXIST）返回 null，其余错误原样抛出。 */
  private async acquireLease(target: string): Promise<FileLockLease | null> {
    let lease: FileLockLease | null = null
    try {
      const handle = await open(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          optionalFsConstant("O_NOFOLLOW"),
        FILE_MODE
      )
      try {
        await handle.sync()
        const opened = await handle.stat()
        lease = new FileLockLease(target, opened.dev, opened.ino)
      } finally {
        await handle.close()
      }
      await this.options.operations.secureCreatedFile(target)
      await this.options.operations.verifyFile(target)
      await this.options.operations.syncDirectory(dirname(target))
      return lease
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return null
      if (lease && (await lease.owns())) {
        await unlink(target).catch(() => undefined)
      }
      throw error
    }
  }

  /**
   * 孤儿锁接管：锁文件为普通文件且 mtime 超过 STALE_LOCK_MS 时删除它，
   * 返回 true 表示路径已可重试创建。删除前按 (dev, ino, mtime) 复核仍是
   * 最初观察到的那个文件，避免误删其他竞争者刚接管建立的新锁；复核与
   * unlink 之间残余的系统调用级竞态窗口是本协议接受的已知取舍（后果是
   * 锁内本地文件操作短暂并发，状态文件均为原子写）。非普通文件（如
   * symlink）不接管，保持 fail-closed 交人工处理。
   */
  private async removeStaleLock(target: string): Promise<boolean> {
    let observed: Awaited<ReturnType<typeof lstat>>
    try {
      observed = await lstat(target)
    } catch (error) {
      // 锁已被持有者释放或被其他竞争者接管完毕，路径已空，可重试创建。
      if (isNodeError(error) && error.code === "ENOENT") return true
      return false
    }
    if (!observed.isFile() || observed.isSymbolicLink()) return false
    if (Date.now() - observed.mtimeMs < STALE_LOCK_MS) return false
    try {
      const current = await lstat(target)
      if (
        current.dev !== observed.dev ||
        current.ino !== observed.ino ||
        current.mtimeMs !== observed.mtimeMs
      ) {
        return false
      }
      await unlink(target)
    } catch (error) {
      return isNodeError(error) && error.code === "ENOENT"
    }
    await this.options.operations
      .syncDirectory(dirname(target))
      .catch(() => undefined)
    return true
  }
}

class FileLockLease {
  constructor(
    private readonly path: string,
    private readonly device: number,
    private readonly inode: number
  ) {}

  async owns(): Promise<boolean> {
    try {
      const info = await lstat(this.path)
      return (
        info.isFile() &&
        !info.isSymbolicLink() &&
        info.dev === this.device &&
        info.ino === this.inode
      )
    } catch {
      return false
    }
  }
}

function optionalFsConstant(name: "O_NOFOLLOW"): number {
  const values = fsConstants as Partial<Record<"O_NOFOLLOW", number>>
  return values[name] ?? 0
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
