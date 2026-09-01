import type { UnknownRecord } from "../message/types.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"

type Scope = { type: "global" } | { type: "group"; groupId: string }
type MuteRow = Scope & {
  key: string
  reason: string
  operatorId: string
  mutedAt: string
  until: number
}
interface BlockedRow {
  type: "user"
  userId: string
  key: string
  reason: string
  operatorId: string
  blockedAt: string
  until: number
}

const mutedScopes = new Map<string, MuteRow>()
const blockedUsers = new Map<string, BlockedRow>()

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).map(item => item.trim()).filter(Boolean)
  if (typeof value === "string") return value.split(/[,，;；|]/).map(item => item.trim()).filter(Boolean)
  return []
}

function userId(event: unknown): string {
  const e = record(event)
  return text(record(e.sender).user_id || e.user_id)
}

function groupId(event: unknown): string {
  return isGroupEvent(event) ? groupIdFromEvent(event) : ""
}

function isPrivate(event: unknown): boolean {
  const e = record(event)
  return Boolean(e.isPrivate || !isGroupEvent(e))
}

function matchAccessItem(item: string, event: unknown): boolean {
  const uid = userId(event)
  const gid = groupId(event)
  if (!item) return false
  if (item.startsWith("^")) return item.slice(1) === uid
  if (item.includes("^")) {
    const [group, user] = item.split("^")
    return Boolean(isGroupEvent(event) && group === gid && user === uid)
  }
  return Boolean(isGroupEvent(event) && item === gid)
}

function formatRemaining(until: number): string {
  if (until === Infinity) return "长期"
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000))
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)}小时`
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}分钟`
  return `${seconds}秒`
}

function blockedUserKey(value: unknown): string {
  const id = text(value).trim()
  return id ? `user:${id}` : ""
}

function scopeKey(scope: Scope): string {
  return scope.type === "global" ? "global" : `group:${scope.groupId}`
}

function scopeFromEvent(event: unknown, options: UnknownRecord): Scope {
  if (options.global) return { type: "global" }
  const id = text(options.groupId || groupId(event))
  return id ? { type: "group", groupId: id } : { type: "global" }
}

function durationUntil(value: unknown): number {
  if (value === Infinity) return Infinity
  return Date.now() + Math.max(1000, Number(value) || 0)
}

function pruneMuted(): void {
  const now = Date.now()
  for (const [key, row] of mutedScopes) if (row.until !== Infinity && row.until <= now) mutedScopes.delete(key)
}

function pruneBlockedUsers(): void {
  const now = Date.now()
  for (const [key, row] of blockedUsers) if (row.until !== Infinity && row.until <= now) blockedUsers.delete(key)
}

export function parseDuration(value: unknown = ""): number {
  const input = text(value).trim()
  if (!input) return Infinity
  const match = input.match(/(\d+(?:\.\d+)?)\s*(秒|s|分钟|分|min|小时|时|h|天|日|d)?/i)
  if (!match) return Infinity
  const numberValue = Number(match[1])
  const unit = match[2] || "分钟"
  if (!Number.isFinite(numberValue) || numberValue <= 0) return Infinity
  if (/秒|s/i.test(unit)) return Math.round(numberValue * 1000)
  if (/小时|时|h/i.test(unit)) return Math.round(numberValue * 60 * 60 * 1000)
  if (/天|日|d/i.test(unit)) return Math.round(numberValue * 24 * 60 * 60 * 1000)
  return Math.round(numberValue * 60 * 1000)
}

export function muteScope(event: unknown = {}, options: UnknownRecord = {}): MuteRow {
  pruneMuted()
  const scope = scopeFromEvent(event, options)
  const durationMs = options.durationMs ?? Infinity
  const row: MuteRow = {
    ...scope,
    key: scopeKey(scope),
    reason: text(options.reason),
    operatorId: text(options.operatorId || record(event).user_id),
    mutedAt: new Date().toISOString(),
    until: durationUntil(durationMs),
  }
  mutedScopes.set(row.key, row)
  return row
}

export function unmuteScope(event: unknown = {}, options: UnknownRecord = {}): boolean {
  pruneMuted()
  return mutedScopes.delete(scopeKey(scopeFromEvent(event, options)))
}

export function listMutedScopes(): Array<MuteRow & { remaining: string; untilAt: string }> {
  pruneMuted()
  return [...mutedScopes.values()].map(row => ({ ...row, remaining: formatRemaining(row.until), untilAt: row.until === Infinity ? "长期" : new Date(row.until).toISOString() }))
}

export function clearMutedScopes(): number {
  const count = mutedScopes.size
  mutedScopes.clear()
  return count
}

export function mutedStats(): { mutedScopes: number; blockedUsers: number } {
  return { mutedScopes: listMutedScopes().length, blockedUsers: listBlockedUsers().length }
}

function mutedScopeFor(event: unknown): MuteRow | null {
  pruneMuted()
  const globalMute = mutedScopes.get("global")
  if (globalMute) return globalMute
  const id = groupId(event)
  return id ? mutedScopes.get(`group:${id}`) || null : null
}

function blockedUserFor(event: unknown): BlockedRow | null {
  pruneBlockedUsers()
  return blockedUsers.get(blockedUserKey(userId(event))) || null
}

export function blockUser(event: unknown = {}, options: UnknownRecord = {}): BlockedRow {
  pruneBlockedUsers()
  const targetUserId = text(options.userId || userId(event)).trim()
  if (!targetUserId) throw new Error("缺少要屏蔽的用户 ID。")
  const row: BlockedRow = {
    type: "user",
    userId: targetUserId,
    key: blockedUserKey(targetUserId),
    reason: text(options.reason),
    operatorId: text(options.operatorId || userId(event)),
    blockedAt: new Date().toISOString(),
    until: durationUntil(options.durationMs ?? Infinity),
  }
  blockedUsers.set(row.key, row)
  return row
}

export function unblockUser(event: unknown = {}, options: UnknownRecord = {}): boolean {
  pruneBlockedUsers()
  return blockedUsers.delete(blockedUserKey(options.userId || userId(event)))
}

export function getBlockedUser(value: unknown): (BlockedRow & { remaining: string; untilAt: string }) | null {
  pruneBlockedUsers()
  const row = blockedUsers.get(blockedUserKey(value))
  return row ? { ...row, remaining: formatRemaining(row.until), untilAt: row.until === Infinity ? "长期" : new Date(row.until).toISOString() } : null
}

export function listBlockedUsers(): Array<BlockedRow & { remaining: string; untilAt: string }> {
  pruneBlockedUsers()
  return [...blockedUsers.values()].map(row => ({ ...row, remaining: formatRemaining(row.until), untilAt: row.until === Infinity ? "长期" : new Date(row.until).toISOString() }))
}

export function clearBlockedUsers(): number {
  const count = blockedUsers.size
  blockedUsers.clear()
  return count
}

export function checkAccess(event: unknown = {}, config: unknown = {}): { ok: boolean; silent?: boolean; reason?: string } {
  const e = record(event)
  const chat = record(record(config).chat)
  const access = record(chat.access)
  if (access.masterBypass !== false && e.isMaster === true) return { ok: true }
  const blocked = blockedUserFor(e)
  if (blocked) return { ok: false, silent: true, reason: `用户 ${blocked.userId} 已被临时屏蔽，剩余 ${formatRemaining(blocked.until)}` }
  const muted = mutedScopeFor(e)
  if (muted) {
    const scope = muted.type === "global" ? "全局" : `群 ${muted.groupId}`
    return { ok: false, silent: true, reason: `${scope}闭嘴中，剩余 ${formatRemaining(muted.until)}` }
  }
  if (isPrivate(e) && access.privateChatEnabled === false) return { ok: false, silent: true, reason: "私聊对话已关闭" }
  const whitelist = normalizeList(access.whitelist)
  const blacklist = normalizeList(access.blacklist)
  if (blacklist.some(item => matchAccessItem(item, e))) return { ok: false, silent: true, reason: "命中对话黑名单" }
  if (whitelist.length && !whitelist.some(item => matchAccessItem(item, e))) return { ok: false, silent: true, reason: "不在对话白名单中" }
  return { ok: true }
}

export const accessControl = {
  checkAccess, muteScope, unmuteScope, listMutedScopes, clearMutedScopes, mutedStats,
  parseDuration, blockUser, unblockUser, getBlockedUser, listBlockedUsers, clearBlockedUsers,
}
