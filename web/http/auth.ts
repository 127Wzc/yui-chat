import crypto from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { configStore, registerConfigPublishHook, yunzaiRoot } from "../../config/store.js"
import type { RuntimeConfigObject } from "../../config/types.js"

type UnknownRecord = Record<string, unknown>

interface TokenEntry {
  userId: string
  expiresAt: number
}

interface WebRequest extends UnknownRecord {
  socket?: { remoteAddress?: unknown; encrypted?: boolean }
  headers?: Record<string, unknown>
  method?: unknown
  secure?: boolean
}

interface WebResponse {
  status(code: number): { json(payload: UnknownRecord): unknown }
  append(name: string, value: string): unknown
}

interface WebSession {
  token: string
  expiresAt: number
  ttlMs: number
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const quickLoginTokens = new Map<string, TokenEntry>()
const accessTokens = new Map<string, TokenEntry>()
const sessionCookieName = "yui_chat_session"
const quickLoginTtlMs = 3 * 60 * 1000

function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url")
}

function prune(map: Map<string, TokenEntry>): void {
  const now = Date.now()
  for (const [token, value] of map) {
    if ((value.expiresAt || 0) <= now) map.delete(token)
  }
}

function normalizedMountPath(config: RuntimeConfigObject = configStore.get()): string {
  const mountPath = text(record(config.web).mountPath || "/yui-chat")
  return mountPath.startsWith("/") ? mountPath : `/${mountPath}`
}

export function buildWebAddress(base: unknown, mountPath: unknown, quickCode?: unknown): string {
  const url = new URL(text(base).trim())
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Web 服务器地址前缀无效")
  }
  const basePath = url.pathname.replace(/\/+$/, "")
  const routePath = text(mountPath || "/yui-chat").replace(/^\/+|\/+$/g, "")
  url.pathname = `${basePath}/${routePath}/`.replace(/\/{2,}/g, "/")
  url.search = quickCode ? `?quick=${encodeURIComponent(text(quickCode))}` : ""
  url.hash = ""
  return url.toString()
}

async function readYunzaiServerUrls(): Promise<string[]> {
  try {
    const configModule = pathToFileURL(path.join(yunzaiRoot, "lib/config/config.js")).href
    const yunzaiConfig = (await import(configModule) as unknown as { default?: UnknownRecord }).default || {}
    const server = record(yunzaiConfig.server)
    const https = record(server.https)
    return [
      server.url,
      https.url,
    ].filter(Boolean).map(text)
  } catch {
    return []
  }
}

export function issueWebAccessToken(userId: unknown): WebSession {
  const accessToken = randomToken(24)
  const ttlMs = Number(record(configStore.get().web).accessTokenTtlMs) || 24 * 60 * 60 * 1000
  accessTokens.set(accessToken, {
    userId: text(userId || ""),
    expiresAt: Date.now() + ttlMs,
  })
  return { token: accessToken, expiresAt: Date.now() + ttlMs, ttlMs }
}

/** 仅供受宿主 master 权限保护的 #yui面板 命令签发；不提供 Web 签发入口。 */
export function issueQuickLogin(userId: unknown): { code: string; expiresAt: number; ttlMs: number } {
  prune(quickLoginTokens)
  const code = randomToken(16)
  const expiresAt = Date.now() + quickLoginTtlMs
  quickLoginTokens.set(code, { userId: text(userId || ""), expiresAt })
  return { code, expiresAt, ttlMs: quickLoginTtlMs }
}

/** 快捷码单次消费后换成浏览器短会话。 */
export function consumeQuickLogin(code: unknown): WebSession {
  prune(quickLoginTokens)
  const key = text(code).trim()
  const ticket = quickLoginTokens.get(key)
  if (!ticket) throw new Error("快捷登录码无效或已过期")
  quickLoginTokens.delete(key)
  return issueWebAccessToken(ticket.userId)
}

/** 长期凭证轮换后撤销全部既有浏览器短会话。 */
export function revokeWebSessions(): number {
  const count = accessTokens.size
  accessTokens.clear()
  return count
}

let observedAuthToken = text(record(configStore.get().web).authToken || "")
registerConfigPublishHook(snapshot => {
  const nextAuthToken = text(record(snapshot.web).authToken || "")
  if (observedAuthToken && nextAuthToken !== observedAuthToken) revokeWebSessions()
  observedAuthToken = nextAuthToken
})

export function validateConfiguredWebToken(token: unknown): boolean {
  const configuredToken = text(record(configStore.get().web).authToken || "").trim()
  if (!configuredToken || !token) return false
  const candidate = text(token)
  const expected = Buffer.from(configuredToken)
  const actual = Buffer.from(candidate)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export function validateWebToken(token: unknown): boolean {
  if (!token) return false
  if (validateConfiguredWebToken(token)) return true
  const candidate = text(token)
  prune(accessTokens)
  return accessTokens.has(candidate)
}

export function requireWebAuth(req: WebRequest, res: WebResponse, next: () => unknown): unknown {
  const headerToken = readWebHeaderToken(req)
  if (validateWebToken(headerToken)) return next()
  const sessionToken = readWebSessionToken(req)
  if (validateWebToken(sessionToken) && allowCookieRequest(req)) return next()
  res.status(401).json({ ok: false, error: "Unauthorized" })
}

export function readWebHeaderToken(req: WebRequest = {}): string {
  const customHeader = req?.headers?.["yui-chat-token"]
  const rawAuthorization = text(req?.headers?.authorization || "")
  const bearer = rawAuthorization.match(/^Bearer\s+(.+)$/i)?.[1]
  return text(customHeader || bearer || "").trim()
}

export function readWebSessionToken(req: WebRequest = {}): string {
  const cookie = text(req?.headers?.cookie || "")
    .split(";")
    .map(item => item.trim())
    .find(item => item.startsWith(`${sessionCookieName}=`))
  if (!cookie) return ""
  try {
    return decodeURIComponent(cookie.slice(sessionCookieName.length + 1))
  } catch {
    return ""
  }
}

export function readWebToken(req: WebRequest = {}): string {
  return readWebHeaderToken(req) || readWebSessionToken(req)
}

function allowCookieRequest(req: WebRequest): boolean {
  const method = text(req?.method || "GET").toUpperCase()
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true
  const fetchSite = text(req?.headers?.["sec-fetch-site"] || "").toLowerCase()
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false
  const origin = text(req?.headers?.origin || "").trim()
  if (!origin) return true
  try {
    return new URL(origin).host === text(req?.headers?.host || "")
  } catch {
    return false
  }
}

function cookieHeader(value: string, req: WebRequest, ttlMs = 0): string {
  const mountPath = normalizedMountPath()
  const attributes = [
    `${sessionCookieName}=${value ? encodeURIComponent(value) : ""}`,
    `Path=${mountPath}`,
    "HttpOnly",
    "SameSite=Strict",
    value ? `Max-Age=${Math.max(1, Math.floor(ttlMs / 1000))}` : "Max-Age=0",
  ]
  if (req?.secure || req?.socket?.encrypted) attributes.push("Secure")
  return attributes.join("; ")
}

export function setWebSessionCookie(req: WebRequest, res: WebResponse, session: WebSession): void {
  res.append("Set-Cookie", cookieHeader(session.token, req, session.ttlMs))
}

export function clearWebSession(req: WebRequest, res: WebResponse): void {
  const token = readWebSessionToken(req)
  if (token) accessTokens.delete(token)
  res.append("Set-Cookie", cookieHeader("", req))
}

export async function buildWebAddresses({ quickCode }: { quickCode?: unknown } = {}): Promise<{ custom: string[]; local: string[]; all: string[] }> {
  const config = await configStore.load()
  const mountPath = normalizedMountPath(config)
  const web = record(config.web)
  const explicit: string[] = []
  if (web.publicBaseUrl) explicit.push(text(web.publicBaseUrl))
  explicit.push(...(Array.isArray(web.publicBaseUrls) ? web.publicBaseUrls.map(text) : []))
  const configured = explicit.some(Boolean) ? explicit : await readYunzaiServerUrls()
  const bases = [...new Set(configured.filter(Boolean))]
  const custom = [...new Set(bases.flatMap(base => {
    try {
      return [buildWebAddress(base, mountPath, quickCode)]
    } catch {
      // 自动读取的 Yunzai 服务地址不由本插件校验；忽略无效项并保留本机后备地址。
      return []
    }
  }))]
  const local = [buildWebAddress(`http://localhost:${numberValue(web.port, 2536)}`, mountPath, quickCode)]
  return { custom, local, all: [...new Set([...custom, ...local])] }
}

export function authStats(): { accessTokens: number } {
  prune(quickLoginTokens)
  prune(accessTokens)
  return {
    accessTokens: accessTokens.size,
  }
}
