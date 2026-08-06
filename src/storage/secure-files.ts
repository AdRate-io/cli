import { constants as fsConstants } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { TextDecoder } from "node:util"
import { dependencyFailure } from "../errors.js"
import { SecureFileLockCoordinator } from "./secure-file-lock.js"
import type { LockRequirement } from "./secure-file-lock.js"

export type { LockRequirement } from "./secure-file-lock.js"

/**
 * 变更类文件操作的锁需求声明。省略时按 `if_held` 处理，与既有调用点
 * 行为一致；受 ABA 威胁的固定路径必须显式传 `required`。
 */
export interface SecureMutationOptions {
  lock?: LockRequirement
}

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const MAX_LOCAL_FILE_BYTES = 1024 * 1024
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
})

export interface WindowsAclController {
  ensureDirectory: (path: string) => Promise<void>
  secure: (path: string, kind: "file" | "directory") => Promise<void>
  verify: (path: string, kind: "file" | "directory") => Promise<boolean>
  atomicReplace: (source: string, target: string) => Promise<void>
}

export interface SecureFileSystemOptions {
  root: string
  platform?: NodeJS.Platform
  uid?: number | null
  windowsAcl?: WindowsAclController
  /** 仅供确定性文件竞态回归使用；生产 runtime 不传入。 */
  testHooks?: {
    afterReadFileOpened?: (path: string) => void | Promise<void>
    afterReadHandleRestat?: (path: string) => void | Promise<void>
  }
}

export class SecureFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SecureFileError"
  }
}

export class SecureFileLockBusyError extends SecureFileError {
  constructor() {
    super("Another AdRate CLI process is updating local authentication state.")
    this.name = "SecureFileLockBusyError"
  }
}

export type AtomicCreateResult = "created" | "exists"

function decodeFatalUtf8(value: Uint8Array): string {
  try {
    return STRICT_UTF8_DECODER.decode(value)
  } catch {
    throw new SecureFileError("The local state file is not valid UTF-8.")
  }
}

function modeBits(mode: number): number {
  return mode & 0o777
}

function optionalFsConstant(name: "O_DIRECTORY" | "O_NOFOLLOW"): number {
  const values = fsConstants as Partial<
    Record<"O_DIRECTORY" | "O_NOFOLLOW", number>
  >
  return values[name] ?? 0
}

export function hardenProcessUmask(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== "win32") process.umask(0o077)
}

export class SecureFileSystem {
  readonly root: string
  private readonly platform: NodeJS.Platform
  private readonly uid: number | null
  private readonly windowsAcl?: WindowsAclController
  private readonly lockCoordinator: SecureFileLockCoordinator
  private readonly testHooks?: SecureFileSystemOptions["testHooks"]

  constructor(options: SecureFileSystemOptions) {
    if (!isAbsolute(options.root)) {
      throw new SecureFileError("The AdRate state directory must be absolute.")
    }
    this.root = resolve(options.root)
    this.platform = options.platform ?? process.platform
    this.uid =
      options.uid ??
      (typeof process.getuid === "function" ? process.getuid() : null)
    this.windowsAcl = options.windowsAcl
    this.testHooks = options.testHooks
    this.lockCoordinator = new SecureFileLockCoordinator({
      operations: {
        assertContained: (path) => this.assertContained(path),
        ensureDirectory: (path) => this.ensureDirectory(path),
        verifyFile: (path) => this.verifyPath(path, "file"),
        secureCreatedFile: (path) => this.secureCreatedFile(path),
        syncDirectory: (path) => this.syncDirectory(path),
        busyError: () => new SecureFileLockBusyError(),
      },
    })
  }

  assertContained(path: string): string {
    const target = resolve(path)
    const fromRoot = relative(this.root, target)
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new SecureFileError(
        "A local state path escaped the AdRate directory."
      )
    }
    return target
  }

  async ensureRoot(): Promise<void> {
    await this.ensureDirectory(this.root)
  }

  async ensureDirectory(path: string): Promise<void> {
    const target = this.assertContained(path)
    if (target !== this.root) await this.ensureDirectory(dirname(target))
    if (this.platform === "win32") {
      await this.requireWindowsAcl().ensureDirectory(target)
    } else {
      let created = false
      try {
        await mkdir(target, { mode: DIRECTORY_MODE })
        created = true
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error
      }
      if (created) await chmod(target, DIRECTORY_MODE)
    }
    await this.verifyPath(target, "directory")
  }

  async exists(path: string): Promise<boolean> {
    const target = this.assertContained(path)
    try {
      const info = await lstat(target)
      if (info.isSymbolicLink()) {
        throw new SecureFileError("A local state path is a symbolic link.")
      }
      return true
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false
      throw error
    }
  }

  async readSecureFile(path: string): Promise<string | null> {
    const target = this.assertContained(path)
    if (!(await this.exists(target))) return null
    await this.verifyPath(target, "file")
    await this.verifyDirectoryChain(dirname(target))
    await this.verifyResolvedParent(target)
    const before = await lstat(target)
    const handle = await open(
      target,
      fsConstants.O_RDONLY | optionalFsConstant("O_NOFOLLOW")
    )
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino
      ) {
        throw new SecureFileError(
          "The local state file changed while it was being opened."
        )
      }
      if (opened.size > MAX_LOCAL_FILE_BYTES) {
        throw new SecureFileError("The local state file is too large.")
      }
      await this.testHooks?.afterReadFileOpened?.(target)
      const chunks: Array<Buffer> = []
      let total = 0
      while (total <= MAX_LOCAL_FILE_BYTES) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, MAX_LOCAL_FILE_BYTES + 1 - total)
        )
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
        if (bytesRead === 0) break
        total += bytesRead
        chunks.push(chunk.subarray(0, bytesRead))
      }
      if (total > MAX_LOCAL_FILE_BYTES) {
        throw new SecureFileError("The local state file is too large.")
      }
      const after = await handle.stat()
      await this.testHooks?.afterReadHandleRestat?.(target)
      let pathAfter
      try {
        pathAfter = await lstat(target)
      } catch {
        throw new SecureFileError(
          "The local state file changed while it was being read."
        )
      }
      if (
        !after.isFile() ||
        !pathAfter.isFile() ||
        pathAfter.isSymbolicLink() ||
        opened.dev !== after.dev ||
        opened.ino !== after.ino ||
        opened.dev !== pathAfter.dev ||
        opened.ino !== pathAfter.ino ||
        opened.size !== after.size ||
        opened.size !== total ||
        opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs ||
        after.size !== pathAfter.size ||
        after.mtimeMs !== pathAfter.mtimeMs ||
        after.ctimeMs !== pathAfter.ctimeMs
      ) {
        throw new SecureFileError(
          "The local state file changed while it was being read."
        )
      }
      return decodeFatalUtf8(Buffer.concat(chunks, total))
    } finally {
      await handle.close()
    }
  }

  async atomicWrite(
    path: string,
    content: string,
    options: SecureMutationOptions = {}
  ): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > MAX_LOCAL_FILE_BYTES) {
      throw new SecureFileError("The local state file is too large.")
    }
    const lock = options.lock ?? "if_held"
    const target = this.assertContained(path)
    const parent = dirname(target)
    await this.ensureDirectory(parent)
    await this.lockCoordinator.assertOwned(lock)
    await this.verifyDirectoryChain(parent)
    let targetIdentity: FileIdentity | null = null
    if (await this.exists(target)) {
      await this.verifyPath(target, "file")
      await this.verifyResolvedParent(target)
      targetIdentity = await this.readFileIdentity(target)
    }
    const temporary = `${target}.tmp-${randomUUID()}`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          optionalFsConstant("O_NOFOLLOW"),
        FILE_MODE
      )
      await handle.writeFile(content, "utf8")
      await handle.sync()
      await handle.close()
      handle = null
      await this.secureCreatedFile(temporary)
      await this.verifyPath(temporary, "file")
      await this.lockCoordinator.assertOwned(lock)
      await this.assertFileIdentity(target, targetIdentity)
      if (this.platform === "win32") {
        await this.requireWindowsAcl().atomicReplace(temporary, target)
      } else {
        await rename(temporary, target)
      }
      await this.syncDirectory(parent)
      await this.verifyPath(target, "file")
      await this.verifyResolvedParent(target)
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  /**
   * 将完整、已 fsync 的临时文件以 no-replace 语义发布为目标文件。
   *
   * 同目录 hard-link 是 POSIX/Windows 都支持的原子 create-if-absent
   * primitive。目标已存在时绝不覆盖；发布成功但后续目录 fsync 失败时
   * 保留完整目标并向调用方报错，调用方因此不会继续不可逆网络操作。
   */
  async atomicCreate(
    path: string,
    content: string,
    options: SecureMutationOptions = {}
  ): Promise<AtomicCreateResult> {
    if (Buffer.byteLength(content, "utf8") > MAX_LOCAL_FILE_BYTES) {
      throw new SecureFileError("The local state file is too large.")
    }
    const lock = options.lock ?? "if_held"
    const target = this.assertContained(path)
    const parent = dirname(target)
    await this.ensureDirectory(parent)
    await this.lockCoordinator.assertOwned(lock)
    await this.verifyDirectoryChain(parent)
    const temporary = `${target}.tmp-${randomUUID()}`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          optionalFsConstant("O_NOFOLLOW"),
        FILE_MODE
      )
      await handle.writeFile(content, "utf8")
      await handle.sync()
      await handle.close()
      handle = null
      await this.secureCreatedFile(temporary)
      await this.verifyPath(temporary, "file")
      const temporaryIdentity = await this.readFileIdentity(temporary)
      await this.lockCoordinator.assertOwned(lock)
      try {
        await link(temporary, target)
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error
        await this.verifyPath(target, "file")
        await this.verifyResolvedParent(target)
        return "exists"
      }
      await this.assertFileIdentity(target, temporaryIdentity)
      await unlink(temporary)
      await this.syncDirectory(parent)
      await this.verifyPath(target, "file")
      await this.assertFileIdentity(target, temporaryIdentity)
      await this.verifyResolvedParent(target)
      return "created"
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      throw error
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }

  async removeSecureFile(
    path: string,
    options: SecureMutationOptions = {}
  ): Promise<boolean> {
    const lock = options.lock ?? "if_held"
    const target = this.assertContained(path)
    // required 的锁检查必须早于"文件不存在"短路：幂等删除同样是受 ABA
    // 保护的临界区，无锁时不能因为当下看不到文件就静默返回 false。
    // if_held 保持原有顺序，避免给既有调用点引入新的失败点。
    if (lock === "required") await this.lockCoordinator.assertOwned(lock)
    if (!(await this.exists(target))) return false
    await this.verifyPath(target, "file")
    await this.verifyDirectoryChain(dirname(target))
    await this.verifyResolvedParent(target)
    const targetIdentity = await this.readFileIdentity(target)
    await this.lockCoordinator.assertOwned(lock)
    await this.assertFileIdentity(target, targetIdentity)
    await unlink(target)
    await this.syncDirectory(dirname(target))
    return true
  }

  withLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
    return this.lockCoordinator.withLock(lockPath, action)
  }

  private async secureCreatedFile(path: string): Promise<void> {
    if (this.platform === "win32") {
      await this.requireWindowsAcl().secure(path, "file")
    } else {
      await chmod(path, FILE_MODE)
    }
  }

  private async verifyPath(
    path: string,
    kind: "file" | "directory"
  ): Promise<void> {
    const info = await lstat(path)
    if (
      info.isSymbolicLink() ||
      (kind === "file" ? !info.isFile() : !info.isDirectory())
    ) {
      throw new SecureFileError(`The local ${kind} path is unsafe.`)
    }
    if (this.platform === "win32") {
      if (!(await this.requireWindowsAcl().verify(path, kind))) {
        throw new SecureFileError(`The local ${kind} ACL is too broad.`)
      }
      return
    }
    const expected = kind === "file" ? FILE_MODE : DIRECTORY_MODE
    if (modeBits(info.mode) !== expected) {
      throw new SecureFileError(
        `The local ${kind} permissions must be ${expected.toString(8)}.`
      )
    }
    if (this.uid !== null && info.uid !== this.uid) {
      throw new SecureFileError(`The local ${kind} has an unexpected owner.`)
    }
  }

  private async verifyResolvedParent(path: string): Promise<void> {
    const resolvedParent = await realpath(dirname(path))
    const resolvedRoot = await realpath(this.root)
    const fromRoot = relative(resolvedRoot, resolvedParent)
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new SecureFileError("A local state file resolved outside its root.")
    }
  }

  private async readFileIdentity(path: string): Promise<FileIdentity> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SecureFileError("The local state file identity is unsafe.")
    }
    return { device: info.dev, inode: info.ino }
  }

  private async assertFileIdentity(
    path: string,
    expected: FileIdentity | null
  ): Promise<void> {
    let current: FileIdentity | null
    try {
      current = await this.readFileIdentity(path)
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") current = null
      else throw error
    }
    if (
      current?.device !== expected?.device ||
      current?.inode !== expected?.inode
    ) {
      throw new SecureFileError(
        "The local state file changed before the operation completed."
      )
    }
  }

  private async verifyDirectoryChain(path: string): Promise<void> {
    const target = this.assertContained(path)
    const fromRoot = relative(this.root, target)
    const segments =
      fromRoot.length === 0
        ? []
        : fromRoot.split(/[\\/]/u).filter((segment) => segment.length > 0)
    let current = this.root
    await this.verifyPath(current, "directory")
    for (const segment of segments) {
      current = resolve(current, segment)
      await this.verifyPath(current, "directory")
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    if (this.platform === "win32") return
    const before = await lstat(path)
    const handle = await open(
      path,
      fsConstants.O_RDONLY |
        optionalFsConstant("O_NOFOLLOW") |
        optionalFsConstant("O_DIRECTORY")
    )
    try {
      const opened = await handle.stat()
      if (
        !opened.isDirectory() ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino
      ) {
        throw new SecureFileError(
          "The local state directory changed while it was being synced."
        )
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private requireWindowsAcl(): WindowsAclController {
    if (!this.windowsAcl) {
      throw dependencyFailure(
        "Windows ACL verification is unavailable; refusing to store credentials."
      )
    }
    return this.windowsAcl
  }
}

interface FileIdentity {
  device: number
  inode: number
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
