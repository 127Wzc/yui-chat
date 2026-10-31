import { configStore } from "../config/store.js"
import { extractMessageContext } from "../core/message/message-context.js"
import type { UnknownRecord } from "../core/message/types.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { explainResourceAccess } from "../tools/access/resource-policy.js"
import { assertMemoryImageSelection, limitMemoryImageSelection, MAX_MEMORY_IMAGE_USERS, validateMemoryImageSelection } from "./image-request.js"
import type { MemoryImageSelection } from "./image-request.js"
import { memoryRepository } from "./repository.js"
import { groupKey, mentionedUserIds, userKey } from "./scopes.js"
import { memoryStore } from "./store.js"

const record = (value: unknown): UnknownRecord => value && typeof value === "object" ? value as UnknownRecord : {}
const MEMORY_NOUN = "(?:的)?\\s*(?:(?:全部|所有|完整|全量|个人|长期|有效|已保存|已存|的)\\s*){0,5}记忆"
const GROUP_MEMORY = new RegExp(`(?:(?:本群|这个群|当前群|群里|群内)(?:的)?\\s*(?:(?:所有|全部|全体)(?:的)?\\s*)?(?:成员|用户|群友|所有人|每个人|大家)?|(?:所有|全部|全体)(?:的)?\\s*(?:群友|群成员)|大家)${MEMORY_NOUN}`, "u")
const ALL_USER_MEMORY = new RegExp(`(?:(?:所有|全部|全体|每个|每位)(?:的)?\\s*(?:用户|使用者)|所有人|每个人)${MEMORY_NOUN}`, "u")

export async function selectionFor(event: UnknownRecord, request: string): Promise<MemoryImageSelection> {
  let selection: MemoryImageSelection
  if (GROUP_MEMORY.test(request)) selection = { scope: "group" }
  else if (ALL_USER_MEMORY.test(request)) selection = { scope: "all" }
  else {
    const own = /(?:我|本人|自己)的?\s*(?:(?:全部|所有|完整|全量|个人|长期|有效|本群|全局|的)\s*){0,5}记忆|(?:全部|所有)关于我的记忆/u.test(request)
    const ownTargetText = request.replace(/\[CQ:at,[^\]]*\]/giu, "@成员")
    const ownTogether = /(?:我|本人|自己)\s*(?:和|跟|与|及|、)\s*[^。；;，,\n]{0,80}记忆/u.test(ownTargetText)
      || /(?:我|本人|自己)的?[^。；;，,\n]{0,20}记忆\s*(?:和|跟|与|及|、)\s*[^。；;，,\n]{0,40}记忆/u.test(ownTargetText)
    const bot = record(event.bot)
    const botIds = new Set([event.self_id, ...(Array.isArray(bot.uin) ? bot.uin : [bot.uin])].map(value => String(value || "").trim()).filter(Boolean))
    // @ 或明确 QQ 号优先；只在没有明确目标时使用群内唯一称呼。
    const numeric = [...request.matchAll(/(?:QQ\s*|用户\s*|成员\s*|@)\d{5,20}(?:\s*(?:、|,|，|和|与|及)\s*(?:(?:QQ|用户|成员)\s*)?\d{5,20})*|\b\d{5,20}\s*的?(?:全部|所有|个人|长期)?记忆/giu)]
      .flatMap(match => [...match[0].matchAll(/\d{5,20}/gu)].map(item => item[0]).filter(id => !match[0].startsWith("@") || !botIds.has(id)))
    const mentions = mentionedUserIds(event)
    const mentionSet = new Set(mentions)
    const numericSet = new Set(numeric)
    const targets: string[] = []
    const native = extractMessageContext({ message: event.message }).chain
    const current = extractMessageContext(event, request).chain
    // 消息段带有正文时保留 @ 与 QQ 号的实际顺序；正文只接受过滤后请求中的号码。
    const parts = native.some(part => part.type === "text") ? [...native, ...current] : current
    for (const part of parts) {
      const ids = part.type === "mention" ? (mentionSet.has(part.userId) ? [part.userId] : [])
        : part.type === "text" ? [...part.text.matchAll(/\d{5,20}/gu)].map(match => match[0]).filter(id => numericSet.has(id)) : []
      for (const id of ids) if (!targets.includes(id)) targets.push(id)
    }
    for (const id of [...mentions, ...numeric]) if (!targets.includes(id)) targets.push(id)
    if (!targets.length && (!own || ownTogether) && groupKey(event) && sqliteClient.status.available) {
      const persona = record(configStore.get().persona)
      const botNames = new Set([persona.firstPerson, ...(Array.isArray(persona.aliases) ? persona.aliases : [])].map(value => String(value || "").trim().toLowerCase()).filter(Boolean))
      const aliases = (await memoryRepository.listGroupIdentityNames(groupKey(event))).filter(item => {
        const alias = String(item.alias || "").trim()
        return [...alias].length >= 2 && !/^\d+$/u.test(alias) && !botNames.has(alias.toLowerCase()) && !botIds.has(String(item.ownerId))
      })
      const ownersByAlias = new Map<string, Set<string>>()
      for (const item of aliases) {
        const alias = String(item.alias)
        if (!ownersByAlias.has(alias)) ownersByAlias.set(alias, new Set())
        ownersByAlias.get(alias)?.add(String(item.ownerId))
      }
      const names = [...ownersByAlias.keys()].sort((a, b) => b.length - a.length)
      const explicitNames: string[] = []
      // 从“记忆”向前读取名字及其并列词，避免把“今天”等普通正文当作额外成员。
      for (const match of request.matchAll(new RegExp(MEMORY_NOUN, "gu"))) {
        let before = request.slice(0, match.index).trimEnd()
        const connected: string[] = []
        while (before) {
          const alias = names.find(name => before.endsWith(name))
          if (!alias) break
          connected.unshift(alias)
          before = before.slice(0, -alias.length).trimEnd()
          const connector = before.match(/(?:和|跟|与|及|、|，|,)$/u)?.[0]
          if (!connector) break
          before = before.slice(0, -connector.length).trimEnd()
        }
        for (const alias of connected) if (!explicitNames.includes(alias)) explicitNames.push(alias)
      }
      const matchedNames = explicitNames.length ? explicitNames : names.filter(alias => {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        return new RegExp(`${escaped}.{0,12}记忆|记忆.{0,12}${escaped}`, "u").test(request)
      })
      if (!explicitNames.length && new Set(matchedNames.flatMap(alias => [...(ownersByAlias.get(alias) || [])])).size > 1) throw new Error("无法唯一确定记忆所属成员，请使用 @ 或 QQ 号。")
      for (const alias of matchedNames) {
        if (targets.length + (ownTogether && !targets.includes(userKey(event)) ? 1 : 0) >= MAX_MEMORY_IMAGE_USERS) break
        const owners = [...(ownersByAlias.get(alias) || [])]
        if (owners.length > 1) throw new Error(`称呼“${alias}”无法唯一确定成员，请使用 @ 或 QQ 号。`)
        if (owners[0] && !targets.includes(owners[0])) targets.push(owners[0])
      }
    }
    if (ownTogether) {
      if (!targets.some(id => id !== userKey(event))) throw new Error("无法确定其他记忆所属用户，请 @ 成员或提供 QQ 号。")
      const ownIndex = targets.indexOf(userKey(event))
      if (ownIndex >= 0) targets.splice(ownIndex, 1)
      targets.unshift(userKey(event))
    }
    targets.splice(MAX_MEMORY_IMAGE_USERS)
    if (own && targets.some(id => id !== userKey(event)) && !ownTogether) throw new Error("本轮同时指定了本人和他人的记忆，请明确说明是否一起使用。")
    if (targets.length === 1) selection = { scope: "user", userId: targets[0] }
    else if (targets.length > 1) selection = { scope: "users", userIds: targets }
    else if (!own && /(?:他|她|别人|其他人|对方|成员|用户|群友).{0,12}记忆|记忆.{0,8}(?:他|她|别人)|[^\s，,。；;]{1,20}的(?:全部|所有|个人|长期)?记忆/u.test(request)) throw new Error("无法确定记忆所属用户，请 @ 成员或提供 QQ 号。")
    else selection = { scope: "self" }
  }
  const limited = limitMemoryImageSelection(selection)
  assertMemoryImageSelection(event, limited)
  return limited
}

export function assertMemoryAccess(event: UnknownRecord): void {
  const config = configStore.get()
  if (record(config.memory).enabled === false) throw new Error("记忆功能未启用，无法附加绘图参考记忆。")
  const access = explainResourceAccess(config, event, "tool", "memory_manage", "", "", false, true)
  const tools = record(config.tools)
  if (tools.enabled !== true || !Array.isArray(tools.enabledTools) || !tools.enabledTools.includes("memory_manage") || !access.allowed) throw new Error(`无法读取绘图参考记忆：${access.allowed ? "记忆工具未启用。" : access.reason}`)
}

/** 只保存经过真实事件校验的范围，消费引用时读取当前有效记忆。 */
export async function prepareMemoryReference(event: UnknownRecord, request: string): Promise<MemoryImageSelection> {
  assertMemoryAccess(event)
  return selectionFor(event, request)
}

/** 管理台只读预览已保存范围的当前记忆；不冒用对话者执行工具。 */
export async function previewMemoryReference(value: unknown, caller: string, groupId: string): Promise<UnknownRecord[]> {
  const selection = record(value) as unknown as MemoryImageSelection
  validateMemoryImageSelection(selection)
  if (!caller || caller === "unknown") throw new Error("无法识别参考资料所属用户。")
  if (selection.scope === "group" && !groupId) throw new Error("无法识别参考资料所属群聊。")
  const rows = await memoryRepository.listImageMemories(selection, caller, groupId)
  return rows.map(item => ({
    userId: String(item.owner_id || ""), scope: String(item.scope_type || ""), groupId: String(item.group_id || ""),
    id: String(item.id || ""), type: String(item.type || "fact"), text: String(item.text || ""),
  }))
}

export async function readMemoryReference(event: UnknownRecord, selection: MemoryImageSelection, signal?: AbortSignal): Promise<{ records: UnknownRecord[]; metadata: UnknownRecord }> {
  signal?.throwIfAborted()
  assertMemoryAccess(event)
  assertMemoryImageSelection(event, selection)
  const read = await memoryStore.listImageMemories(event, selection)
  signal?.throwIfAborted()
  assertMemoryAccess(event)
  if (!read.complete) throw new Error(read.warning || "记忆读取不完整，未提交图片生成；不能将部分资料当作全部记忆。")
  if (!read.items.length) throw new Error("所选范围内没有可用的有效个人记忆，未提交图片生成。")
  const records = read.items.map(item => ({
    userId: String(item.ownerId || ""), scope: String(item.ownerType || ""), groupId: String(item.groupId || ""),
    id: String(item.id || ""), type: String(item.type || "fact"), text: String(item.text || ""),
  }))
  const owners = new Set(records.map(item => item.userId))
  return { records, metadata: { scope: selection.scope, ...(selection.userId ? { userId: selection.userId } : {}), ...(selection.userIds ? { userIds: selection.userIds } : {}), memoryCount: records.length, userCount: owners.size, complete: true, format: "full-text" } }
}
