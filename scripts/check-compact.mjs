import assert from "node:assert/strict"

export async function checkCompact() {
  const { OpenAIResponsesAdapter } = await import("../output/runtime/models/adapters/openai/responses/adapter.js")
  const { messagesForResponses } = await import("../output/runtime/models/adapters/openai/responses/request-adapter.js")
  const { compactPromptHistory, enforcePromptBudgetDetailed } = await import("../output/runtime/core/chat/token-budget.js")
  const adapter = new OpenAIResponsesAdapter()
  const channel = {type:"openai-responses",model:"test-model",baseURL:"https://compact.example/v1",apiKey:"test-key",timeoutMs:1000,query:{route:"test"}}
  const output = [{type:"message",role:"user",content:[{type:"input_text",text:"旧问题"}]},{type:"compaction",id:"cmp_test",encrypted_content:"opaque-state"}]
  const originalFetch = globalThis.fetch
  let status = 200
  let payload = {id:"cmp_response",object:"response.compaction",output,usage:{input_tokens:400,output_tokens:40,total_tokens:440}}
  let captured
  try {
    globalThis.fetch = async (url, init) => {
      captured = {url:String(url),headers:init.headers,body:JSON.parse(init.body)}
      return new Response(JSON.stringify(payload), {status,headers:{"content-type":"application/json"}})
    }
    const result = await adapter.compact({channel,messages:[{role:"user",content:"旧问题"},{role:"assistant",content:"旧回答"}]})
    assert.equal(captured.url,"https://compact.example/v1/responses/compact?route=test")
    assert.equal(captured.body.model,"test-model")
    assert(!("tools" in captured.body) && !("previous_response_id" in captured.body))
    assert.deepEqual(result.protocol.outputItems,output)
    assert.equal(result.usage.total,440)
    const state = {role:"assistant",content:"",protocol:result.protocol}
    assert.deepEqual(messagesForResponses([state]),output)
    const current = {role:"user",content:"本轮身份：小呆毛；群资料：玖弦；本轮问题"}
    const system = {role:"system",content:"人格"}
    const history = [{role:"user",content:"旧问题"},{role:"assistant",content:"旧回答".repeat(2000)}]
    const input = [system,...history,current,{role:"assistant",content:"",tool_calls:[{id:"call1",function:{name:"test",arguments:"{}"}}]},{role:"tool",tool_call_id:"call1",content:"结果"}]
    const config = {chat:{inputTokenBudget:1600}}
    let calls = 0
    const compacted = await compactPromptHistory(input,config,{},async selected => {
      calls++
      assert.deepEqual(selected,history)
      return state
    })
    assert.equal(calls,1)
    assert(compacted.includes(current) && compacted.includes(system))
    assert.deepEqual(compacted.slice(-2),input.slice(-2))
    assert(compacted.includes(state))
    const continuation = {role:"user",content:"请根据工具结果继续"}
    const anchored = await compactPromptHistory([...input,continuation],config,{preserveFrom:current},async selected => {
      assert.deepEqual(selected,history)
      return state
    })
    assert(anchored.includes(current) && anchored.includes(continuation))
    assert.equal(await compactPromptHistory([system,current],config,{},async () => {throw new Error("must not call")}),null)
    assert.equal(await compactPromptHistory(input,config,{},async () => null),null)
    assert.equal(await compactPromptHistory(input,config,{},async () => ({...state,protocol:{kind:"responses",outputItems:[{type:"compaction",encrypted_content:"x".repeat(20000)}]}})),null)
    assert(enforcePromptBudgetDetailed(input,config).compressed)
    for (const failure of [404,500]) {
      status = failure; payload = {error:{message:"unsupported"}}
      await assert.rejects(adapter.compact({channel,messages:history}), error => error.status === failure)
    }
    status = 200; payload = {output:[]}
    await assert.rejects(adapter.compact({channel,messages:history}),/COMPACT_INVALID_OUTPUT/)
    globalThis.fetch = async () => {throw new Error("timeout")}
    await assert.rejects(adapter.compact({channel,messages:history}),/timeout/)
  } finally { globalThis.fetch = originalFetch }
}
