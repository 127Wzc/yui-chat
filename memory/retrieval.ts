import { configStore } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { memoryRepository } from "./repository.js"
import { hasMemoryRecallIntent, hasSpeakerComparisonIntent, mentionedUserIds, recallScopesFor, scopesFor } from "./scopes.js"
import type { MemoryScope } from "./scopes.js"
import { statusFor } from "./decay.js"
import { vectorRecall } from "./vector-recall.js"

type UnknownRecord = Record<string, unknown>

export interface MemoryRecallPlan {
  scopes: MemoryScope[]
  targetUserIds: string[]
  mode: "speaker" | "target" | "comparison"
  allowVector: boolean
}

const TARGET_AFTER_NAME = /(?:喜欢|不喜欢|讨厌|偏好|爱好|兴趣|习惯|性格|昵称|名字|称呼|年龄|几岁|生日|职业|工作|学校|专业|经历|关系|计划|打算|以前|曾经|过去|说过|提过|聊过|是谁|什么人|怎么样|近况|适合|想要|要什么|吃什么|喝什么|玩什么)/i
const TARGET_BEFORE_NAME = /(?:关于|认识|了解|介绍|记得|知道|问问|觉得|适合|推荐给|建议给|送给|帮|替)/i

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function escapeRegExp(value: unknown): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function namedTargetIsRelevant(query: string, alias: string): boolean {
  const clean = alias.trim()
  if ([...clean].length < 2 || /^\d+$/.test(clean)) return false
  const name = escapeRegExp(clean)
  return new RegExp(`${name}.{0,12}${TARGET_AFTER_NAME.source}|${TARGET_BEFORE_NAME.source}.{0,12}${name}`, "i").test(query)
}

function excludedTargetIds(event: UnknownRecord): Set<string> {
  const bot = record(event.bot)
  return new Set([
    event.user_id,
    record(event.sender).user_id,
    event.self_id,
    ...(Array.isArray(bot.uin) ? bot.uin : [bot.uin]),
  ].map(value => String(value || "").trim()).filter(Boolean))
}

async function namedTargetUserIds(event: UnknownRecord, query: string): Promise<string[]> {
  if (event.isGroup !== true || !String(event.group_id || "").trim()) return []
  const aliases = await memoryRepository.listGroupIdentityNames(event.group_id)
  const ownersByAlias = new Map<string, Set<string>>()
  for (const item of aliases) {
    const value = record(item)
    const alias = String(value.alias || "").trim().toLocaleLowerCase("zh-CN")
    const ownerId = String(value.ownerId || "").trim()
    if (!alias || !ownerId || !query.toLocaleLowerCase("zh-CN").includes(alias)) continue
    const owners = ownersByAlias.get(alias) || new Set<string>()
    owners.add(ownerId)
    ownersByAlias.set(alias, owners)
  }
  const excluded = excludedTargetIds(event)
  const targets: string[] = []
  for (const [alias, owners] of ownersByAlias) {
    if (owners.size !== 1 || !namedTargetIsRelevant(query, alias)) continue
    const ownerId = [...owners][0]
    if (!ownerId || excluded.has(ownerId) || targets.includes(ownerId)) continue
    targets.push(ownerId)
    if (targets.length >= 3) break
  }
  return targets
}

/** 用本地规则与群内唯一称呼解析本轮该看谁的记忆，不产生模型调用。 */
export async function resolveMemoryRecallPlan(event: UnknownRecord = {}, query: unknown = ""): Promise<MemoryRecallPlan> {
  const text = String(query || "").trim()
  const allowVector = hasMemoryRecallIntent(text)
  if (!allowVector || event.isGroup !== true) return { scopes: scopesFor(event), targetUserIds: [], mode: "speaker", allowVector }
  const targetUserIds = [...new Set([
    ...mentionedUserIds(event),
    ...await namedTargetUserIds(event, text),
  ])].slice(0, 3)
  if (!targetUserIds.length) return { scopes: scopesFor(event), targetUserIds, mode: "speaker", allowVector }
  const comparison = hasSpeakerComparisonIntent(text)
  return {
    scopes: recallScopesFor(event, targetUserIds, { targetOnly: !comparison }),
    targetUserIds,
    mode: comparison ? "comparison" : "target",
    allowVector,
  }
}

function score(item: UnknownRecord, index = 0): number {
  const status = statusFor(item)
  const statusScore = ({ active: 3, warm: 2, cold: 1 } as Record<string, number>)[status] || 0
  const scopeScore = ({ user: 4, user_group: 3, group: 2 } as Record<string, number>)[String(item.scope_type)] || 0
  return Number(item.score || 0) + Number(item.importance || 0) * 3 + Number(item.confidence || 0) * 2 + statusScore + scopeScore - index * 0.001
}

function boundedRetrievalLimit(value: unknown, fallback = 3): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(20, Math.max(1, Math.trunc(parsed)))
}

// 显式传入 limit（例如 memory_search 工具）时尊重调用方；普通对话不传 limit，
// 这时按全局默认并应用当前群的单群覆盖值。
export async function resolveMemoryRetrievalLimit(e: UnknownRecord = {}, explicitLimit?: unknown): Promise<number> {
  if (explicitLimit !== undefined && explicitLimit !== null) return boundedRetrievalLimit(explicitLimit)
  const root = record(configStore.get())
  const memory = record(root.memory)
  const retrieval = record(memory.retrieval)
  const globalLimit = boundedRetrievalLimit(retrieval.resultLimit, 3)
  if (e.isGroup !== true || !sqliteClient.status.available) return globalLimit
  const groupId = String(e.group_id || "").trim()
  if (!groupId) return globalLimit
  try {
    const row = await sqliteClient.get("SELECT retrieval_result_limit FROM group_memory_policies WHERE group_id=?", [groupId])
    return row?.retrieval_result_limit === null || row?.retrieval_result_limit === undefined
      ? globalLimit
      : boundedRetrievalLimit(row.retrieval_result_limit, globalLimit)
  } catch {
    // 单群策略读取失败时保持全局默认，不影响正常对话。
    return globalLimit
  }
}

export async function retrieveMemory(e: UnknownRecord = {}, query: unknown, options: UnknownRecord = {}): Promise<UnknownRecord[]> {
  const configuredScopes = Array.isArray(options.scopes) ? options.scopes as MemoryScope[] : null
  const plan = configuredScopes ? null : await resolveMemoryRecallPlan(e, query)
  const scopes: MemoryScope[] = configuredScopes || plan?.scopes || scopesFor(e)
  const allowVector = options.allowVector === true || (options.allowVector !== false && (plan?.allowVector || options.limit !== undefined))
  const limit = await resolveMemoryRetrievalLimit(e, options.limit)
  const rows = query
    ? await memoryRepository.search(scopes, query, { limit: options.candidateLimit || 20 })
    : await memoryRepository.list(scopes, { limit, includeCold: false })
  let candidates = rows
  if (query && allowVector && vectorRecall.enabled()) {
    // adaptiveVector=true 时只在 FTS 命中不足目标条数才补语义候选（节约 API）；false 则每次都补。
    const root = record(configStore.get())
    const memory = record(root.memory)
    const retrieval = record(memory.retrieval)
    const adaptive = retrieval.adaptiveVector !== false
    if ((!adaptive || rows.length < limit) && await vectorRecall.hasAnyMemory(scopes)) {
      const vectorRows = await vectorRecall.queryMemoryVectors(scopes, query, { event: e })
      // 按 id 去重合并：同一条记忆保留 FTS 行（bm25 分数），向量行只补 FTS 没召回的部分；
      // 向量层失败会返回空数组，不影响 FTS 结果。
      const seen = new Set(rows.map(row => String(row.id || "")))
      candidates = [...rows, ...vectorRows.filter(row => !seen.has(String(row.id || "")))]
    }
  }
  return candidates
    .map((item, index) => ({ ...item, computedStatus: statusFor(item), _score: score(item, index) }))
    .filter(item => ["active", "warm", "cold"].includes(item.computedStatus) && item.type !== "profile" && item.type !== "short" && !(item.type === "episode" && item.source === "interaction"))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...item }) => item)
}
