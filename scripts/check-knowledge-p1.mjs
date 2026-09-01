import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-knowledge-p1-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot

global.logger = {
  mark() {}, info() {}, warn() {}, error() {}, debug() {},
  blue: value => value, cyan: value => value, red: value => value,
}
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { at: id => `[at:${id}]`, image: value => `[image:${value}]`, record: value => `[record:${value}]`, video: value => `[video:${value}]`, reply: value => `[reply:${value}]` }
global.plugin = class { constructor(options = {}) { this.options = options } }

let sqliteClient
let knowledgeIndexJobs

function chunks(count, prefix = "chunk") {
  return Array.from({ length: count }, (_, index) => ({ content: `${prefix}-${index}`, contentHash: `${prefix}-hash-${index}` }))
}

try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { knowledgeStore } = await import("../output/runtime/knowledge/store.js")
  const { knowledgeRepository } = await import("../output/runtime/knowledge/repository.js")
  const { searchKnowledge } = await import("../output/runtime/knowledge/retrieval.js")
  const { vectorIndex, vectorSpaceMatches } = await import("../output/runtime/knowledge/vector-index.js")
  ;({ knowledgeIndexJobs } = await import("../output/runtime/knowledge/index-jobs.js"))

  await configStore.load()
  await sqliteClient.init(defaults)
  assert.equal(sqliteClient.status.available, true)
  assert.equal(sqliteClient.status.vector?.available, true)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))

  const adapterCalls = []
  let embeddingBarrier = null
  let embeddingInterceptor = null
  adapterRegistry.register({
    id: "knowledge-p1-embedding",
    supportsEmbeddings: true,
    async embedTexts({ channel, texts, dimensions }) {
      adapterCalls.push({ model: channel.name, size: texts.length, dimensions })
      if (embeddingInterceptor) await embeddingInterceptor({ channel, texts })
      if (embeddingBarrier?.model === channel.name) {
        embeddingBarrier.entered()
        await embeddingBarrier.releasePromise
        embeddingBarrier = null
      }
      return {
        vectors: texts.map((text, index) => Array.from({ length: dimensions }, (_, dimension) => dimension === 0 ? 1 : (text.length + index + dimension) / 100)),
        dimensions,
        usage: { input: texts.length, output: 0, total: texts.length, source: "reported" },
      }
    },
  })
  await configStore.update(config => {
    config.apiProviders = [...(config.apiProviders || []).filter(item => item.name !== "knowledge-p1-provider"), { name: "knowledge-p1-provider", type: "knowledge-p1-embedding" }]
    config.models = [
      ...(config.models || []).filter(item => !["knowledge-p1-a", "knowledge-p1-b"].includes(item.name)),
      {
        name: "knowledge-p1-a", modelIdentifier: "knowledge-p1-a", apiProvider: "knowledge-p1-provider", adapter: "knowledge-p1-embedding",
        capabilities: { chat: false, embedding: true },
        embedding: { defaultDimensions: 2, allowedDimensions: [2], supportsDimensionOverride: true, batchSize: 2, timeoutMs: 30000 },
      },
      {
        name: "knowledge-p1-b", modelIdentifier: "knowledge-p1-b", apiProvider: "knowledge-p1-provider", adapter: "knowledge-p1-embedding",
        capabilities: { chat: false, embedding: true },
        embedding: { defaultDimensions: 3, allowedDimensions: [3], supportsDimensionOverride: true, batchSize: 2, timeoutMs: 30000 },
      },
    ]
  })

  // Tests explicitly drive jobs; background scheduling would make race assertions nondeterministic.
  knowledgeIndexJobs.scheduleAvailable = () => {}

  // vec0 must really use each advertised metric. The selected examples make
  // cosine/l2 and l2/l1 disagree, so the default metric cannot pass by accident.
  const metricCases = [
    { metric: "cosine", scope: "metric-cosine", query: [1, 0], values: [[10, 1], [1, 1]], expected: "a" },
    { metric: "l2", scope: "metric-l2-a", query: [1, 0], values: [[10, 1], [1, 1]], expected: "b" },
    { metric: "l2", scope: "metric-l2-b", query: [1, 1], values: [[3, 3], [1, 4]], expected: "a" },
    { metric: "l1", scope: "metric-l1", query: [1, 1], values: [[3, 3], [1, 4]], expected: "b" },
  ]
  for (const testCase of metricCases) {
    const space = await vectorIndex.ensureSpace({ modelName: "metric-model", dimensions: 2, distanceMetric: testCase.metric, scopeKey: testCase.scope })
    await vectorIndex.upsertBatch(space, testCase.values.map((vector, index) => ({ ownerType: "metric", ownerId: index ? "b" : "a", contentHash: String(index), vector })))
    assert.equal((await vectorIndex.search(space, testCase.query, 2))[0]?.ownerId, testCase.expected, `${testCase.metric} must control vec0 ranking`)
  }
  assert.throws(() => vectorIndex.spaceIdFor({ modelName: "bad", dimensions: 2, distanceMetric: "ip" }), /仅支持 cosine、l2、l1/)

  const base = await knowledgeStore.create({
    name: "P1 流式重建",
    config: { embeddingModel: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine", chunking: { targetChars: 20, overlapChars: 0, minChars: 1 } },
  })
  await knowledgeRepository.replaceDocument({
    knowledgeBaseId: base.id,
    sourceType: "text",
    sourceKey: "streaming",
    title: "streaming",
    content: "first generation",
    contentHash: "first-generation",
    chunks: chunks(5, "first"),
  })
  const upsertSizes = []
  const originalUpsertBatch = vectorIndex.upsertBatch.bind(vectorIndex)
  vectorIndex.upsertBatch = async (space, items) => {
    upsertSizes.push(items.length)
    return originalUpsertBatch(space, items)
  }
  adapterCalls.length = 0
  const firstBuild = await knowledgeIndexJobs.queue(base.id, { immediate: true })
  vectorIndex.upsertBatch = originalUpsertBatch
  assert.equal(firstBuild.status, "completed")
  assert.deepEqual(adapterCalls.map(item => item.size), [2, 2, 1], "rebuild must read and embed one bounded page at a time")
  assert.deepEqual(upsertSizes, [2, 2, 1], "each embedding page must be written before reading the next page")
  const firstBuiltBase = await knowledgeRepository.getBase(base.id)
  const firstSpaceId = firstBuiltBase.active_vector_space_id
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM embedding_records WHERE space_id=?", [firstSpaceId], "vectors"))?.total, 5)

  // The per-base queue lock covers only inspection/insertion. A real edit must
  // enqueue its successor while the immediate build is blocked in embedding.
  const concurrentBase = await knowledgeStore.create({ name: "P1 并发后继", config: { embeddingModel: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine" } })
  await knowledgeRepository.replaceDocument({
    knowledgeBaseId: concurrentBase.id, sourceType: "text", sourceKey: "barrier", title: "barrier",
    content: "barrier", contentHash: "barrier", chunks: chunks(1, "barrier"),
  })
  let signalEntered
  let releaseEmbedding
  const enteredPromise = new Promise(resolve => { signalEntered = resolve })
  const releasePromise = new Promise(resolve => { releaseEmbedding = resolve })
  embeddingBarrier = { model: "knowledge-p1-a", entered: signalEntered, releasePromise }
  const blockedBuild = knowledgeIndexJobs.queue(concurrentBase.id, { immediate: true })
  await Promise.race([enteredPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("embedding barrier was not reached")), 1000))])
  const concurrentEdit = await Promise.race([
    knowledgeIndexJobs.queue(concurrentBase.id, { deferIfActive: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("edit was blocked by running embedding")), 250)),
  ])
  assert.equal(concurrentEdit.status, "queued")
  assert.equal(concurrentEdit.deferred, true)
  releaseEmbedding()
  assert.equal((await blockedBuild).status, "completed")
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM knowledge_index_jobs WHERE knowledge_base_id=? AND status='queued'", [concurrentBase.id]))?.total, 1)
  assert.equal((await knowledgeIndexJobs.runNext(concurrentEdit.id))?.status, "completed")

  // An edit while a job is running must create exactly one queued successor,
  // and repeated edits must only refresh that successor.
  const followupBase = await knowledgeStore.create({ name: "P1 后继任务", config: { embeddingModel: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine" } })
  const running = await knowledgeIndexJobs.queue(followupBase.id)
  await sqliteClient.run("UPDATE knowledge_index_jobs SET status='running', lease_until=? WHERE id=?", [Date.now() + 600000, running.id])
  const followups = []
  for (let index = 0; index < 3; index++) followups.push(await knowledgeIndexJobs.queue(followupBase.id, { deferIfActive: true }))
  assert.equal(new Set(followups.map(item => item.id)).size, 1, "running edits must share one queued successor")
  const activeFollowups = await sqliteClient.all("SELECT id, status FROM knowledge_index_jobs WHERE knowledge_base_id=? AND status IN ('running','canceling','queued','retrying') ORDER BY created_at", [followupBase.id])
  assert.deepEqual(activeFollowups.map(item => item.status).sort(), ["queued", "running"])
  await sqliteClient.run("UPDATE knowledge_index_jobs SET status='superseded', lease_until=0 WHERE knowledge_base_id=? AND status IN ('running','queued')", [followupBase.id])

  // An immediate job may observe a configuration change after claim. It must
  // return and release the per-base queue lock instead of recursively waiting
  // on the same lock while it schedules the replacement.
  const mismatchBase = await knowledgeStore.create({ name: "P1 配置竞态", config: { embeddingModel: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine" } })
  const originalClaim = knowledgeIndexJobs.claim.bind(knowledgeIndexJobs)
  knowledgeIndexJobs.claim = async jobId => {
    const claimed = await originalClaim(jobId)
    if (claimed?.knowledge_base_id === mismatchBase.id) {
      await sqliteClient.run("UPDATE knowledge_bases SET embedding_model_name='knowledge-p1-b', embedding_dimensions=3, distance_metric='l1' WHERE id=?", [mismatchBase.id])
    }
    return claimed
  }
  const mismatchResult = await Promise.race([
    knowledgeIndexJobs.queue(mismatchBase.id, { immediate: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("immediate mismatch deadlocked")), 1000)),
  ])
  knowledgeIndexJobs.claim = originalClaim
  assert.equal(mismatchResult.status, "superseded")
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM knowledge_index_jobs WHERE knowledge_base_id=? AND status='queued'", [mismatchBase.id]))?.total, 1, "mismatched immediate job must schedule one replacement after releasing its queue lock")
  await sqliteClient.run("UPDATE knowledge_index_jobs SET status='superseded', lease_until=0 WHERE knowledge_base_id=? AND status='queued'", [mismatchBase.id])

  // Once the state transaction publishes staging, old-space GC and cosmetic
  // progress failures are best effort and must never remove the new active space.
  await knowledgeRepository.replaceDocument({
    knowledgeBaseId: base.id, sourceType: "text", sourceKey: "streaming", title: "streaming",
    content: "second generation", contentHash: "second-generation", chunks: chunks(3, "second"),
  })
  const originalDeleteSpace = vectorIndex.deleteSpace.bind(vectorIndex)
  vectorIndex.deleteSpace = async spaceId => {
    if (spaceId === firstSpaceId) throw new Error("injected old-space GC failure")
    return originalDeleteSpace(spaceId)
  }
  const cleanupFailureBuild = await knowledgeIndexJobs.queue(base.id, { immediate: true })
  vectorIndex.deleteSpace = originalDeleteSpace
  assert.equal(cleanupFailureBuild.status, "completed")
  const cleanupFailureBase = await knowledgeRepository.getBase(base.id)
  assert.notEqual(cleanupFailureBase.active_vector_space_id, firstSpaceId)
  assert(await vectorIndex.getSpace(cleanupFailureBase.active_vector_space_id), "published staging space must survive old-space GC failure")

  await knowledgeRepository.replaceDocument({
    knowledgeBaseId: base.id, sourceType: "text", sourceKey: "streaming", title: "streaming",
    content: "third generation", contentHash: "third-generation", chunks: chunks(4, "third"),
  })
  const originalRun = sqliteClient.run.bind(sqliteClient)
  let completionProgressFailed = false
  sqliteClient.run = async (sql, params, target) => {
    if (!completionProgressFailed && sql === "UPDATE knowledge_index_jobs SET progress_json=?, updated_at=? WHERE id=?") {
      completionProgressFailed = true
      throw new Error("injected completion progress failure")
    }
    return originalRun(sql, params, target)
  }
  const progressFailureBuild = await knowledgeIndexJobs.queue(base.id, { immediate: true })
  sqliteClient.run = originalRun
  assert.equal(progressFailureBuild.status, "completed")
  assert.equal(completionProgressFailed, true)
  const progressFailureBase = await knowledgeRepository.getBase(base.id)
  assert(await vectorIndex.getSpace(progressFailureBase.active_vector_space_id), "published staging space must survive progress failure")

  // Cancellation in the final assert/publish race window must win the CAS.
  await knowledgeRepository.replaceDocument({
    knowledgeBaseId: base.id, sourceType: "text", sourceKey: "streaming", title: "streaming",
    content: "cancel generation", contentHash: "cancel-generation", chunks: chunks(2, "cancel"),
  })
  const cancelJob = await knowledgeIndexJobs.queue(base.id)
  const activeBeforeCancelRace = progressFailureBase.active_vector_space_id
  const originalTransaction = sqliteClient.transaction.bind(sqliteClient)
  let cancelInjected = false
  sqliteClient.transaction = async (operations, target) => {
    if (!cancelInjected && operations?.[0]?.sql?.startsWith("UPDATE knowledge_bases SET active_vector_space_id=")) {
      cancelInjected = true
      await originalRun("UPDATE knowledge_index_jobs SET status='canceling', lease_until=0 WHERE id=?", [cancelJob.id])
    }
    return originalTransaction(operations, target)
  }
  const canceledBuild = await knowledgeIndexJobs.runNext(cancelJob.id)
  sqliteClient.transaction = originalTransaction
  assert.equal(canceledBuild.status, "canceled")
  assert.equal((await knowledgeRepository.getBase(base.id)).active_vector_space_id, activeBeforeCancelRace, "canceled job must not publish staging")
  assert.equal((await sqliteClient.get("SELECT status FROM knowledge_index_jobs WHERE id=?", [cancelJob.id]))?.status, "canceled")

  // Model/dimension/metric changes queue a rebuild, suppress incompatible active
  // metadata immediately, then publish a matching replacement.
  adapterCalls.length = 0
  const switched = await knowledgeStore.update(base.id, { config: { embeddingModel: "knowledge-p1-b", dimensions: 3, distanceMetric: "l1" } })
  assert.equal(switched.config.embeddingModel, "knowledge-p1-b")
  assert.equal(switched.config.dimensions, 3)
  assert.equal(switched.config.distanceMetric, "l1")
  const queuedSwitch = await sqliteClient.get("SELECT id, model_name, dimensions, distance_metric, status FROM knowledge_index_jobs WHERE knowledge_base_id=? AND status='queued' ORDER BY created_at DESC LIMIT 1", [base.id])
  assert.deepEqual({ model: queuedSwitch.model_name, dimensions: queuedSwitch.dimensions, metric: queuedSwitch.distance_metric, status: queuedSwitch.status }, { model: "knowledge-p1-b", dimensions: 3, metric: "l1", status: "queued" })
  const oldSpace = await vectorIndex.getSpace(activeBeforeCancelRace)
  assert.equal(vectorSpaceMatches(oldSpace, { modelName: "knowledge-p1-b", dimensions: 3, distanceMetric: "l1" }), false)
  const callsBeforeMismatchedSearch = adapterCalls.length
  const mismatched = await searchKnowledge({ isMaster: true, user_id: "master" }, "third", { knowledgeBaseIds: [base.id], useVector: true, vectorOnly: true })
  assert.deepEqual(mismatched, [])
  assert.equal(adapterCalls.length, callsBeforeMismatchedSearch, "retrieval must validate active-space metadata before spending embedding tokens")
  assert.equal((await knowledgeIndexJobs.runNext(queuedSwitch.id))?.status, "completed")
  const rebuiltBase = await knowledgeRepository.getBase(base.id)
  const rebuiltSpace = await vectorIndex.getSpace(rebuiltBase.active_vector_space_id)
  assert.equal(vectorSpaceMatches(rebuiltSpace, { modelName: "knowledge-p1-b", dimensions: 3, distanceMetric: "l1" }), true)

  // 孤儿空间回收：崩溃遗留、无任何 active/任务行引用的知识库 staging 空间必须被清理，
  // 而记忆召回（memory-items）与仍被引用的空间绝不能被触碰。
  const orphanSpace = await vectorIndex.ensureSpace({ modelName: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine", scopeKey: `${base.id}:${crypto.randomUUID()}:1` })
  const memorySpace = await vectorIndex.ensureSpace({ modelName: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine", scopeKey: "memory-items" })
  const referencedSpace = await vectorIndex.ensureSpace({ modelName: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine", scopeKey: `${base.id}:${crypto.randomUUID()}:2` })
  await sqliteClient.run(
    "INSERT INTO knowledge_index_jobs(id, knowledge_base_id, vector_space_id, model_name, dimensions, status, max_attempts, created_at, updated_at) VALUES(?, ?, ?, 'knowledge-p1-a', 2, 'failed', 3, ?, ?)",
    [crypto.randomUUID(), base.id, referencedSpace.id, Date.now(), Date.now()],
  )
  const reclaimResult = await knowledgeIndexJobs.cleanupExpired()
  assert.equal(reclaimResult.reclaimedSpaces, 1, "orphan GC must reclaim exactly the unreferenced knowledge space")
  assert.equal(await vectorIndex.getSpace(orphanSpace.id), null, "unreferenced knowledge staging space must be reclaimed")
  assert(await vectorIndex.getSpace(memorySpace.id), "memory-recall space must never be touched by orphan GC")
  assert(await vectorIndex.getSpace(referencedSpace.id), "job-referenced space must survive orphan GC")
  assert(await vectorIndex.getSpace(rebuiltBase.active_vector_space_id), "active space must survive orphan GC")

  // 预算耗尽暂停必须保留 staging 空间；恢复后按 content_hash 续传，
  // 只为缺失分块消耗 embedding，并把同一个空间发布为 active。
  const budgetBase = await knowledgeStore.create({ name: "P1 预算续传", config: { embeddingModel: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine" } })
  await knowledgeRepository.replaceDocument({
    knowledgeBaseId: budgetBase.id, sourceType: "text", sourceKey: "budget", title: "budget",
    content: "budget generation", contentHash: "budget-generation", chunks: chunks(5, "budget"),
  })
  let budgetAdapterCalls = 0
  embeddingInterceptor = ({ channel }) => {
    if (channel.name !== "knowledge-p1-a") return
    budgetAdapterCalls++
    if (budgetAdapterCalls >= 2) {
      const error = new Error("embedding 每日 Token 预算已耗尽")
      error.code = "BUDGET_EXHAUSTED"
      throw error
    }
  }
  const pausedBuild = await knowledgeIndexJobs.queue(budgetBase.id, { immediate: true })
  embeddingInterceptor = null
  assert.equal(pausedBuild.status, "paused_budget")
  const pausedJob = await sqliteClient.get("SELECT id, status, vector_space_id FROM knowledge_index_jobs WHERE knowledge_base_id=?", [budgetBase.id])
  assert.equal(pausedJob.status, "paused_budget")
  const pausedSpace = await vectorIndex.getSpace(pausedJob.vector_space_id)
  assert(pausedSpace, "budget pause must keep the staging space for resume")
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM embedding_records WHERE space_id=?", [pausedSpace.id], "vectors"))?.total, 2, "chunks embedded before the pause must stay in staging")
  await knowledgeIndexJobs.cleanupExpired()
  assert(await vectorIndex.getSpace(pausedSpace.id), "paused staging space must survive orphan GC")
  adapterCalls.length = 0
  await knowledgeIndexJobs.retry(pausedJob.id)
  const resumedBuild = await knowledgeIndexJobs.runNext(pausedJob.id)
  assert.equal(resumedBuild?.status, "completed")
  assert.deepEqual(adapterCalls.map(item => item.size), [2, 1], "resume must only embed chunks missing from staging")
  const resumedBase = await knowledgeRepository.getBase(budgetBase.id)
  assert.equal(resumedBase.active_vector_space_id, pausedSpace.id, "resume must publish the reused staging space")
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM embedding_records WHERE space_id=?", [pausedSpace.id], "vectors"))?.total, 5)

  // 崩溃遗留的 canceling（租约为 0 且无执行器收尾）会阻塞同库新任务，
  // cleanupExpired 必须把它终结为 canceled，但不能碰本进程正在执行的任务。
  const healBase = await knowledgeStore.create({ name: "P1 canceling 自愈", config: { embeddingModel: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine" } })
  const stuckJobId = crypto.randomUUID()
  await sqliteClient.run(
    "INSERT INTO knowledge_index_jobs(id, knowledge_base_id, model_name, dimensions, status, max_attempts, created_at, updated_at) VALUES(?, ?, 'knowledge-p1-a', 2, 'canceling', 3, ?, ?)",
    [stuckJobId, healBase.id, Date.now(), Date.now()],
  )
  const blockedSuccessor = await knowledgeIndexJobs.queue(healBase.id, { deferIfActive: true })
  assert.equal(blockedSuccessor.status, "queued")
  assert.equal(await knowledgeIndexJobs.runNext(blockedSuccessor.id), null, "stale canceling must block claims until healed")
  knowledgeIndexJobs.executingJobIds.add(stuckJobId)
  await knowledgeIndexJobs.cleanupExpired()
  assert.equal((await sqliteClient.get("SELECT status FROM knowledge_index_jobs WHERE id=?", [stuckJobId]))?.status, "canceling", "healing must skip jobs executing in this process")
  knowledgeIndexJobs.executingJobIds.delete(stuckJobId)
  await knowledgeIndexJobs.cleanupExpired()
  assert.equal((await sqliteClient.get("SELECT status FROM knowledge_index_jobs WHERE id=?", [stuckJobId]))?.status, "canceled", "stale canceling must be terminalized")
  assert.equal((await knowledgeIndexJobs.runNext(blockedSuccessor.id))?.status, "completed", "healing must unblock the knowledge base")

  // 执行中/取消中的任务重试必须返回 409 语义错误，不能重置状态。
  const busyBase = await knowledgeStore.create({ name: "P1 重试冲突", config: { embeddingModel: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine" } })
  const busyJobId = crypto.randomUUID()
  await sqliteClient.run(
    "INSERT INTO knowledge_index_jobs(id, knowledge_base_id, model_name, dimensions, status, max_attempts, lease_until, created_at, updated_at) VALUES(?, ?, 'knowledge-p1-a', 2, 'running', 3, ?, ?, ?)",
    [busyJobId, busyBase.id, Date.now() + 600000, Date.now(), Date.now()],
  )
  await assert.rejects(knowledgeIndexJobs.retry(busyJobId), error => error.code === "KNOWLEDGE_INDEX_ALREADY_RUNNING" && error.statusCode === 409)
  assert.equal((await sqliteClient.get("SELECT status FROM knowledge_index_jobs WHERE id=?", [busyJobId]))?.status, "running")
  await sqliteClient.run("UPDATE knowledge_index_jobs SET status='superseded', lease_until=0 WHERE id=?", [busyJobId])

  // 向量库不可用时：显式重建直接拒绝并给出明确错误；deferIfActive 隐式路径降级为 FTS，
  // 两者都不得创建注定失败的任务。
  const offlineBase = await knowledgeStore.create({ name: "P1 向量离线", config: { embeddingModel: "knowledge-p1-a", dimensions: 2, distanceMetric: "cosine" } })
  const onlineStatus = sqliteClient.status
  sqliteClient.status = { ...onlineStatus, vector: { available: false, error: "sqlite-vec 加载失败" } }
  try {
    await assert.rejects(knowledgeIndexJobs.queue(offlineBase.id, { immediate: true }), error => error.code === "VECTOR_STORE_UNAVAILABLE" && /向量数据库不可用/.test(error.message))
    const degraded = await knowledgeIndexJobs.queue(offlineBase.id, { deferIfActive: true })
    assert.deepEqual(degraded, { status: "fts_ready", reason: "vector_unavailable" })
  } finally {
    sqliteClient.status = onlineStatus
  }
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM knowledge_index_jobs WHERE knowledge_base_id=?", [offlineBase.id]))?.total, 0, "vector-unavailable must not enqueue doomed jobs")

  console.log("ok knowledge-p1")
} finally {
  knowledgeIndexJobs?.stop()
  await sqliteClient?.close().catch(() => {})
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
