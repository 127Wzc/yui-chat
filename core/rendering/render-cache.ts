import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { tempDir } from "../../config/store.js"

type UnknownRecord = Record<string, unknown>

interface RenderCacheEntry extends UnknownRecord {
  id: string
  pngFile: string
  metaFile: string
  size: number
}

interface RenderCacheStats extends UnknownRecord {
  files: number
  bytes: number
  dir: string
}

interface RenderCleanupOptions extends UnknownRecord {
  mode?: string
  cacheTtlMs?: unknown
  ttlMs?: unknown
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

const renderCacheDir = path.join(tempDir, "render")
const renderScratchDirs = [path.join(tempDir, "render-html")]

function cacheEnabled(config: UnknownRecord = {}): boolean {
  const response = record(config.response)
  return record(response.render).cache !== false
}

export async function persistRender(kind: unknown, buffer: Uint8Array, meta: unknown, config: UnknownRecord = {}): Promise<RenderCacheEntry | null> {
  if (!cacheEnabled(config)) return null
  await fs.mkdir(renderCacheDir, { recursive: true })
  const id = crypto.createHash("sha256")
    .update(JSON.stringify({ kind, meta, size: buffer.length, now: Date.now() }))
    .digest("hex")
  const pngFile = path.join(renderCacheDir, `${id}.png`)
  const metaFile = path.join(renderCacheDir, `${id}.json`)
  await fs.writeFile(pngFile, buffer)
  await fs.writeFile(metaFile, `${JSON.stringify({
    id,
    kind,
    pngFile,
    size: buffer.length,
    cachedAt: Date.now(),
    meta,
  }, null, 2)}\n`, "utf8")
  return { id, pngFile, metaFile, size: buffer.length }
}

export async function renderCacheStats(): Promise<RenderCacheStats> {
  let files = 0
  let bytes = 0
  for (const dir of [renderCacheDir, ...renderScratchDirs]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        files++
        try {
          const stat = await fs.stat(path.join(dir, entry.name))
          bytes += stat.size
        } catch { /* best-effort：单个文件消失不影响统计。 */ }
      }
    } catch { /* best-effort：目录不存在或不可读时按空目录处理。 */ }
  }
  return { files, bytes, dir: renderCacheDir }
}

export async function cleanupRenderCache(opts: RenderCleanupOptions = {}): Promise<RenderCleanupOptions & { files: number; bytes: number; ttlMs: number; dir: string }> {
  await fs.mkdir(renderCacheDir, { recursive: true })
  const mode = opts.mode || "expired"
  let files = 0
  let bytes = 0
  const ttlMs = Math.max(0, Number(opts.cacheTtlMs ?? opts.ttlMs ?? 24 * 60 * 60 * 1000))
  for (const dir of [renderCacheDir, ...renderScratchDirs]) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = path.join(dir, entry.name)
      try {
        const stat = await fs.stat(file)
        if (mode !== "all" && Date.now() - stat.mtimeMs <= ttlMs) continue
        bytes += stat.size
        await fs.unlink(file)
        files++
      } catch { /* best-effort：并发删除或单文件失败不影响清理。 */ }
    }
  }
  return { mode, files, bytes, ttlMs, dir: renderCacheDir }
}
