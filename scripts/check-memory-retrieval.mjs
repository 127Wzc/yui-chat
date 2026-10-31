import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-memory-retrieval-"))
process.env.YUI_CHAT_RUNTIME_ROOT = root
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { at: String, image: String, record: String, reply: String }
global.plugin = class {}
let sqliteClient, vectorRecall, modelLogStore, fileMemoryStore
try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const { memoryRepository } = await import("../output/runtime/memory/repository.js")
  const { sqliteMemoryStore } = await import("../output/runtime/memory/sqlite-store.js")
  ;({ fileMemoryStore } = await import("../output/runtime/memory/file-store.js"))
  ;({ vectorRecall } = await import("../output/runtime/memory/vector-recall.js"))
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  const { retrieveMemory, fuseMemoryCandidates } = await import("../output/runtime/memory/retrieval.js")
  const { MemoryManageTool } = await import("../output/runtime/tools/builtins/memory.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { addModelsToProvider } = await import("../output/runtime/models/configuration/editor.js")
  const { fitFullMemoryRead, isFullOwnMemoryRequest, parseMemoryCursor } = await import("../output/runtime/memory/full-read.js")
  const { createExecutionRuntime } = await import("../output/runtime/tools/support/execution-runtime.js")
  const { enforcePromptBudgetDetailed, estimateTokens } = await import("../output/runtime/core/chat/token-budget.js")
  await configStore.load()
  await sqliteClient.init(defaults)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  const event = { user_id: "caller", isGroup: true, group_id: "current" }
  const scopes = [{ scopeType: "user", ownerId: "caller", groupId: "" }]
  const now = Date.now()
  const own = Array.from({ length: 260 }, (_, i) => ({ id: `own-${String(i).padStart(3, "0")}`, text: `我喜欢咖啡口味${i}` }))
  const rows = [...own,
    { id: "local", scope: "user_group", group: "current" },
    { id: "cold", confirmed: now - 700 * 86400000 },
    { id: "other-group", scope: "user_group", group: "elsewhere" },
    { id: "other-user", owner: "other" },
    { id: "public", scope: "group", owner: "current", group: "current" },
    { id: "expired", expires: now - 1 }, { id: "archived", status: "archived" }, { id: "deleted", status: "deleted" },
    { id: "decayed", confirmed: now - 2000 * 86400000 },
    { id: "interaction", type: "episode", source: "interaction" },
    { id: "short", type: "short" }, { id: "profile", type: "profile", text: "{}" },
  ]
  await sqliteClient.transaction(rows.map(row => ({ sql: "INSERT INTO memory_items(id,scope_type,owner_id,group_id,type,text,normalized_key,status,source,last_confirmed_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [row.id, row.scope || "user", row.owner || "caller", row.group || "", row.type || "fact", row.text || row.id, row.id, row.status || "active", row.source || "explicit-user", row.confirmed || now, row.expires || 0, now, now] })))

  const tool = new MemoryManageTool()
  const context = { e: event, prompt: "请查询我的全部记忆并总结" }
  assert(isFullOwnMemoryRequest(context.prompt))
  for (const value of ["可以帮我查询我的全部记忆并总结吗？", "请把我的记忆全部列出来", "请查看全部关于我的记忆"]) assert(isFullOwnMemoryRequest(value), value)
  for (const value of ["不要查询我的全部记忆", "你可以查询我的全部记忆吗？", "查询他的全部记忆", "查一下我的咖啡偏好", "帮我查询张三的全部记忆并总结", "我不想看全部记忆，只查咖啡偏好", "帮我查她的全部记忆", "解释查询我的全部记忆这句话", "查询我的记忆和他的全部记忆"]) {
    assert(!isFullOwnMemoryRequest(value), value)
    assert.match(await tool.execute({ action: "list", all: true }, { e: event, prompt: value }), /明确要求/, "model arguments must not override a missing user authorization")
  }
  assert(!(await tool.execute({ action: "list" }, context)).startsWith('{"kind":"memory_full_read"'), "list without all=true must remain bounded")
  assert(!(await tool.execute({ action: "search", query: "咖啡" }, context)).startsWith('{"kind":"memory_full_read"'), "search never silently upgrades to a full read")
  assert.match(await tool.execute({ action: "search", all: true }, context), /action=list/)
  const fullText = await tool.execute({ action: "list", all: true, limit: 1 }, context)
  const full = JSON.parse(fullText)
  assert.equal(full.total, 263, "full read must bypass the old 200-row list cap and relevance selection")
  assert.equal(full.complete, true)
  assert.equal(full.returned, 263)
  assert.equal(full.items.find(item => item.id === "cold").status, "cold")
  assert(full.items.some(item => item.id === "local"))
  assert.equal(full.items.find(item=>item.id==="decayed").status,"cold","old facts remain valid and searchable without new evidence of expiry")
  for (const id of ["other-group", "other-user", "public", "expired", "archived", "deleted", "interaction", "short", "profile"]) assert(!full.items.some(item => item.id === id), id)
  assert.equal((await sqliteMemoryStore.listOwnMemories({ user_id: "caller" })).items.length, 262, "private chat must not include personal group memories")
  await assert.rejects(() => sqliteMemoryStore.listOwnMemories({}), /识别/)
  assert.match(await tool.execute({ action: "list", all: true }, { e: event, prompt: "你好" }), /明确要求/)
  assert.match(await tool.execute({ action: "list", all: true, offset: 1000 }, context), /cursor/)
  const regular = await tool.execute({ action: "list" }, { e: event, prompt: "查看我的记忆" })
  assert.equal((regular.match(/\n   id:/g) || []).length, 12)
  const ids = []
  let cursor
  do {
    const packet = JSON.parse(await tool.execute({ action: "list", all: true, ...(cursor ? { cursor } : {}), pageSize: 70 }, context))
    ids.push(...packet.items.map(item => item.id))
    cursor = packet.nextCursor
    assert.equal(packet.complete, cursor === null)
  } while (cursor !== null)
  assert.deepEqual(ids, full.items.map(item => item.id), "successive pages must cover every authorized record exactly once")
  const fitted = JSON.parse(fitFullMemoryRead(fullText, 500, estimateTokens))
  assert.equal(fitted.complete, false)
  assert.equal(fitted.returned, fitted.items.length)
  assert.equal(parseMemoryCursor(fitted.nextCursor).offset, fitted.items.length)
  assert.equal(parseMemoryCursor(fitted.nextCursor).afterId, fitted.items.at(-1).id)
  const resumed = JSON.parse(await tool.execute({ action: "list", all: true, cursor: fitted.nextCursor }, context))
  assert.deepEqual([...fitted.items, ...resumed.items].map(item => item.id), full.items.map(item => item.id), "compressed content resumes after the last item actually retained")
  const twice = JSON.parse(fitFullMemoryRead(JSON.stringify(fitted), 350, estimateTokens))
  assert.equal(twice.complete, false)
  if (twice.nextCursor) assert.equal(parseMemoryCursor(twice.nextCursor).afterId, twice.items.at(-1).id)
  const tiny = JSON.parse(fitFullMemoryRead(fullText, 96, estimateTokens))
  assert.equal(tiny.complete, false)
  assert(estimateTokens(JSON.stringify(tiny)) <= 96)
  assert.deepEqual(fitted.items, full.items.slice(0, fitted.returned))
  assert(estimateTokens(JSON.stringify(fitted)) <= 500)
  const execution = createExecutionRuntime()
  const wrappedText = execution.formatToolResult({ content: fullText, status: "success" })
  const wrappedFit = fitFullMemoryRead(wrappedText, 800, estimateTokens)
  assert(wrappedFit.includes("工具执行状态："))
  assert.equal(JSON.parse(wrappedFit.split("\n工具执行状态：")[0]).complete, false, "actual Registry result framing must preserve the partial marker")
  const messages = [{ role: "system", content: "memory tool rules" }, { role: "user", content: context.prompt }, { role: "assistant", content: "", tool_calls: [{ id: "full", type: "function", function: { name: "memory_manage", arguments: '{"action":"list","all":true}' } }] }, { role: "tool", tool_call_id: "full", content: wrappedText }]
  assert.equal(enforcePromptBudgetDetailed(messages, { chat: { inputTokenBudget: 100000 } }).messages.at(-1).content, wrappedText)
  const compressed = enforcePromptBudgetDetailed(messages, { chat: { inputTokenBudget: 1500 } })
  assert.equal(JSON.parse(compressed.messages.find(item => item.role === "tool").content.split("\n工具执行状态：")[0]).complete, false, "context compression must not leave a misleading complete=true")

  let vectorCalls = 0, rankCalls = 0, duringRank = null
  const originalEnabled = vectorRecall.enabled, originalQuery = vectorRecall.queryMemoryVectors, originalSearch = memoryRepository.search, originalRerank = adapterRegistry.rerank
  const candidates = await memoryRepository.getMany(own.slice(0, 4).map(item => item.id))
  const byId = new Map(candidates.map(item => [item.id, item]))
  const ordered = own.slice(0, 4).map(item => byId.get(item.id))
  const lexical = ordered.slice(0, 3).map((item, index) => ({ ...item, score: 1e6 - index }))
  const semantic = [ordered[3], ordered[1]].map(item => ({ ...item, score: 0.8 }))
  assert.equal(fuseMemoryCandidates(lexical, semantic, scopes)[0].id, ordered[1].id, "a hit in both routes must outrank a high raw lexical score")
  assert.equal(fuseMemoryCandidates([...lexical, lexical[0]], [], scopes)[0].fusionScore, 1 / 61, "duplicates within a route must not add RRF votes")
  try {
    vectorRecall.enabled = () => true
    vectorRecall.queryMemoryVectors = async () => { vectorCalls++; return semantic }
    memoryRepository.search = async () => lexical
    assert.equal((await retrieveMemory(event, "我以前喜欢什么", { scopes, allowVector: true }))[0].id, ordered[1].id)
    assert.equal(vectorCalls, 1, "vector route must run even when FTS already meets the configured count")
    assert.equal((await retrieveMemory(event, "咖啡", { scopes, allowVector: false })).length, 3)
    assert.equal(vectorCalls, 1, "ordinary unrelated chat must not incur embedding")
    await configStore.update(config => { config.memory.retrieval.resultLimit = 2; config.memory.injectProfile = false })
    const prompt = await sqliteMemoryStore.buildPrompt(event, "我的咖啡喜好")
    assert.equal((prompt.match(/长期记忆（QQ/g) || []).length, 2, "automatic prompt uses configured default count")
    const beforeFull = vectorCalls
    assert.match(await sqliteMemoryStore.buildPrompt(event, context.prompt), /all=true/)
    assert.equal(vectorCalls, beforeFull, "full read must bypass vector and rerank calls")
    let firstPage
    for (const mutate of [
      () => memoryRepository.insert({ id: "new-before-cursor", scopeType: "user", ownerId: "caller", type: "fact", text: "新增的合成记忆" }),
      () => memoryRepository.update("own-001", { text: "修改后的合成记忆" }),
      () => memoryRepository.hardDelete(firstPage.items[0].id),
    ]) {
      firstPage = JSON.parse(await tool.execute({ action: "list", all: true, pageSize: 1 }, context))
      await mutate()
      const changed = JSON.parse(await tool.execute({ action: "list", all: true, cursor: firstPage.nextCursor }, context))
      assert.equal(changed.complete, false)
      assert.equal(changed.restartRequired, true)
      assert.equal(changed.returned, 0, "stale cursor must not skip or mix records from a different revision")
    }
    const foreign = JSON.parse(await tool.execute({ action: "list", all: true, cursor: firstPage.nextCursor }, { ...context, e: { ...event, user_id: "other" } }))
    assert.equal(foreign.restartRequired, true)
    assert.deepEqual(foreign.items, [])
    const invalidCursor = JSON.parse(await tool.execute({ action: "list", all: true, cursor: "invalid" }, context))
    assert.equal(invalidCursor.complete, false)
    assert.equal(invalidCursor.restartRequired, true)
    const fresh = JSON.parse(await tool.execute({ action: "list", all: true }, context))
    assert.equal(fresh.complete, true)
    assert(fresh.items.some(item => item.text === "修改后的合成记忆"))
    // Restore the retrieval fixture after the mutation checks.
    await memoryRepository.update("own-001", { text: own[1].text })
    let cfg = structuredClone(configStore.get())
    cfg.apiProviders.push({ name: "ranks", type: "openai-compatible", baseURL: "https://example.invalid/v1" })
    cfg = addModelsToProvider(cfg, "ranks", ["memory-ranker", "rag-ranker"], { purpose: "rerank" })
    const memoryModel = cfg.models.find(item => item.modelIdentifier === "memory-ranker").name
    const ragModel = cfg.models.find(item => item.modelIdentifier === "rag-ranker").name
    cfg.modelTasks.rerank.modelList = [ragModel]
    Object.assign(cfg.knowledge.retrieval, { rerankEnabled: true, rerankModel: ragModel })
    Object.assign(cfg.memory.retrieval, { rerankEnabled: true, rerankModel: memoryModel, rerankCacheTtlMs: 0, rerankMinScore: 0 })
    assert.equal(validateConfig(cfg).ok, true)
    await configStore.save(cfg)
    adapterRegistry.rerank = async request => {
      rankCalls++
      assert.equal(request.channel.model, "memory-ranker", "memory must not inherit the RAG model/task")
      assert.equal(request.source, "memory-rerank")
      if (duringRank) { const action = duringRank; duringRank = null; await action() }
      return { results: request.documents.map((_, index) => ({ index, score: index === 2 ? 0.9 : 0 })), model: request.channel.model }
    }
    const ranked = await retrieveMemory(event, "我以前喜欢什么", { scopes, allowVector: true })
    assert.equal(rankCalls, 1)
    assert.equal(ranked[0].id, ordered[3].id, "independent reranker must determine final order")
    assert.equal(ranked.length, 2, "zero minimum score must retain zero-score candidates")
    duringRank = () => memoryRepository.hardDelete(ordered[3].id)
    assert(!(await retrieveMemory(event, "我以前喜欢什么，重新检查", { scopes, allowVector: true })).some(item => item.id === ordered[3].id), "withdrawal during model call must be rechecked")
    adapterRegistry.rerank = async () => { throw new Error("fixture timeout") }
    assert.equal((await retrieveMemory(event, "超时后我以前喜欢什么", { scopes, allowVector: true }))[0].id, ordered[1].id, "rerank failure retains local fusion")
    const invalid = structuredClone(configStore.get())
    invalid.memory.retrieval.rerankModel = ""
    assert(validateConfig(invalid).errors.some(issue => issue.path === "memory.retrieval.rerankModel"), "enabled memory rerank must require its own model")
    invalid.memory.retrieval.rerankModel = ragModel
    assert.equal(validateConfig(invalid).ok, true, "explicitly sharing a chosen model is allowed")
    await configStore.update(config => { config.memory.retrieval.adaptiveVector = true })
    assert.equal(configStore.get().memory.retrieval.adaptiveVector, undefined, "obsolete adaptive FTS trigger must not survive normalization")
  } finally {
    vectorRecall.enabled = originalEnabled; vectorRecall.queryMemoryVectors = originalQuery
    memoryRepository.search = originalSearch; adapterRegistry.rerank = originalRerank
  }

  // 客户端组件的渲染和保存契约；不访问浏览器或真实管理端。
  global.location = { hash: "", pathname: "/yui-chat", search: "" }
  global.localStorage = { getItem() { return null } }
  const { createSSRApp, compile } = await import("vue")
  const { renderToString } = await import("vue/server-renderer")
  const advancedUrl = new URL("../output/runtime/web/client/features/advanced/advanced-tab.js", import.meta.url)
  const storeImport = (await fs.readFile(advancedUrl, "utf8")).match(/from "([^"]*app\/store\/store\.js[^"]*)"/)[1]
  const { store: clientStore } = await import(new URL(storeImport, advancedUrl))
  const { AdvancedTab } = await import("../output/runtime/web/client/features/advanced/advanced-tab.js")
  const { components } = await import("../output/runtime/web/client/ui/components.js")
  const templateErrors = []
  compile(AdvancedTab.template, { onError: error => templateErrors.push(error.message), onWarn() {} })
  assert.deepEqual(templateErrors, [])
  clientStore.config = structuredClone(configStore.get())
  clientStore.activeTab = "advanced"
  clientStore.systemSettingsSection = "memory-capture"
  let view
  await renderToString(createSSRApp({ setup() { view = AdvancedTab.setup(); return () => null } }))
  const options = view.memoryRerankModelOptions.value
  assert(options.some(item => item.value === clientStore.config.memory.retrieval.rerankModel))
  assert(options.filter(item => item.value).every(item => clientStore.config.models.find(model => model.name === item.value)?.purpose === "rerank"))
  clientStore.systemSettingsSection = "memory-capture"
  const clientApp = createSSRApp({ setup() {
    view = AdvancedTab.setup()
    view.draft.memoryRerankCandidates = 11
    view.draft.memoryRerankMinScore = 0
    assert.equal(clientStore.dirtyScopes["system:memory-capture"], true)
    return view
  }, template: AdvancedTab.template })
  for (const [name, component] of Object.entries({ ...components, ...AdvancedTab.components })) clientApp.component(name, component)
  const html = await renderToString(clientApp)
  assert(html.includes("记忆向量模型") && html.includes("记忆重排模型") && html.includes("全部记忆"))
  const originalFetch = global.fetch
  let savedPatch
  let clientConfig = structuredClone(configStore.get())
  const ragBefore = JSON.stringify(clientConfig.knowledge)
  global.fetch = async (_url, request = {}) => {
    if (request.method === "PATCH") {
      savedPatch = JSON.parse(request.body).patch
      for (const [key, value] of Object.entries(savedPatch)) {
        const parts = key.split("."); let target = clientConfig
        for (const part of parts.slice(0, -1)) target = target[part]
        target[parts.at(-1)] = value
      }
    }
    return { ok: true, json: async () => ({ config: clientConfig, capture: { defaultPolicy: {} }, summary: {}, backups: [] }) }
  }
  try {
    await view.saveCaptureDefaults()
    assert.equal(savedPatch["memory.retrieval.rerankMaxCandidates"], 11)
    assert.equal(savedPatch["memory.retrieval.rerankMinScore"], 0)
    assert.equal(savedPatch["memory.retrieval.rerankModel"], configStore.get().memory.retrieval.rerankModel)
    assert(Object.keys(savedPatch).every(key => key.startsWith("memory.")))
    assert.equal(JSON.stringify(clientConfig.knowledge), ragBefore, "saving memory controls must leave RAG configuration untouched")
    assert.equal(clientStore.dirtyScopes["system:memory-capture"], undefined)
  } finally { global.fetch = originalFetch }

  // 文件后端仍保持有界读取，不能将截掉的窗口伪装成全量。
  await fileMemoryStore.addFact(event, "我喜欢茶", { immediate: true })
  await fileMemoryStore.addFact(event, "本群我喜欢咖啡", { owner: "scope", immediate: true })
  await fileMemoryStore.addFact({ user_id: "other" }, "他喜欢汽水", { immediate: true })
  const fileRead = await fileMemoryStore.listOwnMemories(event)
  assert.equal(fileRead.complete, true)
  assert.equal(fileRead.items.length, 2)
  assert(!fileRead.items.some(item => item.text.includes("汽水")))
  await fs.appendFile(path.join(fileMemoryStore.rootDir, "memories", "users", "caller.jsonl"), " ".repeat(2100000))
  const bounded = await fileMemoryStore.listOwnMemories(event)
  assert.equal(bounded.complete, false)
  assert.match(bounded.warning, /不能保证全量/)
  console.log("ok memory-retrieval: dual recall/RRF, independent rerank/fallback, default injection count, uncapped own full reads, pagination, budget honesty and scope/lifecycle isolation")
} finally {
  if (vectorRecall?.dirtyTimer) clearTimeout(vectorRecall.dirtyTimer)
  if (fileMemoryStore?.flushTimer) clearTimeout(fileMemoryStore.flushTimer)
  await fileMemoryStore?.flush().catch(() => {})
  await modelLogStore?.stop({ flush: true }).catch(() => {})
  await sqliteClient?.close().catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
}
