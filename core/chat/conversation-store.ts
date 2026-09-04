import { configStore } from "../../config/store.js"
import { sqliteClient } from "../storage/sqlite/client.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import type { UnknownRecord } from "../message/types.js"

interface ParsedConversationKey {
  key: string
  channel: string
  scope: string
  type: "group" | "private" | "unknown"
  groupId?: string
  userId?: string
}

interface ConversationRow extends UnknownRecord {
  history_json?: unknown
  state_json?: unknown
  last_seen_at?: unknown
  expires_at?: unknown
}

interface WebTestSession {
  key: string
  channelId: string
  sessionId: string
  title: string
  messageCount: number
  lastSeen: number
  lastSeenAt: string
  messages: Array<{ role: "user" | "assistant"; text: string }>
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000
let lastSweepAt = 0

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function conversationTtlMs(): number {
  const chat = record(record(configStore.get()).chat)
  return Math.max(60000, Number(chat.conversationTtlMs) || 6 * 60 * 60 * 1000)
}

function historyOf(value: unknown): unknown[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function stateOf(value: unknown): UnknownRecord {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value
    return record(parsed)
  } catch {
    return {}
  }
}

function uniqueKeys(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))]
}

/** 解析 channel + 作用域键；内存和 SQLite 清理必须复用这一份语义。 */
export function parseConversationKey(key: unknown = ""): ParsedConversationKey {
  const value = text(key)
  const groupIndex = value.indexOf(":g:")
  const privateIndex = value.indexOf(":p:")
  const markerIndex = groupIndex >= 0 ? groupIndex : privateIndex
  if (markerIndex < 0) return { key: value, channel: value, scope: "", type: "unknown" }
  const channel = value.slice(0, markerIndex)
  const scope = value.slice(markerIndex + 1)
  const parts = scope.split(":")
  if (parts[0] === "g") return { key: value, channel, scope, type: "group", groupId: parts[1] || "", userId: parts[2] || "" }
  return { key: value, channel, scope, type: "private", userId: parts[1] || "" }
}

export function conversationScopeMatches(parsed: ParsedConversationKey, options: { isGroup?: boolean; groupId?: unknown; userId?: unknown } = {}): boolean {
  const userId = text(options.userId)
  if (options.isGroup) return parsed.type === "group" && text(parsed.groupId) === text(options.groupId) && text(parsed.userId) === userId
  return parsed.type === "private" && text(parsed.userId) === userId
}

function parseWebTestConversationKey(key: unknown): { key: string; channelId: string; sessionId: string } | null {
  const value = text(key)
  const marker = ":p:web-test-"
  const markerIndex = value.lastIndexOf(marker)
  if (markerIndex <= 0) return null
  const channelId = value.slice(0, markerIndex)
  const sessionId = value.slice(markerIndex + marker.length)
  return channelId && sessionId ? { key: value, channelId, sessionId } : null
}

function webTestSessionFromRow(row: ConversationRow): WebTestSession | null {
  const identity = parseWebTestConversationKey(row.conversation_key)
  if (!identity) return null
  const history = historyOf(row.history_json)
    .map(record)
    .filter(item => ["user", "assistant"].includes(text(item.role)) && text(item.content).trim())
    .map(item => ({ role: text(item.role) as "user" | "assistant", text: text(item.content) }))
  const firstUserMessage = history.find(item => item.role === "user")?.text || "新的测试对话"
  const lastSeen = Number(row.last_seen_at || 0)
  return { ...identity, title: firstUserMessage.slice(0, 60), messageCount: history.length, lastSeen, lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : "", messages: history }
}

/** SQLite 会话存储；只负责 TTL、键匹配和原子清理，不承载聊天编排。 */
export class ConversationStore {
  async get(key: string): Promise<{ history: unknown[]; lastSeen: number; usage: UnknownRecord; toolCalls: number; turns: unknown[]; protocolState: UnknownRecord } | null> {
    if (!sqliteClient.status.available) return null
    const conversation = await sqliteClient.get<ConversationRow>("SELECT history_json, state_json, last_seen_at, expires_at FROM conversations WHERE conversation_key = ?", [key])
    if (!conversation) return null
    if (Number(conversation.expires_at || 0) <= Date.now()) {
      await sqliteClient.run("DELETE FROM conversations WHERE conversation_key = ?", [key])
      return null
    }
    const state = stateOf(conversation.state_json)
    return {
      history: historyOf(conversation.history_json),
      lastSeen: Number(conversation.last_seen_at || 0),
      usage: record(state.usage),
      toolCalls: Number(state.toolCalls || 0),
      turns: Array.isArray(state.turns) ? state.turns : [],
      protocolState: record(state.protocolState),
    }
  }

  async save(input: { id: string; history?: readonly unknown[]; turns?: readonly unknown[]; usage?: UnknownRecord; toolCalls?: unknown; protocolState?: UnknownRecord }): Promise<boolean> {
    if (!sqliteClient.status.available) return false
    const now = Date.now()
    const expiresAt = now + conversationTtlMs()
    if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
      lastSweepAt = now
      await sqliteClient.run("DELETE FROM conversations WHERE expires_at <= ?", [now]).catch(error => {
        hostRuntime.logger?.warn?.("[yui-chat] 过期会话清扫失败，等待下个周期重试", error)
      })
    }
    const normalized = Array.isArray(input.history) ? input.history : []
    const state = {
      turns: Array.isArray(input.turns) ? input.turns : [],
      usage: record(input.usage),
      toolCalls: Math.max(0, Number(input.toolCalls || 0)),
      protocolState: record(input.protocolState),
    }
    await sqliteClient.run(
      `INSERT INTO conversations(conversation_key, history_json, state_json, last_seen_at, expires_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(conversation_key) DO UPDATE SET
         history_json=excluded.history_json,
         state_json=excluded.state_json,
         last_seen_at=excluded.last_seen_at,
         expires_at=excluded.expires_at`,
      [input.id, JSON.stringify(normalized), JSON.stringify(state), now, expiresAt],
    )
    return true
  }

  async clear(ids: unknown[] = []): Promise<number> {
    return (await this.clearKeys(ids)).length
  }

  async clearKeys(ids: unknown[] = []): Promise<string[]> {
    const keys = uniqueKeys(ids)
    if (!sqliteClient.status.available || !keys.length) return []
    const placeholders = keys.map(() => "?").join(",")
    const result = await sqliteClient.transaction([
      { sql: `SELECT conversation_key FROM conversations WHERE conversation_key IN (${placeholders})`, params: keys, mode: "all" },
      { sql: `DELETE FROM conversations WHERE conversation_key IN (${placeholders})`, params: keys },
    ])
    const rows = Array.isArray(result[0]) ? result[0] as UnknownRecord[] : []
    return rows.map(row => text(row.conversation_key))
  }

  async clearAllKeys(): Promise<string[]> {
    if (!sqliteClient.status.available) return []
    const result = await sqliteClient.transaction([
      { sql: "SELECT conversation_key FROM conversations", params: [], mode: "all" },
      { sql: "DELETE FROM conversations", params: [] },
    ])
    const rows = Array.isArray(result[0]) ? result[0] as UnknownRecord[] : []
    return rows.map(row => text(row.conversation_key))
  }

  async clearScopeKeys(options: { isGroup?: boolean; groupId?: unknown; userIds?: unknown[] } = {}): Promise<string[]> {
    const users = uniqueKeys(options.userIds)
    if (!sqliteClient.status.available || !users.length) return []
    const rows = await sqliteClient.all<UnknownRecord>("SELECT conversation_key FROM conversations", [])
    const matched = rows.map(row => text(row.conversation_key)).filter(key => {
      const parsed = parseConversationKey(key)
      return users.some(userId => conversationScopeMatches(parsed, { isGroup: options.isGroup, groupId: options.groupId, userId }))
    })
    return this.clearKeys(matched)
  }

  async touch(key: string): Promise<boolean> {
    if (!sqliteClient.status.available) return false
    const now = Date.now()
    const result = await sqliteClient.run("UPDATE conversations SET last_seen_at = ?, expires_at = ? WHERE conversation_key = ?", [now, now + conversationTtlMs(), key])
    return Number(result.changes || 0) > 0
  }

  async listWebTestSessions(options: { limit?: unknown } = {}): Promise<WebTestSession[]> {
    if (!sqliteClient.status.available) return []
    const max = Math.min(100, Math.max(1, Number(options.limit) || 50))
    const now = Date.now()
    await sqliteClient.run("DELETE FROM conversations WHERE expires_at <= ? AND instr(conversation_key, ':p:web-test-') > 0", [now])
    const rows = await sqliteClient.all<ConversationRow>(
      `SELECT conversation_key, history_json, last_seen_at
       FROM conversations
       WHERE expires_at > ? AND instr(conversation_key, ':p:web-test-') > 0
       ORDER BY last_seen_at DESC
       LIMIT ?`,
      [now, max],
    )
    return rows.map(webTestSessionFromRow).filter((row): row is WebTestSession => Boolean(row))
  }

  async deleteWebTestSession(key: string): Promise<number> {
    const identity = parseWebTestConversationKey(key)
    if (!identity || !sqliteClient.status.available) return 0
    return this.clear([identity.key])
  }
}

export const conversationStore = new ConversationStore()
