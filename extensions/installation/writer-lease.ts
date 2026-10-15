import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { isMainThread } from "node:worker_threads"
import { InstallationError } from "./types.js"

interface WriterLease { pid: number; nonce: string; processIdentity?: string }

// Shared by duplicate ESM imports in this runtime; execve discards this registry.
const ownerKey = Symbol.for("yui-chat.installation-writers")
const runtime = globalThis as unknown as Record<symbol, Map<string, string> | undefined>
const owners = runtime[ownerKey] ||= new Map<string, string>()

function code(error: unknown): string { return (error as NodeJS.ErrnoException)?.code || "" }

async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined
  try {
    const [stat, boot] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ])
    const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]
    return start && boot.trim() ? `${boot.trim()}:${start}` : undefined
  } catch (error) {
    // Restricted/missing procfs falls back conservatively to the PID liveness check.
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code(error))) return undefined
    throw error
  }
}

async function readLease(file: string): Promise<{ raw: string; lease: WriterLease } | undefined> {
  let raw: string
  try { raw = await fs.readFile(file, "utf8") } catch (error) {
    if (code(error) === "ENOENT") return undefined
    throw error
  }
  let lease: WriterLease
  try { lease = JSON.parse(raw) as WriterLease } catch {
    throw new InstallationError("INSTALLATION_WRITER_INVALID_LEASE")
  }
  if (!lease || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || typeof lease.nonce !== "string" || !lease.nonce
    || lease.processIdentity !== undefined && (typeof lease.processIdentity !== "string" || !lease.processIdentity)) {
    throw new InstallationError("INSTALLATION_WRITER_INVALID_LEASE")
  }
  return { raw, lease }
}

async function createLease(file: string, lease: WriterLease): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(lease))
  } catch (error) {
    // A failed write can leave incomplete JSON. Compare the created inode rather
    // than parsing that JSON, and never remove a replacement file during rollback.
    try {
      const created = await handle.stat()
      const current = await fs.stat(file).catch(statError => {
        if (code(statError) === "ENOENT") return undefined
        throw statError
      })
      if (current && current.dev === created.dev && current.ino === created.ino) await fs.unlink(file)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "INSTALLATION_LEASE_WRITE_CLEANUP_FAILED")
    }
    throw error
  } finally { await handle.close() }
}

async function stale(lease: WriterLease): Promise<boolean> {
  // Only the main thread may acquire a writer. A live owner in this runtime is
  // already excluded by owners, so a same-PID file belongs to the pre-execve runtime.
  if (lease.pid === process.pid) return true
  try { process.kill(lease.pid, 0) } catch (error) {
    if (code(error) === "ESRCH") return true
    throw error
  }
  const identity = lease.processIdentity ? await processIdentity(lease.pid) : undefined
  return Boolean(identity && identity !== lease.processIdentity)
}

/** Exclusive file creation remains the cross-process boundary; runtime ownership
 * distinguishes a duplicate installer from an execve restart that preserves PID. */
export async function acquireInstallationWriterLease(file: string): Promise<() => Promise<void>> {
  if (!isMainThread) throw new InstallationError("INSTALLATION_WRITER_MAIN_THREAD_REQUIRED")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const canonicalFile = path.join(await fs.realpath(path.dirname(file)), path.basename(file))
  if (owners.has(canonicalFile)) throw new InstallationError("INSTALLATION_WRITER_ALREADY_ACTIVE")
  const nonce = crypto.randomUUID()
  owners.set(canonicalFile, nonce)
  let acquired = false
  let releasing: Promise<void> | null = null
  const release = (): Promise<void> => {
    releasing ||= (async () => {
      if (owners.get(canonicalFile) !== nonce) return
      if (acquired && (await readLease(canonicalFile))?.lease.nonce === nonce) await fs.unlink(canonicalFile)
      owners.delete(canonicalFile)
    })().finally(() => { releasing = null })
    return releasing
  }
  try {
    const lease: WriterLease = { pid: process.pid, nonce, processIdentity: await processIdentity(process.pid) }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await createLease(canonicalFile, lease)
        acquired = true
        return release
      } catch (error) {
        if (code(error) !== "EEXIST") throw error
        const prior = await readLease(canonicalFile)
        if (!prior) continue
        if (!await stale(prior.lease)) throw new InstallationError("INSTALLATION_WRITER_ALREADY_ACTIVE")
        // Re-read after the liveness check rather than knowingly removing a new owner.
        if ((await readLease(canonicalFile))?.raw !== prior.raw) continue
        try { await fs.unlink(canonicalFile) } catch (unlinkError) {
          if (code(unlinkError) !== "ENOENT") throw unlinkError
        }
      }
    }
    throw new InstallationError("INSTALLATION_WRITER_ALREADY_ACTIVE")
  } catch (error) {
    owners.delete(canonicalFile)
    throw error
  }
}
