import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-memory-vectors-"))
process.env.YUI_CHAT_RUNTIME_ROOT = root
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { at: String, image: String, record: String, reply: String }
global.plugin = class {}
let sqliteClient, modelLogStore
const instances = []

try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { MemoryVectorRecall } = await import("../output/runtime/memory/vector-recall.js")
  const { vectorIndex } = await import("../output/runtime/knowledge/vector-index.js")
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  await configStore.load(); await sqliteClient.init(defaults)
  assert.equal(sqliteClient.status.vector?.available, true)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  let calls = 0, onEmbed = null
  adapterRegistry.register({ id: "memory-vector-fixture", supportsEmbeddings: true,
    async embedTexts({ channel, texts, dimensions }) {
      calls++
      const vectors = texts.map(text => {
        const value = text.startsWith("target") ? [0.8, 0.6] : text.startsWith("weak") ? [0, 1] : [1, 0]
        return channel.model === "old" ? value : [-value[1] || 0, value[0]]
      })
      if (onEmbed) { const action = onEmbed; onEmbed = null; await action() }
      return { vectors, dimensions, usage: { input: texts.length, output: 0, total: texts.length, source: "reported" } }
    },
  })
  await configStore.update(config => {
    config.apiProviders.push({ name: "memory-vector-provider", type: "memory-vector-fixture", baseURL: "https://example.invalid/v1" })
    config.models.push({ name: "memory-vector-alias", modelIdentifier: "old", apiProvider: "memory-vector-provider", adapter: "memory-vector-fixture", capabilities: { chat: false, embedding: true }, embedding: { defaultDimensions: 2, allowedDimensions: [2], batchSize: 64, timeoutMs: 30000 } })
    Object.assign(config.memory.retrieval, { embeddingModel: "memory-vector-alias", embeddingDimensions: 2, vectorCandidateLimit: 1 })
  })
  const scope = [{ scopeType: "user_group", ownerId: "target-user", groupId: "target-group" }]
  const now = Date.now()
  const rows = [
    { id: "target", text: "target coffee preference", owner: "target-user", group: "target-group" },
    { id: "weak", text: "weak unrelated topic", owner: "target-user", group: "target-group" },
    { id: "archived", text: "other archived", owner: "target-user", group: "target-group" },
    { id: "expired", text: "other expired", owner: "target-user", group: "target-group" },
    ...Array.from({ length: 1100 }, (_, i) => ({ id: `distractor-${i}`, text: `other ${i}`, owner: "other-user", group: i % 2 ? "target-group" : "other-group" })),
    { id: "other-group", text: "other group", owner: "target-user", group: "other-group" },
  ]
  await sqliteClient.transaction(rows.map(row => ({ sql: "INSERT INTO memory_items(id,scope_type,owner_id,group_id,type,text,normalized_key,last_confirmed_at,created_at,updated_at) VALUES(?,'user_group',?,?,'fact',?,?,?,?,?)", params: [row.id, row.owner, row.group, row.text, row.text, now, now, now] })))
  const recall = new MemoryVectorRecall(); instances.push(recall)
  await recall.syncMemoryVectors(); assert.equal(recall.lastError, "")
  const originalSpace = recall.space
  await sqliteClient.run("UPDATE memory_items SET status='archived' WHERE id='archived'")
  await sqliteClient.run("UPDATE memory_items SET expires_at=? WHERE id='expired'", [now - 1])
  const query = "query coffee preference"
  assert.deepEqual((await recall.queryMemoryVectors(scope, query)).map(row => row.id), ["target"], "scope and eligibility must be applied before top-k despite >1000 closer outsiders")
  const cachedCalls = calls
  assert.deepEqual((await recall.queryMemoryVectors(scope, query)).map(row => row.id), ["target"])
  assert.equal(calls, cachedCalls, "same-identity query must use the cache")
  assert.deepEqual(await recall.queryMemoryVectors([{ scopeType: "user", ownerId: "missing" }], query), [])
  assert.equal(calls, cachedCalls, "empty scopes must not call embedding or search globally")

  const owners = rows.filter(row => row.id !== "target").map(row => row.id).concat("target")
  assert.deepEqual((await vectorIndex.search(originalSpace, [0.8, 0.6], 1, { ownerType: "memory_item", ownerIds: owners })).map(row => row.ownerId), ["target"], "batched rowid filtering must merge exact top-k across all owner batches")
  assert.deepEqual(await vectorIndex.search(originalSpace, [1, 0], 1, { ownerType: "memory_item", ownerIds: [] }), [])
  assert.deepEqual(await vectorIndex.search(originalSpace, [1, 0], 1, { ownerType: "knowledge_chunk", ownerIds: ["target"] }), [])

  await configStore.update(config => { config.models.find(model => model.name === "memory-vector-alias").modelIdentifier = "new" })
  assert.deepEqual(await recall.queryMemoryVectors(scope, query), [], "new model must not query the old memory space")
  assert.notEqual(recall.space.id, originalSpace.id)
  const freshQuery = [...recall.queryCache.values()][0].vector
  assert.deepEqual(freshQuery, [0, 1], "cached query from the old upstream must not survive")
  await recall.syncMemoryVectors(); assert.equal(recall.lastError, "")
  assert.deepEqual((await recall.queryMemoryVectors(scope, query)).map(row => row.id), ["target"])
  assert.equal(await vectorIndex.getSpace(originalSpace.id), null, "successful replacement must reclaim old memory indexes")

  const restarted = new MemoryVectorRecall(); instances.push(restarted)
  const beforeRestart = calls
  await restarted.syncMemoryVectors(); assert.equal(restarted.lastError, "")
  assert.equal(restarted.space.id, recall.space.id)
  assert.equal(calls, beforeRestart, "restart with unchanged identity must reuse persisted vectors")
  assert.deepEqual((await restarted.queryMemoryVectors(scope, query)).map(row => row.id), ["target"])

  const stableSpace = restarted.space
  await configStore.update(config => { config.apiProviders.find(provider => provider.name === "memory-vector-provider").baseURL = "https://example.invalid/v2" })
  await restarted.ensureSpace()
  assert.notEqual(restarted.space.id, stableSpace.id, "provider endpoint changes must isolate memory spaces too")
  onEmbed = () => configStore.update(config => { config.models.find(model => model.name === "memory-vector-alias").embedding.params = { revision: "changed-during-sync" } })
  await restarted.syncMemoryVectors()
  assert(restarted.lastError.includes("同步期间变化"))
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM embedding_records WHERE space_id=?", [restarted.space.id], "vectors")).total, 0, "in-flight stale embedding output must never enter the replacement space")
  assert(await vectorIndex.getSpace(stableSpace.id), "failed replacement must preserve the previous index until a successful sync")
  await restarted.syncMemoryVectors(); assert.equal(restarted.lastError, "")
  assert.deepEqual((await restarted.queryMemoryVectors(scope, query)).map(row => row.id), ["target"])

  onEmbed = () => configStore.update(config => { config.models.find(model => model.name === "memory-vector-alias").embedding.params = { revision: "changed-during-query" } })
  assert.deepEqual(await restarted.queryMemoryVectors(scope, "query uncached coffee"), [], "identity changes during query must degrade to FTS")
  console.log("ok memory-vectors: cosine, scoped top-k, batched filters, identity/cache isolation, restart, GC, and in-flight model changes")
} finally {
  for (const instance of instances) if (instance.dirtyTimer) clearTimeout(instance.dirtyTimer)
  await modelLogStore?.stop({ flush: true }).catch(() => {})
  await sqliteClient?.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
}
