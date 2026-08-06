import { AsyncLocalStorage } from "node:async_hooks"
import { constants as fsConstants } from "node:fs"
import { lstat, open, unlink } from "node:fs/promises"
import { dirname } from "node:path"

const FILE_MODE = 0o600

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
 * 不持久化 owner、PID、租约或接管状态；崩溃残留按 transient state 处理。
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
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw this.options.operations.busyError()
      }
      if (lease && (await lease.owns())) {
        await unlink(target).catch(() => undefined)
      }
      throw error
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
