import { estimateTokens, truncateTextToTokens } from "../core/chat/token-budget.js"
import type { UnknownRecord } from "../core/message/types.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function profileLines(profile: unknown = {}): string[] {
  const value = record(profile)
  const rows: string[] = []
  if (value.name) rows.push(`称呼：${text(value.name)}`)
  if (value.pronouns) rows.push(`代称：${text(value.pronouns)}`)
  if (list(value.interests).length) rows.push(`兴趣：${list(value.interests).map(text).join("、")}`)
  if (list(value.preferences).length) rows.push(`偏好：${list(value.preferences).map(text).join("、")}`)
  if (list(value.dislikes).length) rows.push(`不喜欢：${list(value.dislikes).map(text).join("、")}`)
  if (value.communicationStyle) rows.push(`交流风格：${text(value.communicationStyle)}`)
  if (value.notes) rows.push(`备注：${text(value.notes)}`)
  return rows
}

const MEMORY_PREFIXES: Record<string, Record<string, string>> = {
  group: { fact: "本群公共记忆", episode: "本群经历" },
  user_group: { fact: "该用户在本群的记忆", episode: "该用户在本群的记忆" },
  user: { fact: "该用户的长期记忆", episode: "相关经历" },
}

function memoryPrefix(item: UnknownRecord): string {
  const kind = item.type === "episode" ? "episode" : "fact"
  return MEMORY_PREFIXES[text(item.ownerType)]?.[kind] || (kind === "episode" ? "相关经历" : "记忆")
}

function memoryLabel(item: UnknownRecord): string {
  const prefix = memoryPrefix(item)
  const ownerType = text(item.ownerType)
  const ownerId = text(item.ownerId || item.owner_id).trim()
  if (!ownerId) return prefix
  if (ownerType === "group") return `${prefix}（群 ${ownerId}）`
  if (ownerType === "user" || ownerType === "user_group") return `${prefix}（QQ ${ownerId}）`
  return prefix
}

/** 将画像和召回记忆限制在预算内，并标注每条记忆的授权作用域。 */
export function buildMemoryPrompt(options: unknown = {}): string {
  const value = record(options)
  const profile = record(value.profile)
  const memories = list(value.memories).map(record)
  const tokenBudget = Math.max(30, Number(value.tokenBudget) || 2000)
  const lines: string[] = []
  if (Object.keys(profile).length) lines.push(`用户画像：\n${profileLines(profile).map(item => `- ${item}`).join("\n")}`)
  for (const item of memories) lines.push(`${memoryLabel(item)}：${text(item.text)}`)
  const accepted: string[] = []
  let used = 0
  for (const line of lines) {
    const current = truncateTextToTokens(line, Math.max(30, tokenBudget - used))
    const tokens = estimateTokens(current)
    if (used + tokens > tokenBudget) continue
    accepted.push(current)
    used += tokens
  }
  return accepted.length ? `以下为已授权的个人记忆，仅在与当前问题明确相关时使用：\n${accepted.join("\n")}` : ""
}
