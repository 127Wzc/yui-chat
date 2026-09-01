import { sanitizeIdentifier } from "../../core/shared/identifiers.js"

type UnknownRecord = Record<string, unknown>

export interface WebTestEvent extends UnknownRecord {
  user_id: string
  self_id: string
  isPrivate: boolean
  isGroup: boolean
  isMaster: boolean
  msg: string
  raw_message: string
  message: UnknownRecord[]
  sender: UnknownRecord
}

export function sanitizeWebId(value: unknown = ""): string {
  return sanitizeIdentifier(value, 80, "custom")
}

export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean)
  if (typeof value === "string") return value.split(/[\n,，\s]+/).map(item => item.trim()).filter(Boolean)
  return []
}

export function createPermissionPreviewEvent(role: unknown, query: UnknownRecord = {}): UnknownRecord {
  const base = {
    user_id: query.userId || "10001",
    group_id: query.groupId || "20001",
    sender: { role: "member" },
  }
  if (role === "master") return { ...base, isMaster: true, isGroup: true, sender: { role: "owner" } }
  if (role === "groupOwner") return { ...base, isGroup: true, sender: { role: "owner" } }
  if (role === "groupAdmin") return { ...base, isGroup: true, sender: { role: "admin" } }
  return { ...base, isGroup: true, sender: { role: "member" } }
}

export function createWebTestEvent(sessionId: unknown, prompt = ""): WebTestEvent {
  const userId = `web-test-${sanitizeWebId(sessionId)}`
  const content = typeof prompt === "string" ? prompt : String(prompt ?? "")
  return {
    user_id: userId,
    self_id: "yui-chat-web",
    isPrivate: true,
    isGroup: false,
    isMaster: true,
    msg: content,
    raw_message: content,
    message: content ? [{ type: "text", data: { text: content } }] : [],
    sender: {
      user_id: userId,
      nickname: "Web 测试用户",
      card: "Web 测试用户",
      role: "owner",
    },
  }
}
