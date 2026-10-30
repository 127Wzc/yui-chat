import crypto from "node:crypto"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { ftsIndexText } from "./repository.js"
import type { SqliteOperation } from "../core/storage/types.js"

export type Row = Record<string, unknown>
export interface Target { groupId: string; userId: string }
export interface MemoryRow extends Row {
  id: string; scope_type: string; owner_id: string; group_id: string; type: string; text: string
  fact_key: string; fact_value: string; normalized_key: string; tags_json: string; source: string; status: string
  confidence: number; importance: number; created_at: number; updated_at: number; last_confirmed_at: number; expires_at: number
}
export interface Evidence extends Row { memory_id: string; source_event_id: string; source_type: string; message_id: string }
export interface Version { scopeType: string; ownerId: string; groupId: string; revision: number }
export interface MessageRef { id: string; hash: string; sentAt: number; expiresAt: number }
export interface Snapshot { memories: MemoryRow[]; evidence: Evidence[]; versions: Version[]; messages: MessageRef[] }
export interface Job extends Target {
  id: string; status: string; useHistory: boolean; requestedCount: number; progress: Row
  snapshot: Snapshot; plan: Row[]; receipt: Row; applyHash: string
  createdAt: number; expiresAt: number; undoUntil: number; reviewedAt: number; error: string
}

export const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
export const records = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
function stable(value: unknown): unknown {
  if(Array.isArray(value))return value.map(stable)
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]))
  return value
}
export const hash = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")
export const messageHash = (row:Row):string => hash(["id","group_id","message_id","sender_id","sent_at","text_content","segments_json","is_command","expires_at"].map(key=>row[key]))
export const identifier = (value: unknown): string => {
  const id = String(value || "").trim()
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(id)) throw new Error("群或用户标识无效。")
  return id
}
export function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode, maintenanceError: true }) }

export function targetScopes(target: Target): Omit<Version,"revision">[] {
  return target.userId ? [
    { scopeType: "user", ownerId: target.userId, groupId: "" },
    { scopeType: "user_group", ownerId: target.userId, groupId: target.groupId },
  ] : [{ scopeType: "group", ownerId: target.groupId, groupId: target.groupId }]
}
export async function versions(target: Target): Promise<Version[]> {
  const result: Version[] = []
  for (const scope of targetScopes(target)) {
    const row = await sqliteClient.get("SELECT revision FROM memory_maintenance_versions WHERE scope_type=? AND owner_id=? AND group_id=?", [scope.scopeType, scope.ownerId, scope.groupId])
    result.push({ ...scope, revision: Number(row?.revision || 0) })
  }
  return result
}
export function versionGuards(values: Version[]): SqliteOperation[] {
  return values.map(scope => ({
    sql: "SELECT COALESCE((SELECT revision FROM memory_maintenance_versions WHERE scope_type=? AND owner_id=? AND group_id=?),0) AS revision",
    params: [scope.scopeType,scope.ownerId,scope.groupId], mode: "get", expect: { revision: scope.revision },
  }))
}
/** 全量事实和提炼经历；默认路径只读取证据元信息，绝不关联聊天原文。 */
export async function readSnapshot(target: Target): Promise<Snapshot> {
  const before = await versions(target)
  const memories = await readMemories(target)
  const evidence: Evidence[] = []
  for (let i=0;i<memories.length;i+=400) {
    const ids = memories.slice(i,i+400).map(m=>m.id)
    const sources=await sqliteClient.all<Evidence>(`SELECT * FROM memory_evidence WHERE memory_id IN (${ids.map(()=>"?").join(",")}) ORDER BY memory_id,source_event_id LIMIT 20001`, ids)
    if(sources.length>20000||evidence.length+sources.length>100000)fail("来源证据超过单任务读取上限，未将部分来源当作完整资料。")
    evidence.push(...sources)
  }
  if (hash(before) !== hash(await versions(target))) fail("读取期间记忆已变化，请重新分析。",409)
  return { memories, evidence, versions: before, messages: [] }
}
export async function readMemories(target: Target): Promise<MemoryRow[]> {
  const scopes = targetScopes(target)
  const where = scopes.map(() => "(scope_type=? AND owner_id=? AND group_id=?)").join(" OR ")
  const memories = await sqliteClient.all<MemoryRow>(`SELECT * FROM memory_items WHERE (${where})
    AND type IN ('fact','episode') AND NOT(type='episode' AND source='interaction')
    AND status IN ('active','warm','cold') ORDER BY fact_key,scope_type,group_id,id LIMIT 10001`, scopes.flatMap(s => [s.scopeType,s.ownerId,s.groupId]))
  if (memories.length > 10000) fail("待整理记忆超过单次读取上限，未执行部分整理；请先缩小范围。")
  return memories
}
export async function getJob(id: unknown): Promise<Job> {
  const row = await sqliteClient.get("SELECT * FROM memory_maintenance_jobs WHERE id=?", [identifier(id)])
  if (!row) fail("整理任务不存在、已到期或关联资料已被清理。",404)
  if(Number(row.expires_at)<=Date.now())fail("整理任务已超过保留期限，请创建新的任务。",404)
  return {
    id: String(row.id), groupId: String(row.group_id), userId: String(row.user_id), status: String(row.status),
    useHistory: row.use_history === 1, requestedCount: Number(row.requested_count),
    progress: JSON.parse(String(row.progress_json)), snapshot: {memories:[],evidence:[],versions:[],messages:[],...JSON.parse(String(row.snapshot_json))},
    plan: JSON.parse(String(row.plan_json)), receipt: JSON.parse(String(row.receipt_json)),
    applyHash: String(row.apply_hash), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), undoUntil: Number(row.undo_until), reviewedAt: Number(row.reviewed_at), error: String(row.error_message),
  }
}
export function publicJob(job: Job): Row {
  return { id: job.id, groupId: job.groupId, userId: job.userId, status: job.status, useHistory: job.useHistory, requestedCount: job.requestedCount,
    progress: job.progress, plan: job.plan, receipt: job.status === "applied" || job.status === "undone" ? record(job.receipt.summary) : {},
    createdAt: job.createdAt, expiresAt: job.expiresAt, undoUntil: job.undoUntil, reviewedAt: job.reviewedAt, error: job.error }
}
export async function saveJob(id: string, patch: Row, statuses: string[] = ["queued","collecting","analyzing"]): Promise<void> {
  const allowed: Record<string,string> = { status:"status", progress:"progress_json", snapshot:"snapshot_json", plan:"plan_json", error:"error_message" }
  const pairs = Object.entries(patch).filter(([key])=>allowed[key])
  const result = await sqliteClient.run(`UPDATE memory_maintenance_jobs SET ${pairs.map(([key])=>`${allowed[key]}=?`).join(",")},updated_at=? WHERE id=? AND status IN (${statuses.map(()=>"?").join(",")})`, [...pairs.map(([key,value])=>allowed[key].endsWith("_json") ? JSON.stringify(value):value),Date.now(),id,...statuses])
  if (Number(result.changes)!==1) fail("任务已取消、资料已清理或状态已变化。",409)
}
export async function saveSnapshot(job: Job, snapshot: Snapshot): Promise<void> {
  const groups = new Set([job.groupId,...snapshot.memories.map(m=>m.group_id),...snapshot.evidence.filter(e=>e.source_type.startsWith("group-message:")).map(e=>e.source_type.slice(14))].filter(Boolean))
  const operations: SqliteOperation[] = [
    ...versionGuards(snapshot.versions),
    { sql: "UPDATE memory_maintenance_jobs SET snapshot_json=?,updated_at=? WHERE id=? AND status='collecting'", params:[JSON.stringify(snapshot),Date.now(),job.id],expectChanges:1 },
    ...snapshot.memories.map(m=>({sql:"INSERT OR IGNORE INTO memory_maintenance_sources(job_id,memory_id,group_id) VALUES(?,?,?)",params:[job.id,m.id,""]})),
    ...[...groups].map(group=>({sql:"INSERT OR IGNORE INTO memory_maintenance_sources(job_id,memory_id,group_id) VALUES(?,?,?)",params:[job.id,"",group]})),
  ]
  await sqliteClient.transaction(operations)
}

const columns = ["id","scope_type","owner_id","group_id","type","text","normalized_key","fact_key","fact_value","tags_json","importance","confidence","status","source","last_confirmed_at","expires_at","created_at","updated_at"] as const
/** 写入来源、正文、事实键和检索正文共用事务；范围迁移也通过本方法处理。 */
export function writeMemory(row: MemoryRow, exists: boolean, evidence: Evidence[], replaceEvidence = false): SqliteOperation[] {
  const operations: SqliteOperation[] = exists ? [{ sql: `UPDATE memory_items SET ${columns.slice(1).map(c=>`${c}=?`).join(",")} WHERE id=?`,params:[...columns.slice(1).map(c=>row[c]),row.id],expectChanges:1 }]
    : [{ sql:`INSERT INTO memory_items(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`,params:columns.map(c=>row[c]),expectChanges:1 }]
  operations.push({sql:"DELETE FROM memory_fts WHERE memory_id=?",params:[row.id]})
  if (row.status!=="deleted") operations.push({sql:"INSERT INTO memory_fts(memory_id,text) VALUES(?,?)",params:[row.id,ftsIndexText(row.text)]})
  if (replaceEvidence) operations.push({sql:"DELETE FROM memory_evidence WHERE memory_id=?",params:[row.id]})
  for (const source of evidence) operations.push({sql:"INSERT INTO memory_evidence(memory_id,source_event_id,source_type,message_id) VALUES(?,?,?,?) ON CONFLICT(memory_id,source_event_id) DO NOTHING",params:[row.id,source.source_event_id,source.source_type,source.message_id]})
  return operations
}
export async function currentRows(ids: string[]): Promise<MemoryRow[]> {
  const rows: MemoryRow[] = []
  for (let i=0;i<ids.length;i+=400) { const part=ids.slice(i,i+400); rows.push(...await sqliteClient.all<MemoryRow>(`SELECT * FROM memory_items WHERE id IN (${part.map(()=>"?").join(",")}) ORDER BY id`,part)) }
  return rows
}
export async function currentEvidence(ids: string[]): Promise<Evidence[]> {
  const rows: Evidence[] = []
  for(let i=0;i<ids.length;i+=400){const part=ids.slice(i,i+400);rows.push(...await sqliteClient.all<Evidence>(`SELECT * FROM memory_evidence WHERE memory_id IN (${part.map(()=>"?").join(",")}) ORDER BY memory_id,source_event_id`,part))}
  return rows
}
export async function cleanupMaintenance(): Promise<void> {
  await sqliteClient.run("DELETE FROM memory_maintenance_jobs WHERE (status='applied' AND undo_until<?) OR (status<>'applied' AND expires_at<?)",[Date.now(),Date.now()])
}
