import type { UnknownRecord } from "../core/message/types.js"

export interface MemoryScope extends UnknownRecord {
  scopeType: string
  ownerId: string
  groupId: string
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

export function userKey(event: unknown = {}): string {
  const value = record(event)
  const sender = record(value.sender)
  return text(value.user_id || sender.user_id || "unknown")
}

export function groupKey(event: unknown = {}): string {
  const value = record(event)
  return value.isGroup ? text(value.group_id || "unknown") : ""
}

export function scopeKey(event: unknown = {}): string {
  const value = record(event)
  return value.isGroup ? `group:${groupKey(value)}` : `private:${userKey(value)}`
}

/** 返回与 memory_items.scope_type 对齐的用户、群和群内用户作用域。 */
export function scopesFor(event: unknown = {}): MemoryScope[] {
  const userId = userKey(event)
  const groupId = groupKey(event)
  return [
    { scopeType: "user", ownerId: userId, groupId: "" },
    ...(groupId
      ? [{ scopeType: "group", ownerId: groupId, groupId }, { scopeType: "user_group", ownerId: userId, groupId }]
      : []),
  ]
}
