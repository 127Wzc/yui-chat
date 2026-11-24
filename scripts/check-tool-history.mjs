import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-tool-history-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.chdir(path.resolve(root, "../.."))
const warnings = []
global.logger = { mark() {}, info() {}, warn: (...args) => warnings.push(args.join(" ")), error() {}, debug() {}, blue: v => v, cyan: v => v, red: v => v }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = { image: value => ({ type: "image", value }) }
global.plugin = class {}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check, label) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return
    await sleep(10)
  }
  assert.fail(label)
}
function assertPairs(messages) {
  const calls = messages.flatMap(message => message.toolCalls || message.tool_calls || [])
  const results = messages.filter(message => message.role === "tool")
  assert.equal(new Set(calls.map(call => call.id)).size, calls.length)
  for (const call of calls) assert.equal(results.filter(result => (result.toolCallId || result.tool_call_id) === call.id).length, 1)
  for (const result of results) assert(calls.some(call => call.id === (result.toolCallId || result.tool_call_id)))
}

let sqliteClient, modelLogStore
try {
  const { configStore } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  assert.equal((await sqliteClient.init()).available, true)
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { backgroundTaskService } = await import("../output/runtime/core/scheduling/background-task-service.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const { conversationStore } = await import("../output/runtime/core/chat/conversation-store.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { providerResolver } = await import("../output/runtime/models/routing/provider-resolver.js")
  const { enforcePromptBudgetDetailed } = await import("../output/runtime/core/chat/token-budget.js")
  const { buildReplyPayload } = await import("../output/runtime/core/chat/response-pipeline.js")
  const { toolHistoryText } = await import("../output/runtime/core/chat/tool-history.js")
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  const config = structuredClone(defaults)
  config.tools.enabled = true
  config.tools.policy.allowCustomTools = true
  config.tools.promptSelection.enabled = false
  config.modelTasks.replyer.maxTokens = 512
  config.chat.inputTokenBudget = 16000
  config.chat.execution.background = { enabled: true, maxConcurrent: 4, maxQueue: 10 }
  configStore.get = () => config
  configStore.load = async () => structuredClone(config)
  const channel = { id: "history-check", type: "history-check", model: "mock", modelConfig: { toolUse: true, contextWindowTokens: 32000 }, timeoutMs: 1000 }
  providerResolver.resolve = async () => channel
  providerResolver.resolveCandidateChannels = () => [channel]
  let scenario, sequence = 0
  function setup({ backgroundSilent = false, background = false, finalReply = true, terminal = "已处理。", execute, queue } = {}) {
    const gate = deferred()
    const id = `case-${++sequence}`
    const marker = `ACTUAL_RESULT_${id}`
    scenario = { id, marker, gate, terminal, requests: [], invoke: true }
    const local = scenario
    config.tools.enabledTools = ["history_tool"]
    toolRegistry.tools.clear()
    toolRegistry.register({ name: "history_tool", source: "custom", category: "test", description: "Perform the requested action", requiresFinalReply: finalReply,
      parameters: { type: "object", properties: { token: { type: "string" } } },
      execution: { effect: "non_idempotent", repeatPolicy: "dedupe", retryPolicy: "none", backgroundSilent, background, timeoutMs: 1000 },
      ...(queue ? { backgroundQueue: queue } : {}),
      async execute(args) {
        if (backgroundSilent || background) await gate.promise
        if (execute) return execute(marker, args)
        return { status: "success", content: `${"前文".repeat(200)}\n${marker}\ntoken=RESULT_SECRET`, retryAllowed: false }
      },
    })
    adapterRegistry.register({ id: channel.type, protocol: "responses", supportsTools: true, supportsVision: false, supportsStreaming: false,
      async sendMessage(request) {
        local.requests.push(structuredClone(request.messages))
        assertPairs(request.messages)
        if (local.invoke && local.requests.length === 1) return { id, text: "", toolCalls: local.calls || [{ id: "reused-call-id", name: "history_tool", arguments: { token: "ARGUMENT_SECRET" } }], usage: { input: 2, output: 1, total: 3 } }
        await local.beforeReply?.()
        return { id: `${id}-final`, upstreamResponseId: `resp_${id}`, text: local.terminal, toolCalls: [], usage: { input: 2, output: 1, total: 3 } }
      },
    })
    local.e = { isGroup: true, isMaster: true, group_id: "history-group", user_id: id, sender: { role: "owner" } }
    return local
  }
  const send = (local, prompt = "执行这个动作", extra = {}) => chatService.send(local.e, prompt, { channelId: channel.id, source: "tool-history-check", applyInputFilters: false, ...extra })
  const load = local => conversationStore.get(`${channel.id}:g:history-group:${local.id}`)
  const toolTrace = stored => stored?.turns[0]?.toolChain[0]
  async function checkFollowup(local, expected) {
    local.invoke = false
    const before = local.requests.length
    await send(local, "刚才实际执行的结果是什么")
    const request = local.requests[before]
    assertPairs(request)
    assert(JSON.stringify(request).includes(expected), "later model input must include actual execution facts")
    assert(!JSON.stringify(request).includes("RESULT_SECRET"))
    assert(!JSON.stringify(request).includes("ARGUMENT_SECRET"))
  }

  for (const finalReply of [false, true]) {
    const local = setup({ finalReply })
    const result = await send(local)
    const stored = await load(local)
    assert.equal(result.text, finalReply ? "已处理。" : "")
    assert.equal(stored.turns.length, 1)
    assert.equal(stored.toolCalls, 1)
    assert(stored.usage.total > 0)
    assert(toolTrace(stored).result.includes(local.marker), "preserve more than the 300-character preview")
    assertPairs(stored.history)
    assert(stored.history.some(message => message.role === "tool" && message.content.includes(local.marker)))
    assert(!stored.history.some(message => message.content === "<EMPTY>"))
    const listing = chatService.listConversations().find(item => item.userId === local.id)
    assert.equal(listing.turns, 1)
    assert.equal(listing.historyMessages, finalReply ? 2 : 1)
    chatService.conversations.clear() // Subsequent context must also work after a cache loss/restart.
    await checkFollowup(local, local.marker)
  }

  // A pure <EMPTY> still creates no conversation turn, reply, or memory input.
  const empty = setup({ terminal: "<EMPTY>" })
  empty.invoke = false
  const emptyResult = await send(empty)
  const emptyStored = await load(empty)
  assert.equal(emptyResult.text, "")
  assert.deepEqual(emptyStored.history, [])
  assert.deepEqual(emptyStored.turns, [])
  assert.equal((await buildReplyPayload("<EMPTY>", config)).empty, true)
  const emptyWithTool = setup({ terminal: "<EMPTY>" })
  await send(emptyWithTool)
  assert((await load(emptyWithTool)).history.some(message => message.role === "tool"))
  assert(!(await load(emptyWithTool)).history.some(message => message.role === "assistant" && message.content === "<EMPTY>"))

  for (const kind of ["silent", "ordinary", "failed", "structured-failed", "partial", "timeout"]) {
    const local = setup({ backgroundSilent: kind !== "ordinary" && kind !== "partial", background: kind === "ordinary" || kind === "partial",
      execute: kind === "failed" ? () => { throw new Error("actual background failure") }
        : kind === "structured-failed" ? () => ({ status: "failed", content: "actual structured failure", isError: true })
          : kind === "partial" ? () => ({ status: "partial", content: "one item sent; second item failed" }) : undefined,
    })
    const result = await send(local)
    assert.equal(toolTrace(await load(local)).status, "accepted")
    const taskId = result.toolChain[0].metadata.taskId
    const expected = kind === "failed" ? "actual background failure" : kind === "structured-failed" ? "actual structured failure"
      : kind === "partial" ? "second item failed" : kind === "timeout" ? "超时" : local.marker
    if (kind !== "timeout") local.gate.resolve()
    await eventually(async () => toolTrace(await load(local))?.status !== "accepted", `${kind} completion was not saved`)
    const stored = await load(local)
    assert(toolTrace(stored).result.includes(expected))
    assert(stored.history.find(message => message.role === "tool").content.includes(expected))
    assert.equal(toolTrace(stored).status, ["failed", "structured-failed", "timeout"].includes(kind) ? "error" : kind === "partial" ? "partial" : "ok")
    assert.equal(backgroundTaskService.get(taskId).status, ["failed", "structured-failed", "timeout"].includes(kind) ? "error" : "ok")
    assertPairs(stored.history)
    await checkFollowup(local, expected)
    local.gate.resolve()
  }

  // A fast background result can arrive before the initial conversation commit.
  const early = setup({ backgroundSilent: true })
  early.gate.resolve()
  await send(early)
  await eventually(async () => toolTrace(await load(early))?.status === "ok", "early completion was lost")
  await checkFollowup(early, early.marker)

  const parallel = setup({ backgroundSilent: true, execute: (marker, args) => ({ status: "success", content: `${marker}_${args.label}` }) })
  parallel.calls = ["a", "b"].map(label => ({ id: `parallel-${label}`, name: "history_tool", arguments: { label } }))
  await send(parallel)
  parallel.gate.resolve()
  await eventually(async () => (await load(parallel))?.turns[0].toolChain.every(trace => trace.status === "ok"), "concurrent completions lost an update")
  assert((await load(parallel)).history.some(message => message.role === "tool" && message.content.includes(`${parallel.marker}_a`)))
  assert((await load(parallel)).history.some(message => message.role === "tool" && message.content.includes(`${parallel.marker}_b`)))
  await checkFollowup(parallel, `${parallel.marker}_a`)

  // The same tool and supplier call ID in consecutive turns must survive reverse completion.
  const firstTask = deferred(), secondTask = deferred()
  const consecutive = setup({ backgroundSilent: true, execute: (marker, args) =>
    (args.label === "first" ? firstTask : secondTask).promise.then(() => ({ status: "success", content: `${marker}_${args.label}`, executedCount: 1, retryAllowed: false })),
  })
  consecutive.calls = [{ id: "reused-call-id", name: "history_tool", arguments: { label: "first" } }]
  const firstResult = await send(consecutive, "启动第一个任务")
  consecutive.requests.length = 0
  consecutive.calls = [{ id: "reused-call-id", name: "history_tool", arguments: { label: "second" } }]
  const secondResult = await send(consecutive, "启动第二个任务")
  assert.notEqual(firstResult.toolChain[0].metadata.taskId, secondResult.toolChain[0].metadata.taskId)
  consecutive.gate.resolve()
  secondTask.resolve()
  await eventually(async () => (await load(consecutive))?.turns[1].toolChain[0].status === "ok", "second task did not finish first")
  assert.equal((await load(consecutive)).turns[0].toolChain[0].status, "accepted")
  firstTask.resolve()
  await eventually(async () => (await load(consecutive))?.turns[0].toolChain[0].status === "ok", "first task did not finish")
  const consecutiveStored = await load(consecutive)
  for (const [index, label] of ["first", "second"].entries()) {
    const turn = consecutiveStored.turns[index]
    const trace = turn.toolChain[0]
    assert.equal(trace.result, JSON.stringify({ status: "success", content: `${consecutive.marker}_${label}`, executedCount: 1, retryAllowed: false }))
    assert.equal(trace.executedCount, 1)
    assert.equal(trace.completedCount, 1)
    assert.equal(trace.remainingCount, 0)
    assert.equal(trace.retryAllowed, false)
    const receipt = consecutiveStored.history.find(message => message.role === "tool" && message.metadata.turnId === turn.id)
    assert.equal(JSON.parse(receipt.content).remainingCount, 0)
    assert(receipt.content.includes(`${consecutive.marker}_${label}`))
  }
  assertPairs(consecutiveStored.history)

  // A failed model continuation must not discard tools that already ran.
  for (const backgroundSilent of [false, true]) {
    const failedModel = setup({ backgroundSilent, execute: marker => ({ status: "success", content: marker, executedCount: 1 }) })
    failedModel.beforeReply = () => { throw new Error("injected model continuation failure") }
    await assert.rejects(send(failedModel), /injected model continuation failure/)
    const saved = await load(failedModel)
    assert.equal(saved.turns.length, 1)
    assert.equal(saved.turns[0].adapter, channel.type)
    assert.equal(saved.turns[0].channel, channel.id)
    assert.equal(saved.history.filter(message => message.role === "assistant" && message.content).length, 0)
    if (backgroundSilent) failedModel.gate.resolve()
    await eventually(async () => toolTrace(await load(failedModel))?.status === "ok", "model failure lost the tool completion")
    failedModel.beforeReply = undefined
    await checkFollowup(failedModel, failedModel.marker)
  }

  // A successful fallback must retain the failed channel's already accepted task.
  const fallback = setup({ backgroundSilent: true })
  fallback.beforeReply = () => { throw new Error("injected first-channel failure") }
  const originalCandidates = providerResolver.resolveCandidateChannels
  const originalStrategy = config.modelTasks.replyer.selectionStrategy
  const fallbackChannel = { ...channel, id: "history-fallback", type: "history-fallback" }
  config.modelTasks.replyer.selectionStrategy = "fallback"
  providerResolver.resolveCandidateChannels = () => [channel, fallbackChannel]
  adapterRegistry.register({ id: fallbackChannel.type, supportsTools: true, supportsVision: false, supportsStreaming: false,
    async sendMessage() { return { id: "fallback-answer", text: "备用渠道已回复。", toolCalls: [], usage: { input: 2, output: 1, total: 3 } } },
  })
  const fallbackResult = await send(fallback)
  assert.equal(fallbackResult.text, "备用渠道已回复。")
  assert.equal(fallbackResult.toolChain.length, 1)
  fallback.gate.resolve()
  await eventually(async () => toolTrace(await load(fallback))?.status === "ok", "fallback discarded the accepted task")
  providerResolver.resolveCandidateChannels = originalCandidates
  config.modelTasks.replyer.selectionStrategy = originalStrategy

  for (const completesEarly of [false, true]) {
    const counted = setup({ backgroundSilent: true, execute: marker => ({ status: "partial", content: marker, executedCount: 1, retryAllowed: false }) })
    Object.assign(toolRegistry.get("history_tool").common.execution, { supportsCount: true, countField: "count", maxCount: 5 })
    counted.calls = [{ id: "counted-call", name: "history_tool", arguments: { count: 3 } }]
    if (completesEarly) counted.gate.resolve()
    await send(counted)
    counted.gate.resolve()
    await eventually(async () => toolTrace(await load(counted))?.status === "partial", "partial count was not saved")
    const countedTrace = toolTrace(await load(counted))
    assert.equal(countedTrace.requestedCount, 3)
    assert.equal(countedTrace.executedCount, 1)
    assert.equal(countedTrace.completedCount, 1)
    assert.equal(countedTrace.remainingCount, 2)
    assert.equal(countedTrace.retryAllowed, false)
  }

  // Counted tools require structured results in the foreground and in both background modes.
  for (const mode of ["foreground", "silent", "ordinary"]) {
    const counted = setup({ backgroundSilent: mode === "silent", background: mode === "ordinary", execute: () => "done" })
    Object.assign(toolRegistry.get("history_tool").common.execution, { supportsCount: true, countField: "count", maxCount: 5 })
    counted.calls = [{ id: "count-contract", name: "history_tool", arguments: { count: 3 } }]
    await send(counted)
    counted.gate.resolve()
    await eventually(async () => toolTrace(await load(counted))?.status === "failed", `${mode} accepted an unstructured count`)
    const trace = toolTrace(await load(counted))
    assert.equal(trace.executedCount, 0)
    assert.equal(trace.completedCount, 0)
    assert.equal(trace.remainingCount, 3)
    assert(JSON.stringify(trace).includes("工具未返回结构化执行结果"))
  }

  // Explicit per-target counts and the planned count cap follow the same execution rules.
  for (const backgroundSilent of [false, true]) {
    for (const partial of [false, true]) {
      const counted = setup({ backgroundSilent, execute: marker => ({ status: partial ? "partial" : "success", content: marker,
        executedCount: partial ? 1 : 9, ...(partial ? { targetCounts: { "qqs:a": 1, "qqs:b": 0 } } : {}), retryAllowed: false,
      }) })
      Object.assign(toolRegistry.get("history_tool").common.execution, { supportsCount: true, countField: "count", maxCount: 5, targetFields: ["qqs"] })
      counted.calls = [{ id: "count-progress", name: "history_tool", arguments: partial ? { qqs: ["a", "b"], count: 1 } : { qqs: ["a"], count: 3 } }]
      await send(counted)
      counted.gate.resolve()
      await eventually(async () => toolTrace(await load(counted))?.status === (partial ? "partial" : "ok"), "count outcome was not saved")
      const trace = toolTrace(await load(counted))
      assert.equal(trace.executedCount, partial ? 1 : 3)
      assert.equal(trace.completedCount, partial ? 1 : 3)
      assert.equal(trace.remainingCount, partial ? 1 : 0)
    }
  }

  // Canonical delivery receipts retain semantic sent/partial/failed states and counts.
  for (const receiptStatus of ["sent", "partial", "failed"]) {
    const local = setup({ backgroundSilent: true, execute: marker => ({ status: "success", content: marker,
      metadata: { messageSendPlan: { parts: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } },
    }) })
    toolRegistry.get("history_tool").common.autoDelivery = { via: "message_send", batching: "merge", continueConversation: false }
    config.tools.enabledTools.push("message_send")
    const sentCount = receiptStatus === "sent" ? 2 : receiptStatus === "partial" ? 1 : 0
    toolRegistry.register({ name: "message_send", source: "builtin", category: "media", description: "Deliver parts",
      parameters: { type: "object", properties: {} }, execution: { effect: "non_idempotent", retryPolicy: "none", maxAttempts: 1 },
      async execute() { return { kind: receiptStatus === "failed" ? "error" : "delivery", chain: [{ type: "text", text: "actual content" }],
        isError: receiptStatus === "failed", receipt: { id: `actual-${receiptStatus}`, status: receiptStatus, partCount: 2, sentCount, failedCount: 2 - sentCount }, metadata: {},
      } },
    })
    await send(local)
    local.gate.resolve()
    const expected = receiptStatus === "sent" ? "ok" : receiptStatus === "partial" ? "partial" : "error"
    await eventually(async () => toolTrace(await load(local))?.status === expected, `${receiptStatus} receipt was not saved accurately`)
    const trace = toolTrace(await load(local))
    assert.equal(trace.metadata.receiptStatus, receiptStatus)
    assert.equal(trace.metadata.receiptSentCount, sentCount)
    assert.equal(trace.metadata.receiptFailedCount, 2 - sentCount)
    assert(trace.result.includes(local.marker))
    const completionLog = [...modelLogStore.memoryTools.values()].find(row => row.tool_call_id === trace.metadata.taskId)
    assert.equal(completionLog.status, expected)
    assert.equal(JSON.parse(completionLog.metadata_json).receiptStatus, receiptStatus)
    await checkFollowup(local, local.marker)
  }

  // A background media plan must retain its selected resource and actual failed receipt.
  for (const backgroundSilent of [false, true]) {
    const directPartial = setup({ backgroundSilent, background: !backgroundSilent, execute: () => ({
      kind: "delivery", chain: [{ type: "text", text: "first sent" }], isError: false,
      receipt: { id: "direct-partial", status: "partial", partCount: 2, sentCount: 1, failedCount: 1 }, metadata: {},
    }) })
    await send(directPartial)
    directPartial.gate.resolve()
    await eventually(async () => toolTrace(await load(directPartial))?.status === "partial", "direct canonical background delivery lost partial status")
    assert.equal(toolTrace(await load(directPartial)).metadata.receiptStatus, "partial")
  }

  // A failed automatic plan retains both its selected resource and failed delivery output.
  const failedDelivery = setup({ backgroundSilent: true, execute: marker => ({ status: "success", content: marker,
    metadata: { messageSendPlan: { parts: [{ type: "image", source: { kind: "url", value: "https://example.com/selected.png" } }] } },
  }) })
  toolRegistry.get("history_tool").common.autoDelivery = { via: "message_send", batching: "merge", continueConversation: false }
  config.tools.enabledTools.push("message_send")
  toolRegistry.register({ name: "message_send", source: "builtin", category: "media", description: "Deliver a message",
    parameters: { type: "object", properties: {} }, execution: { effect: "non_idempotent", retryPolicy: "none", maxAttempts: 1 },
    async execute() { return { status: "failed", content: "actual host delivery error", isError: true, retryAllowed: false } },
  })
  await send(failedDelivery)
  failedDelivery.gate.resolve()
  await eventually(async () => toolTrace(await load(failedDelivery))?.status === "error", "failed media delivery was not saved")
  const failedDeliveryTrace = toolTrace(await load(failedDelivery))
  assert(failedDeliveryTrace.result.includes(failedDelivery.marker))
  assert(failedDeliveryTrace.result.includes("actual host delivery error"))
  assert(failedDeliveryTrace.result.includes("selected.png"))
  await checkFollowup(failedDelivery, "actual host delivery error")

  // Write failures retry the pending patch against committed SQLite state.
  const retry = setup({ backgroundSilent: true })
  await send(retry)
  const originalSave = conversationStore.save
  let writes = 0
  conversationStore.save = async input => {
    if (input.history.some(message => message.role === "tool" && message.content.includes(retry.marker)) && writes++ === 0) throw new Error("injected background write failure")
    return originalSave.call(conversationStore, input)
  }
  retry.gate.resolve()
  await eventually(async () => toolTrace(await load(retry))?.status === "ok", "failed background write was not retried")
  assert(writes >= 2)
  conversationStore.save = originalSave
  assert(warnings.some(message => message.includes("后台工具结果写回 SQLite 失败")))

  // Exhausted short retries remain recoverable on the next read, without rerunning the tool.
  for (const afterFailure of ["recover", "clear-key", "clear-scope", "clear-all"]) {
    let executions = 0
    const retained = setup({ backgroundSilent: true, execute: marker => { executions++; return { status: "success", content: marker, executedCount: 1 } } })
    const accepted = await send(retained)
    const warningOffset = warnings.length
    let failures = 0
    conversationStore.save = async input => {
      if (input.history.some(message => message.role === "tool" && message.content.includes(retained.marker))) {
        failures++
        throw new Error("injected persistent background write failure")
      }
      return originalSave.call(conversationStore, input)
    }
    retained.gate.resolve()
    await eventually(() => failures >= 3 && warnings.slice(warningOffset).some(message => message.includes("后台工具任务回调失败")), "short retries did not exhaust")
    assert.equal(toolTrace(await load(retained)).status, "accepted")
    conversationStore.save = originalSave
    if (afterFailure === "clear-key") await chatService.clearByKeys([accepted.conversationKey])
    if (afterFailure === "clear-scope") await chatService.clear(retained.e)
    if (afterFailure === "clear-all") await chatService.clearAll()
    retained.invoke = false
    const requestOffset = retained.requests.length
    await send(retained, "新的独立问题：解释一下闭包")
    assert.equal(executions, 1, "reading retained results must never rerun a tool")
    const stored = await load(retained)
    if (afterFailure === "recover") {
      assert.equal(toolTrace(stored).status, "ok")
      assert(JSON.stringify(retained.requests[requestOffset]).includes(retained.marker))
    } else {
      assert(!JSON.stringify(stored).includes(retained.marker), "clearing must remove retained writebacks as well")
      assert(!JSON.stringify(retained.requests[requestOffset]).includes(retained.marker))
    }
  }

  // A later reply must remain intact when an older background task completes.
  const late = setup({ backgroundSilent: true })
  await send(late)
  late.invoke = false
  late.terminal = "后续对话必须保留。"
  await send(late, "另一个问题")
  late.gate.resolve()
  await eventually(async () => toolTrace(await load(late))?.status === "ok", "late completion was not saved")
  assert.equal((await load(late)).turns.length, 2)
  assert((await load(late)).history.some(message => message.content === late.terminal))

  for (const clear of ["key", "scope", "all"]) {
    const local = setup({ backgroundSilent: true })
    const result = await send(local)
    if (clear === "key") await chatService.clearByKeys([result.conversationKey])
    else if (clear === "scope") await chatService.clear(local.e)
    else await chatService.clearAll()
    local.invoke = false
    local.terminal = "新会话。"
    await send(local, "重新开始")
    const fresh = await load(local)
    local.gate.resolve()
    await eventually(() => backgroundTaskService.get(result.toolChain[0].metadata.taskId)?.status === "ok", "cleared background did not finish")
    await chatService.waitForConversationMutations()
    assert.deepEqual(await load(local), fresh, "old result must not resurrect or modify a cleared session")
  }

  // Completion during the first SQLite save cannot be overwritten by its accepted snapshot.
  const committing = setup({ backgroundSilent: true })
  const saveEntered = deferred(), saveRelease = deferred()
  let blocked = false
  conversationStore.save = async input => {
    if (!blocked && input.turns?.some(turn => turn.toolChain?.some(trace => trace.status === "accepted"))) {
      blocked = true
      saveEntered.resolve()
      await saveRelease.promise
    }
    return originalSave.call(conversationStore, input)
  }
  const committingSend = send(committing)
  await saveEntered.promise
  committing.gate.resolve()
  await eventually(() => [...modelLogStore.memoryTools.values()].some(row => row.tool_name === "history_tool" && row.result_text.includes(committing.marker)), "completion did not precede first save")
  saveRelease.resolve()
  await committingSend
  conversationStore.save = originalSave
  assert.equal(toolTrace(await load(committing)).status, "ok")

  // A response started before writeback must not restore a stale upstream link.
  const privateCase = setup({ backgroundSilent: true })
  privateCase.e = { isGroup: false, isMaster: true, user_id: privateCase.id }
  const privateKey = `${channel.id}:p:${privateCase.id}`
  await send(privateCase)
  privateCase.invoke = false
  await send(privateCase, "后台还没完成，先聊聊")
  assert(Object.keys((await conversationStore.get(privateKey)).protocolState.responses).length > 0)
  const replyEntered = deferred(), replyRelease = deferred()
  privateCase.beforeReply = async () => { replyEntered.resolve(); await replyRelease.promise }
  const inFlightReply = send(privateCase, "继续这个话题")
  await replyEntered.promise
  privateCase.gate.resolve()
  await eventually(async () => toolTrace(await conversationStore.get(privateKey))?.status === "ok", "in-flight background update was not saved")
  replyRelease.resolve()
  await inFlightReply
  privateCase.beforeReply = undefined
  assert.deepEqual((await conversationStore.get(privateKey)).protocolState.responses, {})
  await checkFollowup(privateCase, privateCase.marker)

  // Canceling a queued task must fire its completion callback without running it.
  const blockerGate = deferred()
  const blocker = backgroundTaskService.submit({ name: "history-blocker", queueKey: "history-cancel", maxConcurrent: 1, maxQueue: 2, execute: () => blockerGate.promise })
  let canceledExecutions = 0
  const canceled = setup({ backgroundSilent: true, queue: () => ({ queueKey: "history-cancel", maxConcurrent: 1, maxQueue: 2 }), execute: () => { canceledExecutions++; return "must not run" } })
  const canceledResult = await send(canceled)
  const canceledId = canceledResult.toolChain[0].metadata.taskId
  assert.equal(backgroundTaskService.get(canceledId).status, "queued")
  assert.equal(backgroundTaskService.cancel(canceledId), true)
  await eventually(async () => toolTrace(await load(canceled))?.status === "canceled", "queued cancellation was not saved")
  assert.equal(canceledExecutions, 0)
  assert(toolTrace(await load(canceled)).durationMs < 10000)
  await checkFollowup(canceled, "canceled")
  blockerGate.resolve()
  await eventually(() => backgroundTaskService.get(blocker.id)?.status === "ok", "blocker did not finish")

  // A deleted or expired row, and an evicted turn in a live session, stay absent.
  for (const removal of ["delete", "expire", "trim"]) {
    const local = setup({ backgroundSilent: true })
    const result = await send(local)
    if (removal === "delete") await chatService.clearByKeys([result.conversationKey])
    else if (removal === "expire") {
      await sqliteClient.run("UPDATE conversations SET expires_at = 0 WHERE conversation_key = ?", [result.conversationKey])
      chatService.conversations.delete(result.conversationKey)
    } else {
      const priorLimit = config.chat.maxHistoryMessages
      config.chat.maxHistoryMessages = 2
      local.invoke = false
      await send(local, "保留的新轮次")
      config.chat.maxHistoryMessages = priorLimit
    }
    local.gate.resolve()
    await eventually(() => backgroundTaskService.get(result.toolChain[0].metadata.taskId)?.status === "ok", "evicted task did not finish")
    await chatService.waitForConversationMutations()
    const stored = await load(local)
    if (removal === "trim") assert(!JSON.stringify(stored).includes(local.marker))
    else assert.equal(stored, null)
  }

  // Retention and input-budget trimming must retain complete call/result pairs.
  const trim = setup({ finalReply: false })
  const priorLimit = config.chat.maxHistoryMessages
  config.chat.maxHistoryMessages = 2
  await send(trim)
  trim.requests.length = 0 // Intentionally reuse a supplier call ID in the next turn.
  await send(trim, "再执行一个动作")
  const retained = await load(trim)
  assert.equal(retained.turns.length, 1)
  assert.equal(retained.history.filter(message => message.role === "user").length, 1)
  assertPairs(retained.history)
  const bounded = enforcePromptBudgetDetailed([...retained.history, { role: "user", content: "追问" }], { chat: { inputTokenBudget: 1100 } }, { maxTokens: 512 })
  assertPairs(bounded.messages)
  config.chat.maxHistoryMessages = priorLimit

  const transient = setup({ backgroundSilent: true })
  const transientResult = await send(transient, "临时执行", { transient: true })
  transient.gate.resolve()
  await eventually(() => backgroundTaskService.get(transientResult.toolChain[0].metadata.taskId)?.status === "ok", "transient task did not finish")
  assert.equal(await load(transient), null)
  assert(!toolHistoryText({ image: { kind: "bytes", value: [1, 2, 3] }, token: "secret" }).includes("[1,2,3]"))
  assert(!toolHistoryText("inline image=data:image/png;base64,aGVsbG8=").includes("aGVsbG8="))
  console.log("ok tool history: shared foreground/background count contract, canonical sent/partial/failed delivery, silent replay, EMPTY, reversed completions, model failure, commit races, retained writes, clearing/expiry, paired retention, media redaction")
} finally {
  await modelLogStore?.stop({ flush: true })
  await sqliteClient?.close().catch(() => {})
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
process.exit(0)
