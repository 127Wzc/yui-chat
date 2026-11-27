import assert from "node:assert/strict"
import { parseOpenAIStreamResponse } from "../output/runtime/models/adapters/openai/chat/adapter.js"
import { parseResponsesStreamResponse } from "../output/runtime/models/adapters/openai/responses/response-adapter.js"
import { parseClaudeStreamResponse } from "../output/runtime/models/adapters/claude.js"
import { parseGeminiStreamResponse } from "../output/runtime/models/adapters/gemini.js"
import { normalizeModelResponse } from "../output/runtime/models/protocol/normalize.js"
import { createApiClient } from "../output/runtime/web/client/app/store/api.js"

const fixtures = [
  [parseOpenAIStreamResponse, [
    { choices: [{ delta: { reasoning_content: "分析" } }] },
    { choices: [{ delta: { content: "你好" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  ]],
  [parseResponsesStreamResponse, [
    { type: "response.reasoning_summary_text.delta", delta: "分析" },
    { type: "response.output_text.delta", item_id: "msg", output_index: 0, delta: "你好" },
    { type: "response.completed", response: { id: "response", status: "completed", output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
  ]],
  [parseClaudeStreamResponse, [
    { type: "message_start", message: { id: "claude", usage: { input_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "分析" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "never-visible" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  ]],
  [parseGeminiStreamResponse, [
    { candidates: [{ index: 0, content: { parts: [{ thought: true, text: "分析" }] } }] },
    { candidates: [{ index: 0, content: { parts: [{ text: "你好" }] } }] },
    { candidates: [{ index: 0, finishReason: "STOP", content: { parts: [] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } },
  ]],
]
for (const [parse, frames] of fixtures) {
  let stream
  const deltas = []
  const body = new ReadableStream({ start(controller) { stream = controller } })
  let completed = false
  const result = parse(new Response(body, { headers: { "content-type": "text/event-stream" } }), delta => deltas.push(delta)).then(value => { completed = true; return value })
  const encoder = new TextEncoder()
  for (const frame of frames.slice(0, 2)) for (const byte of encoder.encode(`data: ${JSON.stringify(frame)}\r\n\r\n`)) stream.enqueue(new Uint8Array([byte]))
  // Claude 前两帧仅创建内容块，其余协议已返回可见增量。
  for (let i = 0; i < 30 && !deltas.length; i++) await new Promise(resolve => setImmediate(resolve))
  if (parse !== parseClaudeStreamResponse) assert(deltas.length > 0, parse.name)
  assert.equal(completed, false)
  for (const frame of frames.slice(2)) stream.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
  stream.close()
  const response = normalizeModelResponse(await result)
  assert.equal(response.text, "你好", parse.name)
  assert.equal(response.reasoningText, "分析", parse.name)
  assert.equal(deltas.filter(item => item.type === "text").map(item => item.text).join(""), "你好")
  assert.equal(deltas.filter(item => item.type === "reasoning").map(item => item.text).join(""), "分析")
  assert(!JSON.stringify(deltas).includes("never-visible"))
}
const nativeFetch = global.fetch
try {
  global.fetch = async () => new Response('event: progress\ndata: {"id":"one"}\n\n', { headers: { "content-type": "text/event-stream" } })
  await assert.rejects(createApiClient({ basePath: "/yui-chat" }).requestStream("/api/chat/test", {}, () => {}), /提前结束/)
  global.fetch = async () => new Response('event: error\ndata: {"error":"供应商失败"}\n\n', { headers: { "content-type": "text/event-stream" } })
  await assert.rejects(createApiClient({ basePath: "/yui-chat" }).requestStream("/api/chat/test", {}, () => {}), /供应商失败/)
} finally { global.fetch = nativeFetch }
console.log("ok chat stream protocols: incremental UTF-8 frames, visible reasoning, signatures excluded, final aggregation, failures and premature EOF")
