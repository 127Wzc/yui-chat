import { configStore } from "../config/store.js"
import { contentHash, chunkText } from "./chunking.js"
import { knowledgeRepository } from "./repository.js"
import { authorizedKnowledgeBaseIds } from "./access.js"
import { buildKnowledgePrompt, searchKnowledge, type KnowledgeResult } from "./retrieval.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { knowledgeIndexJobs } from "./index-jobs.js"
import { normalizeKnowledgeDocuments } from "./ingestion.js"
import { resolveEmbeddingDimensions } from "../models/embeddings/dimensions.js"
import { normalizeDistanceMetric, vectorIndex } from "./vector-index.js"
import type { KnowledgeIndexJobOptions } from "./index-jobs.js"

type UnknownRecord = Record<string, unknown>

interface KnowledgeEvent extends UnknownRecord {
  isGroup?: boolean
  user_id?: unknown
  group_id?: unknown
}

interface IngestInput extends UnknownRecord {
  knowledgeBaseId: unknown
  name?: unknown
  content?: unknown
  kind?: unknown
  metadata?: unknown
  uri?: unknown
}

interface UpdateDocumentInput extends UnknownRecord {
  knowledgeBaseId: unknown
  documentId: unknown
  title?: unknown
  content?: unknown
}

interface KnowledgeBase extends UnknownRecord {
  id?: unknown
  protected?: unknown
  config?: UnknownRecord
  auto_retrieve?: unknown
  active_vector_space_id?: unknown
}

interface PreparedDocument {
  document: { name: string; content: string; metadata: UnknownRecord }
  text: string
  hash: string
  chunks: UnknownRecord[]
  sourceKey: string
  replacedChunks: number
}

const BUILTIN_COMMANDS_ID = "builtin-commands"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

export class KnowledgeStore {
  initialized = false

  async init(_config: unknown = configStore.get()): Promise<void> {
    if (this.initialized || !sqliteClient.status.available) return
    const existing = await knowledgeRepository.getBase(BUILTIN_COMMANDS_ID)
    await knowledgeRepository.upsertBase({
      id: BUILTIN_COMMANDS_ID,
      name: "内置指令知识库",
      description: "由 Yunzai 指令扫描和人工精修组成的受保护知识库。",
      type: "command",
      builtIn: true,
      protected: true,
      defaultActive: true,
      autoRetrieve: true,
      triggerWords: ["怎么", "如何", "指令", "命令", "帮助", "help"],
      tags: ["builtin", "commands"],
      // 启动时只补齐受保护库的元信息，不覆盖管理员已经选定的向量模型。
      config: {
        ...(existing?.config || {}),
        chunking: { targetChars: 800, overlapChars: 120, minChars: 80, ...(existing?.config?.chunking || {}) },
      },
    })
    for (const role of ["user", "groupAdmin", "groupOwner", "master"]) {
      await knowledgeRepository.setGrant({ knowledgeBaseId: BUILTIN_COMMANDS_ID, principalType: "role", principalId: role })
    }
    this.initialized = true
  }

  async list(e: KnowledgeEvent | null = null): Promise<UnknownRecord[]> {
    const ids = e ? await authorizedKnowledgeBaseIds(e) : null
    return knowledgeRepository.listBases(ids)
  }

  async create(input: UnknownRecord = {}): Promise<UnknownRecord> {
    const baseConfig = this.validateBaseConfig(record(input.config))
    const base = await knowledgeRepository.upsertBase({
      ...input,
      builtIn: false,
      protected: false,
      defaultActive: input.defaultActive !== false,
      autoRetrieve: input.autoRetrieve === true,
      config: {
        embeddingModel: "",
        dimensions: 0,
        chunking: { targetChars: 800, overlapChars: 120, minChars: 80 },
        ...baseConfig,
      },
    })
    // 普通知识库默认仅主人可见；工具权限与库授权由不同表负责。
    if (!base?.id) throw new Error("知识库创建失败")
    await knowledgeRepository.setGrant({ knowledgeBaseId: base.id, principalType: "role", principalId: "master" })
    return base
  }

  validateBaseConfig(input: UnknownRecord = {}, current: UnknownRecord = {}): UnknownRecord {
    const config = record(configStore.get())
    const embeddingModel = String(input.embeddingModel ?? current.embeddingModel ?? "").trim()
    const dimensions = Number(input.dimensions ?? current.dimensions ?? 0)
    const distanceMetric = normalizeDistanceMetric(input.distanceMetric ?? current.distanceMetric ?? "cosine")
    if (!embeddingModel) return { ...current, ...input, embeddingModel: "", dimensions: 0, distanceMetric }
    const model = records(config.models).find(item => text(item.name) === embeddingModel)
    if (record(model?.capabilities).embedding !== true) throw new Error("请选择已启用 embedding 能力的模型")
    return { ...current, ...input, embeddingModel, dimensions: resolveEmbeddingDimensions(model, dimensions), distanceMetric }
  }

  vectorConfigChanged(current: UnknownRecord = {}, next: UnknownRecord = {}): boolean {
    return text(current.embeddingModel) !== text(next.embeddingModel)
      || numberValue(current.dimensions, 0) !== numberValue(next.dimensions, 0)
      || text(current.distanceMetric || "cosine") !== text(next.distanceMetric || "cosine")
  }

  async applyVectorConfigChange(baseId: unknown, current: KnowledgeBase, base: KnowledgeBase | null): Promise<KnowledgeBase | null> {
    if (!this.vectorConfigChanged(current.config || {}, base?.config || {})) return base
    if (base?.config?.embeddingModel) {
      await knowledgeIndexJobs.queue(baseId, { start: true, deferIfActive: true } satisfies KnowledgeIndexJobOptions)
      await sqliteClient.run(
        `UPDATE knowledge_index_jobs
         SET status=CASE WHEN status='running' THEN 'canceling' ELSE 'superseded' END,
             lease_until=0, error='向量配置已变更，等待新配置重建', updated_at=?
         WHERE knowledge_base_id=? AND status IN ('running','retrying','paused_budget','paused_no_model')
           AND (model_name<>? OR dimensions<>? OR distance_metric<>?)`,
        [Date.now(), baseId, base.config.embeddingModel, numberValue(base.config.dimensions, 0), base.config.distanceMetric || "cosine"],
      )
      return knowledgeRepository.getBase(baseId)
    }
    const previousSpaceId = text(current.active_vector_space_id)
    await sqliteClient.transaction([
      { sql: "UPDATE knowledge_bases SET active_vector_space_id=NULL, updated_at=? WHERE id=?", params: [Date.now(), baseId] },
      { sql: "UPDATE knowledge_index_jobs SET status=CASE WHEN status='running' THEN 'canceling' ELSE 'superseded' END, lease_until=0, error='已关闭向量检索', updated_at=? WHERE knowledge_base_id=? AND status IN ('queued','retrying','running','paused_budget','paused_no_model')", params: [Date.now(), baseId] },
    ])
    if (previousSpaceId) await vectorIndex.deleteSpace(previousSpaceId).catch(() => {})
    return knowledgeRepository.getBase(baseId)
  }

  async update(baseId: unknown, input: UnknownRecord = {}): Promise<UnknownRecord> {
    const current = await knowledgeRepository.getBase(baseId)
    if (!current) throw new Error("知识库不存在")
    if (current.protected && (input.name || input.type || input.config)) throw new Error("内置受保护知识库不能修改核心配置")
    const base = await knowledgeRepository.upsertBase({
      ...input,
      id: baseId,
      protected: Boolean(current.protected),
      config: this.validateBaseConfig(record(input.config), current.config || {}),
    })
    return await this.applyVectorConfigChange(baseId, current, base) || {}
  }

  async syncBuiltinCommands(commands: readonly UnknownRecord[] = []): Promise<UnknownRecord> {
    if (!sqliteClient.status.available) return { synced: 0 }
    const normalized = [...new Map(commands
      .map(command => [text(command.id).trim(), command] as const)
      .filter(([id]) => id)).values()]
    const currentCount = await sqliteClient.get(
      "SELECT COUNT(*) AS count FROM knowledge_documents WHERE knowledge_base_id=? AND source_type='command'",
      [BUILTIN_COMMANDS_ID],
    )
    // 空扫描不能把已经可用的 SQLite 投影清空；首次空库则保持空状态即可。
    const currentDocumentCount = numberValue(currentCount?.count, 0)
    if (!normalized.length && currentDocumentCount > 0) {
      return { synced: 0, deleted: 0, total: currentDocumentCount, skipped: true, reason: "empty_command_set" }
    }
    let synced = 0
    let added = 0
    let updated = 0
    const preservedManual = normalized.filter(command => command.manual || command.pluginKey === "manual").length
    const activeSourceKeys = new Set<string>()
    for (const command of normalized) {
      const commandId = text(command.id).trim()
      if (!commandId) continue
      const parameterHints = records(command.parameterHints)
      const documentText = [
        command.pluginName || command.pluginKey,
        command.description || command.summary,
        command.body,
        command.fnc,
        command.regexp,
        ...(Array.isArray(command.commandHeads) ? command.commandHeads : []),
        ...(Array.isArray(command.intentHints) ? command.intentHints : []),
        ...(Array.isArray(command.examples) ? command.examples : []),
        ...parameterHints.map(item => `${text(item.name)} ${text(item.description)}`),
      ].filter(Boolean).map(value => text(value)).join("\n")
      if (!documentText) continue
      activeSourceKeys.add(`command:${commandId}`)
      const hash = contentHash(documentText)
      const origin = record(command.origin)
      const result = await knowledgeRepository.replaceDocument({
        knowledgeBaseId: BUILTIN_COMMANDS_ID,
        sourceType: "command",
        sourceKey: `command:${commandId}`,
        title: text(command.suggestedCommand || command.example || command.fnc || commandId).slice(0, 500),
        content: documentText,
        contentHash: hash,
        metadata: { commandId, origin },
        chunks: chunkText(documentText, { targetChars: 800, overlapChars: 120, minChars: 20 }).map(chunk => ({ ...chunk, tokenCount: Math.ceil(chunk.content.length / 2) })),
      })
      if (result.changed === true) {
        synced++
        if (result.created === true) added++
        else updated++
      }
    }
    const stale = await sqliteClient.all(
      "SELECT id, source_key FROM knowledge_documents WHERE knowledge_base_id=? AND source_type='command'",
      [BUILTIN_COMMANDS_ID],
    )
    let deleted = 0
    for (const document of stale) {
      if (activeSourceKeys.has(text(document.source_key))) continue
      if (await knowledgeRepository.deleteDocument(BUILTIN_COMMANDS_ID, document.id)) deleted++
    }
    const changed = synced > 0 || deleted > 0
    const base = await knowledgeRepository.getBase(BUILTIN_COMMANDS_ID)
    const index = changed && base?.config?.embeddingModel ? await knowledgeIndexJobs.queue(BUILTIN_COMMANDS_ID, { start: true, deferIfActive: true }) : null
    return {
      synced,
      deleted,
      total: normalized.length,
      changed,
      // 扫描前后内容哈希相同就不会创建 generation；人工修订本身是独立文档，
      // 对应插件规则会在扫描阶段被人工修订遮蔽，不会覆盖该正文或单独触发重建。
      comparison: { added, updated, deleted, unchanged: normalized.length - synced, preservedManual },
      index,
    }
  }

  async updateBuiltinRetrieval(input: UnknownRecord = {}): Promise<UnknownRecord> {
    const current = await knowledgeRepository.getBase(BUILTIN_COMMANDS_ID)
    if (!current) throw new Error("内置指令知识库不存在")
    const config = this.validateBaseConfig({
      embeddingModel: input.embeddingModel,
      dimensions: input.dimensions,
      distanceMetric: input.distanceMetric,
    }, current.config || {})
    const base = await knowledgeRepository.upsertBase({
      id: BUILTIN_COMMANDS_ID,
      protected: true,
      config: {
        ...(current.config || {}),
        ...config,
      },
    })
    if (!base) throw new Error("内置指令知识库更新失败")
    const changed = this.vectorConfigChanged(current.config || {}, base.config || {})
    const updatedBase = changed ? await this.applyVectorConfigChange(BUILTIN_COMMANDS_ID, current, base) : base
    const index = changed && updatedBase?.config?.embeddingModel
      ? await sqliteClient.get("SELECT id, status FROM knowledge_index_jobs WHERE knowledge_base_id=? AND status IN ('queued','running','canceling','retrying') ORDER BY created_at DESC LIMIT 1", [BUILTIN_COMMANDS_ID])
      : null
    return { base: updatedBase, index }
  }

  async ingestText({ knowledgeBaseId, name = "直接文本", content = "", kind = "text", metadata = {}, uri = "" }: IngestInput): Promise<UnknownRecord> {
    const base = await knowledgeRepository.getBase(knowledgeBaseId)
    if (!base) throw new Error("知识库不存在")
    const config = record(configStore.get())
    const indexing = record(record(config.knowledge).indexing)
    const maxBytes = Math.max(1024, numberValue(indexing.maxFileBytes, 10485760) || 10485760)
    const documents = normalizeKnowledgeDocuments({ name, content, kind, metadata })
    if (!documents.length) throw new Error("知识内容不能为空")
    const maxChunks = Math.max(1, numberValue(indexing.maxChunksPerKnowledgeBase, 100000) || 100000)
    const prepared: PreparedDocument[] = []
    for (const [position, document] of documents.entries()) {
      const documentText = document.content
      if (Buffer.byteLength(documentText) > maxBytes) throw new Error(`知识内容超过 ${maxBytes} 字节上限`)
      const hash = contentHash(documentText)
      const chunks = chunkText(documentText, record(base.config?.chunking)).map(chunk => ({ ...chunk, tokenCount: Math.ceil(chunk.content.length / 2) }))
      const sourceKey = `${text(uri || name || "source")}:${position}`
      const existing = await sqliteClient.get(
        `SELECT COUNT(c.id) AS chunks FROM knowledge_documents d
         LEFT JOIN knowledge_chunks c ON c.document_id=d.id
         WHERE d.knowledge_base_id=? AND d.source_key=?`,
        [knowledgeBaseId, sourceKey],
      )
      prepared.push({ document, text: documentText, hash, chunks, sourceKey, replacedChunks: numberValue(existing?.chunks, 0) })
    }
    const current = await sqliteClient.get("SELECT COUNT(*) AS chunks FROM knowledge_chunks WHERE knowledge_base_id=?", [knowledgeBaseId])
    const projected = numberValue(current?.chunks, 0) + prepared.reduce((sum, item) => sum + item.chunks.length - item.replacedChunks, 0)
    if (projected > maxChunks) throw new Error(`知识库分块将达到 ${projected}，超过 ${maxChunks} 上限`)
    const results = []
    for (const item of prepared) {
      results.push(await knowledgeRepository.replaceDocument({ knowledgeBaseId, sourceType: kind, sourceKey: item.sourceKey, title: item.document.name, content: item.text, contentHash: item.hash, metadata: item.document.metadata, chunks: item.chunks }))
    }
    const index = results.some(result => result.changed === true) ? await knowledgeIndexJobs.queue(knowledgeBaseId, { start: true, deferIfActive: true }) : null
    return { sourceId: text(results[0]?.sourceId), documents: results, changed: results.some(result => result.changed === true), indexState: text(index?.status || "fts_ready"), index }
  }

  async updateDocument({ knowledgeBaseId, documentId, title = "", content = "" }: UpdateDocumentInput): Promise<UnknownRecord> {
    const base = await knowledgeRepository.getBase(knowledgeBaseId)
    const document = await knowledgeRepository.getDocument(knowledgeBaseId, documentId)
    if (!base || !document) throw new Error("知识文档不存在")
    if (base.protected) throw new Error("内置受保护知识库的内容由指令扫描维护")
    const contentText = text(content).trim()
    if (!contentText) throw new Error("知识内容不能为空")
    const config = record(configStore.get())
    const indexing = record(record(config.knowledge).indexing)
    const maxBytes = Math.max(1024, numberValue(indexing.maxFileBytes, 10485760) || 10485760)
    if (Buffer.byteLength(contentText) > maxBytes) throw new Error(`知识内容超过 ${maxBytes} 字节上限`)
    const chunks = chunkText(contentText, record(base.config?.chunking)).map(chunk => ({ ...chunk, tokenCount: Math.ceil(chunk.content.length / 2) }))
    const counts = await sqliteClient.get(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN document_id=? THEN 1 ELSE 0 END) AS current FROM knowledge_chunks WHERE knowledge_base_id=?",
      [documentId, knowledgeBaseId],
    )
    const maxChunks = Math.max(1, numberValue(indexing.maxChunksPerKnowledgeBase, 100000) || 100000)
    const projected = numberValue(counts?.total, 0) - numberValue(counts?.current, 0) + chunks.length
    if (projected > maxChunks) throw new Error(`知识库分块将达到 ${projected}，超过 ${maxChunks} 上限`)
    const hash = contentHash(contentText)
    const result = await knowledgeRepository.replaceDocument({
      knowledgeBaseId,
      sourceType: document.source_type,
      sourceKey: document.source_key,
      title: text(title || document.title || "未命名文档").trim(),
      content: contentText,
      contentHash: hash,
      metadata: document.metadata || {},
      chunks,
    })
    const index = result.changed === true ? await knowledgeIndexJobs.queue(knowledgeBaseId, { start: true, deferIfActive: true }) : null
    return { ...result, index }
  }

  async deleteDocument(knowledgeBaseId: unknown, documentId: unknown): Promise<UnknownRecord> {
    const base = await knowledgeRepository.getBase(knowledgeBaseId)
    if (!base) throw new Error("知识库不存在")
    if (base.protected) throw new Error("内置受保护知识库的内容由指令扫描维护")
    const deleted = await knowledgeRepository.deleteDocument(knowledgeBaseId, documentId)
    const index = deleted && base.config?.embeddingModel ? await knowledgeIndexJobs.queue(knowledgeBaseId, { start: true, deferIfActive: true }) : null
    return { deleted, index }
  }

  async search(e: KnowledgeEvent, query: unknown, options: UnknownRecord = {}): Promise<KnowledgeResult[]> {
    const config = record(configStore.get())
    const retrieval = record(record(config.knowledge).retrieval)
    return searchKnowledge(e, query, {
      ...options,
      candidateLimit: options.candidateLimit || retrieval.ftsCandidateLimit,
      limit: options.limit || retrieval.resultLimit,
    })
  }

  async buildPrompt(e: unknown, query: unknown): Promise<string> {
    const event = record(e) as KnowledgeEvent
    const bases = await this.list(event)
    const queryText = text(query).toLowerCase()
    const matching = bases.filter(base => {
      const triggerWords: unknown[] = Array.isArray(record(base.config).triggerWords) ? record(base.config).triggerWords as unknown[] : []
      return base.id !== BUILTIN_COMMANDS_ID && Boolean(base.auto_retrieve) && triggerWords.some((word: unknown) => queryText.includes(text(word).toLowerCase()))
    })
    if (!matching.length) return ""
    const config = record(configStore.get())
    const resultConfig = record(record(config.knowledge).retrieval)
    const results = await this.search(event, query, { knowledgeBaseIds: matching.map(base => base.id) })
    return buildKnowledgePrompt(results, numberValue(resultConfig.resultTokenBudget, 800) || 800)
  }
}

export const knowledgeStore = new KnowledgeStore()
export { BUILTIN_COMMANDS_ID }
