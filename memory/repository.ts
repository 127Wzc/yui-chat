import { statusFor } from "./decay.js"
import { isDerivedMemory, isSingleValueFact } from "./write-policy.js"
import crypto from "node:crypto"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import type { SqliteOperation } from "../core/storage/types.js"
import { vectorRecall } from "./vector-recall.js"
import type { MemoryImageSelection } from "./image-request.js"

type UnknownRecord = Record<string, unknown>

interface MemoryItem extends UnknownRecord {
  id?: string
  scopeType?: string
  ownerId?: string
  groupId?: string
  type?: string
  text?: string
  normalized?: string
  factKey?: string
  factValue?: string
  tags?: unknown
  importance?: unknown
  confidence?: unknown
  status?: string
  source?: string
  lastConfirmedAt?: unknown
  expiresAt?: unknown
  observedAt?: unknown
  validityReason?: string
  supersededBy?: string
}

interface MemoryScope extends UnknownRecord {
  scopeType: string
  ownerId: string
  groupId?: string
}

interface RepositoryOptions extends UnknownRecord {
  limit?: unknown
  includeCold?: boolean
  includeInteraction?: boolean
  pageSize?: unknown
  page?: unknown
  query?: unknown
  scopeType?: unknown
  factLimit?: unknown
  evidence?: unknown
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function parse<T = unknown>(value: unknown, fallback?: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback as T
  } catch {
    return fallback as T
  }
}

const id = (): string => crypto.randomUUID()

function insertOperations(item: MemoryItem, memoryId: string, evidence: unknown = []): SqliteOperation[] {
  const timestamp = Date.now()
  const text = String(item.text || "")
  return [
    { sql: "INSERT INTO memory_items(id,scope_type,owner_id,group_id,type,text,normalized_key,fact_key,fact_value,tags_json,importance,confidence,status,source,last_confirmed_at,expires_at,created_at,updated_at,observed_at,validity_reason,superseded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [memoryId,item.scopeType,item.ownerId,item.groupId||"",item.type||"fact",text,item.normalized||text.toLowerCase(),String(item.factKey||""),String(item.factValue||""),JSON.stringify(item.tags||[]),Number(item.importance??0.6),Number(item.confidence??0.8),item.status||"active",item.source||"manual",item.lastConfirmedAt??timestamp,item.expiresAt||0,timestamp,timestamp,item.observedAt||0,item.validityReason||"",item.supersededBy||""] },
    { sql: "INSERT INTO memory_fts(memory_id,text) VALUES(?,?)", params: [memoryId,ftsIndexText(text)] },
    ...evidenceOperations(memoryId,evidence),
  ]
}

function evidenceOperations(memoryId: string, evidence: unknown = []): SqliteOperation[] {
  return (Array.isArray(evidence) ? evidence : []).map(item => {
    const value = record(item)
    return {
    sql: "INSERT INTO memory_evidence(memory_id, source_event_id, source_type, message_id) VALUES(?, ?, ?, ?) ON CONFLICT(memory_id, source_event_id) DO NOTHING",
    params: [
      memoryId,
      String(value.sourceEventId || value.messageId || value.sourceType || id()),
      String(value.sourceType || "memory"),
      String(value.messageId || ""),
    ],
    }
  })
}

const WORD_PATTERN = /[\p{L}\p{N}_-]+/gu
const HAN_RUN_PATTERN = /\p{Script=Han}+|[^\p{Script=Han}]+/gu
const HAN_PATTERN = /\p{Script=Han}/u

// FTS 词元化（索引侧与查询侧刻意不对称）：
// memory_fts 的 unicode61 分词会把连续中文并成一个 token，中文子串查询在 FTS 上几乎永远无法命中。
// 这里先切出词段（字母/数字等非 CJK 段原样保留；"bge3模型"这类混合段先按 Han/非 Han 拆开），
// 再把 CJK 段展开为字级词元：
// - 索引侧输出 unigram + bigram 全量，单字查询也能命中；记忆是千级数据，索引膨胀可忽略。
// - 查询侧只输出 bigram（段长为 1 时退回 unigram）：bigram 携带语序约束，在 OR 语义下能压低
//   单字带来的误命中；且查询 bigram 必然是索引 bigram 的子集，不会因此漏召回。
function ftsTokens(value: unknown = "", { forIndex = false }: { forIndex?: boolean } = {}): string[] {
  const tokens: string[] = []
  for (const word of String(value).match(WORD_PATTERN) || []) {
    for (const run of word.match(HAN_RUN_PATTERN) || []) {
      if (!HAN_PATTERN.test(run)) {
        // 与旧 ftsQuery 的 {1,32} 上限保持一致，超长非 CJK 段按 32 字符切块，两侧规则相同即可互相命中。
        for (let index = 0; index < run.length; index += 32) tokens.push(run.slice(index, index + 32))
        continue
      }
      const chars = [...run]
      if (chars.length === 1) {
        tokens.push(chars[0])
        continue
      }
      if (forIndex) tokens.push(...chars)
      for (let index = 0; index < chars.length - 1; index += 1) tokens.push(chars[index] + chars[index + 1])
    }
  }
  return tokens
}

export function ftsIndexText(value: unknown = ""): string {
  return ftsTokens(value, { forIndex: true }).join(" ")
}

function ftsQuery(value: unknown = ""): string {
  return [...new Set(ftsTokens(value))].map(term => `"${term.replaceAll('"', "")}"`).join(" OR ")
}

export class MemoryRepository {
  async insert(item: MemoryItem = {}, options: RepositoryOptions = {}): Promise<MemoryItem | null> {
    const memoryId = item.id || id()
    const unique:SqliteOperation[] = options.uniqueFact===true ? [{sql:"SELECT COUNT(*) AS count FROM memory_items WHERE scope_type=? AND owner_id=? AND group_id=? AND type=? AND status IN ('active','warm','cold') AND ((fact_key<>'' AND fact_key=? AND fact_value=?) OR normalized_key=?)",params:[item.scopeType,item.ownerId,item.groupId||"",item.type||"fact",item.factKey||"",item.factValue||"",item.normalized||String(item.text||"").toLowerCase()],mode:"get",expect:{count:0}}] : []
    await sqliteClient.transaction([...unique,...insertOperations(item, memoryId, options.evidence)])
    vectorRecall.markDirty()
    return this.get(memoryId)
  }

  /** 替代与新事实入库共用事务，插入失败不能留下已归档但无替代的旧行。 */
  async replaceFact(current: MemoryItem, item: MemoryItem, evidence: unknown = []): Promise<MemoryItem | null> {
    const memoryId = id()
    await sqliteClient.transaction([
      {sql:"SELECT updated_at,status,source,text,fact_key,fact_value,observed_at,expires_at FROM memory_items WHERE id=?",params:[current.id],mode:"get",expect:Object.fromEntries(["updated_at","status","source","text","fact_key","fact_value","observed_at","expires_at"].map(key=>[key,current[key]]))},
      { sql: "UPDATE memory_items SET status='archived',validity_reason='superseded',superseded_by=?,updated_at=? WHERE id=? AND updated_at=? AND status IN ('active','warm','cold')", params: [memoryId,Date.now(),current.id,current.updated_at],expectChanges:1 },
      ...insertOperations(item,memoryId,evidence),
    ])
    vectorRecall.markDirty()
    return this.get(memoryId)
  }

  async observationTime(item: MemoryItem): Promise<number> {
    if (Number(item.observed_at || 0)) return Number(item.observed_at)
    if(!isDerivedMemory(item))return Number(item.last_confirmed_at||item.created_at||0)
    const source = await sqliteClient.get<UnknownRecord>(`SELECT MAX(m.sent_at) AS time FROM memory_evidence e JOIN group_memory_messages m ON m.id=e.source_event_id AND e.source_type='group-message:'||m.group_id AND (e.message_id='' OR e.message_id=m.message_id) WHERE e.memory_id=?`,[item.id])
    return Number(source?.time || item.last_confirmed_at || item.created_at || 0)
  }

  async revision(item: MemoryItem): Promise<number> {
    const row=await sqliteClient.get("SELECT revision FROM memory_maintenance_versions WHERE scope_type=? AND owner_id=? AND group_id=?",[item.scope_type,item.owner_id,item.group_id||""])
    return Number(row?.revision||0)
  }

  async resolvePending(current: MemoryItem, accept: boolean, text: string, tags: unknown, revision: number): Promise<MemoryItem | null> {
    if(current.status!=="archived"||current.validity_reason!=="pending")throw new Error("这条记忆已不在待核实状态，请刷新。")
    if(accept&&Number(current.expires_at||0)>0&&Number(current.expires_at)<=Date.now())throw new Error("这条建议已到期，不能直接采纳为当前事实。")
    const timestamp=Date.now()
    await sqliteClient.transaction([
      {sql:"SELECT COALESCE((SELECT revision FROM memory_maintenance_versions WHERE scope_type=? AND owner_id=? AND group_id=?),0) AS revision",params:[current.scope_type,current.owner_id,current.group_id||""],mode:"get",expect:{revision}},
      {sql:"SELECT status,validity_reason,updated_at FROM memory_items WHERE id=?",params:[current.id],mode:"get",expect:{status:"archived",validity_reason:"pending",updated_at:current.updated_at}},
      ...(accept&&isSingleValueFact(current.fact_key)?[{sql:"UPDATE memory_items SET status='archived',validity_reason='superseded',superseded_by=?,updated_at=? WHERE id<>? AND scope_type=? AND owner_id=? AND group_id=? AND fact_key=? AND status IN ('active','warm','cold')",params:[current.id,timestamp,current.id,current.scope_type,current.owner_id,current.group_id,current.fact_key]}]:[]),
      {sql:"UPDATE memory_items SET status=?,validity_reason=?,source=?,text=?,normalized_key=?,tags_json=?,updated_at=? WHERE id=?",params:[accept?"active":"archived",accept?"":"manual","manual-edit",text,text.toLowerCase(),JSON.stringify(tags||[]),timestamp,current.id],expectChanges:1},
      {sql:"DELETE FROM memory_fts WHERE memory_id=?",params:[current.id]},
      {sql:"INSERT INTO memory_fts(memory_id,text) VALUES(?,?)",params:[current.id,ftsIndexText(text)]},
    ])
    vectorRecall.markDirty()
    return this.get(current.id)
  }

  async get(memoryId: unknown): Promise<MemoryItem | null> {
    const row = await sqliteClient.get<MemoryItem>("SELECT * FROM memory_items WHERE id = ?", [memoryId])
    return row ? { ...row, tags: parse(row.tags_json) } : null
  }

  async findExactFact(scope: MemoryScope, text: string, type = "fact"): Promise<MemoryItem | null> {
    const row=await sqliteClient.get<MemoryItem>("SELECT * FROM memory_items WHERE scope_type=? AND owner_id=? AND group_id=? AND type=? AND normalized_key=? AND status IN ('active','warm','cold') ORDER BY created_at,id LIMIT 1",[scope.scopeType,scope.ownerId,scope.groupId||"",type,text.toLowerCase()])
    return row?{...row,tags:parse(row.tags_json)}:null
  }

  async listEvidence(memoryId: string, page = 1): Promise<UnknownRecord> {
    const pageSize = 20
    const currentPage = Math.max(1, Math.trunc(Number(page) || 1))
    const total = Number((await sqliteClient.get("SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id=?", [memoryId]))?.count || 0)
    // 同时核对来源群和消息 ID，不能只凭 source_event_id 连接到其他群的原文。
    const rows = await sqliteClient.all<UnknownRecord>(
      `SELECT e.source_event_id, e.source_type, e.message_id,
        m.sender_id, m.sender_name, m.sent_at, m.text_content
       FROM memory_evidence e LEFT JOIN group_memory_messages m
         ON m.id=e.source_event_id AND e.source_type='group-message:' || m.group_id
         AND (e.message_id='' OR e.message_id=m.message_id)
       WHERE e.memory_id=? ORDER BY m.sent_at DESC, e.source_event_id ASC LIMIT ? OFFSET ?`,
      [memoryId, pageSize, (currentPage - 1) * pageSize],
    )
    return {
      total, page: currentPage, pageSize,
      items: rows.map(row => ({
        id: row.source_event_id, messageId: row.message_id,
        groupId: String(row.source_type || "").startsWith("group-message:") ? String(row.source_type).slice(14) : "",
        available: row.sent_at !== null && row.sent_at !== undefined,
        senderId: row.sender_id || "", senderName: row.sender_name || "", sentAt: Number(row.sent_at || 0),
        text: String(row.text_content || ""),
      })),
    }
  }

  async update(memoryId: unknown, patch: MemoryItem = {}, options: RepositoryOptions = {}): Promise<MemoryItem | null> {
    const current = await this.get(memoryId)
    if (!current) return null
    const expected=record(options.expectedCurrent)
    if(Object.keys(expected).length && ["updated_at","source","status","text"].some(key=>expected[key]!==current[key]))throw new Error("记忆在提炼期间已变化，保留检查点供续处理。")
    if(patch.observedAt!==undefined){
      patch={...patch,observedAt:Math.max(Number(patch.observedAt)||0,Number(current.observed_at)||0),lastConfirmedAt:Math.max(Number(patch.lastConfirmedAt)||0,Number(current.last_confirmed_at)||0),confidence:Math.max(Number(patch.confidence??current.confidence),Number(current.confidence))}
    }
    const next: MemoryItem = { ...current, ...patch, tags: patch.tags || current.tags || [], updated_at: Date.now() }
    await sqliteClient.transaction([
      {sql:"SELECT updated_at,status,source,text,confidence,last_confirmed_at,observed_at,expires_at,validity_reason FROM memory_items WHERE id=?",params:[memoryId],mode:"get",expect:Object.fromEntries(["updated_at","status","source","text","confidence","last_confirmed_at","observed_at","expires_at","validity_reason"].map(key=>[key,current[key]]))},
      { sql: "UPDATE memory_items SET text=?, normalized_key=?, fact_key=?, fact_value=?, tags_json=?, importance=?, confidence=?, status=?, source=?, last_confirmed_at=?, expires_at=?, updated_at=? WHERE id=?", params: [next.text, next.normalized || String(next.text).toLowerCase(), next.factKey ?? next.fact_key ?? "", next.factValue ?? next.fact_value ?? "", JSON.stringify(next.tags), Number(next.importance), Number(next.confidence), next.status, next.source, next.lastConfirmedAt || next.last_confirmed_at, next.expiresAt ?? next.expires_at ?? 0, next.updated_at, memoryId] },
      { sql: "UPDATE memory_items SET observed_at=?,validity_reason=?,superseded_by=? WHERE id=?", params: [patch.observedAt??current.observed_at??0,patch.validityReason??current.validity_reason??"",patch.supersededBy??current.superseded_by??"",memoryId] },
      { sql: "DELETE FROM memory_fts WHERE memory_id = ?", params: [memoryId] },
      ...(next.status === "deleted" ? [] : [{ sql: "INSERT INTO memory_fts(memory_id, text) VALUES(?, ?)", params: [memoryId, ftsIndexText(next.text)] }]),
      ...evidenceOperations(String(memoryId || ""), options.evidence),
    ])
    vectorRecall.markDirty()
    return this.get(memoryId)
  }

  async addEvidence(memoryId: unknown, evidence: UnknownRecord = {}): Promise<string> {
    const sourceEventId = String(evidence.sourceEventId || evidence.messageId || evidence.sourceType || id())
    await sqliteClient.run(
      "INSERT INTO memory_evidence(memory_id, source_event_id, source_type, message_id) VALUES(?, ?, ?, ?) ON CONFLICT(memory_id, source_event_id) DO NOTHING",
      [
        String(memoryId || ""),
        sourceEventId,
        String(evidence.sourceType || "memory"),
        String(evidence.messageId || ""),
      ],
    )
    return sourceEventId
  }

  async hardDelete(memoryId: unknown): Promise<MemoryItem | null> {
    const current = await this.get(memoryId)
    if (!current) return null
    await sqliteClient.transaction([
      { sql: "DELETE FROM memory_fts WHERE memory_id = ?", params: [memoryId] },
      { sql: "DELETE FROM memory_items WHERE id = ?", params: [memoryId] },
    ])
    vectorRecall.markDirty()
    return current
  }

  async hardDeleteGroup(scopeId: unknown, options: RepositoryOptions = {}): Promise<number> {
    const key = String(scopeId || "")
    const includeInteraction = options.includeInteraction !== false
    const scopedRows = await sqliteClient.all<UnknownRecord>(
      `SELECT id FROM memory_items
       WHERE ((scope_type = 'group' AND owner_id = ? AND group_id = ?) OR (scope_type = 'user_group' AND group_id = ?))
         ${includeInteraction ? "" : "AND NOT (type='episode' AND source='interaction')"}`,
      [key, key, key],
    )
    const originType = `group-message:${key}`
    // 修订/合并会把派生记忆的 source 改写为 superseded/duplicate-merged，这些归档版本同样携带群消息摘录，必须一并纳入清理。
    const globalRows = await sqliteClient.all<UnknownRecord>(
      `SELECT m.id,
        SUM(CASE WHEN e.source_type = ? THEN 1 ELSE 0 END) AS current_evidence,
        SUM(CASE WHEN e.source_type <> ? THEN 1 ELSE 0 END) AS other_evidence
       FROM memory_items m
       JOIN memory_evidence e ON e.memory_id = m.id
       WHERE m.scope_type = 'user'
         AND (m.source LIKE 'group-window%' OR m.source LIKE 'maintenance:%' OR m.source IN ('superseded', 'duplicate-merged'))
         AND e.source_type LIKE 'group-message:%'
       GROUP BY m.id
       HAVING current_evidence > 0`,
      [originType, originType],
    )
    const preserved = globalRows.filter(row => Number(row.other_evidence || 0) > 0).map(row => row.id)
    for (const memoryId of preserved) {
      await sqliteClient.run("DELETE FROM memory_evidence WHERE memory_id=? AND source_type=?", [memoryId, originType])
    }
    const ids = [...new Set([
      ...scopedRows.map(row => row.id),
      ...globalRows.filter(row => Number(row.other_evidence || 0) === 0).map(row => row.id),
    ])]
    if (!ids.length) return 0
    const placeholders = ids.map(() => "?").join(",")
    await sqliteClient.transaction([
      { sql: `DELETE FROM memory_fts WHERE memory_id IN (${placeholders})`, params: ids },
      { sql: `DELETE FROM memory_items WHERE id IN (${placeholders})`, params: ids },
    ])
    vectorRecall.markDirty()
    return ids.length
  }

  async getMany(ids: string[]): Promise<MemoryItem[]> {
    if (!ids.length) return []
    const rows = await sqliteClient.all<MemoryItem>(`SELECT * FROM memory_items WHERE id IN (${ids.map(() => "?").join(",")})`, ids)
    return rows.map(row => ({ ...row, tags: parse(row.tags_json) }))
  }

  /** 本人的全部有效记忆；不经过相关性排序、默认召回条数或 200 条目录上限。 */
  async listOwnMemories(userId: string, groupId = ""): Promise<MemoryItem[]> {
    const rows = await sqliteClient.all<MemoryItem>(`SELECT * FROM memory_items WHERE owner_id=?
      AND ((scope_type='user' AND group_id='') OR (scope_type='user_group' AND group_id=? AND ?<>''))
      AND type IN ('fact','episode') AND NOT (type='episode' AND source='interaction')
      AND status IN ('active','warm','cold') AND (expires_at=0 OR expires_at>?) ORDER BY id`, [userId, groupId, groupId, Date.now()])
    return rows.filter(row => ["active", "warm", "cold"].includes(statusFor(row))).map(row => ({ ...row, tags: parse(row.tags_json) }))
  }

  /** 绘图附件只读有效个人事实与提炼经历，跨用户授权由门面按真实事件校验。 */
  async listImageMemories(selection: MemoryImageSelection, caller: string, groupId: string): Promise<MemoryItem[]> {
    if (selection.scope === "self" || selection.scope === "user") return this.listOwnMemories(selection.userId || caller, groupId)
    const params: unknown[] = []
    let scope = "scope_type IN ('user','user_group')"
    if (selection.scope === "group") {
      // 与管理端成员目录相同：本群有已采集发言或个人本群记忆的成员；不扫描其他群。
      scope = `((scope_type='user' AND group_id='' AND owner_id IN (
        SELECT sender_id FROM group_memory_messages WHERE group_id=?
        UNION SELECT owner_id FROM memory_items WHERE scope_type='user_group' AND group_id=?
        UNION SELECT ?
      )) OR (scope_type='user_group' AND group_id=?))`
      params.push(groupId, groupId, caller, groupId)
    }
    const rows = await sqliteClient.all<MemoryItem>(`SELECT * FROM memory_items WHERE ${scope}
      AND type IN ('fact','episode') AND NOT (type='episode' AND source='interaction')
      AND status IN ('active','warm','cold') AND (expires_at=0 OR expires_at>?)
      ORDER BY owner_id, scope_type, group_id, id`, [...params, Date.now()])
    return rows.filter(row => ["active", "warm", "cold"].includes(statusFor(row))).map(row => ({ ...row, tags: parse(row.tags_json) }))
  }

  async list(scopes: MemoryScope[] = [], options: RepositoryOptions = {}): Promise<MemoryItem[]> {
    if (!scopes.length) return []
    const conditions = scopes.map(() => "(scope_type=? AND owner_id=? AND group_id=?)").join(" OR ")
    const params = scopes.flatMap(scope => [scope.scopeType, scope.ownerId, scope.groupId || ""])
    const status = options.includeCold ? "('active','warm','cold')" : "('active','warm')"
    const rows = await sqliteClient.all<MemoryItem>(`SELECT * FROM memory_items WHERE (${conditions}) AND status IN ${status} AND (expires_at = 0 OR expires_at > ?) ORDER BY importance DESC, updated_at DESC LIMIT ?`, [...params, Date.now(), Math.max(1, Number(options.limit) || 20)])
    return rows.map(row => ({ ...row, tags: parse(row.tags_json) }))
  }

  async listByFactKey(scope: MemoryScope = { scopeType: "", ownerId: "", groupId: "" }, factKey: unknown = "", options: RepositoryOptions = {}): Promise<MemoryItem[]> {
    const key = String(factKey || "").trim()
    if (!key) return []
    const rows = await sqliteClient.all<MemoryItem>(
      `SELECT * FROM memory_items
       WHERE scope_type=? AND owner_id=? AND group_id=? AND fact_key=?
         AND status IN ('active','warm','cold') AND (?=1 OR expires_at = 0 OR expires_at > ?)
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      [scope.scopeType, scope.ownerId, scope.groupId || "", key,options.includeExpired===true?1:0, Date.now(), Math.max(1, Number(options.limit) || 50)],
    )
    return rows.map(row => ({ ...row, tags: parse(row.tags_json) }))
  }

  async listPage(scope: MemoryScope = { scopeType: "", ownerId: "", groupId: "" }, options: RepositoryOptions = {}): Promise<{ items: MemoryItem[]; total: number; page: number; pageSize: number }> {
    const scopeType = String(scope.scopeType || "").trim()
    const ownerId = String(scope.ownerId || "").trim()
    const groupId = String(scope.groupId || "").trim()
    if (!scopeType || !ownerId) return { items: [], total: 0, page: 1, pageSize: 20 }
    const pageSize = Math.max(1, Math.min(100, Number(options.pageSize) || 20))
    const page = Math.max(1, Number(options.page) || 1)
    const query = String(options.query || "").trim().slice(0, 200)
    const status = options.includeCold ? "('active','warm','cold')" : "('active','warm')"
    const base = "scope_type=? AND owner_id=? AND group_id=? AND type NOT IN ('profile','short') AND NOT (type='episode' AND source='interaction') AND " + (options.includeHistory===true?"status<>'deleted'":"((status IN " + status + " AND (expires_at = 0 OR expires_at > ?)) OR (status='archived' AND validity_reason='pending'))")
    const params:unknown[] = [scopeType, ownerId, groupId,...(options.includeHistory===true?[]:[Date.now()])]
    const filter = query ? " AND text LIKE ?" : ""
    const filterParams = query ? [`%${query}%`] : []
    const total = await sqliteClient.get(`SELECT COUNT(*) AS count FROM memory_items WHERE ${base}${filter}`, [...params, ...filterParams])
    const rows = await sqliteClient.all<MemoryItem>(
      `SELECT memory_items.*, (SELECT COUNT(*) FROM memory_evidence e WHERE e.memory_id=memory_items.id) AS evidence_count
       FROM memory_items WHERE ${base}${filter} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, ...filterParams, pageSize, (page - 1) * pageSize],
    )
    return { items: rows.map(row => ({ ...row, tags: parse(row.tags_json) })), total: Number(total?.count || 0), page, pageSize }
  }

  async listGroupMembers(groupId: unknown, options: RepositoryOptions = {}): Promise<UnknownRecord[]> {
    const key = String(groupId || "").trim()
    if (!key) return []
    const query = String(options.query || "").trim().slice(0, 120)
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 80))
    const filter = query ? " AND (member_id LIKE ? OR member_name LIKE ?)" : ""
    const history=options.includeHistory===true
    const params = [key, key, ...(history?[]:[Date.now()]), ...(query ? [`%${query}%`, `%${query}%`] : []), limit]
    const rows = await sqliteClient.all<UnknownRecord>(
      `SELECT member_id, MAX(member_name) AS member_name, MAX(seen_at) AS last_seen_at,
        COUNT(DISTINCT NULLIF(memory_id, '')) AS memory_count
       FROM (
         SELECT sender_id AS member_id, sender_name AS member_name, sent_at AS seen_at, '' AS memory_id
         FROM group_memory_messages
         WHERE group_id=? AND sender_id<>''
         UNION ALL
         SELECT owner_id AS member_id, '' AS member_name, updated_at AS seen_at, id AS memory_id
         FROM memory_items
         WHERE scope_type='user_group' AND group_id=? AND type NOT IN ('profile','short')
           AND NOT (type='episode' AND source='interaction')
           AND ${history?"status<>'deleted'":"status IN ('active','warm','cold') AND (expires_at=0 OR expires_at>?)"}
       )
       WHERE member_id<>''${filter}
       GROUP BY member_id
       ORDER BY memory_count DESC, last_seen_at DESC, member_id ASC
       LIMIT ?`,
      params,
    )
    return rows.map(row => ({
      userId: row.member_id,
      name: row.member_name || "",
      lastSeenAt: Number(row.last_seen_at || 0),
      memoryCount: Number(row.memory_count || 0),
    }))
  }

  /** 当前群成员可用于文本指代的最新群名片、QQ 昵称和自述别名。 */
  async listGroupIdentityNames(groupId: unknown, limit: unknown = 500): Promise<UnknownRecord[]> {
    const key = String(groupId || "").trim()
    if (!key) return []
    const rows = await sqliteClient.all<UnknownRecord>(
      `WITH latest_group_names AS (
         SELECT sender_id AS owner_id, sender_name AS alias, sent_at AS seen_at
         FROM (
           SELECT sender_id, sender_name, sent_at,
             ROW_NUMBER() OVER (PARTITION BY sender_id ORDER BY sent_at DESC, message_id DESC) AS owner_rank
           FROM group_memory_messages
           WHERE group_id=? AND sender_id<>'' AND sender_name<>''
         )
         WHERE owner_rank=1
       ), group_members AS (
         SELECT owner_id FROM latest_group_names
         UNION
         SELECT owner_id FROM memory_items
         WHERE scope_type='user_group' AND group_id=? AND status IN ('active','warm','cold')
       ), identity_names AS (
         SELECT m.owner_id, m.fact_value AS alias, m.updated_at AS seen_at
         FROM memory_items m
         JOIN group_members g ON g.owner_id=m.owner_id
         WHERE m.fact_key IN ('identity.qq_nickname','identity.group_card','identity.nickname')
           AND m.status IN ('active','warm','cold') AND TRIM(m.fact_value)<>''
           AND (m.expires_at=0 OR m.expires_at>?)
           AND ((m.scope_type='user' AND m.group_id='') OR (m.scope_type='user_group' AND m.group_id=?))
       )
       SELECT owner_id, alias, MAX(seen_at) AS seen_at
       FROM (
         SELECT owner_id, alias, seen_at FROM latest_group_names
         UNION ALL
         SELECT owner_id, alias, seen_at FROM identity_names
       )
       WHERE owner_id<>'' AND TRIM(alias)<>''
       GROUP BY owner_id, alias
       ORDER BY seen_at DESC
       LIMIT ?`,
      [key, key, Date.now(), key, Math.max(1, Math.min(1000, Number(limit) || 500))],
    )
    return rows.map(row => ({ ownerId: String(row.owner_id || ""), alias: String(row.alias || "").trim() })).filter(row => row.ownerId && row.alias)
  }

  async search(scopes: MemoryScope[] = [], query: unknown = "", options: RepositoryOptions = {}): Promise<MemoryItem[]> {
    if (!scopes.length || !String(query).trim()) return []
    const conditions = scopes.map(() => "(m.scope_type=? AND m.owner_id=? AND m.group_id=?)").join(" OR ")
    const params = scopes.flatMap(scope => [scope.scopeType, scope.ownerId, scope.groupId || ""])
    const match = ftsQuery(query)
    if (!match) return []
    let rows: MemoryItem[] = []
    try {
      rows = await sqliteClient.all<MemoryItem>(`SELECT m.*, -bm25(memory_fts) AS score FROM memory_fts JOIN memory_items m ON m.id=memory_fts.memory_id WHERE memory_fts MATCH ? AND (${conditions}) AND m.status IN ('active','warm','cold') AND (m.expires_at = 0 OR m.expires_at > ?) ORDER BY bm25(memory_fts) LIMIT ?`, [match, ...params, Date.now(), Math.max(1, Number(options.limit) || 20)])
    } catch { /* Unicode FTS 的分词差异不应阻断本地 LIKE 降级。 */ }
    if (!rows.length) {
      const like = `%${String(query).trim().slice(0, 200)}%`
      rows = await sqliteClient.all<MemoryItem>(`SELECT m.*, 0.1 AS score FROM memory_items m WHERE (${conditions}) AND m.status IN ('active','warm','cold') AND (m.expires_at = 0 OR m.expires_at > ?) AND m.text LIKE ? ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`, [...params, Date.now(), like, Math.max(1, Number(options.limit) || 20)])
    }
    return rows.map(row => ({ ...row, tags: parse(row.tags_json) }))
  }

  async listProfiles(limit: unknown = 50): Promise<MemoryItem[]> {
    const rows = await sqliteClient.all<MemoryItem>("SELECT * FROM memory_items WHERE type='profile' AND status='active' ORDER BY updated_at DESC LIMIT ?", [Math.max(1, Number(limit) || 50)])
    return rows.map(row => ({ ...row, profile: parse(row.text, {}), tags: parse(row.tags_json) }))
  }

  // 画像点查：不经过 listProfiles 的条数上限，画像总量超过上限时也能命中旧用户。
  async getProfileByOwner(ownerId: unknown): Promise<MemoryItem | null> {
    const key = String(ownerId || "").trim()
    if (!key) return null
    const row = await sqliteClient.get<MemoryItem>(
      "SELECT * FROM memory_items WHERE type='profile' AND status='active' AND owner_id=? ORDER BY updated_at DESC LIMIT 1",
      [key],
    )
    return row ? { ...row, profile: parse(row.text, {}), tags: parse(row.tags_json) } : null
  }

  // 画像列表的事实预览一次取齐（按 owner 分区取前 N 条），替代每个画像一次查询的 N+1。
  async listFactsByOwners(ownerIds: unknown[] = [], { factLimit = 3 }: { factLimit?: unknown } = {}): Promise<Map<string, MemoryItem[]>> {
    const unique = [...new Set((Array.isArray(ownerIds) ? ownerIds : []).map(String).filter(Boolean))]
    const byOwner = new Map<string, MemoryItem[]>()
    if (!unique.length) return byOwner
    const rows = await sqliteClient.all<MemoryItem>(
      `SELECT * FROM (
         SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.owner_id ORDER BY m.importance DESC, m.updated_at DESC) AS owner_rank
         FROM memory_items m
         WHERE m.scope_type='user' AND m.group_id='' AND m.type='fact'
           AND m.status IN ('active','warm','cold') AND (m.expires_at = 0 OR m.expires_at > ?)
           AND m.owner_id IN (${unique.map(() => "?").join(",")})
       ) WHERE owner_rank <= ?`,
      [Date.now(), ...unique, Math.max(1, Number(factLimit) || 3)],
    )
    for (const { owner_rank: _ownerRank, ...row } of rows) {
      const ownerId = String(row.owner_id || "")
      const list = byOwner.get(ownerId) || []
      list.push({ ...row, tags: parse(row.tags_json) })
      byOwner.set(ownerId, list)
    }
    return byOwner
  }

  async listManagedScopes(options: RepositoryOptions = {}): Promise<MemoryItem[]> {
    const requestedType = options.scopeType === "user" || options.scopeType === "group" ? options.scopeType : ""
    const params = requestedType ? [requestedType] : []
    const rows = await sqliteClient.all<MemoryItem>(`
      SELECT scope_type, owner_id, group_id,
        SUM(CASE WHEN type NOT IN ('profile', 'short') THEN 1 ELSE 0 END) AS memory_count,
        MAX(updated_at) AS updated_at,
        MAX(CASE WHEN type = 'profile' THEN text ELSE '' END) AS profile_json
      FROM memory_items
      WHERE scope_type IN ('user', 'group')
        AND status IN ('active', 'warm', 'cold')
        ${requestedType ? "AND scope_type = ?" : ""}
      GROUP BY scope_type, owner_id, group_id
      ORDER BY updated_at DESC
      LIMIT 1000
    `, params)
    const query = String(options.query || "").trim().toLowerCase()
    const filtered = query
      ? rows.filter(row => `${row.owner_id} ${row.profile_json || ""}`.toLowerCase().includes(query))
      : rows
    return filtered.slice(0, Math.max(1, Math.min(500, Number(options.limit) || 200))).map(row => ({
      ...row,
      profile: parse(row.profile_json, {}),
    }))
  }

  async deleteExpired(graceDays: unknown = 30, expiredFactDays: unknown = 0): Promise<number> {
    const threshold = Date.now() - Math.max(0, Number(graceDays) || 30) * 86400000
    const factDays = Math.max(0, Number(expiredFactDays) || 0)
    const rows = await sqliteClient.all<UnknownRecord>("SELECT id FROM memory_items WHERE expires_at > 0 AND ((type IN ('short','episode') AND expires_at < ?) OR (type='fact' AND ?>0 AND expires_at < ?))", [threshold,factDays,Date.now()-factDays*86400000])
    if (!rows.length) return 0
    const ids = rows.map(row => row.id)
    await sqliteClient.transaction([{ sql: `DELETE FROM memory_fts WHERE memory_id IN (${ids.map(() => "?").join(",")})`, params: ids }, { sql: `DELETE FROM memory_items WHERE id IN (${ids.map(() => "?").join(",")})`, params: ids }])
    vectorRecall.markDirty()
    return ids.length
  }
}

export const memoryRepository = new MemoryRepository()
