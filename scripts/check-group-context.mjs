import assert from "node:assert/strict"

export async function checkGroupContext(image) {
  const { configStore } = await import("../output/runtime/config/store.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const { recentContextStore } = await import("../output/runtime/core/chat/recent-context.js")
  const { contentToText } = await import("../output/runtime/core/message/message-context.js")
  const { messagesForResponses } = await import("../output/runtime/models/adapters/openai/responses/request-adapter.js")
  const config = await configStore.load()
  const next = structuredClone(config)
  next.context.recentMessageCount = 30
  next.context.captureGroups = true
  next.mediaRecognition.enabled = true
  next.mediaRecognition.preferNativeVision = true
  const mock = adapterRegistry.get("mock")
  const originalSend = mock.sendMessage
  const originalVision = mock.supportsVision
  const originalNative = mock.supportsNativeToolSearch
  const originalProtocol = mock.protocol
  const originalCompact = mock.compact
  const requests = []
  const base = { isGroup:true, group_id:"group-relations", self_id:"bot-relations" }
  const a = {...base, user_id:"user-a", sender:{nickname:"小呆毛"}}
  const b = {...base, user_id:"user-b", sender:{nickname:"玖弦"}}
  const send = (event, prompt) => chatService.send({...event,msg:prompt},prompt,{disableTools:true,persistMemory:false})
  const current = () => requests.at(-1).messages.findLast(item => item.role === "user")
  try {
    await configStore.save(next)
    recentContextStore.clear()
    mock.supportsVision = true
    mock.supportsNativeToolSearch = true
    mock.protocol = "responses"
    mock.sendMessage = async request => {
      requests.push({ ...request, channel: { ...request.channel, responsesRuntime: { ...request.channel.responsesRuntime } } })
      return {id:"group-test-"+requests.length,upstreamResponseId:"resp-group-"+requests.length,text:request.event.user_id === "user-a" ? "看不出图里是谁。" : "水仙是自己和自己配对。",toolCalls:[],stopReason:"end_turn",usage:{input:1,output:1,total:2,source:"reported"}}
    }
    const own = await send({...a,message_id:"a1"}, "这张图是谁")
    recentContextStore.record({...a,message_id:"a1",msg:"这张图是谁"})
    recentContextStore.recordAssistant({...a,message_id:"a1"},"看不出图里是谁。",{message_id:"bot-a1"})
    await send({...b,message_id:"b1"}, "水仙是什么意思")
    recentContextStore.record({...b,message_id:"b1",msg:"水仙是什么意思"})
    recentContextStore.recordAssistant({...b,message_id:"b1"},"水仙是自己和自己配对。",{message_id:"bot-b1"})
    recentContextStore.record({...a,group_id:"another-group",message_id:"foreign",msg:"其他群秘密"})
    await send({...a,message_id:"a2"}, "你问问他图里是谁")
    assert(requests.at(-1).messages.filter(item => item.role === "system").every(item => !contentToText(item.content).includes("水仙是什么意思")))
    assert(!contentToText(current().content).includes("水仙是什么意思"))

    assert(!contentToText(current().content).includes("其他群秘密"))
    assert(requests.at(-1).messages.some(item => item.role === "assistant" && item.content === "看不出图里是谁。"))
    assert(!requests.at(-1).messages.some(item => item.role === "assistant" && item.content === "水仙是自己和自己配对。"))
    assert(!(await chatService.getHistory(own.conversationKey)).some(item => contentToText(item.content).includes("水仙是什么意思")))
    await send({...a,message_id:"a3"}, "你刚才和玖弦聊了什么")
    assert(contentToText(current().content).includes('"requestedUserIds":["user-b"]'))
    assert(contentToText(current().content).includes("水仙是自己和自己配对"))
    assert.equal(requests.at(-1).channel.responsesRuntime.previousResponseId,"")
    const savedHistory = await chatService.getHistory(own.conversationKey)
    assert(savedHistory.filter(item => item.role === "user").every(item => !contentToText(item.content).includes("【本轮身份】")))
    const ref = JSON.parse(recentContextStore.buildReference(a,"玖弦聊了什么",{maxTokens:1200}))
    assert(ref.messages.some(item => item.speaker.userId === "user-b"))
    assert(ref.messages.some(item => item.respondingToUserId === "user-b"))
    assert.equal(recentContextStore.buildReference(a,"你好",{history:savedHistory}),"")
    const small = JSON.parse(recentContextStore.buildReference(a,"玖弦聊了什么",{maxTokens:180}))
    assert(small.messages.length === 0 || small.messages.some(item => item.messageId === "b1") && small.messages.some(item => item.messageId === "bot-b1"), "budget must retain or omit the whole question/answer")
    if (!small.messages.length) assert(small.unavailable)
    // 整体预算不足时，当前明确询问的群资料不能被整块替换为空。
    const tight = structuredClone(next)
    tight.chat.inputTokenBudget = 1800
    for (const model of tight.models) model.contextWindowTokens = 1024
    await configStore.save(tight)
    await send({...a,message_id:"budget-question"},"你刚才和玖弦聊了什么")
    assert(contentToText(current().content).includes("水仙是什么意思"))
    await configStore.save(next)
    recentContextStore.record({...b,message_id:"b-image",msg:"",message:[{type:"image",url:"https://example.com/expired.png"}]})
    let reads = 0
    const imageEvent = {...a,message_id:"a4",getMessage:async id => {
      reads++
      assert.equal(id,"b-image")
      return {message_id:id,user_id:"user-b",group_id:base.group_id,message:[{type:"image",url:image}]}
    }}
    await send(imageEvent,"埋埋看看玖弦发的图片")
    assert.equal(reads,1)
    assert(Array.isArray(current().content))
    assert.equal(current().content.filter(part => part.type === "image_url").length,1)
    assert.equal(requests.at(-1).event.user_id,"user-a")
    assert(contentToText(current().content).includes("玖弦"))
    assert.equal(messagesForResponses([current()])[0].content.filter(part => part.type === "input_image").length,1)
    await send({...imageEvent,message_id:"a5",getMessage:async () => ({message_id:"wrong",user_id:"user-b",message:[{type:"image",url:image}]})},"看看玖弦发的图片")
    assert(!Array.isArray(current().content) || !current().content.some(part => part.type === "image_url"))
    assert(requests.at(-1).messages.some(item => contentToText(item.content).includes("未能重新读取")))
    recentContextStore.record({...a,message_id:"a-image",msg:"",message:[{type:"image",url:image}]})
    const comparison = recentContextStore.selectRecentImages(a,"比较玖弦和我的图片")
    assert.deepEqual(comparison.images.map(item => item.userId),["user-b","user-a"])
    recentContextStore.record({...b,message_id:"b-images",msg:"",message:[{type:"image",url:"https://example.com/one.png"},{type:"image",url:"https://example.com/two.png"}]})
    const plural = recentContextStore.selectRecentImages(a,"看看玖弦发的图片")
    assert.equal(plural.images.length,2)
    assert.deepEqual(plural.images.map(item => item.imageIndex),[0,1])
    const all = recentContextStore.selectRecentImages(a,"看看玖弦发的几张图片",2)
    assert.equal(all.images.length,2)
    assert(all.diagnostic.includes("最近的 2 张"))
    assert(all.images.every(item => item.messageId === "b-images"), "newest image message must survive the cap")
    assert.equal(recentContextStore.selectRecentImages(a,"看看陌生人刚才发的是什么").images.length,0)
    const { refreshRecentImage } = await import("../output/runtime/core/message/media-context.js")
    const refreshed = await refreshRecentImage({...a,getMessage:async id => ({message_id:id,user_id:"user-b",message:[{type:"image",url:"https://example.com/fresh-one.png"},{type:"image",url:"https://example.com/fresh-two.png"}]})},plural.images[1])
    assert.equal(refreshed,"https://example.com/fresh-two.png")
    assert.equal(await refreshRecentImage({...a,getMessage:async id => ({message_id:id,sender:{user_id:"wrong-author"},message:[{type:"image",url:image}]})},plural.images[0]),null)
    assert.equal(recentContextStore.buildReference({...a,isGroup:false}, "玖弦"),"")
    const missing = recentContextStore.selectRecentImages(a,"看看不存在成员发的图片")
    assert.equal(missing.images.length,0)
    recentContextStore.record({...b,user_id:"duplicate-b",message_id:"duplicate",msg:"同名成员",sender:{nickname:"玖弦"}})
    assert.equal(recentContextStore.selectRecentImages(a,"看看玖弦发的图片").images.length,0)
    assert.equal(recentContextStore.selectRecentImages({...a,message:[{type:"at",qq:"user-b"}]},"看看他的图片").images.length,2)
    const privateEvent = {user_id:"private-relations",self_id:base.self_id,isGroup:false}
    await send({...privateEvent,message_id:"p1"},"你好")
    await send({...privateEvent,message_id:"p2"},"继续")
    assert(requests.at(-1).channel.responsesRuntime.previousResponseId.startsWith("resp-group-"), "private conversations should keep upstream continuation")
    await chatService.clear(privateEvent)
    // 在实际模型步骤验证 compact 优先、失败回退和上游链重建。
    const compactChannel = {id:"mock",type:"mock",model:"mock",modelConfig:{contextWindowTokens:4096,responses:{stateMode:"auto"}}}
    const compactHistory = [{role:"user",content:"个人旧问题"},{role:"assistant",content:"个人旧回答".repeat(3000)}]
    let compactCalls = 0
    mock.compact = async request => {
      compactCalls++
      assert(!JSON.stringify(request.messages).includes("群聊参考资料"))
      return {id:"cmp_test",text:"",toolCalls:[],stopReason:"end_turn",usage:{input:10,output:2,total:12,source:"reported"},protocol:{kind:"responses",outputItems:[{type:"compaction",encrypted_content:"test-state"}]}}
    }
    const runCompact = () => chatService.runModelStepWithChannel({e:a,prompt:"你刚才和玖弦聊了什么",config:next,history:compactHistory,step:{id:"reply",task:"replyer",mode:"final"},channel:compactChannel,disableTools:true})
    const compactResult = await runCompact()
    assert.equal(compactCalls,1)
    assert(requests.at(-1).messages.some(item => item.protocol?.outputItems?.some(value => value.type === "compaction")))
    assert(contentToText(current().content).includes("群聊参考资料"))
    assert(compactResult.modelCalls.some(item => item.operation === "compact"))
    const { responsesStateKey } = await import("../output/runtime/models/configuration/responses-state.js")
    await chatService.runModelStepWithChannel({e:privateEvent,prompt:"继续",config:next,history:compactHistory,protocolState:{responses:{[responsesStateKey(compactChannel)]:{previousResponseId:"resp_old"}}},step:{id:"reply",task:"replyer",mode:"final"},channel:compactChannel,disableTools:true})
    assert.equal(compactCalls,2)
    assert.equal(requests.at(-1).channel.responsesRuntime.previousResponseId,"")
    assert(requests.at(-1).messages.some(item => item.protocol?.outputItems?.some(value => value.type === "compaction")))
    mock.compact = async () => {compactCalls++; throw new Error("404 unsupported")}
    await runCompact()
    assert.equal(compactCalls,3)
    assert(!requests.at(-1).messages.some(item => item.protocol?.outputItems?.some(value => value.type === "compaction")))
    assert(!requests.at(-1).messages.some(item => item.content === compactHistory[1].content))
    mock.compact = originalCompact
    mock.supportsVision = false
    await send({...imageEvent,message_id:"a6",message:[{type:"at",qq:"user-b"}]},"看看他的图片")
    assert(!Array.isArray(current().content) || !current().content.some(part => part.type === "image_url"))
  } finally {
    mock.sendMessage = originalSend
    mock.supportsNativeToolSearch = originalNative
    mock.protocol = originalProtocol
    mock.compact = originalCompact
    mock.supportsVision = originalVision
    await chatService.clear(a)
    await chatService.clear(b)
    recentContextStore.clear()
    await configStore.save(config)
  }
}
