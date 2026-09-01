import assert from "node:assert/strict"

const { MessageChainBuilder } = await import("../output/typescript/core/message-chain/index.js")
const { normalizeModelResponse, normalizeModelStopReason } = await import("../output/typescript/models/protocol/index.js")
const { createAgentTurnState } = await import("../output/typescript/core/chat/agent-turn-state.js")
const { buildAgentLoopContinuationMessages } = await import("../output/typescript/core/chat/chat-support.js")
const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
const { SqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js")
const { defaults } = await import("../output/runtime/config/defaults.js")
const { schemaManifest } = await import("../output/runtime/config/schema.js")
const { replaceWithSafeRegex } = await import("../output/runtime/core/shared/safe-regex.js")
const { contentToText, normalizeListedModels, tokenUsage } = await import("../output/runtime/models/adapters/base.js")
const { MockAdapter } = await import("../output/runtime/models/adapters/mock.js")
const { OpenAICompatibleAdapter } = await import("../output/runtime/models/adapters/openai-compatible.js")
const { GeminiAdapter } = await import("../output/runtime/models/adapters/gemini.js")
const { ClaudeAdapter } = await import("../output/runtime/models/adapters/claude.js")
const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
const { buildReasoningPayload } = await import("../output/runtime/models/configuration/reasoning.js")

assert.equal(defaults.context.recentMessageCount, 20)
assert.equal(schemaManifest.summary.tabs > 0, true)
assert.equal(contentToText([{ type: "text", text: "模型" }]), "模型")
assert.equal(normalizeListedModels([{ id: "models/smoke" }])[0]?.id, "smoke")
assert.equal(tokenUsage({ usage: { prompt_tokens: 2, completion_tokens: 3 } }).total, 5)
assert.equal((await new MockAdapter().listModels()).length, 3)
assert.equal(new OpenAICompatibleAdapter().supportsStreaming, true)
assert.equal(new GeminiAdapter().supportsEmbeddings, true)
assert.equal(new ClaudeAdapter().supportsTools, true)
assert.equal(adapterRegistry.listAdapters().length, 6)
assert.equal(buildReasoningPayload({ type: "openai-compatible", model: "gpt-5", reasoning: { effort: "medium" } })?.reasoning?.effort, "medium")
assert.equal(await replaceWithSafeRegex("a1", "\\d", "x"), "ax")

const chain = new MessageChainBuilder()
  .text("结果：")
  .mention(42)
  .image({ kind: "url", value: "https://example.com/a.png", mimeType: "image/png" })

assert.equal(chain.length, 3)
assert.equal(chain.hasMedia(), true)
assert.equal(chain.buildOutbound()?.length, 3)

const { enforcePromptBudgetDetailed, estimateTokens } = await import("../output/runtime/core/chat/token-budget.js")

// 未超窗口时原样返回，不做任何压缩。
const smallPrompt = enforcePromptBudgetDetailed([
  { role: "system", content: "系统" },
  { role: "user", content: "你好" },
], { chat: { inputTokenBudget: 6000 } })
assert.equal(smallPrompt.compressed, false)
assert.equal(smallPrompt.messages.length, 2)

// 超窗口时压缩，且同批次的 assistant/tool 配对不能被拆散。
const bulky = "详细内容".repeat(4000)
const compressed = enforcePromptBudgetDetailed([
  { role: "system", content: "系统" },
  { role: "assistant", content: "", tool_calls: [{ id: "call-a", function: { name: "search", arguments: bulky } }, { id: "call-b", function: { name: "fetch", arguments: bulky } }] },
  { role: "tool", tool_call_id: "call-a", name: "search", content: bulky },
  { role: "tool", tool_call_id: "call-b", name: "fetch", content: bulky },
  { role: "user", content: "继续" },
], { chat: { inputTokenBudget: 2000 } })
assert.equal(compressed.compressed, true)
assert.equal(compressed.after < compressed.before, true)
const keptCallIds = compressed.messages.filter(item => item.role === "tool").map(item => item.tool_call_id).sort()
const declaredCallIds = compressed.messages.flatMap(item => (item.tool_calls || []).map(call => call.id)).sort()
assert.deepEqual(keptCallIds, declaredCallIds)
assert.equal(compressed.messages.at(-1)?.content, "继续")
assert.equal(compressed.messages[0]?.content, "系统")

// 模型声明的上下文窗口优先于全局预算：大窗口下大工具结果不压缩，输出预留从窗口中扣除。
const bulkyUser = { role: "user", content: "a".repeat(40000) }
const windowed = enforcePromptBudgetDetailed([
  { role: "system", content: "系统" },
  bulkyUser,
], { chat: { inputTokenBudget: 2000 } }, { channel: { modelConfig: { contextWindowTokens: 128000 } }, maxTokens: 1024 })
assert.equal(windowed.compressed, false)
assert.equal(windowed.limit, 128000 - 1024 - 200)
assert.equal(windowed.messages.length, 2)

// 未声明窗口时回落全局输入预算，同样扣除输出预留与安全边际。
const fallback = enforcePromptBudgetDetailed([
  { role: "system", content: "系统" },
  bulkyUser,
], { chat: { inputTokenBudget: 2000 } }, { maxTokens: 1024 })
assert.equal(fallback.compressed, true)
assert.equal(fallback.limit, 2000 - 1024 - 200)

// 孤立任务（记忆提炼等）不传 options：只有全局预算兜底，显式输出上限不参与。
const isolated = enforcePromptBudgetDetailed([
  { role: "system", content: "系统" },
  { role: "user", content: "你好" },
], {})
assert.equal(isolated.compressed, false)
assert.equal(isolated.limit, 5800)

const modelResponse = normalizeModelResponse({
  id: "response-1",
  content: "需要调用工具",
  tool_calls: [{ id: "call-1", function: { name: "search", arguments: '{"q":"猫"}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
})
assert.equal(modelResponse.text, "需要调用工具")
assert.equal(modelResponse.toolCalls[0]?.name, "search")
assert.equal(modelResponse.toolCalls[0]?.arguments.q, "猫")
assert.equal(modelResponse.stopReason, "tool_calls")
assert.equal(modelResponse.usage.total, 14)
assert.equal(normalizeModelStopReason("end_turn"), "end_turn")
assert.equal(normalizeModelStopReason("MAX_TOKENS"), "max_tokens")
assert.equal(normalizeModelStopReason("max_tokens", 1), "max_tokens")
assert.equal(normalizeModelStopReason("pause_turn", 1), "pause_turn")
assert.equal(normalizeModelStopReason("refusal", 1), "refusal")

const visualMessage = {
  role: "user",
  content: [
    { type: "text", text: "看看这张图" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ],
}
const continuedVisualMessage = buildAgentLoopContinuationMessages([visualMessage])[0]
assert.equal(Array.isArray(continuedVisualMessage.content), true)
assert.equal(continuedVisualMessage.content[0]?.type, "text")
assert.equal(continuedVisualMessage.content[2]?.image_url?.url, "data:image/png;base64,AAAA")
assert.equal(estimateTokens(continuedVisualMessage.content[0]?.text) < 60, true)

const agentTurn = createAgentTurnState()
agentTurn.observeModel("tool_calls")
agentTurn.beginToolExecution()
agentTurn.requestFinalReply(true)
agentTurn.beginModelDecision()
agentTurn.observeModel("end_turn")
assert.equal(agentTurn.state.finalReplyRequired, true)
assert.equal(agentTurn.beginEmptyFinalRecovery(), true)
assert.equal(agentTurn.beginEmptyFinalRecovery(), false)
agentTurn.complete(false)
assert.deepEqual(agentTurn.summary(), {
  phase: "completed",
  lastStopReason: "end_turn",
  finalReplyRequired: true,
  emptyFinalRecoveryCount: 1,
  finalizationReason: "EMPTY_FINAL_RESPONSE",
})

let runtimeConfigRow = {
  schema_version: 1,
  revision: 0,
  overrides_json: "{}",
  updated_at: 0,
}
const runtimeConfigClient = {
  async get() {
    return runtimeConfigRow.revision ? runtimeConfigRow : undefined
  },
  async run(_sql, params) {
    runtimeConfigRow = {
      schema_version: 1,
      revision: runtimeConfigRow.revision + 1,
      overrides_json: String(params[0]),
      updated_at: Number(params[1]),
    }
    return {}
  },
}
const runtimeConfigRepository = new SqliteRuntimeConfigRepository(runtimeConfigClient)
assert.equal((await runtimeConfigRepository.load()).exists, false)
const savedConfig = await runtimeConfigRepository.save({ chat: { maxToolRounds: 4 } })
assert.equal(savedConfig.overrides.chat.maxToolRounds, 4)

class FakeSqliteWorker {
  listeners = new Map()

  constructor() {
    queueMicrotask(() => this.emit("message", {
      type: "ready",
      result: { vector: { available: true, error: "" }, migrations: ["001-baseline.sql"], integrity: "ok" },
    }))
  }

  once(event, listener) {
    const entries = this.listeners.get(event) || []
    entries.push({ listener, once: true })
    this.listeners.set(event, entries)
  }

  on(event, listener) {
    const entries = this.listeners.get(event) || []
    entries.push({ listener, once: false })
    this.listeners.set(event, entries)
  }

  emit(event, value) {
    const entries = this.listeners.get(event) || []
    this.listeners.set(event, entries.filter(entry => !entry.once))
    for (const entry of entries) entry.listener(value)
  }

  postMessage(message) {
    queueMicrotask(() => this.emit("message", {
      id: message.id,
      result: message.kind === "get" ? { value: 1 } : message.kind === "close" ? { ok: true } : [],
    }))
  }

  async terminate() {
    this.emit("exit", 0)
    return 0
  }
}

let workerData
let workerExecArgv
const sqliteClient = new SqliteClient({
  dataDir: "/tmp/yui-chat",
  workerUrl: "worker.js",
  createWorker: (_url, options) => {
    workerData = options.workerData
    workerExecArgv = options.execArgv
    return new FakeSqliteWorker()
  },
  joinPath: (...parts) => parts.join("/"),
  execArgv: ["--input-type=module", "--max-old-space-size=3072"],
})
const sqliteStatus = await sqliteClient.init({ storage: { sqlite: { enabled: true } } })
assert.equal(sqliteStatus.available, true)
assert.equal(workerData.stateFile, "/tmp/yui-chat/storage/state.sqlite3")
assert.deepEqual(workerExecArgv, [])
assert.equal((await sqliteClient.get("SELECT 1")).value, 1)
await sqliteClient.close()

console.log("TypeScript runtime smoke: ok")
