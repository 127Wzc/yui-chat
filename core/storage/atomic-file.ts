import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

/** 原子文件写入参数；临时文件权限默认只允许当前进程用户读取。 */
export interface AtomicFileOptions {
  mode?: number
  encoding?: string
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(directory, "r")
    await handle.sync()
  } catch {
    // best-effort：部分平台不支持同步目录句柄，文件替换本身仍然有效。
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** 通过同目录临时文件、fsync 和 rename 完成原子替换，避免半写配置。 */
export async function writeFileAtomic(file: string, contents: string, options: AtomicFileOptions = {}): Promise<void> {
  const directory = path.dirname(file)
  const temporaryFile = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  await fs.mkdir(directory, { recursive: true })
  try {
    handle = await fs.open(temporaryFile, "wx", options.mode ?? 0o600)
    await handle.writeFile(contents, options.encoding || "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryFile, file)
    await syncDirectory(directory)
  } finally {
    await handle?.close().catch(() => {})
    await fs.unlink(temporaryFile).catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error
    })
  }
}
