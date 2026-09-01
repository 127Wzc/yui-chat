import type { UnknownRecord } from "./types.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function eventTypes(event: unknown): string[] {
  const value = record(event)
  return [value.message_type, value.detail_type, value.notice_type]
    .map(item => text(item).trim().toLowerCase())
    .filter(Boolean)
}

/** 从不同适配器的宿主事件中读取当前群号；不依赖单一的 group_id 字段。 */
export function groupIdFromEvent(event: unknown = {}): string {
  const value = record(event)
  const group = record(value.group)
  return text(value.group_id || value.groupId || group.group_id || group.groupId || group.id).trim()
}

/**
 * 统一判断宿主事件是否处于群聊。
 * 明确的消息类型优先，避免携带来源群号的群临时私聊被误判成群聊；其余
 * 适配器可通过 isGroup、group_id 或 group 对象补足宿主没有设置的标记。
 */
export function isGroupEvent(event: unknown = {}): boolean {
  const value = record(event)
  const types = eventTypes(value)
  if (types.some(type => ["group", "guild", "channel"].includes(type))) return true
  if (types.some(type => ["private", "friend", "direct"].includes(type))) return false
  if (value.isGroup === true) return true
  if (value.isPrivate === true || value.isGroup === false) return false
  return Boolean(groupIdFromEvent(value))
}

/** 在对话或工具入口补齐统一群聊字段，保留原宿主事件对象及其方法。 */
export function normalizeEventScope<T extends UnknownRecord>(event: T): T {
  const value = event as UnknownRecord
  const groupId = groupIdFromEvent(value)
  if (isGroupEvent(value)) {
    value.isGroup = true
    value.isPrivate = false
    if (!value.group_id && groupId) value.group_id = groupId
  } else if (eventTypes(value).some(type => ["private", "friend", "direct"].includes(type)) || value.isPrivate === true) {
    value.isGroup = false
    value.isPrivate = true
  }
  return event
}
