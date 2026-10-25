import { cleanCommandRetrievalText } from "./command-retrieval-text.js"
import crypto from "node:crypto"
import { configStore } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import type { SqliteOperation } from "../core/storage/types.js"
import { cloneJsonValue } from "../core/shared/json-values.js"
import { chunkText, contentHash } from "./chunking.js"
import { knowledgeRepository } from "./repository.js"
import { knowledgeIndexJobs } from "./index-jobs.js"
import { commandAvailability, commandPluginId, readCommandAvailability } from "./command-availability.js"

type Row = Record<string, any>
export const COMMAND_BASE = "builtin-commands"
const key = (id: string): string => `command:${id}`
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => [name, canonical(child)])) : value }
const signature = (value: unknown): string => contentHash(JSON.stringify(canonical(value)))
interface ImportDocument { id: string; title: string; retrievalText: string; metadata: Row }
interface Bundle { schemaVersion: 1; sourceId: string; complete: boolean; documents: ImportDocument[]; deletedIds: string[] }
export interface ImportOptions { policy?: "overwrite" | "skip"; deleteMissing?: boolean; expectedRevision?: string; operation?: "import" | "edit" | "restore" | "delete" }
let mutationQueue: Promise<unknown> = Promise.resolve()
function serialize<T>(action: () => Promise<T>): Promise<T> { const next = mutationQueue.then(action, action); mutationQueue = next.then(() => undefined, () => undefined); return next }
function normalize(input: unknown): Bundle {
  const bundle = record(input)
  if (bundle.schemaVersion !== 1 || typeof bundle.sourceId !== "string" || !/^[\w:.-]{1,120}$/u.test(bundle.sourceId)) throw new Error("请提供 schemaVersion=1 和有效的 sourceId")
  if (!Array.isArray(bundle.documents) || bundle.documents.length > 10000) throw new Error("documents 必须是数组，最多 10000 条")
  const seen = new Set<string>()
  const documents = bundle.documents.map((raw: unknown) => {
    const row = record(raw)
    if (typeof row.id !== "string" || !row.id.trim() || row.id !== row.id.trim() || row.id.length > 900 || /[\u0000-\u001f]/u.test(row.id)) throw new Error("每条指令必须有不超过 900 字符的永久 ID")
    if (seen.has(row.id)) throw new Error(`导入文件有重复 ID：${row.id}`)
    seen.add(row.id)
    if (typeof row.retrievalText !== "string" || !row.retrievalText.trim() || row.retrievalText.length > 60000) throw new Error(`检索正文不能为空且最多 60000 字符：${row.id}`)
    const metadata = cloneJsonValue(record(row.metadata))
    if (!cleanCommandRetrievalText(row.retrievalText, metadata)) throw new Error(`清理后的检索正文不能为空：${row.id}`)
    if (JSON.stringify(metadata).length > 100000) throw new Error(`元数据过大：${row.id}`)
    return { id: row.id, title: String(row.title || metadata.suggestedCommand || metadata.fnc || row.id).slice(0, 500), retrievalText: cleanCommandRetrievalText(row.retrievalText, metadata), metadata }
  })
  const deletedIds = bundle.deletedIds === undefined ? [] : bundle.deletedIds
  if (!Array.isArray(deletedIds) || deletedIds.length > 10000 || deletedIds.some(id => typeof id !== "string" || !id || id.length > 900 || seen.has(id))) throw new Error("deletedIds 必须是有效 ID 数组，且不能同时出现在 documents 中")
  const normalized: Bundle = { schemaVersion: 1, sourceId: bundle.sourceId, complete: bundle.complete === true, documents, deletedIds: [...new Set<string>(deletedIds)] }
  if (Buffer.byteLength(JSON.stringify(normalized)) > 12 * 1024 * 1024) throw new Error("导入数据最多 12 MiB")
  return normalized
}
function metadataFor(document: ImportDocument, sourceId: string): Row {
  const raw = document.metadata
  const command = { ...raw, id: document.id, retrievalText: document.retrievalText, suggestedCommand: typeof raw.suggestedCommand === "string" ? raw.suggestedCommand : raw.example || document.title, origin: record(raw.origin), description: raw.description || document.title, imported: true }
  return { commandId: document.id, importSourceId: sourceId, origin: command.origin, command, chunkOptions: { targetChars: 6000, overlapChars: 0, minChars: 1 } }
}
function documentFrom(row: Row): ImportDocument {
  const meta = record(row.metadata || JSON.parse(row.metadata_json || "{}")), command = record(meta.command)
  const { id: _id, retrievalText: _text, imported: _imported, ...raw } = command
  return { id: String(meta.commandId || String(row.source_key).slice(8)), title: String(row.title), retrievalText: String(row.content), metadata: raw }
}
export function commandChunks(text: string): Array<{ content: string; contentHash: string }> {
  return text.length <= 6000 ? [{ content: text, contentHash: contentHash(text) }] : chunkText(text, { targetChars: 1600, overlapChars: 0, minChars: 1 })
}
async function currentRows(): Promise<Row[]> { return sqliteClient.all<Row>("SELECT * FROM knowledge_documents WHERE knowledge_base_id=? AND source_type='command'", [COMMAND_BASE]) }
async function plan(input: unknown, options: ImportOptions): Promise<{ bundle: Bundle; rows: Row[]; changes: Row[]; summary: Row; revision: string }> {
  const bundle = normalize(input)
  if (options.policy !== undefined && !["overwrite", "skip"].includes(options.policy)) throw new Error("未知覆盖策略")
  if (options.deleteMissing) throw new Error("导入不执行同步删除，请在列表中手动删除")
  if (bundle.deletedIds.length && options.operation !== "delete") throw new Error("导入不能删除条目，请使用列表删除操作")
  const rows = await currentRows(), byKey = new Map(rows.map(row => [row.source_key, row]))
  const missingKeys = bundle.documents.filter(document => !byKey.has(key(document.id))).map(document => key(document.id))
  for (let offset = 0; offset < missingKeys.length; offset += 200) {
    const keys = missingKeys.slice(offset, offset + 200)
    const history = await sqliteClient.all<Row>(`SELECT DISTINCT source_key,json_extract(snapshot_json,'$.sourceId') AS source_id FROM knowledge_document_history WHERE knowledge_base_id=? AND source_key IN (${keys.map(() => "?").join(",")})`, [COMMAND_BASE, ...keys])
    if (history.some(row => row.source_id !== bundle.sourceId)) throw new Error("ID 的保留历史已属于其他来源，禁止复用")
  }
  const changes: Row[] = [], summary = { inserted: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 }
  for (const document of bundle.documents) {
    const current = byKey.get(key(document.id)), metadata = metadataFor(document, bundle.sourceId)
    if (current && record(JSON.parse(current.metadata_json)).importSourceId !== bundle.sourceId) throw new Error(`ID 已属于其他来源，禁止覆盖：${document.id}`)
    if (current && signature({ title: current.title, text: current.content, metadata: JSON.parse(current.metadata_json).command }) === signature({ title: document.title, text: document.retrievalText, metadata: metadata.command })) { summary.unchanged++; continue }
    if (current && options.policy !== "overwrite") { summary.skipped++; continue }
    const operation = current ? "update" : "insert"
    summary[current ? "updated" : "inserted"]++
    changes.push({ id: document.id, operation, document, current, metadata })
  }
  const deletes = new Set(bundle.deletedIds)
  for (const id of deletes) {
    const current = byKey.get(key(id)); if (!current) continue
    if (record(JSON.parse(current.metadata_json)).importSourceId !== bundle.sourceId) throw new Error(`不能删除其他来源的 ID：${id}`)
    changes.push({ id, operation: "delete", current }); summary.deleted++
  }
  const revision = signature(rows.map(row => [row.id, row.updated_at, row.content_hash, row.metadata_json]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  return { bundle, rows, changes, summary, revision }
}
async function applyImport(input: unknown, options: ImportOptions, schedule = true): Promise<Row> {
  const { bundle, changes, summary, revision } = await plan(input, options)
  if (options.expectedRevision && options.expectedRevision !== revision) throw Object.assign(new Error("预览后知识库已变化，请重新预览"), { statusCode: 409 })
  const runId = crypto.randomUUID(), timestamp = Date.now(), operations: SqliteOperation[] = [{ sql: "INSERT INTO knowledge_import_runs(id, source_id, operation, summary_json, created_at) VALUES(?,?,?,?,?)", params: [runId, bundle.sourceId, options.operation || "import", JSON.stringify({ ...summary, policy: options.policy || "skip" }), timestamp] }]
  let chunkDelta = 0
  for (const change of changes) {
    const sourceKey = key(change.id), current = change.current as Row | undefined
    if (current) {
      const snapshot = { sourceId: bundle.sourceId, document: documentFrom(current) }
      operations.push({ sql: "INSERT INTO knowledge_document_history(knowledge_base_id,source_key,snapshot_json,operation,created_at) VALUES(?,?,?,?,?)", params: [COMMAND_BASE, sourceKey, JSON.stringify(snapshot), change.operation, timestamp] },
        { sql: "DELETE FROM knowledge_document_history WHERE knowledge_base_id=? AND source_key=? AND id NOT IN (SELECT id FROM knowledge_document_history WHERE knowledge_base_id=? AND source_key=? ORDER BY id DESC LIMIT ?)", params: [COMMAND_BASE, sourceKey, COMMAND_BASE, sourceKey, change.operation === "delete" ? 3 : 2] })
    }
    const oldChunks = current ? await sqliteClient.all<Row>("SELECT id FROM knowledge_chunks WHERE document_id=?", [current.id]) : []
    if (change.operation === "delete") { chunkDelta -= oldChunks.length; operations.push({ sql: "DELETE FROM knowledge_documents WHERE id=?", params: [current!.id] }) }
    else {
      const chunks = commandChunks(change.document.retrievalText)
      chunkDelta += chunks.length - oldChunks.length
      const prepared = await knowledgeRepository.prepareDocument({ knowledgeBaseId: COMMAND_BASE, sourceType: "command", sourceKey, title: change.document.title, content: change.document.retrievalText, contentHash: contentHash(change.document.retrievalText), metadata: change.metadata, chunks })
      operations.push(...prepared.operations)
      if (prepared.result.changed) operations.push({ sql: "INSERT INTO knowledge_vector_tasks(kind,owner_id,knowledge_base_id,content_hash,updated_at) VALUES('document',?,?,?,?) ON CONFLICT(kind,owner_id) DO UPDATE SET content_hash=excluded.content_hash, updated_at=excluded.updated_at, attempts=0,retry_at=0,error=''", params: [prepared.result.id, COMMAND_BASE, contentHash(change.document.retrievalText), timestamp] })
    }
    // Cleanup is idempotent and durable; the worker checks whether a chunk was retained before deleting.
    for (const chunk of oldChunks) operations.push({ sql: "INSERT INTO knowledge_vector_tasks(kind,owner_id,knowledge_base_id,content_hash,updated_at) VALUES('delete',?,?, '',?) ON CONFLICT(kind,owner_id) DO UPDATE SET updated_at=excluded.updated_at,attempts=0,retry_at=0,error=''", params: [chunk.id, COMMAND_BASE, timestamp] })
    operations.push({ sql: "INSERT INTO knowledge_import_changes(run_id,document_key,operation,before_hash,after_hash) VALUES(?,?,?,?,?)", params: [runId, change.id, options.operation === "restore" ? "restore" : change.operation, current?.content_hash || "", change.document ? contentHash(change.document.retrievalText) : ""] })
  }
  if (chunkDelta > 0) {
    const maxChunks = Math.max(1, Number(record(record(configStore.get().knowledge).indexing).maxChunksPerKnowledgeBase) || 100000)
    const total = Number((await sqliteClient.get("SELECT COUNT(*) AS n FROM knowledge_chunks WHERE knowledge_base_id=?", [COMMAND_BASE]))?.n || 0) + chunkDelta
    if (total > maxChunks) throw new Error(`知识库分块将达到 ${total}，超过 ${maxChunks} 上限`)
  }
  for (const change of changes.filter(row => row.operation !== "delete")) operations.push({ sql: "DELETE FROM knowledge_document_history WHERE knowledge_base_id=? AND source_key=? AND id NOT IN (SELECT id FROM knowledge_document_history WHERE knowledge_base_id=? AND source_key=? ORDER BY id DESC LIMIT 2)", params: [COMMAND_BASE, key(change.id), COMMAND_BASE, key(change.id)] })
  if (changes.length) operations.push({ sql: "UPDATE knowledge_bases SET updated_at=MAX(updated_at+1,?) WHERE id=?", params: [timestamp, COMMAND_BASE] })
  await sqliteClient.transaction(operations)
  if (changes.length && schedule) knowledgeIndexJobs.scheduleAvailable()
  return { runId, summary, changed: changes.length > 0 }
}
export const commandImports = {
  preview(input: unknown, options: ImportOptions = {}): Promise<Row> { return serialize(async () => { const result = await plan(input, options); return { summary: result.summary, revision: result.revision, changes: result.changes.map(row => ({ id: row.id, operation: row.operation, title: row.document?.title || row.current.title })) } }) },
  apply(input: unknown, options: ImportOptions = {}): Promise<Row> {
    return serialize(() => applyImport(input, options))
  },
  /** 显式重建的正文清理和投影更新也占用同一写队列，并保留历史/审计。 */
  rebuildRetrieval<T>(rebuild: () => Promise<T>): Promise<T> {
    return serialize(async () => {
      const busy = await sqliteClient.get("SELECT id FROM knowledge_index_jobs WHERE knowledge_base_id=? AND status IN ('queued','running','canceling','retrying')", [COMMAND_BASE])
      if (busy) throw Object.assign(new Error("已有索引任务，请完成或取消后再重建"), { code: "KNOWLEDGE_INDEX_ALREADY_RUNNING", statusCode: 409 })
      const groups = new Map<string, ImportDocument[]>()
      for (const row of await currentRows()) {
        const sourceId = record(JSON.parse(row.metadata_json)).importSourceId
        if (!sourceId) continue
        const document = documentFrom(row)
        if (cleanCommandRetrievalText(document.retrievalText, document.metadata) === document.retrievalText) continue
        groups.set(sourceId, [...(groups.get(sourceId) || []), document])
      }
      for (const [sourceId, documents] of groups) {
        await applyImport({ schemaVersion: 1, sourceId, complete: false, documents }, { policy: "overwrite", operation: "edit" }, false)
      }
      return rebuild()
    })
  },
  async list(): Promise<Row[]> {
    const state = await readCommandAvailability()
    return (await currentRows()).map(row => {
      const document = documentFrom(row), sourceId = JSON.parse(row.metadata_json).importSourceId || "yunzai"
      return { ...document, sourceId, documentId: row.id, updatedAt: row.updated_at, ...commandAvailability(document.id, sourceId, document.metadata, state) }
    })
  },
  setAvailability(input: Row): Promise<Row> {
    return serialize(async () => {
      const { sourceId, kind, ids, enabled } = input
      if (typeof sourceId !== "string" || !/^[\w:.-]{1,120}$/u.test(sourceId) || !["plugin", "command"].includes(kind) || typeof enabled !== "boolean"
        || !Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== "string" || !id || id.length > 1000)) throw new Error("请提供有效来源、目标和启停状态")
      const targets = [...new Set<string>(ids)]
      const rows: Row[] = []
      const select = "SELECT metadata_json FROM knowledge_documents WHERE knowledge_base_id=? AND source_type='command' AND json_extract(metadata_json,'$.importSourceId')=?"
      if (kind === "plugin") rows.push(...await sqliteClient.all<Row>(select, [COMMAND_BASE, sourceId]))
      else for (let offset = 0; offset < targets.length; offset += 200) {
        const batch = targets.slice(offset, offset + 200)
        rows.push(...await sqliteClient.all<Row>(`${select} AND source_key IN (${batch.map(() => "?").join(",")})`, [COMMAND_BASE, sourceId, ...batch.map(key)]))
      }
      const metadata = rows.map(row => JSON.parse(row.metadata_json)), targetSet = new Set(targets)
      const available = new Set(metadata.map(meta => kind === "plugin" ? commandPluginId(record(meta.command)) : String(meta.commandId)))
      if (targets.some(id => !available.has(id))) throw new Error("所选指令或插件不属于当前来源，请刷新列表")
      await sqliteClient.transaction(targets.map(id => enabled
        ? { sql: "DELETE FROM knowledge_command_disabled WHERE source_id=? AND kind=? AND target_id=?", params: [sourceId, kind, id] }
        : { sql: "INSERT OR IGNORE INTO knowledge_command_disabled(source_id,kind,target_id) VALUES(?,?,?)", params: [sourceId, kind, id] }))
      const state = await readCommandAvailability()
      return { availability: metadata.filter(meta => targetSet.has(kind === "plugin" ? commandPluginId(record(meta.command)) : String(meta.commandId))).map(meta => ({ id: String(meta.commandId), ...commandAvailability(String(meta.commandId), sourceId, record(meta.command), state) })) }
    })
  },
  async export(sourceId: string): Promise<Row> { return { schemaVersion: 1, sourceId, complete: true, documents: (await currentRows()).filter(row => JSON.parse(row.metadata_json).importSourceId === sourceId).map(documentFrom) } },
  async history(id: string): Promise<Row[]> { return sqliteClient.all<Row>("SELECT id,operation,created_at,snapshot_json FROM knowledge_document_history WHERE knowledge_base_id=? AND source_key=? ORDER BY id DESC LIMIT 3", [COMMAND_BASE, key(id)]).then(rows => rows.map(row => ({ ...row, snapshot: JSON.parse(row.snapshot_json) }))) },
  async restore(id: string, historyId: number, expectedRevision: string): Promise<Row> {
    const history = (await this.history(id)).find(row => row.id === historyId)
    if (!history) throw new Error("历史版本不存在或已自动清理")
    return this.apply({ schemaVersion: 1, sourceId: history.snapshot.sourceId, documents: [history.snapshot.document] }, { expectedRevision, operation: "restore", policy: "overwrite" })
  },
  async logs(page = 1): Promise<Row> {
    const limit = 20, offset = (Math.max(1, Math.floor(page)) - 1) * limit
    const rows = await sqliteClient.all<Row>("SELECT * FROM knowledge_import_runs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", [limit, offset])
    return { runs: rows.map(row => ({ ...row, summary: JSON.parse(row.summary_json) })), total: Number((await sqliteClient.get("SELECT COUNT(*) AS n FROM knowledge_import_runs"))?.n || 0) }
  },
  async log(id: string): Promise<Row[]> { return sqliteClient.all<Row>("SELECT document_key,operation,before_hash,after_hash FROM knowledge_import_changes WHERE run_id=? ORDER BY document_key", [id]) },
}
