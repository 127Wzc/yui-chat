import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { mediaCacheDir } from "../../core/media/media-cache.js"
import { fetchSafeHttp } from "../../core/network/safe-http-client.js"
import { linkSafetyConfig } from "../../core/network/link-safety-policy.js"
import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import { fetchJson } from "./shared.js"
import type { UnknownRecord } from "../../core/message/types.js"

export const imageSourceIds = ["bing", "baidu", "serp-bing", "serp-yandex", "pixiv"] as const
export type ImageSourceId = (typeof imageSourceIds)[number]

export interface ImageCandidate extends UnknownRecord {
  source: ImageSourceId
  title: string
  url: string
  thumbnail?: string
  site?: string
  width?: number
  height?: number
  pageUrl?: string
  author?: string
  authorId?: string
  artworkId?: string
  imageIndex?: number
  r18?: boolean
  downloadHeaders?: Record<string, string>
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function decodeHtml(value: unknown = ""): string {
  return text(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
}

function cleanImageUrl(value: unknown = ""): string {
  const url = decodeHtml(value).trim()
  return /^https?:\/\//i.test(url) ? url : ""
}

function compactImageResults(rows: unknown, source: ImageSourceId, limit: number): ImageCandidate[] {
  const seen = new Set<string>()
  const out: ImageCandidate[] = []
  for (const row of records(rows)) {
    const url = cleanImageUrl(row.url || row.murl || row.objURL || row.original || row.imgUrl)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({
      source,
      title: text(row.title || row.fromPageTitle || row.ptitle || row.desc || "image").replace(/<[^>]+>/g, "").slice(0, 120),
      url,
      thumbnail: cleanImageUrl(row.thumbnail || row.thumbUrl || row.thumbURL || row.turl),
      site: text(row.site || row.fromURLHost || row.host || row.from).slice(0, 100),
      width: Number(row.width || row.w || row.ow) || undefined,
      height: Number(row.height || row.h || row.oh) || undefined,
    })
    if (out.length >= limit) break
  }
  return out
}

async function fetchBaiduImages(query: string, limit: number, cfg: UnknownRecord): Promise<ImageCandidate[]> {
  const data = record(await fetchJson(`https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word=${encodeURIComponent(query)}&pn=0&rn=${limit}`, {
    headers: { "User-Agent": text(cfg.userAgent) || "Mozilla/5.0 Yui-Chat/0.1" },
    timeoutMs: Number(cfg.timeoutMs) || 12000,
  }))
  return compactImageResults(data.data, "baidu", limit)
}

async function fetchBingImages(query: string, limit: number, cfg: UnknownRecord): Promise<ImageCandidate[]> {
  const response = await fetchWithTimeout(`https://cn.bing.com/images/async?q=${encodeURIComponent(query)}&first=1&count=${limit}&adlt=off&mmasync=1`, {
    headers: { "User-Agent": text(cfg.userAgent) || "Mozilla/5.0 Yui-Chat/0.1" },
    timeoutMs: Number(cfg.timeoutMs) || 12000,
  })
  const html = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const rows: UnknownRecord[] = []
  const re = /class=["']iusc["'][^>]*\sm=["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    try {
      const meta = record(JSON.parse(decodeHtml(match[1])))
      const dimensions = record(meta.md)
      rows.push({ title: meta.t, url: meta.murl, thumbnail: meta.turl, site: meta.purl, width: dimensions.w, height: dimensions.h })
    } catch {
      // Bing 的单个 metadata 块损坏时跳过，其余候选仍可继续使用。
    }
  }
  return compactImageResults(rows, "bing", limit)
}

async function fetchSerpImages(query: string, limit: number, source: "bing" | "yandex", cfg: UnknownRecord): Promise<ImageCandidate[]> {
  const data = await fetchJson(`https://serp.ikechan8370.com/image/${source}?q=${encodeURIComponent(query)}&limit=${limit}`, {
    headers: { "User-Agent": text(cfg.userAgent) || "Mozilla/5.0 Yui-Chat/0.1" },
    timeoutMs: Number(cfg.timeoutMs) || 12000,
  })
  const payload = record(data)
  return compactImageResults(Array.isArray(data) ? data : payload.results || payload.data || [], source === "bing" ? "serp-bing" : "serp-yandex", limit)
}

async function fetchPixivImages(query: string, limit: number, cfg: UnknownRecord, r18: boolean): Promise<ImageCandidate[]> {
  const endpoint = text(cfg.pixivEndpoint || "https://api.lolicon.app/setu/v2").trim()
  const url = new URL(endpoint)
  url.searchParams.set("size", "regular")
  url.searchParams.set("tag", query)
  url.searchParams.set("num", String(Math.max(1, Math.min(limit, 10))))
  url.searchParams.set("r18", r18 ? "1" : "0")
  const payload = record(await fetchJson(url.toString(), {
    headers: { "User-Agent": text(cfg.userAgent) || "Yui-Chat/0.1 pixiv-search" },
    timeoutMs: Number(cfg.timeoutMs) || 12000,
  }))
  const out: ImageCandidate[] = []
  for (const item of records(payload.data)) {
    const urls = record(item.urls)
    const imageUrl = cleanImageUrl(urls.original || urls.regular || urls.small)
    if (!imageUrl) continue
    const artworkId = text(item.pid).trim()
    const page = artworkId ? `https://www.pixiv.net/artworks/${artworkId}` : ""
    const imageIndex = Number(item.p) || 0
    out.push({
      source: "pixiv",
      title: text(item.title || `Pixiv ${artworkId}`).slice(0, 120),
      url: imageUrl,
      thumbnail: cleanImageUrl(urls.small || urls.thumb_mini),
      site: "pixiv.net",
      pageUrl: page,
      author: text(item.author).slice(0, 100),
      authorId: text(item.uid),
      artworkId,
      imageIndex,
      width: Number(item.width) || undefined,
      height: Number(item.height) || undefined,
      r18: Number(item.r18) > 0,
      downloadHeaders: { Referer: page || "https://www.pixiv.net/", "User-Agent": text(cfg.userAgent) || "Mozilla/5.0 Yui-Chat/0.1" },
    })
  }
  return out.slice(0, limit)
}

export async function searchImageChannel(source: ImageSourceId, query: string, limit: number, cfg: UnknownRecord, options: { r18?: boolean } = {}): Promise<ImageCandidate[]> {
  if (source === "baidu") return fetchBaiduImages(query, limit, cfg)
  if (source === "serp-bing") return fetchSerpImages(query, limit, "bing", cfg)
  if (source === "serp-yandex") return fetchSerpImages(query, limit, "yandex", cfg)
  if (source === "pixiv") return fetchPixivImages(query, limit, cfg, options.r18 === true)
  return fetchBingImages(query, limit, cfg)
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") return ".png"
  if (mimeType === "image/webp") return ".webp"
  if (mimeType === "image/gif") return ".gif"
  return ".jpg"
}

/** 将最终选中的远程图片落入统一临时缓存，投递时不再依赖宿主二次下载。 */
export async function cacheImageCandidate(candidate: ImageCandidate, cfg: UnknownRecord, config: unknown, signal?: AbortSignal): Promise<UnknownRecord> {
  const id = crypto.createHash("sha256").update(candidate.url).digest("hex")
  await fs.mkdir(mediaCacheDir, { recursive: true })
  let entries: Array<{ name: string; isFile(): boolean }> = []
  try {
    entries = await fs.readdir(mediaCacheDir, { withFileTypes: true })
  } catch {
    // 首次运行尚无缓存目录时按空目录处理。
  }
  const existing = entries.find(entry => entry.isFile() && entry.name.startsWith(`image_${id}.`))?.name
  if (existing) {
    const file = path.join(mediaCacheDir, existing)
    const stat = await fs.stat(file).catch(() => null)
    if (stat?.isFile() && stat.size > 0) return { kind: "cache", value: file, name: existing }
  }
  const maxBytes = Math.max(1024 * 1024, Number(cfg.maxImageBytes) || 32 * 1024 * 1024)
  const response = await fetchSafeHttp(candidate.url, {
    allowPrivateHosts: linkSafetyConfig(config).allowPrivateHosts,
    maxBytes,
    timeoutMs: Number(cfg.downloadTimeoutMs || cfg.timeoutMs) || 30000,
    signal,
    headers: {
      Accept: "image/*",
      "User-Agent": text(cfg.userAgent) || "Mozilla/5.0 Yui-Chat/0.1",
      ...candidate.downloadHeaders,
    },
  })
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`)
  const mimeType = text(response.headers.get("content-type")).split(";", 1)[0].trim().toLowerCase()
  if (!mimeType.startsWith("image/")) throw new Error(`图片类型无效：${mimeType || "unknown"}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length) throw new Error("图片内容为空。")
  const file = path.join(mediaCacheDir, `image_${id}${extensionForMime(mimeType)}`)
  await fs.writeFile(file, bytes)
  return { kind: "cache", value: file, mimeType, name: path.basename(file) }
}
