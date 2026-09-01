import type { UnknownRecord } from "../core/message/types.js"
import { extractMessageContext } from "../core/message/message-context.js"

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

function scopeIdentity(scope: MemoryScope): string {
  return `${scope.scopeType}|${scope.ownerId}|${scope.groupId || ""}`
}

const MEMORY_RECALL_INTENT = /(?:记得|记忆|以前|曾经|过去|说过|提过|聊过|经历|关系|认识|了解|介绍|是谁|什么人|怎么样|近况|喜欢|不喜欢|讨厌|偏好|爱好|兴趣|习惯|性格|昵称|名字|称呼|叫(?:什|啥)|年龄|几岁|生日|职业|工作|学校|专业|常玩|最常|计划|打算|想要|适合|推荐|建议|选(?:择)?|买什么|吃什么|喝什么|送什么)/i
const SPEAKER_COMPARISON_INTENT = /(?:(?:我|我们|咱们|本人).{0,12}(?:和|跟|与|相比|区别|共同)|(?:和|跟|与).{0,12}(?:我|我们|咱们|本人))/i

/** 轻量判断当前问题是否可能受个人事实、偏好或经历影响；不调用模型。 */
export function hasMemoryRecallIntent(query: unknown = ""): boolean {
  return MEMORY_RECALL_INTENT.test(text(query))
}

export function hasSpeakerComparisonIntent(query: unknown = ""): boolean {
  return SPEAKER_COMPARISON_INTENT.test(text(query))
}

/** 返回群聊消息中明确 @ 到的成员 QQ；私聊和 @全体不产生目标。 */
export function mentionedUserIds(event: unknown = {}): string[] {
  const value = record(event)
  if (!groupKey(value)) return []
  const context = extractMessageContext(event)
  const bot = record(value.bot)
  const excluded = new Set([
    userKey(value),
    text(value.self_id).trim(),
    ...(Array.isArray(bot.uin) ? bot.uin : [bot.uin]).map(item => text(item).trim()),
    "all",
  ].filter(Boolean))
  return [...new Set((context.mentions || [])
    .map(item => text(item.qq).trim())
    .filter(userId => userId && !excluded.has(userId)))]
}

/**
 * 返回普通记忆检索可见的作用域。
 *
 * 目标成员必须由上层意图判断后显式传入；这里只负责组合和去重。
 * targetOnly 用于询问他人时排除提问者个人作用域，避免记忆相互竞争。
 */
export function recallScopesFor(event: unknown = {}, targetUserIds: unknown[] = [], { targetOnly = false }: { targetOnly?: boolean } = {}): MemoryScope[] {
  const base = scopesFor(event)
  const value = record(event)
  const groupId = groupKey(value)
  if (!groupId) return base

  const scopes = targetOnly ? base.filter(scope => scope.scopeType === "group") : [...base]
  const seen = new Set(scopes.map(scopeIdentity))
  for (const rawUserId of targetUserIds.slice(0, 3)) {
    const userId = text(rawUserId).trim()
    if (!userId) continue
    const targets: MemoryScope[] = [
      { scopeType: "user", ownerId: userId, groupId: "" },
      { scopeType: "user_group", ownerId: userId, groupId },
    ]
    for (const scope of targets) {
      const identity = scopeIdentity(scope)
      if (seen.has(identity)) continue
      seen.add(identity)
      scopes.push(scope)
    }
  }
  return scopes
}
