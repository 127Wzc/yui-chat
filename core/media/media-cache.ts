import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import { tempDir } from "../../config/store.js"
import { assertSafeHttpUrl, linkSafetyConfig, resolveTrustedResourceRequest } from "../network/link-safety-policy.js"
import { fetchSafeHttp } from "../network/safe-http-client.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import type { UnknownRecord } from "../message/types.js"

type MediaAttachment = UnknownRecord & {
  kind?: unknown
  url?: unknown
  source?: unknown
}

type MediaResult = {
  dataUrl: string
  thumbnailDataUrl?: string
  mimeType: string
  size: number
  cached: boolean
}

type BufferLike = Uint8Array & {
  toString(encoding?: string): string
}

export const mediaCacheDir = path.join(tempDir, "media-cache")
const defaultAllowedMime = ["image/jpeg", "image/png", "image/webp", "image/gif"]

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bufferFactory(): {
  from(value: string | ArrayBuffer | Uint8Array, encoding?: string): BufferLike
} | null {
  const value = (globalThis as typeof globalThis & {
    Buffer?: { from(input: string | ArrayBuffer | Uint8Array, encoding?: string): BufferLike }
  }).Buffer
  return value || null
}

function bufferFrom(value: string | ArrayBuffer | Uint8Array, encoding?: string): BufferLike {
  const factory = bufferFactory()
  if (factory) return factory.from(value, encoding)
  if (typeof value === "string") throw new Error("当前运行时缺少 Buffer，无法解码媒体数据。")
  return value instanceof Uint8Array ? value as BufferLike : new Uint8Array(value) as BufferLike
}

function mediaConfig(config: unknown): { remoteFetch: UnknownRecord; thumbnail: UnknownRecord } {
  const root = record(config)
  const recognition = record(root.mediaRecognition)
  const response = record(root.response)
  const render = record(response.render)
  return {
    remoteFetch: {
      enabled: true,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 10000,
      maxAttachments: 3,
      cacheTtlMs: 24 * 60 * 60 * 1000,
      allowedMimeTypes: defaultAllowedMime,
      ...record(recognition.remoteFetch),
    },
    thumbnail: {
      enabled: true,
      maxWidth: 320,
      maxHeight: 220,
      quality: 76,
      format: "jpeg",
      maxSourceBytes: 4 * 1024 * 1024,
      ...record(render.mediaThumbnail),
    },
  }
}

function hash(value: unknown = ""): string {
  return crypto.createHash("sha256").update(text(value)).digest("hex")
}

async function cachePaths(url: string): Promise<{ id: string; metaFile: string; dataFile: string }> {
  await fs.mkdir(mediaCacheDir, { recursive: true })
  const id = hash(url)
  return {
    id,
    metaFile: path.join(mediaCacheDir, `${id}.json`),
    dataFile: path.join(mediaCacheDir, `${id}.bin`),
  }
}

function toDataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${bufferFrom(bytes).toString("base64")}`
}

async function readCached(url: string, cacheTtlMs: number): Promise<MediaResult | null> {
  return readCachedKey(hash(url), cacheTtlMs)
}

async function readCachedKey(key: string, cacheTtlMs: number, maxBytes = 4 * 1024 * 1024): Promise<MediaResult | null> {
  if (!/^[a-f0-9]{64}$/.test(key)) return null
  const files = { metaFile: path.join(mediaCacheDir, `${key}.json`), dataFile: path.join(mediaCacheDir, `${key}.bin`) }
  try {
    const meta = record(JSON.parse(await fs.readFile(files.metaFile, "utf8")))
    if (Date.now() - number(meta.cachedAt) > cacheTtlMs) return null
    if ((await fs.stat(files.dataFile)).size > maxBytes) return null
    const data = await fs.readFile(files.dataFile)
    return {
      dataUrl: toDataUrl(text(meta.mimeType), data),
      mimeType: text(meta.mimeType),
      size: data.length,
      cached: true,
    }
  } catch {
    // 缓存缺失、过期或损坏时回源请求，不阻断当前媒体识别。
    return null
  }
}

async function writeCached(url: string, mimeType: string, bytes: Uint8Array): Promise<void> {
  const files = await cachePaths(url)
  await fs.writeFile(files.dataFile, bytes)
  await fs.writeFile(files.metaFile, `${JSON.stringify({ url: /^data:/i.test(url) ? undefined : url, mimeType, size: bytes.length, cachedAt: Date.now() }, null, 2)}\n`, "utf8")
}

function parseDataImageUrl(dataUrl: unknown): { mimeType: string; bytes: BufferLike } | null {
  const match = text(dataUrl).match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/i)
  if (!match) return null
  return {
    mimeType: match[1].toLowerCase().replace("image/jpg", "image/jpeg"),
    bytes: bufferFrom(match[2].replace(/\s+/g, ""), "base64"),
  }
}

async function makeThumbnailDataUrl(bytes: Uint8Array, options: UnknownRecord): Promise<string> {
  if (options.enabled === false || !(bytes instanceof Uint8Array) || !bytes.length) return ""
  if (bytes.length > Math.max(1024, number(options.maxSourceBytes, 4 * 1024 * 1024))) return ""
  const format = text(options.format || "jpeg").toLowerCase() === "webp" ? "webp" : "jpeg"
  const resized = await sharp(bytes, { animated: false, limitInputPixels: 12000000 })
    .rotate()
    .resize({
      width: Math.max(80, number(options.maxWidth, 320)),
      height: Math.max(80, number(options.maxHeight, 220)),
      fit: "inside",
      withoutEnlargement: true,
    })
    [format]({ quality: Math.max(40, Math.min(95, number(options.quality, 76))) })
    .toBuffer()
  return `data:image/${format};base64,${bufferFrom(resized).toString("base64")}`
}

async function thumbnailFromDataUrl(dataUrl: unknown, options: UnknownRecord): Promise<string> {
  const parsed = parseDataImageUrl(dataUrl)
  if (!parsed) return ""
  try {
    return await makeThumbnailDataUrl(parsed.bytes, options)
  } catch {
    // 缩略图是可选优化，原图准备成功时不能因缩略图失败而使整条消息失败。
    return ""
  }
}

async function fetchRemoteImage(url: string, options: UnknownRecord, config: unknown, useCache = true): Promise<MediaResult> {
  const safety = linkSafetyConfig(config)
  const trustedRequest = resolveTrustedResourceRequest(url, ["qq-media"], config)
  const allowPrivateHosts = safety.allowPrivateHosts || trustedRequest?.allowPrivateHosts === true
  const safeUrl = trustedRequest?.url || await assertSafeHttpUrl(url, { allowPrivateHosts })
  if (useCache) {
    const cached = await readCached(safeUrl, number(options.cacheTtlMs))
    if (cached) return { ...cached, thumbnailDataUrl: await thumbnailFromDataUrl(cached.dataUrl, record(options.thumbnail)) }
  }

  const response = await fetchSafeHttp(safeUrl, {
    method: "GET",
    allowPrivateHosts,
    maxBytes: number(options.maxBytes, 2 * 1024 * 1024),
    timeoutMs: number(options.timeoutMs, 15000),
    headers: { "User-Agent": "Yui-Chat/0.1 media-fetch", Accept: "image/*" },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const maxBytes = number(options.maxBytes, 2 * 1024 * 1024)
  const contentLength = number(response.headers.get("content-length"))
  if (contentLength && contentLength > maxBytes) throw new Error(`媒体大小超过限制：${maxBytes} bytes`)
  const mimeType = text(response.headers.get("content-type")).split(";")[0].trim().toLowerCase()
  const allowed = new Set(Array.isArray(options.allowedMimeTypes) ? options.allowedMimeTypes.map(text) : defaultAllowedMime)
  if (!allowed.has(mimeType)) throw new Error(`不支持的媒体类型：${mimeType || "unknown"}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (useCache) await writeCached(safeUrl, mimeType, bytes)
  return {
    dataUrl: toDataUrl(mimeType, bytes),
    thumbnailDataUrl: await makeThumbnailDataUrl(bytes, record(options.thumbnail)).catch(error => {
      hostRuntime.logger?.warn?.("[yui-chat] 远程媒体缩略图生成失败", error)
      return ""
    }),
    mimeType,
    size: bytes.length,
    cached: false,
  }
}

/** 准备可安全传给视觉模型的图片；普通图片可缓存，引用图片始终只在本轮使用。 */
export async function prepareMediaForVision(media: unknown = {}, config: unknown = {}): Promise<unknown> {
  const input = record(media)
  const cfg = mediaConfig(config)
  const options: UnknownRecord = { ...cfg.remoteFetch, thumbnail: cfg.thumbnail }
  if (!Object.keys(input).length) return media
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []).map(item => ({ ...record(item) })) as MediaAttachment[]
  const diagnostics = Array.isArray(input.diagnostics) ? [...input.diagnostics] : []
  const next: UnknownRecord = { ...input, attachments, diagnostics }
  let processed = 0
  // 比较时先为两种来源各保留一张，避免引用中的多图挤掉本次新图。
  const candidates = attachments.filter(item => item.kind === "image" && item.visionEligible !== false)
  const other = candidates.find(item => item.source !== candidates[0]?.source)
  const preparationOrder = input.imageFocus === "both" && other
    ? [...new Set([candidates[0], other, ...attachments])]
    : attachments
  for (const attachment of preparationOrder) {
    const kind = text(attachment.kind)
    const url = text(attachment.url)
    if (kind !== "image") continue
    if (attachment.source === "quote") {
      // 调用方不能把上一次请求留下的已准备内容带回引用；每次引用都
      // 必须由刚解析出的 URL 重新准备，且不允许携带缓存键或命中标记。
      delete attachment.preparedUrl
      delete attachment.cacheKey
      delete attachment.cached
      delete attachment.thumbnailDataUrl
      delete attachment.originalUrl
    }
    if (attachment.visionEligible === false) {
      attachment.visionSkipped = true
      continue
    }
    if (processed >= Math.max(0, number(options.maxAttachments))) {
      attachment.limitSkipped = true
      delete attachment.preparedUrl
      continue
    }
    if (attachment.source !== "quote" && attachment.cacheKey && attachment.fromHistory) {
      const cached = await readCachedKey(text(attachment.cacheKey), number(options.cacheTtlMs), number(options.maxBytes))
      if (cached) {
        attachment.preparedUrl = cached.dataUrl
        attachment.cached = true
        processed += 1
      } else {
        attachment.prepareError = "之前讨论的图片缓存已过期或不可用，需要重新提供图片。"
        diagnostics.push(attachment.prepareError)
      }
      continue
    }
    if (!url) continue
    // 引用消息里的 URL 可能是短时签名地址。它必须使用本轮由 getMessage
    // 取得的最新值并即时解码，既不读取旧缓存，也不把正文写回缓存。
    const cacheable = attachment.source !== "quote"
    if (/^data:/i.test(url)) {
      const parsed = parseDataImageUrl(url)
      if (!parsed || parsed.bytes.length > number(options.maxBytes)) {
        attachment.prepareError = "图片格式无效或超过大小限制。"
        diagnostics.push(attachment.prepareError)
        continue
      }
      attachment.preparedUrl = url
      attachment.thumbnailDataUrl = await thumbnailFromDataUrl(url, cfg.thumbnail)
      if (cacheable) {
        try {
          await writeCached(url, parsed.mimeType, parsed.bytes)
          attachment.cacheKey = hash(url)
        } catch (error) {
          // 缓存只用于下一轮按需回看，写入失败不影响本轮已准备好的图片。
          hostRuntime.logger?.warn?.("[yui-chat] 图片上下文缓存失败", error)
        }
      }
      processed += 1
      continue
    }
    if (options.enabled === false && /^https?:/i.test(url)) {
      // 管理员显式关闭本地预取时，仍允许视觉模型自行读取已筛选的远程图片。
      attachment.preparedUrl = url
      processed += 1
      continue
    }
    if (!/^https?:/i.test(url)) {
      attachment.prepareError = "仅支持 http/https 或 data:image 媒体输入，本地文件和其他协议不会传给视觉模型。"
      diagnostics.push(`媒体 ${text(attachment.source || attachment.kind || "unknown")} 已跳过：${text(attachment.prepareError)}`)
      continue
    }
    try {
      attachment.originalUrl = url
      const result = await fetchRemoteImage(url, options, config, cacheable)
      attachment.url = result.dataUrl
      attachment.preparedUrl = result.dataUrl
      attachment.thumbnailDataUrl = result.thumbnailDataUrl || ""
      attachment.mimeType = result.mimeType
      attachment.size = result.size
      attachment.cached = result.cached
      if (cacheable) attachment.cacheKey = hash(url)
      processed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      delete attachment.preparedUrl
      attachment.prepareError = message
      diagnostics.push(`媒体 ${url} 下载失败：${message}`)
    }
  }
  return next
}

export async function mediaCacheStats(): Promise<{ files: number; bytes: number; dir: string }> {
  try {
    const entries = await fs.readdir(mediaCacheDir, { withFileTypes: true })
    let bytes = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        bytes += (await fs.stat(path.join(mediaCacheDir, entry.name))).size
      } catch {
        // 单个文件被并发清理时忽略该文件，统计仍然可用。
      }
    }
    return { files: entries.filter(entry => entry.isFile()).length, bytes, dir: mediaCacheDir }
  } catch {
    return { files: 0, bytes: 0, dir: mediaCacheDir }
  }
}

async function removeCachePair(id: string): Promise<{ files: number; bytes: number }> {
  const removed = { files: 0, bytes: 0 }
  for (const suffix of [".json", ".bin"]) {
    const file = path.join(mediaCacheDir, `${id}${suffix}`)
    try {
      const stat = await fs.stat(file)
      removed.bytes += stat.size
      await fs.unlink(file)
      removed.files += 1
    } catch (error) {
      if (record(error).code !== "ENOENT") throw error
    }
  }
  return removed
}

export async function cleanupMediaCache(options: unknown = {}): Promise<UnknownRecord> {
  const opts = record(options)
  await fs.mkdir(mediaCacheDir, { recursive: true })
  const mode = text(opts.mode || "expired")
  if (mode === "all") {
    const entries = await fs.readdir(mediaCacheDir, { withFileTypes: true })
    let files = 0
    let bytes = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = path.join(mediaCacheDir, entry.name)
      try {
        const stat = await fs.stat(file)
        bytes += stat.size
        await fs.unlink(file)
        files += 1
      } catch {
        // 清理是尽力而为操作，单个文件失败不影响其余缓存。
      }
    }
    return { mode, files, bytes, dir: mediaCacheDir }
  }

  const ttlMs = Math.max(0, number(opts.cacheTtlMs ?? opts.ttlMs, 24 * 60 * 60 * 1000))
  const entries = await fs.readdir(mediaCacheDir, { withFileTypes: true })
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const metaFile = path.join(mediaCacheDir, entry.name)
    try {
      const meta = record(JSON.parse(await fs.readFile(metaFile, "utf8")))
      if (Date.now() - number(meta.cachedAt) <= ttlMs) continue
      const removed = await removeCachePair(entry.name.replace(/\.json$/, ""))
      files += removed.files
      bytes += removed.bytes
    } catch {
      const removed = await removeCachePair(entry.name.replace(/\.json$/, ""))
      files += removed.files
      bytes += removed.bytes
    }
  }
  // B 站封面/视频是可直接交给 message_send 的独立缓存文件，
  // 没有 URL 缓存的 .json/.bin 配对，因此按 mtime 纳入同一 TTL 清理。
  for (const entry of entries) {
    if (!entry.isFile() || !/^bilibili_.+\.(?:mp4|jpe?g|png|webp|gif)$/i.test(entry.name)) continue
    const file = path.join(mediaCacheDir, entry.name)
    try {
      const stat = await fs.stat(file)
      if (Date.now() - stat.mtimeMs <= ttlMs) continue
      await fs.unlink(file)
      files += 1
      bytes += stat.size
    } catch {
      // 并发清理已删除文件时忽略。
    }
  }
  return { mode, files, bytes, ttlMs, dir: mediaCacheDir }
}
