import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import type { UnknownRecord } from "../../core/message/types.js"
import { groupIdFromEvent, isGroupEvent } from "../../core/message/event-scope.js"

/** 将配置或工具参数中的列表值归一化为字符串数组。 */
export function arrayFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item || "")).filter(Boolean)
  return String(value || "").split(/[\s,，]+/).filter(Boolean)
}

/** 返回当前事件对应的群或私聊目标标识。 */
export function currentTarget(e: UnknownRecord = {}): string {
  const sender = e.sender && typeof e.sender === "object" ? e.sender as UnknownRecord : {}
  return isGroupEvent(e) ? groupIdFromEvent(e) : String(e?.user_id || sender.user_id || "")
}

/** 读取大于 0 的数字，否则使用安全默认值。 */
export function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? "").trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function currentUser(e: UnknownRecord = {}): number {
  const sender = e.sender && typeof e.sender === "object" ? e.sender as UnknownRecord : {}
  return Number(e.user_id || sender.user_id || 0)
}

export function currentGroup(e: UnknownRecord = {}): number {
  return Number(groupIdFromEvent(e) || 0)
}

export function isGroupAdmin(e: UnknownRecord = {}): boolean {
  const sender = e.sender && typeof e.sender === "object" ? e.sender as UnknownRecord : {}
  return Boolean(e.isMaster || ["owner", "admin"].includes(String(sender.role || "")))
}

export async function pickGroup(e: UnknownRecord = {}, groupId = currentGroup(e)): Promise<unknown> {
  if (!groupId) throw new Error("当前不是群聊，且没有指定 groupId")
  if (e.group && Number(groupIdFromEvent(e)) === Number(groupId)) return e.group
  const bot = e.bot && typeof e.bot === "object" ? e.bot as UnknownRecord : {}
  const pick = bot.pickGroup
  const group = typeof pick === "function" ? await pick.call(bot, Number(groupId), true) : null
  if (!group) throw new Error(`无法获取群 ${groupId}`)
  return group
}

export async function getMemberMap(group: unknown): Promise<Map<number, UnknownRecord> | null> {
  try {
    const target = group && typeof group === "object" ? group as UnknownRecord : {}
    const getMemberMap = target.getMemberMap
    const value = typeof getMemberMap === "function" ? await getMemberMap.call(target) : null
    return value instanceof Map ? value as Map<number, UnknownRecord> : null
  } catch {
    return null
  }
}

/** 从宿主对象中取方法并绑定 this，统一给内置工具使用。 */
export function requireMethod(target: unknown, name: string, label = name): (...args: unknown[]) => unknown {
  const record = target && typeof target === "object" ? target as UnknownRecord : {}
  if (typeof record[name] !== "function") throw new Error(`当前适配器不支持 ${label}。`)
  return record[name].bind(target) as (...args: unknown[]) => unknown
}

export async function fetchJson(url: string, options: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetchWithTimeout(url, { timeoutMs: 15000, ...options })
  const text = await response.text()
  let data: unknown = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: text }
    }
  }
  if (!response.ok) {
    const htmlError = /text\/html/i.test(response.headers.get("content-type") || "") || /^\s*<!doctype html/i.test(text)
    const errorPayload = data && typeof data === "object" ? data as UnknownRecord : {}
    const detail = response.status === 412 && htmlError
      ? "触发远端服务安全风控策略"
      : typeof errorPayload.message === "string"
      ? errorPayload.message
      : typeof errorPayload.error === "string"
        ? errorPayload.error.slice(0, 300)
        : text.slice(0, 300)
    throw Object.assign(new Error(`HTTP ${response.status}${detail ? `：${detail}` : ""}`), {
      status: response.status,
      url: String(url),
    })
  }
  return data
}

export function textFromHtml(html: unknown = "", maxChars = 6000): string {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
}

export function jsonSnippet(value: unknown, maxChars = 12000): string {
  return (JSON.stringify(value, null, 2) || "").slice(0, maxChars)
}
