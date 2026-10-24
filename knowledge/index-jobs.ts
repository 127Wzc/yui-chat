import { redactErrorText } from "../core/shared/error-details.js"
import { embeddingIdentity } from "./embedding-identity.js"
import crypto from "node:crypto"
import { configStore } from "../config/store.js"
import { modelLogStore } from "../core/observability/model-log.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { embeddingRunner } from "../models/embeddings/runner.js"
import { vectorIndex, vectorSpaceMatches } from "./vector-index.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import type { VectorSpace } from "./vector-index.js"

type UnknownRecord = Record<string, unknown>
type JobStatus = "queued" | "retrying" | "running" | "canceling" | "paused_budget" | "paused_no_model" | "completed" | "failed" | "canceled" | "superseded"

interface IndexJobRow extends UnknownRecord {
  id?: unknown
  knowledge_base_id?: unknown
  vector_space_id?: unknown
  model_name?: unknown
  dimensions?: unknown
  distance_metric?: unknown
  chunk_strategy_json?: unknown
  progress_json?: unknown
  status?: unknown
  attempts?: unknown
  max_attempts?: unknown
  lease_until?: unknown
}

export interface KnowledgeIndexJobOptions {
  immediate?: boolean
  start?: boolean
  deferIfActive?: boolean
}

export interface KnowledgeIndexInspection {
  knowledgeBaseId: string
  state: "ready" | "missing" | "incompatible" | "not_configured" | "unavailable" | "changed"
  total: number
  indexed: number
  missing: number
  checkedAt: number
}

type QueueOptions = KnowledgeIndexJobOptions

interface ProgressPatch extends UnknownRecord {
  phase?: unknown
  processed?: unknown
  total?: unknown
  percent?: unknown
  message?: unknown
  error?: unknown
}

interface ProgressOptions {
  renewLease?: boolean
}

interface PublishedOptions {
  job: IndexJobRow
  stagingSpace: VectorSpace
  previousSpaceId: string
  total: number
  writeProgress: (patch: ProgressPatch, options?: ProgressOptions) => Promise<UnknownRecord>
}

interface ChunkRow extends UnknownRecord {
  id?: unknown
  document_id?: unknown
  ordinal?: unknown
  content?: unknown
  content_hash?: unknown
}

const leaseMs = 10 * 60 * 1000
const retentionMs = 7 * 24 * 60 * 60 * 1000
const terminalStatuses: JobStatus[] = ["completed", "failed", "canceled", "superseded"]
const staleActiveStatuses: JobStatus[] = ["queued", "retrying", "running", "canceling", "paused_budget", "paused_no_model"]
const activeStatuses: JobStatus[] = ["queued", "retrying", "running", "canceling"]

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function message(error: unknown): string { return text(record(error).message || error || "未知错误").slice(0, 1000) }
function errorCode(error: unknown): string { return text(record(error).code) }
function progress(value: unknown): UnknownRecord {
  try { return value ? record(typeof value === "string" ? JSON.parse(value) : value) : {} } catch { return {} }
}
function progressPercent(processed = 0, total = 0): number { return Number(total) ? Math.max(0, Math.min(100, Math.round(Number(processed || 0) * 100 / Number(total)))) : 0 }
function canceledError(): Error & { code: string } { const error = new Error("索引任务已取消") as Error & { code: string }; error.code = "INDEX_JOB_CANCELED"; return error }
function alreadyActiveError(status = "running"): Error & { code: string; statusCode: number } {
  const error = new Error(status === "queued" ? "已有待执行的重建任务，请等待完成或先取消当前任务。" : "当前知识库正在重建，请等待完成或先取消当前任务。") as Error & { code: string; statusCode: number }
  error.code = "KNOWLEDGE_INDEX_ALREADY_RUNNING"
  error.statusCode = 409
  return error
}
function vectorUnavailableError(detail: unknown = ""): Error & { code: string; statusCode: number } {
  const error = new Error(`向量数据库不可用${detail ? `（${text(detail).slice(0, 200)}）` : ""}，无法执行向量重建，请先修复 sqlite-vec 环境。`) as Error & { code: string; statusCode: number }
  error.code = "VECTOR_STORE_UNAVAILABLE"
  error.statusCode = 400
  return error
}
// 知识库 staging 空间保留 base/job/attempt，新增配置指纹；兼容旧空间的孤儿回收。
// 记忆召回（memory-items）等其他归属不含这个形状，孤儿回收据此绝不越界。
function knowledgeScopeSegments(scopeKey: unknown = ""): string[] | null {
  const segments = text(scopeKey).split(":")
  return (segments.length === 3 || (segments.length === 4 && /^fp-[a-f0-9]{24}$/.test(segments[3]))) && segments.every(Boolean) && /^\d+$/.test(segments[2]) ? segments : null
}

export class KnowledgeIndexJobs {
  timer: ReturnType<typeof setInterval> | null = null
  queueLocks = new Map<string, Promise<void>>()
  executingJobIds = new Set<string>()
  processingDocuments = false

  start(): void {
    if (this.timer) return
    this.scheduleAvailable()
    this.cleanupExpired().catch(error => hostRuntime.logger?.warn?.("[yui-chat] 清理过期索引任务失败", error))
    this.timer = setInterval(() => this.runAvailable().catch(error => hostRuntime.logger?.warn?.("[yui-chat] 执行索引任务失败", error)), 60 * 1000)
    this.timer.unref?.()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  scheduleAvailable(): void {
    const timer = setTimeout(() => this.runAvailable().catch(error => hostRuntime.logger?.warn?.("[yui-chat] 执行后续索引任务失败", error)), 0)
    timer.unref?.()
  }

  scheduleReplacement(knowledgeBaseId: unknown): void {
    const timer = setTimeout(() => this.queue(knowledgeBaseId, { start: true, deferIfActive: true })
      .catch(error => hostRuntime.logger?.warn?.("[yui-chat] 排入新配置知识索引失败", error)), 0)
    timer.unref?.()
  }

  async withQueueLock<T>(knowledgeBaseId: unknown, action: () => Promise<T>): Promise<T> {
    const key = text(knowledgeBaseId)
    const previous = this.queueLocks.get(key) || Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>(resolve => { release = resolve })
    this.queueLocks.set(key, current)
    await previous
    try { return await action() } finally {
      release()
      if (this.queueLocks.get(key) === current) this.queueLocks.delete(key)
    }
  }

  /** 只读检查所有已保存分块，不受屏蔽开关影响，不触发分片或模型请求。 */
  async inspect(knowledgeBaseId: unknown): Promise<KnowledgeIndexInspection> {
    const base = await sqliteClient.get<UnknownRecord>("SELECT * FROM knowledge_bases WHERE id=?", [knowledgeBaseId])
    if (!base) throw new Error("知识库不存在")
    const count = await sqliteClient.get("SELECT COUNT(*) AS total FROM knowledge_chunks WHERE knowledge_base_id=?", [knowledgeBaseId])
    const result: KnowledgeIndexInspection = { knowledgeBaseId: text(knowledgeBaseId), state: "missing", total: Number(count?.total || 0), indexed: 0, missing: Number(count?.total || 0), checkedAt: Date.now() }
    if (!base.embedding_model_name || !Number(base.embedding_dimensions)) return { ...result, state: "not_configured" }
    if (!sqliteClient.status.vector?.available) return { ...result, state: "unavailable" }
    const fingerprint = embeddingIdentity(base.embedding_model_name)
    const space = await vectorIndex.getSpace(base.active_vector_space_id)
    if (space && (!vectorSpaceMatches(space, { modelName: base.embedding_model_name, dimensions: base.embedding_dimensions, distanceMetric: base.distance_metric }) || !space.scopeKey.endsWith(`:fp-${fingerprint}`))) return { ...result, state: "incompatible" }
    let documentId = "", ordinal = -1
    if (space) {
      while (true) {
        const chunks = await sqliteClient.all<ChunkRow>(
          "SELECT id, document_id, ordinal, content_hash FROM knowledge_chunks WHERE knowledge_base_id=? AND (document_id>? OR (document_id=? AND ordinal>?)) ORDER BY document_id, ordinal LIMIT 400",
          [knowledgeBaseId, documentId, documentId, ordinal],
        )
        if (!chunks.length) break
        const hashes = await vectorIndex.indexedContentHashes(space, "knowledge_chunk", chunks.map(chunk => text(chunk.id)))
        result.indexed += chunks.filter(chunk => hashes.get(text(chunk.id)) === text(chunk.content_hash)).length
        documentId = text(chunks.at(-1)?.document_id); ordinal = Number(chunks.at(-1)?.ordinal)
      }
    }
    const current = await sqliteClient.get("SELECT updated_at FROM knowledge_bases WHERE id=?", [knowledgeBaseId])
    if (!current || current.updated_at !== base.updated_at || fingerprint !== embeddingIdentity(base.embedding_model_name)) return { ...result, indexed: 0, state: "changed" }
    result.missing = Math.max(0, result.total - result.indexed)
    result.state = result.missing ? "missing" : "ready"
    return result
  }

  async repair(knowledgeBaseId: unknown, options: QueueOptions = {}): Promise<UnknownRecord> {
    const inspection = await this.inspect(knowledgeBaseId)
    if (inspection.state === "not_configured") return { status: "fts_ready", inspection }
    if (inspection.state === "unavailable") throw vectorUnavailableError(sqliteClient.status.vector?.error)
    if (inspection.state === "changed") throw new Error("检查期间知识库或模型配置发生变化，请重新检查")
    if (!inspection.missing) return { status: "ready", inspection }
    // 仍走既有 staging/发布流程，兼容向量直接复制，只为缺失或摘要不一致的分块调用模型。
    return { ...await this.queue(knowledgeBaseId, options), inspection }
  }

  async queue(knowledgeBaseId: unknown, options: QueueOptions = {}): Promise<UnknownRecord | null> {
    const queued = await this.withQueueLock(knowledgeBaseId, () => this.queueLocked(knowledgeBaseId, options))
    if (!queued?.id || queued.status === "fts_ready") return queued
    if (options.immediate === true && queued.startable !== false) return this.runNext(queued.id)
    if (options.start === true && queued.startable !== false) this.scheduleAvailable()
    const { startable, ...result } = queued
    return result
  }

  async queueLocked(knowledgeBaseId: unknown, { deferIfActive = false }: QueueOptions = {}): Promise<UnknownRecord> {
    const base = await sqliteClient.get<UnknownRecord>("SELECT embedding_model_name, embedding_dimensions, distance_metric, chunk_strategy_json FROM knowledge_bases WHERE id=?", [knowledgeBaseId])
    if (!base) throw new Error("知识库不存在")
    if (!base.embedding_model_name || !Number(base.embedding_dimensions)) return { status: "fts_ready", reason: "no_embedding_model" }
    if (!sqliteClient.status.vector?.available) {
      // 向量库缺失时任务必然失败，不再入队重试：显式重建直接报错；
      // 内容写入等 deferIfActive 隐式路径静默降级为 FTS，不阻断文档保存。
      if (!deferIfActive) throw vectorUnavailableError(sqliteClient.status.vector?.error)
      return { status: "fts_ready", reason: "vector_unavailable" }
    }
    const active = await sqliteClient.all<IndexJobRow>(
      `SELECT id, status FROM knowledge_index_jobs WHERE knowledge_base_id=? AND status IN (${activeStatuses.map(() => "?").join(",")}) ORDER BY created_at ASC`,
      [knowledgeBaseId, ...activeStatuses],
    )
    if (active.length && !deferIfActive) throw alreadyActiveError(text(active[0].status))
    const queued = active.find(item => ["queued", "retrying"].includes(text(item.status)))
    const blocking = active.find(item => ["running", "canceling"].includes(text(item.status)))
    if (deferIfActive && queued) {
      const queuedSpaceId = vectorIndex.spaceIdFor({
        modelName: base.embedding_model_name,
        dimensions: base.embedding_dimensions,
        distanceMetric: base.distance_metric || "cosine",
        scopeKey: `${knowledgeBaseId}:${queued.id}:1`,
      })
      // 多次内容/配置变更合并到同一个后继任务，并刷新为最新配置快照。
      await sqliteClient.run(
        "UPDATE knowledge_index_jobs SET vector_space_id=?, model_name=?, dimensions=?, distance_metric=?, chunk_strategy_json=?, status='queued', lease_until=0, updated_at=? WHERE id=? AND status IN ('queued','retrying')",
        [queuedSpaceId, base.embedding_model_name, Number(base.embedding_dimensions), base.distance_metric || "cosine", base.chunk_strategy_json || "{}", Date.now(), queued.id],
      )
      return { id: queued.id, status: "queued", deferred: true, startable: !blocking }
    }
    const timestamp = Date.now()
    const jobId = crypto.randomUUID()
    const config = record(configStore.get())
    const maxAttempts = Math.max(1, Math.min(20, numberValue(record(record(config.knowledge).indexing).maxAttempts, 3) || 3))
    const stageScope = `${knowledgeBaseId}:${jobId}:1`
    const vectorSpaceId = vectorIndex.spaceIdFor({ modelName: base.embedding_model_name, dimensions: base.embedding_dimensions, distanceMetric: base.distance_metric || "cosine", scopeKey: stageScope })
    await sqliteClient.transaction([
      { sql: "UPDATE knowledge_index_jobs SET status='superseded', lease_until=0, updated_at=? WHERE knowledge_base_id=? AND status IN ('paused_budget', 'paused_no_model')", params: [timestamp, knowledgeBaseId] },
      { sql: "INSERT INTO knowledge_index_jobs(id, knowledge_base_id, vector_space_id, model_name, dimensions, distance_metric, chunk_strategy_json, progress_json, status, max_attempts, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, '{}', 'queued', ?, ?, ?)", params: [jobId, knowledgeBaseId, vectorSpaceId, base.embedding_model_name, Number(base.embedding_dimensions), base.distance_metric || "cosine", base.chunk_strategy_json || "{}", maxAttempts, timestamp, timestamp] },
    ])
    return { id: jobId, status: "queued", deferred: Boolean(blocking), startable: !blocking }
  }

  async claim(jobId: unknown = ""): Promise<IndexJobRow | undefined> {
    const timestamp = Date.now()
    const cleanJobId = text(jobId)
    const idFilter = cleanJobId ? " AND candidate.id=?" : ""
    return sqliteClient.get<IndexJobRow>(
      `UPDATE knowledge_index_jobs
       SET status='running', attempts=attempts+1, lease_until=?, error='', updated_at=?
       WHERE id=(
         SELECT candidate.id FROM knowledge_index_jobs candidate
         WHERE (candidate.status='queued' OR (candidate.status='retrying' AND candidate.lease_until<=?) OR (candidate.status='running' AND candidate.lease_until>0 AND candidate.lease_until<=?))${idFilter}
           AND candidate.attempts<candidate.max_attempts
           AND NOT EXISTS (SELECT 1 FROM knowledge_index_jobs running WHERE running.knowledge_base_id=candidate.knowledge_base_id AND running.status IN ('running', 'canceling') AND running.id<>candidate.id)
         ORDER BY candidate.created_at LIMIT 1
       ) RETURNING *`,
      [timestamp + leaseMs, timestamp, timestamp, timestamp, ...(cleanJobId ? [cleanJobId] : [])],
    )
  }

  async runAvailable(): Promise<Array<UnknownRecord | null>> {
    await this.runPendingDocuments()
    await this.cleanupExpired()
    const config = record(configStore.get())
    const concurrency = Math.max(1, Math.min(16, numberValue(record(record(config.knowledge).indexing).concurrency, 2) || 2))
    return Promise.all(Array.from({ length: concurrency }, () => this.runNext()))
  }

  /** Merge changed chunks from nearby documents into model batches, without rebuilding a space. */
  async runPendingDocuments(): Promise<void> {
    if (this.processingDocuments || !sqliteClient.status.vector?.available) return
    this.processingDocuments = true
    try {
      const tasks = await sqliteClient.all<UnknownRecord>("SELECT * FROM knowledge_vector_tasks WHERE attempts<3 AND retry_at<=? ORDER BY CASE WHEN kind='delete' THEN 0 ELSE 1 END,updated_at LIMIT 50", [Date.now()])
      const groups = new Map<string, { space: VectorSpace; model: string; dimensions: number; fingerprint: string; items: Array<{ task: UnknownRecord; chunk: ChunkRow }> }>()
      let completed = 0
      const finish = async (task: UnknownRecord): Promise<void> => {
        await sqliteClient.run("DELETE FROM knowledge_vector_tasks WHERE kind=? AND owner_id=? AND updated_at=? AND content_hash=?", [task.kind, task.owner_id, task.updated_at, task.content_hash])
        completed++
      }
      const fail = async (task: UnknownRecord, error: unknown): Promise<void> => {
        await sqliteClient.run("UPDATE knowledge_vector_tasks SET attempts=attempts+1,retry_at=?,error=? WHERE kind=? AND owner_id=? AND updated_at=?", [Date.now() + 60000, redactErrorText(message(error), 300), task.kind, task.owner_id, task.updated_at])
        hostRuntime.logger?.warn?.("[yui-chat] 增量知识向量更新失败，正文保留，等待重试", redactErrorText(message(error)))
      }
      for (const task of tasks) {
        try {
          if (await sqliteClient.get("SELECT id FROM knowledge_index_jobs WHERE knowledge_base_id=? AND status IN ('running','canceling')", [task.knowledge_base_id])) continue
          if (task.kind === "delete") {
            if (!await sqliteClient.get("SELECT id FROM knowledge_chunks WHERE id=?", [task.owner_id])) await vectorIndex.deleteOwners("knowledge_chunk", [task.owner_id])
            await finish(task); continue
          }
          const base = await sqliteClient.get<UnknownRecord>("SELECT * FROM knowledge_bases WHERE id=?", [task.knowledge_base_id])
          if (!base?.embedding_model_name || !Number(base.embedding_dimensions)) continue
          const document = await sqliteClient.get<UnknownRecord>("SELECT content_hash FROM knowledge_documents WHERE id=? AND knowledge_base_id=?", [task.owner_id, task.knowledge_base_id])
          if (!document || document.content_hash !== task.content_hash) { await finish(task); continue }
          const fingerprint = embeddingIdentity(base.embedding_model_name), dimensions = Number(base.embedding_dimensions)
          let space = await vectorIndex.getSpace(base.active_vector_space_id)
          if (!space) {
            space = await vectorIndex.ensureSpace({ modelName: base.embedding_model_name, dimensions, distanceMetric: "cosine", scopeKey: `${task.knowledge_base_id}:incremental:fp-${fingerprint}` })
            if (!space) continue
            await sqliteClient.run("UPDATE knowledge_bases SET active_vector_space_id=? WHERE id=? AND active_vector_space_id IS NULL AND updated_at=?", [space.id, task.knowledge_base_id, base.updated_at])
            if ((await sqliteClient.get("SELECT active_vector_space_id FROM knowledge_bases WHERE id=?", [task.knowledge_base_id]))?.active_vector_space_id !== space.id) continue
          }
          if (!vectorSpaceMatches(space, { modelName: base.embedding_model_name, dimensions, distanceMetric: "cosine" }) || !space.scopeKey.endsWith(`:fp-${fingerprint}`)) continue
          const chunks = await sqliteClient.all<ChunkRow>("SELECT id,content,content_hash FROM knowledge_chunks WHERE document_id=? ORDER BY ordinal", [task.owner_id])
          const indexed = await vectorIndex.indexedContentHashes(space, "knowledge_chunk", chunks.map(chunk => text(chunk.id)))
          const pending = chunks.filter(chunk => indexed.get(text(chunk.id)) !== chunk.content_hash)
          if (!pending.length) { await finish(task); continue }
          const group = groups.get(space.id) || { space, model: text(base.embedding_model_name), dimensions, fingerprint, items: [] }
          group.items.push(...pending.map(chunk => ({ task, chunk }))); groups.set(space.id, group)
        } catch (error) { await fail(task, error) }
      }
      for (const group of groups.values()) {
        const byDocument = new Map<string, Array<{ task: UnknownRecord; chunk: ChunkRow; index: number }>>()
        group.items.forEach((item, index) => { const id = text(item.task.owner_id); const values = byDocument.get(id) || []; values.push({ ...item, index }); byDocument.set(id, values) })
        try {
          const embedded = await embeddingRunner.embedTexts({ modelName: group.model, texts: group.items.map(item => text(item.chunk.content)), dimensions: group.dimensions, purpose: "embedding_knowledge", source: "knowledge-document-update", taskName: "knowledge-vector-update" })
          for (const [id, items] of byDocument) {
            const task = items[0].task
            const latest = await sqliteClient.get("SELECT d.content_hash,b.active_vector_space_id FROM knowledge_documents d JOIN knowledge_bases b ON b.id=d.knowledge_base_id WHERE d.id=?", [id])
            if (latest?.content_hash !== task.content_hash || latest?.active_vector_space_id !== group.space.id || group.fingerprint !== embeddingIdentity(group.model)) continue
            await vectorIndex.upsertBatch(group.space, items.map(item => ({ ownerType: "knowledge_chunk", ownerId: text(item.chunk.id), contentHash: text(item.chunk.content_hash), vector: embedded.vectors[item.index] })))
            await finish(task)
          }
        } catch (error) { for (const items of byDocument.values()) await fail(items[0].task, error) }
      }
      if (tasks.length === 50 && completed) this.scheduleAvailable()
    } finally { this.processingDocuments = false }
  }

  async assertStillRunning(jobId: unknown): Promise<void> {
    const row = await sqliteClient.get<UnknownRecord>("SELECT status FROM knowledge_index_jobs WHERE id=?", [jobId])
    if (row?.status !== "running") throw canceledError()
  }

  async finishPublished({ job, stagingSpace, previousSpaceId, total, writeProgress }: PublishedOptions): Promise<UnknownRecord> {
    if (previousSpaceId && previousSpaceId !== stagingSpace.id) {
      try {
        await vectorIndex.deleteSpace(previousSpaceId)
      } catch (error) {
        hostRuntime.logger?.warn?.("[yui-chat] 已发布新知识索引，但清理旧向量空间失败，等待后续 GC", error)
      }
    }
    try {
      await writeProgress({ phase: "completed", processed: total, total, percent: 100, message: `索引已完成，共 ${total} 个分块`, error: "" }, { renewLease: false })
    } catch (error) {
      hostRuntime.logger?.warn?.("[yui-chat] 知识索引已发布，但完成进度写入失败", error)
    }
    return { id: job.id, status: "completed", chunks: total }
  }

  async runNext(jobId: unknown = ""): Promise<UnknownRecord | null> {
    const job = await this.claim(jobId)
    if (!job) return null
    const jobIdText = text(job.id)
    this.executingJobIds.add(jobIdText)
    let stagingSpace: VectorSpace | null = null
    let published = false
    const writeProgress = async (patch: ProgressPatch, { renewLease = true }: ProgressOptions = {}): Promise<UnknownRecord> => {
      const next = { ...progress(job.progress_json), ...patch, updatedAt: Date.now() }
      await sqliteClient.run(
        renewLease
          ? "UPDATE knowledge_index_jobs SET progress_json=?, lease_until=?, updated_at=? WHERE id=? AND status='running'"
          : "UPDATE knowledge_index_jobs SET progress_json=?, updated_at=? WHERE id=?",
        renewLease
          ? [JSON.stringify(next), Date.now() + leaseMs, Date.now(), job.id]
          : [JSON.stringify(next), Date.now(), job.id],
      )
      job.progress_json = JSON.stringify(next)
      return next
    }
    try {
      await writeProgress({ phase: "preparing", processed: 0, total: 0, percent: 0, message: "准备读取知识分块", error: "" })
      const base = await sqliteClient.get<UnknownRecord>("SELECT id, embedding_model_name, embedding_dimensions, distance_metric, chunk_strategy_json, active_vector_space_id, updated_at FROM knowledge_bases WHERE id=?", [job.knowledge_base_id])
      if (!base) {
        await sqliteClient.run("UPDATE knowledge_index_jobs SET status='canceled', lease_until=0, error='知识库已删除', updated_at=? WHERE id=?", [Date.now(), job.id])
        return { id: job.id, status: "canceled" }
      }
      const currentModel = text(base.embedding_model_name)
      const currentDimensions = numberValue(base.embedding_dimensions, 0)
      const currentMetric = text(base.distance_metric || "cosine")
      if (!currentModel || !currentDimensions) {
        await writeProgress({ phase: "paused_no_model", percent: 0, message: "缺少可用的向量模型", error: "缺少可用的向量模型" })
        // 状态守卫：执行期间被外部置为 canceling 时不覆盖，遗留行由 cleanupExpired 终结为 canceled。
        await sqliteClient.run("UPDATE knowledge_index_jobs SET status='paused_no_model', lease_until=0, updated_at=? WHERE id=? AND status='running'", [Date.now(), job.id])
        return { id: job.id, status: "paused_no_model" }
      }
      if (currentModel !== String(job.model_name || "") || currentDimensions !== Number(job.dimensions || 0) || currentMetric !== String(job.distance_metric || "cosine")) {
        await sqliteClient.run("UPDATE knowledge_index_jobs SET status='superseded', lease_until=0, error='向量配置已变更', updated_at=? WHERE id=? AND status='running'", [Date.now(), job.id])
        const replacement = await sqliteClient.get("SELECT id FROM knowledge_index_jobs WHERE knowledge_base_id=? AND id<>? AND status IN ('queued','retrying') ORDER BY created_at DESC LIMIT 1", [job.knowledge_base_id, job.id])
        if (!replacement) this.scheduleReplacement(job.knowledge_base_id)
        return { id: job.id, status: "superseded", replacementId: replacement?.id || "" }
      }
      const totalRow = await sqliteClient.get("SELECT COUNT(*) AS count FROM knowledge_chunks WHERE knowledge_base_id=?", [job.knowledge_base_id])
      const total = Number(totalRow?.count || 0)
      const fingerprint = embeddingIdentity(job.model_name)
      const dimensions = Number(job.dimensions)
      const activeSpaceId = String(base.active_vector_space_id || "")
      // 预算/无模型暂停和重试恢复时，若模型、维度、度量与分块策略都没变就复用原 staging 空间续传，
      // 不把 attempts 编入既有空间；配置已变才丢弃旧空间按当前 attempt 另建。
      const previousStaging = job.vector_space_id ? await vectorIndex.getSpace(job.vector_space_id) : null
      const reusable = Boolean(previousStaging)
        && previousStaging !== null
        && previousStaging.id !== activeSpaceId
        && previousStaging.scopeKey.endsWith(`:fp-${fingerprint}`)
        && vectorSpaceMatches(previousStaging, { modelName: job.model_name, dimensions, distanceMetric: job.distance_metric || "cosine" })
        && String(job.chunk_strategy_json || "{}") === String(base.chunk_strategy_json || "{}")
      const scopeKey = reusable && previousStaging ? previousStaging.scopeKey : `${job.knowledge_base_id}:${job.id}:${job.attempts}:fp-${fingerprint}`
      const stagingSpaceId = reusable && previousStaging ? previousStaging.id : vectorIndex.spaceIdFor({ modelName: job.model_name, dimensions, distanceMetric: job.distance_metric || "cosine", scopeKey })
      // 任务行先指向目标空间、之后才创建空间（引用先于存在）。孤儿回收按“先快照空间清单、
      // 再收集引用”的顺序扫描，因此任何已存在的空间要么已被引用、要么真是孤儿，无需与执行器加锁。
      await sqliteClient.run("UPDATE knowledge_index_jobs SET vector_space_id=?, dimensions=?, updated_at=? WHERE id=?", [stagingSpaceId, dimensions, Date.now(), job.id])
      if (!reusable && previousStaging && previousStaging.id !== activeSpaceId) {
        // 改指后旧空间已无引用，删除失败也会被孤儿回收兜底。
        await vectorIndex.deleteSpace(previousStaging.id).catch(error => hostRuntime.logger?.warn?.("[yui-chat] 丢弃过期 staging 向量空间失败，等待孤儿回收", error))
      }
      stagingSpace = reusable && previousStaging ? previousStaging : await vectorIndex.ensureSpace({ modelName: job.model_name, dimensions, distanceMetric: job.distance_metric || "cosine", scopeKey })
      if (!stagingSpace) throw new Error("向量数据库不可用")
      await writeProgress({ phase: "embedding", processed: 0, total, percent: total ? 0 : 100, message: total ? `生成并写入向量 0/${total}` : "没有可索引的知识分块", error: "" })
      const config = record(configStore.get())
      const model = (Array.isArray(config.models) ? config.models : []).find(item => text(record(item).name) === text(job.model_name))
      const modelEmbedding = record(record(model).embedding)
      const batchSize = Math.max(1, Math.min(512, numberValue(modelEmbedding.batchSize || record(record(config.knowledge).indexing).batchSize, 32) || 32))
      let trace: ReturnType<typeof modelLogStore.createTrace> | null = null
      const activeSpace = activeSpaceId ? await vectorIndex.getSpace(activeSpaceId) : null
      const reusableActive = activeSpace?.scopeKey.endsWith(`:fp-${fingerprint}`) ? activeSpace : null
      let copied = 0
      let processed = 0
      let cursorDocumentId = ""
      let cursorOrdinal = -1
      try {
        while (processed < total) {
          await this.assertStillRunning(job.id)
          const batch = await sqliteClient.all<ChunkRow>(
            `SELECT id, document_id, ordinal, content, content_hash FROM knowledge_chunks
             WHERE knowledge_base_id=? AND (document_id>? OR (document_id=? AND ordinal>?))
             ORDER BY document_id, ordinal LIMIT ?`,
            [job.knowledge_base_id, cursorDocumentId, cursorDocumentId, cursorOrdinal, batchSize],
          )
          if (!batch.length) break
          copied += await vectorIndex.copyMatching(reusableActive, stagingSpace, batch)
          // 续传复用空间时按 content_hash 跳过已写入的分块，只为缺失/变更分块消耗 embedding 预算。
          const writtenHashes = await vectorIndex.indexedContentHashes(stagingSpace, "knowledge_chunk", batch.map(chunk => text(chunk.id)))
          const pending = batch.filter(chunk => writtenHashes.get(String(chunk.id)) !== String(chunk.content_hash))
          if (pending.length) {
            trace ||= modelLogStore.createTrace({ source: "knowledge-index-rebuild", purpose: "embedding_knowledge", metadata: { knowledgeBaseId: job.knowledge_base_id, indexJobId: job.id, totalChunks: total } })
            const embedded = await embeddingRunner.embedTexts({
              modelName: text(job.model_name), texts: pending.map(chunk => text(chunk.content)), dimensions,
              purpose: "embedding_knowledge", source: "knowledge-index-rebuild", taskName: "knowledge-vector-rebuild", trace,
              metadata: { knowledgeBaseId: job.knowledge_base_id, indexJobId: job.id, batchOffset: processed, batchSize: pending.length, totalChunks: total },
            })
            await this.assertStillRunning(job.id)
            await vectorIndex.upsertBatch(stagingSpace, pending.map((chunk, index) => ({ ownerType: "knowledge_chunk", ownerId: text(chunk.id), contentHash: text(chunk.content_hash), vector: embedded.vectors[index] })))
          }
          processed += batch.length
          const last = batch.at(-1)
          if (!last) break
          cursorDocumentId = text(last.document_id)
          cursorOrdinal = numberValue(last.ordinal, -1)
          await writeProgress({ phase: "embedding", processed, total, percent: progressPercent(processed, total), message: `生成并写入向量 ${processed}/${total}`, error: "" })
        }
        modelLogStore.finishTrace(trace, { status: "ok", metadata: { totalChunks: total, modelName: job.model_name } })
      } catch (error) {
        modelLogStore.finishTrace(trace, { status: "error", error: message(error), metadata: { totalChunks: total, modelName: job.model_name } })
        throw error
      }
      await this.assertStillRunning(job.id)
      if (fingerprint !== embeddingIdentity(job.model_name)) throw new Error("向量模型配置在重建期间变化，请重试")
      await writeProgress({ reusedChunks: copied, embeddingFingerprint: fingerprint })
      const previousSpaceId = String(base.active_vector_space_id || "")
      const timestamp = Date.now()
      const publish = await sqliteClient.transaction([
        { sql: "UPDATE knowledge_bases SET active_vector_space_id=?, updated_at=MAX(updated_at+1, ?) WHERE id=? AND embedding_model_name=? AND embedding_dimensions=? AND distance_metric=? AND updated_at=? AND EXISTS (SELECT 1 FROM knowledge_index_jobs WHERE id=? AND status='running')", params: [stagingSpace.id, timestamp, job.knowledge_base_id, job.model_name, dimensions, job.distance_metric || "cosine", base.updated_at, job.id] },
        { sql: "UPDATE knowledge_index_jobs SET status='completed', lease_until=0, error='', completed_at=?, updated_at=? WHERE id=? AND status='running' AND EXISTS (SELECT 1 FROM knowledge_bases WHERE id=? AND active_vector_space_id=?)", params: [timestamp, timestamp, job.id, job.knowledge_base_id, stagingSpace.id] },
        { sql: "UPDATE knowledge_index_jobs SET status='canceled', lease_until=0, error='', completed_at=?, updated_at=? WHERE id=? AND status='canceling'", params: [timestamp, timestamp, job.id] },
        { sql: "UPDATE knowledge_index_jobs SET status='superseded', lease_until=0, error='重建期间向量配置已变更', completed_at=?, updated_at=? WHERE id=? AND status='running'", params: [timestamp, timestamp, job.id] },
      ])
      published = numberValue(record(publish?.[1]).changes, 0) > 0
      if (!published) {
        // 未能发布即被取消/顶替，staging 已无用途；删除失败时空间仍被任务行引用，随任务删除或过期清理回收。
        await vectorIndex.deleteSpace(stagingSpace.id).catch(error => hostRuntime.logger?.warn?.("[yui-chat] 清理未发布的 staging 向量空间失败", error))
        stagingSpace = null
        const canceled = numberValue(record(publish?.[2]).changes, 0) > 0
        if (!canceled) this.scheduleReplacement(job.knowledge_base_id)
        return { id: job.id, status: canceled ? "canceled" : "superseded", chunks: processed }
      }
      await sqliteClient.run("DELETE FROM knowledge_vector_tasks WHERE kind='document' AND knowledge_base_id=? AND EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.id=knowledge_vector_tasks.owner_id AND d.content_hash=knowledge_vector_tasks.content_hash)", [job.knowledge_base_id])
      return await this.finishPublished({ job, stagingSpace, previousSpaceId, total: processed, writeProgress })
    } catch (error) {
      const currentProgress = progress(job.progress_json)
      if (published) {
        hostRuntime.logger?.warn?.("[yui-chat] 知识索引已经发布，忽略发布后清理错误", error)
        return { id: job.id, status: "completed", chunks: Number(currentProgress.processed || 0) }
      }
      const discardStaging = async () => {
        if (!stagingSpace) return
        // 取消即丢弃 staging；删除失败时空间仍被任务行引用，随任务删除或过期清理回收，不阻塞取消。
        await vectorIndex.deleteSpace(stagingSpace.id).catch(cleanupError => hostRuntime.logger?.warn?.("[yui-chat] 清理已取消任务的 staging 向量空间失败", cleanupError))
      }
      const terminalizeCanceled = () => sqliteClient.run(
        "UPDATE knowledge_index_jobs SET status='canceled', lease_until=0, error='', progress_json=?, updated_at=? WHERE id=? AND status IN ('running', 'canceling')",
        [JSON.stringify({ ...currentProgress, phase: "canceled", message: "索引任务已取消", error: "", updatedAt: Date.now() }), Date.now(), job.id],
      )
      if (errorCode(error) === "INDEX_JOB_CANCELED") {
        await discardStaging()
        await terminalizeCanceled()
        return { id: job.id, status: "canceled" }
      }
      const status: JobStatus = errorCode(error) === "BUDGET_EXHAUSTED" ? "paused_budget" : numberValue(job.attempts, 0) >= numberValue(job.max_attempts, 1) ? "failed" : "retrying"
      const retryAt = status === "retrying" ? Date.now() + Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, Number(job.attempts || 1) - 1)) : 0
      const errorMessage = message(error)
      // 预算耗尽等可恢复暂停与重试都保留 staging 空间和任务行引用，恢复后按 content_hash 续传；
      // 终态 failed 的空间同样留给手动重试复用，随任务删除或过期清理一并回收。
      // 状态守卫：执行期间被外部置为 canceling 时不得回写覆盖，改按取消收尾。
      const updated = await sqliteClient.run("UPDATE knowledge_index_jobs SET status=?, lease_until=?, error=?, progress_json=?, updated_at=? WHERE id=? AND status='running'", [status, retryAt, errorMessage, JSON.stringify({ ...currentProgress, phase: status, message: status === "retrying" ? "构建失败，等待重试" : "索引构建失败", error: errorMessage, updatedAt: Date.now() }), Date.now(), job.id])
      if (!numberValue(updated?.changes, 0)) {
        const canceled = await terminalizeCanceled()
        if (numberValue(canceled?.changes, 0)) {
          await discardStaging()
          return { id: job.id, status: "canceled" }
        }
        const row = await sqliteClient.get<UnknownRecord>("SELECT status FROM knowledge_index_jobs WHERE id=?", [job.id])
        return { id: job.id, status: row?.status || status, error: errorMessage }
      }
      return { id: job.id, status, error: errorMessage, retryAt }
    } finally {
      this.executingJobIds.delete(jobIdText)
      this.scheduleAvailable()
    }
  }

  async retry(jobId: unknown): Promise<UnknownRecord> {
    const job = await sqliteClient.get<IndexJobRow>("SELECT id, knowledge_base_id, status FROM knowledge_index_jobs WHERE id=?", [jobId])
    if (!job) throw new Error("索引任务不存在")
    if (job.status === "completed") throw new Error("已完成的任务请通过知识库重建创建新任务")
    // 执行中/取消中的任务不接受重试，否则重置会被执行器的收尾路径静默覆盖。
    if (["running", "canceling"].includes(text(job.status))) throw alreadyActiveError(text(job.status))
    const active = await sqliteClient.get<IndexJobRow>(`SELECT status FROM knowledge_index_jobs WHERE knowledge_base_id=? AND id<>? AND status IN (${activeStatuses.map(() => "?").join(",")}) LIMIT 1`, [job.knowledge_base_id, job.id, ...activeStatuses])
    if (active) throw alreadyActiveError(text(active.status))
    await sqliteClient.run("UPDATE knowledge_index_jobs SET status='queued', attempts=0, lease_until=0, error='', progress_json=?, updated_at=? WHERE id=?", [JSON.stringify({ phase: "queued", processed: 0, percent: 0, message: "等待重试", error: "", updatedAt: Date.now() }), Date.now(), jobId])
    return { id: jobId, status: "queued" }
  }

  async cancel(jobId: unknown): Promise<boolean> {
    const nextStatus: JobStatus = this.executingJobIds.has(text(jobId)) ? "canceling" : "canceled"
    const result = await sqliteClient.run(`UPDATE knowledge_index_jobs SET status=?, lease_until=0, updated_at=? WHERE id=? AND status NOT IN ('completed', 'canceled', 'superseded')`, [nextStatus, Date.now(), jobId])
    return Boolean(result.changes)
  }

  async remove(jobId: unknown): Promise<boolean> {
    const job = await sqliteClient.get<IndexJobRow>("SELECT id, vector_space_id, status FROM knowledge_index_jobs WHERE id=?", [jobId])
    if (!job) return false
    if (!terminalStatuses.includes(text(job.status) as JobStatus)) throw new Error("运行中的索引任务请先取消，结束后再删除记录")
    const active = await sqliteClient.get("SELECT 1 FROM knowledge_bases WHERE active_vector_space_id=?", [job.vector_space_id])
    const result = await sqliteClient.run(`DELETE FROM knowledge_index_jobs WHERE id=? AND status IN (${terminalStatuses.map(() => "?").join(",")})`, [job.id, ...terminalStatuses])
    if (result.changes && !active && job.vector_space_id) await vectorIndex.deleteSpace(job.vector_space_id)
    return Boolean(result.changes)
  }

  async cleanupExpired(timestamp = Date.now()): Promise<UnknownRecord> {
    const cutoff = numberValue(timestamp, Date.now()) - retentionMs
    // 本进程正在执行的任务由执行器自行续租和收尾，状态自愈只处理其他进程/上次崩溃遗留的行，避免误杀活任务。
    const executing = [...this.executingJobIds]
    const executingFilter = executing.length ? ` AND id NOT IN (${executing.map(() => "?").join(",")})` : ""
    const expired = await sqliteClient.all<IndexJobRow>(`SELECT vector_space_id FROM knowledge_index_jobs WHERE status IN (${terminalStatuses.map(() => "?").join(",")}) AND updated_at<?`, [...terminalStatuses, cutoff])
    const deleted = await sqliteClient.run(`DELETE FROM knowledge_index_jobs WHERE status IN (${terminalStatuses.map(() => "?").join(",")}) AND updated_at<?`, [...terminalStatuses, cutoff])
    for (const item of expired) {
      if (!item.vector_space_id) continue
      const active = await sqliteClient.get("SELECT 1 FROM knowledge_bases WHERE active_vector_space_id=?", [item.vector_space_id])
      if (!active) await vectorIndex.deleteSpace(item.vector_space_id)
    }
    // 崩溃遗留的 canceling 没有执行器收尾、不可 claim 又阻塞同库新任务，租约过期后直接终结解除阻塞。
    const healed = await sqliteClient.run(`UPDATE knowledge_index_jobs SET status='canceled', lease_until=0, error='进程中断导致取消未完成，已自动终结', updated_at=? WHERE status='canceling' AND lease_until<=?${executingFilter}`, [timestamp, timestamp, ...executing])
    const canceled = await sqliteClient.run(`UPDATE knowledge_index_jobs SET status='canceled', lease_until=0, error='任务超过 7 天已自动取消', updated_at=? WHERE status IN (${staleActiveStatuses.map(() => "?").join(",")}) AND created_at<?${executingFilter}`, [timestamp, ...staleActiveStatuses, cutoff, ...executing])
    const stale = await sqliteClient.run(`UPDATE knowledge_index_jobs SET status='failed', lease_until=0, error='进程中断导致任务未完成，已标记失败', updated_at=? WHERE status='running' AND lease_until>0 AND lease_until<=? AND attempts>=max_attempts${executingFilter}`, [timestamp, timestamp, ...executing])
    const reclaimed = await this.reclaimOrphanSpaces()
    return { deleted: Number(deleted?.changes || 0), canceled: Number(canceled?.changes || 0), failed: Number(stale?.changes || 0), healedCanceling: Number(healed?.changes || 0), reclaimedSpaces: reclaimed }
  }

  // 回收崩溃/重启遗留的孤儿 staging 空间：知识库归属（scope_key 形如 "<baseId>:<jobId>:<attempt>"）
  // 且既不是任何库的 active 空间、也不被任何任务行引用的空间可以安全删除。
  // 并发安全依赖两个顺序约定，无需与执行器加锁：
  // 1) 执行器总是先把任务行指向目标空间、之后才创建空间（引用先于存在）；
  // 2) 这里先快照空间清单、再收集引用。快照里出现的空间要么在引用集合里，要么真是孤儿。
  // 启动路径（start → cleanupExpired）此时还没有执行器在跑，天然满足同样的结论。
  async reclaimOrphanSpaces(): Promise<number> {
    if (!sqliteClient.status.vector?.available) return 0
    const candidates = (await vectorIndex.listSpaces()).filter(space => knowledgeScopeSegments(space.scopeKey))
    if (!candidates.length) return 0
    const bases = await sqliteClient.all<UnknownRecord>("SELECT active_vector_space_id AS id FROM knowledge_bases WHERE active_vector_space_id IS NOT NULL AND active_vector_space_id<>''")
    const jobs = await sqliteClient.all<UnknownRecord>("SELECT DISTINCT vector_space_id AS id FROM knowledge_index_jobs WHERE vector_space_id<>''")
    const referenced = new Set([...bases, ...jobs].map(row => text(row.id)))
    let reclaimed = 0
    for (const space of candidates) {
      if (referenced.has(space.id)) continue
      try {
        if (await vectorIndex.deleteSpace(space.id)) reclaimed++
      } catch (error) {
        hostRuntime.logger?.warn?.("[yui-chat] 回收孤儿向量空间失败，等待下轮清理重试", error)
      }
    }
    if (reclaimed) hostRuntime.logger?.mark?.(`[yui-chat] 已回收 ${reclaimed} 个孤儿知识向量空间`)
    return reclaimed
  }
}

export const knowledgeIndexJobs = new KnowledgeIndexJobs()
