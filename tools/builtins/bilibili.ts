import { fetchJson } from "./shared.js"
import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import type { UnknownRecord } from "../../core/message/types.js"

const BILIBILI_HOME = "https://www.bilibili.com"
const DUCKDUCKGO_HTML = "https://html.duckduckgo.com/html/"
const BILIBILI_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const BILIBILI_SESSION_TTL_MS = 20 * 60 * 1000
interface BilibiliSession {
  cookie: string
  expiresAt: number
}

let bilibiliSession: BilibiliSession = { cookie: "", expiresAt: 0 }
let sessionRefreshPromise: Promise<BilibiliSession> | null = null

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorStatus(error: unknown): number {
  const value = Number(record(error).status)
  return Number.isFinite(value) ? value : 0
}

function responseCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const values = headers.getSetCookie?.() || [headers.get("set-cookie")].filter(Boolean)
  return values.map(value => String(value).split(";", 1)[0]).filter(Boolean).join("; ")
}

function browserHeaders(cookie = ""): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: `${BILIBILI_HOME}/`,
    "User-Agent": BILIBILI_USER_AGENT,
    ...(cookie ? { Cookie: cookie } : {}),
  }
}

async function refreshBilibiliSession(): Promise<BilibiliSession> {
  const response = await fetchWithTimeout(BILIBILI_HOME, {
    headers: browserHeaders(),
    timeoutMs: 15000,
  })
  if (!response.ok) throw new Error(`Bilibili 会话初始化失败：HTTP ${response.status}`)
  bilibiliSession = {
    cookie: responseCookies(response),
    expiresAt: Date.now() + BILIBILI_SESSION_TTL_MS,
  }
  return bilibiliSession
}

async function currentBilibiliSession(force = false): Promise<BilibiliSession> {
  if (!force && bilibiliSession.expiresAt > Date.now()) return bilibiliSession
  if (!sessionRefreshPromise) {
    sessionRefreshPromise = refreshBilibiliSession().finally(() => {
      sessionRefreshPromise = null
    })
  }
  return sessionRefreshPromise
}

async function fetchBilibiliJson(url: string): Promise<UnknownRecord> {
  const request = async (session: BilibiliSession): Promise<UnknownRecord> => {
    const data = record(await fetchJson(url, { headers: browserHeaders(session.cookie) }))
    if (Number(data.code || 0) === 0) return data
    const error = Object.assign(new Error(`Bilibili API ${data.code}：${text(data.message) || "请求失败"}`), { status: Number(data.code) })
    if (Number(data.code) === -412) Object.assign(error, { status: 412 })
    throw error
  }
  let session = await currentBilibiliSession()
  try {
    return await request(session)
  } catch (error) {
    if (errorStatus(error) !== 412) throw error
    session = await currentBilibiliSession(true)
    return request(session)
  }
}

function decodeUrlComponent(value: unknown = ""): string {
  try {
    return decodeURIComponent(text(value).replace(/&amp;/g, "&"))
  } catch {
    return text(value)
  }
}

function duckDuckGoBilibiliResults(html: unknown = "", limit = 5): UnknownRecord[] {
  const rows: UnknownRecord[] = []
  const seen = new Set<string>()
  const pattern = /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const match of text(html).matchAll(pattern)) {
    const href = decodeHtml(match[1])
    const redirectTarget = href.match(/[?&]uddg=([^&]+)/i)?.[1]
    const target = decodeUrlComponent(redirectTarget || href)
    const bvid = target.match(/BV[0-9A-Za-z]+/i)?.[0]
    if (!bvid || seen.has(bvid.toUpperCase())) continue
    seen.add(bvid.toUpperCase())
    rows.push({
      title: cleanBilibiliTitle(match[2]).replace(/[_-]?哔哩哔哩(?:_bilibili)?$/i, "").trim(),
      author: "unknown",
      duration: "-",
      play: "-",
      bvid,
      aid: 0,
      url: buildBilibiliVideoUrl({ bvid }),
    })
    if (rows.length >= limit) break
  }
  return rows
}

async function searchBilibiliViaWebIndex(keyword: unknown, limit: number): Promise<UnknownRecord[]> {
  const query = `site:bilibili.com/video ${keyword}`
  const response = await fetchWithTimeout(`${DUCKDUCKGO_HTML}?q=${encodeURIComponent(query)}`, {
    timeoutMs: 15000,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent": BILIBILI_USER_AGENT,
    },
  })
  if (!response.ok) throw new Error(`B 站降级搜索失败：HTTP ${response.status}`)
  return duckDuckGoBilibiliResults(await response.text(), limit)
}

export function resetBilibiliSessionForTest(): void {
  bilibiliSession = { cookie: "", expiresAt: 0 }
  sessionRefreshPromise = null
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

export function cleanBilibiliTitle(value: unknown = ""): string {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function normalizeBilibiliVideoId(value: unknown = ""): string {
  const raw = text(value).trim()
  const bvid = raw.match(/BV[0-9A-Za-z]+/i)?.[0]
  if (bvid) return bvid
  const aid = raw.match(/(?:^|[/?#=&])av?(\d+)(?:$|[/?#=&])/i)?.[0]
  if (aid) return aid.replace(/^[^a-zA-Z0-9]*/, "")
  if (/^\d+$/.test(raw)) return raw
  return raw
}

export function isBilibiliVideoId(value: unknown = ""): boolean {
  const id = normalizeBilibiliVideoId(value)
  return /^BV[0-9A-Za-z]+$/i.test(id) || /^av?\d+$/i.test(id) || /^\d+$/.test(id)
}

export function buildBilibiliVideoUrl(item: UnknownRecord = {}): string {
  return item.bvid
    ? `https://www.bilibili.com/video/${item.bvid}`
    : item.aid
      ? `https://www.bilibili.com/video/av${item.aid}`
      : ""
}

export async function searchBilibiliVideos(keyword: unknown, limit = 5): Promise<UnknownRecord[]> {
  let data: UnknownRecord
  try {
    data = await fetchBilibiliJson(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(text(keyword))}`)
  } catch (error) {
    if (errorStatus(error) !== 412) throw error
    const fallbackRows = await searchBilibiliViaWebIndex(keyword, limit)
    if (fallbackRows.length) return fallbackRows
    throw new Error("B 站搜索触发风控，降级搜索也没有找到可用视频。", { cause: error })
  }
  const payload = record(data.data)
  const rows = Array.isArray(payload.result) ? payload.result.map(record).slice(0, limit) : []
  return rows.map(item => {
    const bvid = text(item.bvid).trim()
    const aid = Number(item.aid) || 0
    return {
      title: cleanBilibiliTitle(item.title || "Bilibili 视频"),
      author: String(item.author || "unknown"),
      duration: String(item.duration || "-"),
      play: String(item.play || "-"),
      bvid,
      aid,
      url: buildBilibiliVideoUrl({ bvid, aid }),
    }
  }).filter(item => item.url)
}

export function pickBilibiliVideo(rows: UnknownRecord[] = [], pick: unknown = "first"): UnknownRecord | null {
  if (!rows.length) return null
  const mode = String(pick || "first").trim().toLowerCase()
  if (mode === "random") return rows[Math.floor(Math.random() * rows.length)]
  return rows[0]
}

export async function fetchBilibiliVideoDetail(idOrUrl: unknown): Promise<UnknownRecord> {
  const id = normalizeBilibiliVideoId(idOrUrl)
  if (!isBilibiliVideoId(id)) throw new Error("B 站视频 ID 格式不正确，请提供 BV 号、av 号、纯数字 av 号或视频链接。")
  const isBvid = /^BV[0-9A-Za-z]+$/i.test(id)
  const aid = id.replace(/^av/i, "")
  const query = isBvid ? `bvid=${encodeURIComponent(id)}` : `aid=${encodeURIComponent(aid)}`
  const data = await fetchBilibiliJson(`https://api.bilibili.com/x/web-interface/view?${query}`)
  if (Number(data.code) !== 0 || !data.data) {
    throw new Error(text(data.message || data.code || "unknown"))
  }
  const item = record(data.data)
  return {
    ...item,
    title: cleanBilibiliTitle(item.title || "Bilibili 视频"),
    url: buildBilibiliVideoUrl(item),
  }
}

export async function fetchBilibiliVideoBuffer(item: UnknownRecord = {}, options: UnknownRecord = {}): Promise<Uint8Array> {
  const bvid = text(item.bvid).trim()
  const cid = Number(item.cid) || 0
  if (!bvid || !cid) throw new Error("B 站视频缺少 bvid 或 cid，无法获取播放地址。")
  const data = await fetchBilibiliJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=32&fnval=0`)
  const videoPayload = record(data.data)
  const durl = Array.isArray(videoPayload.durl) ? record(videoPayload.durl[0]) : {}
  const videoUrl = text(durl.url).trim()
  if (!videoUrl) throw new Error("B 站没有返回可下载的视频地址。")
  const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || 64 * 1024 * 1024)
  const signal = options.signal as AbortSignal | undefined
  const response = await fetchWithTimeout(videoUrl, {
    timeoutMs: Math.max(5000, Number(options.timeoutMs) || 120000),
    signal,
    headers: {
      ...browserHeaders((await currentBilibiliSession()).cookie),
      Accept: "*/*",
      Referer: `${BILIBILI_HOME}/video/${bvid}`,
    },
  })
  if (!response.ok) throw new Error(`B 站视频下载失败：HTTP ${response.status}`)
  const declaredBytes = Number(response.headers.get("content-length")) || 0
  if (declaredBytes > maxBytes) throw new Error(`B 站视频大小 ${declaredBytes} bytes，超过设置上限 ${maxBytes} bytes。`)
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error(`B 站视频大小 ${buffer.length} bytes，超过设置上限 ${maxBytes} bytes。`)
  return buffer
}
