import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-sqlite-integration-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot

global.logger = {
  mark() {}, info() {}, warn() {}, error() {}, debug() {},
  blue: value => value, cyan: value => value, red: value => value,
}
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { at: id => `[at:${id}]`, image: value => `[image:${value}]`, record: value => `[record:${value}]`, video: value => `[video:${value}]`, reply: value => `[reply:${value}]` }
global.plugin = class { constructor(options = {}) { this.options = options } }

const event = { isGroup: true, group_id: "baseline-group", user_id: "baseline-user", sender: { role: "member", nickname: "基线用户", card: "基线名片" } }

let sqliteClient
let configStore
let groupCaptureStore
let modelLogStore
let knowledgeIndexJobs
let resolveMemoryRetrievalLimit
let resolveMemoryRecallPlan
let vectorRecall

try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  assert.equal(defaults.memory.retrieval.promptTokenBudget, 2000, "memory prompt budget should default to 2000 tokens")
  ;({ configStore } = await import("../output/runtime/config/store.js"))
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const { conversationStore } = await import("../output/runtime/core/chat/conversation-store.js")
  const { memoryStore } = await import("../output/runtime/memory/store.js")
  const { memoryRepository } = await import("../output/runtime/memory/repository.js")
  ;({ groupCaptureStore } = await import("../output/runtime/memory/group-capture.js"))
  ;({ resolveMemoryRetrievalLimit, resolveMemoryRecallPlan } = await import("../output/runtime/memory/retrieval.js"))
  ;({ vectorRecall } = await import("../output/runtime/memory/vector-recall.js"))
  const { knowledgeStore } = await import("../output/runtime/knowledge/store.js")
  const { knowledgeRepository } = await import("../output/runtime/knowledge/repository.js")
  const { searchKnowledge } = await import("../output/runtime/knowledge/retrieval.js")
  const { vectorIndex } = await import("../output/runtime/knowledge/vector-index.js")
  ;({ knowledgeIndexJobs } = await import("../output/runtime/knowledge/index-jobs.js"))
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  const { embeddingRunner } = await import("../output/runtime/models/embeddings/runner.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { createConfigBackup, restoreConfigBackup } = await import("../output/runtime/core/storage/config-backup-service.js")

  await configStore.load()
  await sqliteClient.init(defaults)
  assert.equal(sqliteClient.status.available, true, "SQLite worker must start with a new baseline database")
  assert.equal(sqliteClient.status.integrity, "ok", "SQLite worker must report an intact baseline database")
  assert.deepEqual((sqliteClient.status.migrations || []).map(row => row.id), ["001-baseline.sql", "002-tool-call-events.sql", "003-model-call-snapshots.sql", "004-conversation-state.sql"], "runtime state database must apply the baseline, combined tool/runtime, model snapshot, and conversation state migrations")
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  await configStore.update(config => {
    config.memory.groupCapture.enabled = true
    config.logging.level = "debug"
    config.apiProviders = [...(config.apiProviders || []).filter(item => item.name !== "baseline-provider"), { name: "baseline-provider", type: "baseline-embedding" }]
    config.models = [...(config.models || []).filter(item => item.name !== "baseline-embedding"), {
      name: "baseline-embedding",
      modelIdentifier: "baseline-embedding",
      apiProvider: "baseline-provider",
      adapter: "baseline-embedding",
      capabilities: { chat: false, embedding: true },
      embedding: { defaultDimensions: 2, allowedDimensions: [2], supportsDimensionOverride: true, batchSize: 16, timeoutMs: 30000 },
    }]
  })

  await conversationStore.save({
    id: "baseline:conversation",
    history: [{ role: "user", content: "你好" }, { role: "assistant", content: "你好，我在。" }],
    turns: [{ prompt: "你好", response: "你好，我在。" }],
    usage: { input: 2, output: 3, total: 5 },
    toolCalls: 1,
    protocolState: { responses: { "responses:provider:model": { previousResponseId: "resp_baseline" } } },
  })
  const baselineConversation = await conversationStore.get("baseline:conversation")
  assert.equal(baselineConversation?.history.length, 2, "conversation history must round-trip as one JSON record")
  assert.equal(baselineConversation?.turns.length, 1, "conversation audit turns must round-trip independently from model history")
  assert.equal(baselineConversation?.usage.total, 5, "conversation usage totals must survive a SQLite round trip")
  assert.equal(baselineConversation?.toolCalls, 1, "conversation tool call totals must survive a SQLite round trip")
  assert.equal(baselineConversation?.protocolState.responses["responses:provider:model"].previousResponseId, "resp_baseline", "Responses upstream state must remain attached to the local conversation record")
  await conversationStore.save({ id: "baseline-chat:p:web-test-baseline-history", history: [{ role: "user", content: "SQLite 历史测试" }, { role: "assistant", content: "已保存。" }] })
  const webTestSession = (await conversationStore.listWebTestSessions()).find(item => item.sessionId === "baseline-history")
  assert.equal(webTestSession?.messages.length, 2, "web test history must be read from the unified SQLite conversation record")
  assert.equal(await conversationStore.deleteWebTestSession(webTestSession?.key), 1, "a web test history record must be deletable without affecting other conversations")

  const fact = await memoryStore.addFact(event, "我喜欢手冲咖啡", { source: "explicit-user" })
  await memoryRepository.addEvidence(fact.id, { sourceEventId: "baseline-message-1", sourceType: "explicit-user", messageId: "baseline-message-1" })
  assert((await memoryStore.search(event, "手冲咖啡", 5)).some(item => item.id === fact.id), "memory FTS must retrieve an explicit fact")
  assert.equal((await sqliteClient.get("SELECT source_type FROM memory_evidence WHERE memory_id=?", [fact.id]))?.source_type, "explicit-user", "memory evidence must retain only the source reference")

  await groupCaptureStore.init()
  assert.equal(await resolveMemoryRetrievalLimit({ isGroup: false, user_id: "baseline-user" }), 3, "global automatic memory retrieval default should be three results")
  await groupCaptureStore.setPolicy("group", event.group_id, { enabled: true, overrides: { retrievalResultLimit: true }, retrievalResultLimit: 2 })
  assert.equal((await groupCaptureStore.listPolicies({ includeMessageStats: false })).find(policy => policy.scopeId === event.group_id)?.retrievalResultLimit, 2, "group memory policy should expose its retrieval result limit override")
  assert.equal(await resolveMemoryRetrievalLimit(event), 2, "automatic memory retrieval should apply the group override")

  const targetUserId = "mentioned-user"
  const mentionEvent = {
    ...event,
    user_id: "question-user",
    sender: { role: "member", user_id: "question-user", nickname: "提问者" },
    msg: `[CQ:at,qq=${targetUserId}] 她喜欢什么`,
    raw_message: `[CQ:at,qq=${targetUserId}] 她喜欢什么`,
    message: [
      { type: "at", data: { qq: targetUserId } },
      { type: "text", data: { text: "她喜欢什么" } },
    ],
  }
  const targetFact = await memoryStore.addFact(
    { ...event, user_id: targetUserId, sender: { role: "member", user_id: targetUserId, nickname: "被提问成员" } },
    "用户喜欢《未定事件簿》角色夏彦",
    { source: "group-capture" },
  )
  await memoryRepository.insert({
    scopeType: "user_group", ownerId: targetUserId, groupId: event.group_id, type: "fact",
    text: "用户在本群的群名片为「玖弦」", factKey: "identity.group_card", factValue: "玖弦", source: "platform-metadata",
  })
  const mentionPlan = await resolveMemoryRecallPlan(mentionEvent, "她喜欢什么")
  const mentionedScopes = mentionPlan.scopes
  assert.equal(mentionPlan.mode, "target", "a personal question about an at-mentioned member should use target mode")
  assert(mentionedScopes.some(scope => scope.scopeType === "user" && scope.ownerId === targetUserId && scope.groupId === ""), "group mention should add the target user's global memory scope")
  assert(mentionedScopes.some(scope => scope.scopeType === "user_group" && scope.ownerId === targetUserId && scope.groupId === event.group_id), "group mention should add the target user's current-group memory scope")
  assert(!mentionedScopes.some(scope => scope.ownerId === mentionEvent.user_id), "target mode should not mix the asker's personal memory into the target's answer")
  const mentionedPrompt = await memoryStore.buildPrompt(mentionEvent, "她喜欢什么")
  assert(mentionedPrompt.includes(`QQ ${targetUserId}`) && mentionedPrompt.includes(targetFact.text), "automatic memory prompt should inject and attribute a mentioned member's group-collected fact")
  assert.equal(await vectorRecall.hasAnyMemory(mentionedScopes), true, "vector memory preflight should see a mentioned member's memory")
  const unrelatedMentionPlan = await resolveMemoryRecallPlan(mentionEvent, "过来看看这个")
  assert.equal(unrelatedMentionPlan.mode, "speaker", "an ordinary at mention should not open the mentioned member's memory scope")
  assert(!unrelatedMentionPlan.scopes.some(scope => scope.ownerId === targetUserId), "an unrelated at mention must not scan target memory")
  const botMentionPlan = await resolveMemoryRecallPlan({ ...mentionEvent, self_id: targetUserId }, "你喜欢什么")
  assert(!botMentionPlan.scopes.some(scope => scope.ownerId === targetUserId), "at the bot itself must not be treated as a member-memory target")
  const namedPlan = await resolveMemoryRecallPlan({ ...mentionEvent, msg: "玖弦喜欢什么", raw_message: "玖弦喜欢什么", message: [{ type: "text", data: { text: "玖弦喜欢什么" } }] }, "玖弦喜欢什么")
  assert.equal(namedPlan.mode, "target", "a unique group card used in a personal question should resolve the target without an at mention")
  assert(namedPlan.targetUserIds.includes(targetUserId), "name-based target resolution should map the group card back to its QQ owner")
  const speakerPlan = await resolveMemoryRecallPlan({ ...mentionEvent, msg: "给我推荐一款游戏", raw_message: "给我推荐一款游戏", message: [{ type: "text", data: { text: "给我推荐一款游戏" } }] }, "给我推荐一款游戏")
  assert.equal(speakerPlan.mode, "speaker")
  assert.equal(speakerPlan.allowVector, true, "personalized recommendations may use the speaker's memory")

  assert.equal(groupCaptureStore.record({ ...event, message_id: "baseline-group-message", message: [{ type: "text", data: { text: "我喜欢手冲咖啡。" } }] }), true, "enabled group capture policy must accept a normal group message")
  await groupCaptureStore.flush()
  const captured = await groupCaptureStore.listMessages("group", event.group_id)
  assert.equal(captured.length, 1, "group capture must persist messages by group ID and message ID")
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM group_memory_messages WHERE group_id=?", [event.group_id]))?.total, 1, "group capture schema must not require a generic scope discriminator")

  await knowledgeStore.init()
  const base = await knowledgeStore.create({ name: "基线知识库", description: "用于验证 FTS 召回" })
  const ingested = await knowledgeStore.ingestText({ knowledgeBaseId: base.id, name: "coffee.md", content: "手冲咖啡需要控制水温与研磨度。", kind: "text" })
  assert.equal(ingested.indexState, "fts_ready", "knowledge ingestion without an embedding model must remain FTS-ready")
  const knowledge = await searchKnowledge({ isMaster: true, user_id: "master" }, "手冲咖啡", { knowledgeBaseIds: [base.id] })
  assert.equal(knowledge.length, 1, "authorized knowledge search must return the ingested FTS chunk")
  const document = (await knowledgeRepository.listDocuments(base.id))[0]
  assert.equal(document.source_type, "text", "knowledge document must store its source type directly")
  assert.equal(document.source_key, "coffee.md:0", "knowledge document must store its source key directly")
  assert.equal((await knowledgeRepository.listGrants(base.id))[0]?.default_active, 1, "default-active is derived for the API, not persisted in grants")

  modelLogStore.start(configStore.get())
  const trace = modelLogStore.createTrace({ event, source: "baseline-test", purpose: "reply", conversationKey: "baseline:conversation", prompt: "基线会话提问" })
  const call = modelLogStore.beginModelCall({
    trace,
    event,
    source: "baseline-test",
    purpose: "reply",
    channel: { name: "baseline-chat", type: "mock", model: "baseline-chat", provider: { name: "baseline-provider" }, modelConfig: { name: "baseline-chat" } },
    messages: [{ role: "user", content: "测试模型日志" }],
    metadata: {
      route: {
        task: "reply",
        strategy: "fallback",
        round: 0,
        phase: "initial",
        availableModels: [{ id: "baseline-chat", model: "baseline-chat", provider: "baseline-provider", adapter: "mock" }],
        actualModel: { id: "baseline-chat", model: "baseline-chat", provider: "baseline-provider", adapter: "mock" },
      },
    },
  })
  modelLogStore.completeModelCall(call, { response: { text: "完成", usage: { input: 2, output: 3, total: 5, source: "reported" } } })
  const toolEvent = modelLogStore.recordToolCall(trace, {
    modelCallId: call.id,
    round: 1,
    callIndex: 1,
    toolCallId: "baseline-tool-call",
    toolName: "baseline_tool",
    source: "custom",
    category: "network",
    status: "ok",
    startedAt: Date.now() - 5,
    endedAt: Date.now(),
    durationMs: 5,
    delivery: "silent",
    requiresFinalReply: true,
    arguments: { query: "咖啡", env: { API_KEY: "integration-secret", REGION: "cn" } },
    result: "找到 1 条结果",
    resultChars: 7,
  })
  assert(toolEvent?.id && trace?.toolCalls === 1, "tool event should be accepted by the model log store")
  modelLogStore.finishTrace(trace, { status: "ok", response: "完成" })
  const childTrace = modelLogStore.createTrace({ event, source: "subagent", purpose: "subagent", parentId: trace.id, conversationKey: "baseline:conversation" })
  const childCall = modelLogStore.beginModelCall({
    trace: childTrace,
    event,
    source: "subagent",
    purpose: "subagent",
    channel: { name: "baseline-child", type: "mock", model: "baseline-child", provider: { name: "baseline-provider" }, modelConfig: { name: "baseline-child" } },
    messages: [{ role: "user", content: "子任务" }],
    parentToolId: "baseline-tool-call",
  })
  modelLogStore.completeModelCall(childCall, { response: { text: "子任务完成", usage: { input: 1, output: 1, total: 2, source: "reported" } } })
  modelLogStore.finishTrace(childTrace, { status: "ok", response: "子任务完成" })
  assert.equal(await modelLogStore.flush(true), true, `model log queue must flush to the baseline schema: ${modelLogStore.lastError}`)
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM ai_runs WHERE source='baseline-test'"))?.total, 1, "one model trace must create one run")
  assert.deepEqual(
    await sqliteClient.get("SELECT tool_name, round, call_index, status, requires_final_reply, result_text FROM tool_call_events WHERE run_id=?", [trace.id]),
    { tool_name: "baseline_tool", round: 1, call_index: 1, status: "ok", requires_final_reply: 1, result_text: "找到 1 条结果" },
    "tool event must persist the round, status, reply policy, and readable result",
  )
  const toolArguments = await sqliteClient.get("SELECT arguments_json FROM tool_call_events WHERE run_id=?", [trace.id])
  assert(toolArguments.arguments_json.includes("咖啡") && !toolArguments.arguments_json.includes("integration-secret"), "tool event arguments must keep useful values and redact environment credentials")
  const runDetail = await modelLogStore.getRun(trace.id)
  assert.equal(runDetail.run.response_text, "完成", "run detail must expose the final model response")
  assert.equal(runDetail.modelCalls[0]?.response_text, "完成", "model detail must expose the model response")
  assert.equal(runDetail.modelCalls[0]?.available_models[0]?.id, "baseline-chat", "model detail must expose available route models")
  assert.equal(runDetail.modelCalls[0]?.actual_model?.id, "baseline-chat", "model detail must expose the actual route model")
  assert.equal(runDetail.modelCalls[0]?.route?.phase, "initial", "model detail must expose the route phase")
  assert.equal(runDetail.toolCalls[0]?.tool_name, "baseline_tool", "run detail must expose persisted tool events")
  assert.equal(runDetail.childRuns[0]?.parent_run_id, trace.id, "run detail must expose child runs through parent lineage")
  const childDetail = await modelLogStore.getRun(childTrace.id)
  assert.equal(childDetail.modelCalls[0]?.parent_tool_id, "baseline-tool-call", "child model calls must retain their parent tool relationship")
  assert.deepEqual(runDetail.toolCalls[0]?.arguments, { query: "咖啡", env: { API_KEY: "<redacted>", REGION: "cn" } }, "run detail must parse tool arguments for the UI")
  const callDetail = await modelLogStore.getModelCallDetail(call.id)
  assert.equal(callDetail.snapshot.message_count, 1, "model request detail must expose the captured context count")
  assert.equal(callDetail.snapshot.messages[0].content, "测试模型日志", "model request detail must expose the captured context")
  assert.equal(callDetail.snapshot.tools.length, 0, "model request detail must expose the injected tool list separately")
  const conversationDetail = await modelLogStore.getConversation(trace.id)
  assert.equal(conversationDetail.items.length, 1, "conversation detail must index top-level turns by conversation key")
  assert.equal(conversationDetail.session.key, "baseline:conversation", "conversation detail must expose a stable internal session key separately from the turn list")
  assert.equal(conversationDetail.session.turn_count, 1, "conversation detail must expose the retained turn count")
  assert.equal(conversationDetail.items[0].prompt_text, "基线会话提问", "conversation detail must expose the redacted turn prompt")
  assert.deepEqual(conversationDetail.items[0].model_call_ids, [call.id], "conversation detail must link each turn to its model calls")
  assert.deepEqual(await sqliteClient.get("SELECT calls, input_tokens, output_tokens, total_tokens FROM ai_usage_daily WHERE model_name=? AND purpose=?", ["baseline-chat", "reply"]), { calls: 1, input_tokens: 2, output_tokens: 3, total_tokens: 5 }, "terminal model calls must roll up through the database trigger")
  const toolCleanup = await modelLogStore.cleanup({ filters: { source: "baseline-test" } })
  assert.equal(toolCleanup.toolCalls, 1, "log cleanup must count tool events with their parent run")
  assert.equal(await modelLogStore.getRun(trace.id), null, "log cleanup must remove tool events with their parent run")

  adapterRegistry.register({
    id: "baseline-embedding",
    supportsEmbeddings: true,
    async embedTexts({ texts }) { return { vectors: texts.map(text => String(text).includes("低相关测试") ? [0, 1] : [1, 0]), dimensions: 2, usage: { input: 4, output: 0, total: 4, source: "reported" } } },
  })
  if (sqliteClient.status.vector?.available) {
    await configStore.update(config => {
      config.memory.retrieval.embeddingModel = "baseline-embedding"
      config.memory.retrieval.embeddingDimensions = 2
      config.memory.retrieval.adaptiveVector = true
    })
    await vectorRecall.syncMemoryVectors()
    const vectorOnlyResults = await memoryStore.search(mentionEvent, "她以前有哪些个人经历", 3)
    assert(vectorOnlyResults.some(item => item.id === targetFact.id), "vector recall should search a mentioned member's memory scope when FTS has no hit")
    const lowSimilarityResults = await memoryStore.search(mentionEvent, "低相关测试：她以前有哪些个人经历", 3)
    assert(!lowSimilarityResults.some(item => item.id === targetFact.id), "vector recall should reject semantically low-similarity target memories")
  }
  const embeddingBudgetBefore = Number((await sqliteClient.get("SELECT calls FROM embedding_budget_daily WHERE model_name=? AND purpose=?", ["baseline-embedding", "embedding_memory"]))?.calls || 0)
  await embeddingRunner.embedTexts({ modelName: "baseline-embedding", texts: ["预算测试"], dimensions: 2, purpose: "embedding_memory" })
  assert.equal((await sqliteClient.get("SELECT calls FROM embedding_budget_daily WHERE model_name=? AND purpose=?", ["baseline-embedding", "embedding_memory"]))?.calls, embeddingBudgetBefore + 1, "embedding budget must persist independently from aggregate logs")

  if (sqliteClient.status.vector?.available) {
    const space = await vectorIndex.ensureSpace({ modelName: "baseline-vector", dimensions: 2, scopeKey: "integration" })
    await vectorIndex.upsert(space, { ownerType: "knowledge_chunk", ownerId: "baseline-chunk", contentHash: "baseline", vector: [1, 0] })
    assert.equal((await vectorIndex.search(space, [1, 0], 5))[0]?.ownerId, "baseline-chunk", "vector metadata and per-space vector table must remain linked")
    await vectorIndex.deleteSpace(space.id)
  }

  await sqliteClient.run("INSERT INTO capability_rules(id, subject_type, subject_id, group_id, resource_type, resource_id, effect, created_at, updated_at) VALUES('baseline-backup-rule', 'user', 'baseline-user', '', 'tool', 'weather', 'deny', ?, ?)", [Date.now(), Date.now()])
  const backup = await createConfigBackup()
  await sqliteClient.run("UPDATE capability_rules SET effect='allow' WHERE id='baseline-backup-rule'")
  await restoreConfigBackup(backup.fileName)
  assert.equal((await sqliteClient.get("SELECT effect FROM capability_rules WHERE id='baseline-backup-rule'"))?.effect, "deny", "configuration backup must restore whitelisted baseline settings")

  assert.equal(await knowledgeRepository.deleteBase(base.id), true, "deleting a knowledge base must remove its documents and FTS projection")
  assert.equal((await sqliteClient.get("SELECT COUNT(*) AS total FROM knowledge_fts WHERE knowledge_base_id=?", [base.id]))?.total, 0, "knowledge FTS rows must not outlive their base")
  console.log("ok sqlite-integration")
} finally {
  knowledgeIndexJobs?.stop()
  await groupCaptureStore?.stop({ flush: true }).catch(() => {})
  await modelLogStore?.stop({ flush: true }).catch(() => {})
  await sqliteClient?.close().catch(() => {})
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
