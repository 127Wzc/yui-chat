import assert from "node:assert/strict"

export async function checkCompact() {
  const { OpenAIResponsesAdapter } = await import("../output/runtime/models/adapters/openai/responses/adapter.js")
  const { messagesForResponses, buildResponsesRequest } = await import("../output/runtime/models/adapters/openai/responses/request-adapter.js")
  const { enforcePromptBudgetDetailed } = await import("../output/runtime/core/chat/token-budget.js")
  const adapter = new OpenAIResponsesAdapter()
  const channel = { type: "openai-responses", model: "test-model", baseURL: "https://compact.example/v1", apiKey: "test-key", timeoutMs: 1000, query: { route: "test" }, responsesRuntime: { stateMode: "local", compactThreshold: 3200 } }
  const output = [{ type: "compaction", id: "cmp_test", encrypted_content: "opaque-state" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "继续回答" }] }]
  const originalFetch = globalThis.fetch
  const captures = []
  try {
    globalThis.fetch = async (url, init) => {
      captures.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ id: "resp_compacted", status: "completed", output, usage: { input_tokens: 400, output_tokens: 40, total_tokens: 440 } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const result = await adapter.sendMessage({ channel, messages: [{ role: "user", content: "旧问题" }] })
    assert.equal(captures[0].url, "https://compact.example/v1/responses?route=test")
    assert.deepEqual(captures[0].body.context_management, [{ type: "compaction", compact_threshold: 3200 }])
    assert.equal(captures[0].body.store, false)
    assert.equal(result.text, "继续回答")
    assert.equal(result.usage.total, 440)
    assert.deepEqual(result.protocol.outputItems, output)
    const state = { role: "assistant", content: result.text, protocol: result.protocol }
    assert.deepEqual(messagesForResponses([state]), output)
    await adapter.sendMessage({ channel, messages: [state, { role: "user", content: "继续" }] })
    assert.deepEqual(captures[1].body.input.slice(0, 2), output)
    const linked = buildResponsesRequest({ channel: { ...channel, responsesRuntime: { stateMode: "auto", compactThreshold: 3200, previousResponseId: "resp_compacted" } }, messages: [state, { role: "user", content: "新问题" }] })
    assert.equal(linked.previous_response_id, "resp_compacted")
    assert.equal(linked.input.length, 1)
    assert.deepEqual(linked.context_management, captures[0].body.context_management)
    const windowed = buildResponsesRequest({ channel: { ...channel, responsesRuntime: {}, modelConfig: { contextWindowTokens: 128000 } }, messages: [], maxTokens: 1024 })
    assert.equal(windowed.context_management[0].compact_threshold, Math.floor((128000 - 1024 - 200) * 0.8))
    const safe = enforcePromptBudgetDetailed([{ role: "system", content: "人格" }, { role: "user", content: "旧问题".repeat(3000) }, { role: "user", content: "本轮问题" }], { chat: { inputTokenBudget: 1600 } })
    assert(safe.compressed && safe.messages.at(-1).content === "本轮问题")
    // 服务端压缩的 SSE 项必须保留，不能只保存普通文本 delta。
    globalThis.fetch = async (url, init) => {
      captures.push({ url: String(url), body: JSON.parse(init.body) })
      const source = ['event: response.output_item.added', `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: output[0] })}`, '', 'event: response.completed', `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_stream_compact", status: "completed", usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })}`, ''].join("\n")
      return new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const streamed = await adapter.sendMessage({ channel: { ...channel, stream: true }, messages: [{ role: "user", content: "流式压缩" }] })
    assert.deepEqual(streamed.protocol.outputItems[0], output[0])
    assert.equal(streamed.usage.total, 110)
    // 压缩错误使用有界本地正文恢复；不再携带失效状态或重发压缩设置。
    const replayMessages = [
      { role: "system", content: "人格" },
      { role: "user", content: "旧问题".repeat(3000) },
      { role: "assistant", content: "可见答复", protocol: { kind: "responses", outputItems: [output[0], { type: "function_call", call_id: "real_call", name: "lookup", arguments: "{}" }] } },
      { role: "tool", toolCallId: "real_call", content: "实际工具结果" },
      { role: "user", content: "本轮问题" },
    ]
    const fallbackChannel = { ...channel, responsesRuntime: { stateMode: "auto", previousResponseId: "old_response", compactThreshold: 800, inputTokenBudget: 1600 } }
    let attempts = []
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      captures.push({ url: String(url), body })
      attempts.push(body)
      return attempts.length === 1
        ? new Response(JSON.stringify({ error: { code: "unknown_parameter", param: "context_management", message: "Unsupported parameter" } }), { status: 400 })
        : new Response(JSON.stringify({ id: "fresh_response", status: "completed", output: [], usage: { input_tokens: 40, output_tokens: 5, total_tokens: 45 } }), { status: 200 })
    }
    const fallback = await adapter.sendMessage({ channel: fallbackChannel, messages: replayMessages.slice(-1), replayMessages, maxTokens: 100 })
    assert.equal(attempts.length, 2)
    assert.equal(fallback.responsesStateRecovery.reason, "compaction_failed")
    assert.equal(fallback.upstreamStateReset, true)
    assert.equal(fallback.usage.total, 45)
    assert(fallback.responsesStateRecovery.localCompaction.messagesDropped > 0)
    assert.equal(attempts[1].context_management, undefined)
    assert.equal(attempts[1].previous_response_id, undefined)
    assert(!JSON.stringify(attempts[1].input).includes("opaque-state"))
    assert(!JSON.stringify(attempts[1].input).includes("旧问题"))
    assert(attempts[1].input.some(item => item.type === "function_call" && item.call_id === "real_call"))
    assert(attempts[1].input.some(item => item.type === "function_call_output" && item.call_id === "real_call" && item.output === "实际工具结果"))
    assert.equal(attempts[1].input.at(-1).content, "本轮问题")
    // 本地模式、严格续接模式以及 HTTP 200/SSE 内嵌失败也可恢复压缩错误。
    for (const mode of ["local", "previous_response_id"]) {
      attempts = []
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body)
        captures.push({ url: String(url), body })
        attempts.push(body)
        const failed = { id: "failed_response", status: "failed", error: { code: "compaction_failed", message: "Compaction failed" } }
        return new Response(JSON.stringify(attempts.length === 1 ? failed : { id: "fresh", status: "completed", output: [] }), { status: 200 })
      }
      const recovered = await adapter.sendMessage({ channel: { ...fallbackChannel, responsesRuntime: { ...fallbackChannel.responsesRuntime, stateMode: mode } }, messages: replayMessages, maxTokens: 100 })
      assert.equal(recovered.responsesStateRecovery.reason, "compaction_failed")
      assert.equal(attempts.length, 2)
    }
    attempts = []
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      captures.push({ url: String(url), body })
      attempts.push(body)
      const data = attempts.length === 1
        ? { type: "response.failed", response: { status: "failed", error: { code: "context_length_exceeded", message: "Context window exceeded" } } }
        : { type: "response.completed", response: { id: "fresh_stream", status: "completed", output: [] } }
      return new Response(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const recoveredStream = await adapter.sendMessage({ channel: { ...fallbackChannel, stream: true }, messages: replayMessages, maxTokens: 100 })
    assert.equal(recoveredStream.responsesStateRecovery.reason, "context_length_exceeded")
    assert.equal(recoveredStream.responsesStateRecovery.localCompaction.limit, 650)
    assert.equal(attempts.length, 2)
    // 取消、鉴权、限流、无关错误和第二次失败不得继续重试。
    for (const [status, error, expected] of [[401, { message: "compaction unauthorized" }, 1], [429, { message: "compaction rate limit" }, 1], [400, { message: "invalid model" }, 1], [500, { code: "compaction_failed", message: "Compaction failed" }, 2]]) {
      attempts = []
      globalThis.fetch = async (url, init) => { captures.push({ url: String(url) }); attempts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ error }), { status }) }
      await assert.rejects(adapter.sendMessage({ channel, messages: [{ role: "user", content: "本轮问题" }] }))
      assert.equal(attempts.length, expected)
    }
    const abort = new Error("compaction aborted")
    abort.name = "AbortError"
    let abortedAttempts = 0
    globalThis.fetch = async () => { abortedAttempts++; throw abort }
    await assert.rejects(adapter.sendMessage({ channel, messages: [] }), error => error === abort)
    assert.equal(abortedAttempts, 1)
    globalThis.fetch = async (url) => { captures.push({ url: String(url) }); return new Response(JSON.stringify({ error: { message: "unsupported" } }), { status: 400 }) }
    await assert.rejects(adapter.sendMessage({ channel, messages: [] }), error => error.status === 400)
    assert(captures.every(item => new URL(item.url).pathname === "/v1/responses"))
    assert.equal(adapter.compact, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
}
