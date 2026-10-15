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
  next.context.capturePrivate = true
  next.mediaRecognition.enabled = true
  next.mediaRecognition.preferNativeVision = true
  const mock = adapterRegistry.get("mock")
  const originalSend = mock.sendMessage
  const originalVision = mock.supportsVision
  const originalNative = mock.supportsNativeToolSearch
  const originalProtocol = mock.protocol
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
    assert(contentToText(current().content).includes("水仙是什么意思"))

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
    assert(ref.messages.some(item => item.from === "user-b"))
    assert(ref.messages.some(item => item.replyTo === "b1"))
    for (const prompt of ["你好", "玉玉他们叽里呱啦说啥呢", "他们在聊什么"]) {
      const diagnostics = {}
      const background = JSON.parse(recentContextStore.buildReference(a,prompt,{history:savedHistory,diagnostics}))
      assert(background.messages.some(item => item.messageId === "b1"), "ordinary group prompts must include other members")
      assert(background.messages.some(item => item.messageId === "bot-b1"))
      assert.equal(diagnostics.includedMessages, background.messages.length)
      assert.equal(diagnostics.eligibleMessages, diagnostics.includedMessages + diagnostics.omittedMessages)
    }
    await chatService.send({...a,message_id:"natural-group",msg:"玉玉他们叽里呱啦说啥呢"},"玉玉他们叽里呱啦说啥呢",{source:"firstPerson",disableTools:true,persistMemory:false})
    assert(contentToText(current().content).includes("水仙是什么意思"))
    assert(contentToText(current().content).includes("水仙是自己和自己配对"))
    const small = JSON.parse(recentContextStore.buildReference(a,"玖弦聊了什么",{maxTokens:50}))
    assert(small.messages.length === 0 || small.messages.some(item => item.messageId === "b1") && small.messages.some(item => item.messageId === "bot-b1"), "budget must retain or omit the whole question/answer")
    if (!small.messages.length) assert(small.unavailable)
    assert(small.incomplete)
    const orderingEvent = {...a,group_id:"window-order"}
    for (const [message_id,user_id] of [["older",a.user_id],["newer",b.user_id],["current",a.user_id]]) {
      recentContextStore.record({...orderingEvent,message_id,user_id,sender:{nickname:user_id},msg:"一条群消息"})
    }
    const window = JSON.parse(recentContextStore.buildReference({...orderingEvent,message_id:"current"},"你好"))
    assert.deepEqual(window.messages.map(item => item.messageId),["older","newer"], "current message must not be repeated")
    const { estimateTokens } = await import("../output/runtime/core/chat/token-budget.js")
    const oneRowBudget = Math.max(...window.messages.map(item => estimateTokens(JSON.stringify({members:{[item.from]:item.from},incomplete:true,messages:[item]}))))
    const newest = JSON.parse(recentContextStore.buildReference({...orderingEvent,message_id:"current"},"你好",{maxTokens:oneRowBudget}))
    assert.deepEqual(newest.messages.map(item => item.messageId),["newer"], "recent group messages must outrank older requester messages")
    const quoted = JSON.parse(recentContextStore.buildReference({...orderingEvent,message_id:"current",message:[{type:"reply",id:"older"}]},"解释一下",{maxTokens:oneRowBudget}))
    assert.deepEqual(quoted.messages.map(item => item.messageId),["older"], "explicit references must outrank newer messages")
    const deduplicated = JSON.parse(recentContextStore.buildReference({...orderingEvent,message_id:"current"},"你好",{history:[{role:"user",metadata:{messageId:"older"}}]}))
    assert.deepEqual(deduplicated.messages.map(item => item.messageId),["newer"])
    const empty = JSON.parse(recentContextStore.buildReference({...a,group_id:"empty-window"},"你好"))
    assert.deepEqual(empty.messages,[])
    assert.deepEqual(empty.members,{})
    assert(empty.unavailable)
    // Compact shared window retains a cross-member coffee thread without CQ URLs or empty fields.
    const coffee = {...a,group_id:"coffee-context"}
    const observer = {...b,group_id:coffee.group_id}
    recentContextStore.record({...coffee,message_id:"coffee",msg:"小鹿咖啡的小黄油拿铁"})
    recentContextStore.record({...observer,message_id:"join",msg:"那是什么",message:[{type:"reply",id:"coffee"},{type:"text",text:"那是什么"}]})
    recentContextStore.recordAssistant({...coffee,message_id:"ask"},"是哪家咖啡？",{message_id:"answer"})
    recentContextStore.record({...coffee,message_id:"ask",msg:"搜索介绍一下",message:[{type:"reply",id:"coffee"},{type:"text",text:"搜索介绍一下"}]})
    recentContextStore.record({...coffee,message_id:"sticker",msg:"[CQ:image,file=x,url=https://example.com/image.png?rkey=private-signature]"})
    recentContextStore.record({...coffee,message_id:"coffee",msg:"小鹿咖啡的小黄油拿铁"})
    const compactReference = recentContextStore.buildReference(observer,"是瑞幸的，你去搜一下")
    const coffeeRows = JSON.parse(compactReference).messages
    assert(coffeeRows.findIndex(row=>row.messageId==="ask") < coffeeRows.findIndex(row=>row.messageId==="answer"))
    assert.equal(coffeeRows[0].messageId,"coffee", "duplicate capture must not move a message to the tail")
    assert(coffeeRows.some(row=>row.messageId==="sticker" && row.images===1))
    assert(!compactReference.includes("CQ:") && !compactReference.includes("private-signature"))
    assert(coffeeRows.every(row=>!("relation" in row)) && !("windowMessages" in JSON.parse(compactReference)))
    assert(estimateTokens(compactReference)<=1200)

    // Own new image survives a short text interruption; competing images require clarification.
    const adjacent = {...a,group_id:"adjacent-images"}
    recentContextStore.record({...adjacent,message_id:"own-new",msg:"",message:[{type:"image",url:image},{type:"image",url:"https://example.com/second.png"}]})
    recentContextStore.record({...adjacent,user_id:b.user_id,message_id:"interruption",msg:"路过"})
    assert.equal(recentContextStore.selectAdjacentImages(adjacent,"看看这个").images.length,2)
    recentContextStore.record({...adjacent,user_id:b.user_id,message_id:"other-new",msg:"",message:[{type:"image",url:image}]})
    recentContextStore.record({...adjacent,message_id:"text-after",msg:"嗯"})
    assert.equal(recentContextStore.selectAdjacentImages(adjacent,"看看这个").images.length,0)
    assert.equal(recentContextStore.selectRecentImages(adjacent,"看看他刚发的图").images.length,0)
    assert(recentContextStore.selectRecentImages(adjacent,"看看我刚发的图").images.every(item=>item.userId===a.user_id))
    const { deliverMessageChain } = await import("../output/runtime/core/message-chain/delivery.js")
    const delivered = await deliverMessageChain([
      {type:"image",source:{kind:"base64",value:image}},
      {type:"image",source:{kind:"base64",value:image}},
    ], {e:{...adjacent,reply:async()=>({message_id:"bot-image"})},config:next})
    assert.equal(delivered.status,"sent")
    const botImages = recentContextStore.selectRecentImages(adjacent,"玉玉你刚发的图是什么")
    assert.equal(botImages.images.length,2)
    assert(botImages.images.every(item=>item.userId===base.self_id))
    await recentContextStore.recordDeliveredImages(adjacent,{message_id:"failed-image",status:"failed"},1)
    assert(!recentContextStore.selectRecentImages(adjacent,"你发的图片").images.some(item=>item.messageId==="failed-image"))
    const botImageEvent = {...adjacent,message_id:"ask-bot-image",getMessage:async id=>({message_id:id,user_id:base.self_id,group_id:adjacent.group_id,message:[{type:"image",url:image},{type:"image",url:image}]})}
    await send(botImageEvent,"玉玉你刚发的图是什么")
    assert(Array.isArray(current().content) && current().content.some(part=>part.type==="image_url"))
    assert(contentToText(current().content).includes("bot-image"))

    // Real receipt shapes must preserve both reference metadata and actual visual input.
    for (const [index, receipt] of [
      [{message_id:"bot-wrapped"}],
      {data:{message_id:"bot-wrapped"}},
      {message_id:["bot-wrapped"],data:[{message_id:"bot-wrapped"}]},
    ].entries()) {
      const wrappedEvent = {...a,group_id:`wrapped-image-${index}`,message_id:`wrapped-question-${index}`,
        reply:async()=>receipt,
        getMessage:async id=>({message_id:id,user_id:base.self_id,group_id:`wrapped-image-${index}`,message:[{type:"image",url:image}]})}
      await deliverMessageChain([{type:"image",source:{kind:"base64",value:image}}],{e:wrappedEvent,config:next})
      recentContextStore.recordAssistant(wrappedEvent,"图片已发送",receipt)
      const diagnostics = {}
      const reference = JSON.parse(recentContextStore.buildReference(wrappedEvent,"看看你最新发的图片",{
        history:[{role:"assistant",content:"图片已发送",metadata:{messageId:"bot-wrapped"}}],diagnostics,
      }))
      assert(reference.messages.some(row=>row.messageId==="bot-wrapped" && row.images===1), "text history must not deduplicate image records")
      assert.equal(diagnostics.windowImageMessages,1)
      assert.equal(diagnostics.includedImageMessages,1)
      for (const prompt of ["玉玉看看你最新发的图片","看看您最新发的截图",`${next.persona.firstPerson}最新发的图片`]) {
        const selected = recentContextStore.selectRecentImages(wrappedEvent,prompt)
        assert.equal(selected.images[0]?.messageId,"bot-wrapped")
        assert.equal(selected.diagnostic,"")
      }
      await send({...wrappedEvent,message_id:`wrapped-followup-${index}`},"玉玉看看你最新发的图片")
      assert(current().content.some(part=>part.type==="image_url"), "latest assistant images must become native vision input")
    }
    const compoundEvent = {...a,group_id:"compound-image-receipt",message_id:"compound-trigger",
      getMessage:async id=>({message_id:id,user_id:id==="foreign" ? b.user_id : base.self_id,group_id:"compound-image-receipt",
        message:id==="picture" || id==="foreign" ? [{type:"image",url:image}] : [{type:"text",text:"一条文字消息"}]})}
    await recentContextStore.recordDeliveredImages(compoundEvent,{message_id:["picture","text","foreign"],data:[{message_id:"picture"},{message_id:"text"},{message_id:"foreign"}]},1)
    assert.deepEqual(recentContextStore.selectRecentImages(compoundEvent,"你最新发的图片").images.map(item=>item.messageId),["picture"], "compound receipts must validate actual images and their authors")
    await recentContextStore.recordDeliveredImages(compoundEvent,[{message_id:"failed",status:"failed"}],1)
    await recentContextStore.recordDeliveredImages(compoundEvent,{data:{message_id:"failed"},status:"failed"},1)
    assert.equal(recentContextStore.selectRecentImages(compoundEvent,"你最新发的图片").images[0].messageId,"picture")

    // 私聊会话归属不随助手作者改变，也不能泄漏到其他用户的窗口。
    const privateImageEvent = { isGroup: false, self_id: base.self_id, user_id: "private-image-owner", message_id: "private-trigger",
      reply: async () => ({ message_id: "private-picture" }),
      getMessage: async id => ({ message_id: id, user_id: base.self_id, message: [{ type: "image", url: image }] }) }
    await deliverMessageChain([{ type: "image", source: { kind: "base64", value: image } }], { e: privateImageEvent, config: next })
    recentContextStore.recordAssistant(privateImageEvent, "图片已发送", { message_id: "private-picture" })
    const privateSelection = recentContextStore.selectRecentImages(privateImageEvent, "你刚发的图是什么")
    assert.equal(privateSelection.images[0]?.messageId, "private-picture")
    assert.equal(privateSelection.images[0]?.userId, base.self_id)
    assert.equal(recentContextStore.selectRecentImages({ ...privateImageEvent, user_id: "another-private-user" }, "你刚发的图是什么").images.length, 0)
    const { refreshRecentImage } = await import("../output/runtime/core/message/media-context.js")
    assert.equal(await refreshRecentImage(privateImageEvent, privateSelection.images[0]), image)

    // 首次平台读取挂起时，总等待必须有界，后续发送批次仍完成；迟到结果不补写。
    let finishRead
    let readsStarted = 0
    let batchesSent = 0
    const slowEvent = { ...a, group_id: "slow-image-receipt", message_id: "slow-trigger",
      getMessage: () => { readsStarted++; return new Promise(resolve => { finishRead = resolve }) },
      reply: async () => ++batchesSent === 1 ? { message_id: ["slow-picture", "other-picture"] } : { message_id: "video-sent" } }
    const started = Date.now()
    let testTimeout
    let slowReceipt
    try {
      slowReceipt = await Promise.race([
        deliverMessageChain([
          { type: "image", source: { kind: "base64", value: image } },
          { type: "video", source: { kind: "base64", value: image } },
        ], { e: slowEvent, config: next }),
        new Promise((_, reject) => { testTimeout = setTimeout(() => reject(new Error("receipt observation blocked delivery")), 3000) }),
      ])
    } finally {
      clearTimeout(testTimeout)
    }
    assert.equal(slowReceipt.status, "sent")
    assert.equal(batchesSent, 2)
    assert.equal(readsStarted, 1)
    assert(Date.now() - started < 3000, "receipt observation must share one bounded wait")
    finishRead({ message_id: "slow-picture", group_id: slowEvent.group_id, user_id: base.self_id, message: [{ type: "image", url: image }] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(recentContextStore.selectRecentImages(slowEvent, "你刚发的图片").images.length, 0)
    assert.equal(readsStarted, 1, "expired observation must not start another receipt read")


    for (const context of [{...next.context,recentMessageCount:0},{...next.context,captureGroups:false}]) {
      await configStore.save({...next,context})
      assert.equal(recentContextStore.buildReference(a,"玉玉他们说啥呢"),"")
      await recentContextStore.recordDeliveredImages(slowEvent, { message_id: ["disabled-1", "disabled-2"] }, 1)
      assert.equal(readsStarted, 1, "disabled context capture must not read platform messages")
    }
    await configStore.save(next)
    recentContextStore.record({...b,message_id:"b1",msg:"水仙是什么意思"})
    recentContextStore.recordAssistant({...b,message_id:"b1"},"水仙是自己和自己配对。",{message_id:"bot-b1"})
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
    // 实际模型步骤在普通请求中传入服务端压缩阈值，不再发起独立调用。
    const compactChannel = {id:"mock",type:"mock",model:"mock",modelConfig:{contextWindowTokens:4096,responses:{stateMode:"auto"}}}
    const compactHistory = [{role:"user",content:"个人旧问题"},{role:"assistant",content:"个人旧回答".repeat(3000)}]
    const { inputTokenLimit } = await import("../output/runtime/core/chat/token-budget.js")
    const runCompact = () => chatService.runModelStepWithChannel({e:a,prompt:"你刚才和玖弦聊了什么",config:next,history:compactHistory,step:{id:"reply",task:"replyer",mode:"final"},channel:compactChannel,disableTools:true})
    const requestCount = requests.length
    const registrySend = adapterRegistry.sendMessage
    let compactResult
    let compactMetadata
    try {
      adapterRegistry.sendMessage = async function(request) { compactMetadata = request.metadata; return registrySend.call(this, request) }
      compactResult = await runCompact()
    } finally { adapterRegistry.sendMessage = registrySend }
    assert.equal(requests.length, requestCount + 1)
    assert.equal(requests.at(-1).channel.responsesRuntime.compactThreshold, Math.max(1, Math.floor(inputTokenLimit(next, { channel: compactChannel, maxTokens: requests.at(-1).maxTokens }) * 0.8)))
    assert(contentToText(current().content).includes("群聊参考资料"))
    assert(!compactResult.modelCalls.some(item => item.operation === "compact"))
    assert(!requests.at(-1).messages.some(item => item.content === compactHistory[1].content))
    assert(compactMetadata.localCompaction.messagesDropped > 0, "actual local trimming must be included in model log metadata")
    const { responsesStateKey } = await import("../output/runtime/models/configuration/responses-state.js")
    await chatService.runModelStepWithChannel({e:privateEvent,prompt:"继续",config:next,history:compactHistory,protocolState:{responses:{[responsesStateKey(compactChannel)]:{previousResponseId:"resp_old"}}},step:{id:"reply",task:"replyer",mode:"final"},channel:compactChannel,disableTools:true})
    assert.equal(requests.at(-1).channel.responsesRuntime.previousResponseId,"resp_old")
    assert(requests.at(-1).channel.responsesRuntime.compactThreshold > 0)
    // A mistaken read-only search gets one correction opportunity before forced delivery.
    const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
    const { normalizeTool } = await import("../output/runtime/tools/support/contract.js")
    const savedKnowledge = toolRegistry.get("knowledge_manage")
    const savedSend = mock.sendMessage
    const queries = []
    try {
      toolRegistry.tools.set("knowledge_manage", normalizeTool({
        name:"knowledge_manage",category:"search",risk:"low",tags:["search"],policy:{},
        parameters:{type:"object",properties:{action:{type:"string"},query:{type:"string"}},required:["query"]},
        execution:{effect:"read",repeatPolicy:"allow"},
        execute:async args=>{queries.push(args.query); return args.query.includes("Steam") ? "Steam 指令" : "瑞幸小黄油拿铁资料"},
      }))
      let turn = 0
      mock.sendMessage = async request=>{
        turn++
        const result = {id:`correction-${turn}`,text:"",stopReason:"tool_calls",usage:{input:1,output:1,total:2,source:"reported"}}
        if (turn===1) return {...result,toolCalls:[{id:"wrong-topic",name:"knowledge_manage",arguments:{action:"search",query:"Steam 特惠"}}]}
        if (turn===2) {
          assert.equal(request.toolChoice,"required")
          assert(request.tools.some(tool=>tool.name==="knowledge_manage"))
          return {...result,toolCalls:[{id:"correct-topic",name:"knowledge_manage",arguments:{action:"search",query:"瑞幸 小黄油拿铁"}}]}
        }
        assert.equal(request.toolChoice?.name,"message_send", "only one correction opportunity is allowed")
        return {...result,toolCalls:[{id:"deliver-corrected",name:"message_send",arguments:{parts:[{type:"text",text:"这是瑞幸的小黄油拿铁。"}]}}]}
      }
      const correctionConfig = structuredClone(next)
      correctionConfig.tools.enabled = true
      correctionConfig.tools.enabledTools = [...new Set([...correctionConfig.tools.enabledTools,"knowledge_manage","message_send"])]
      correctionConfig.tools.promptSelection.enabled = false
      correctionConfig.chat.maxToolRounds = 4
      await chatService.runModelStepWithChannel({e:{...observer,isMaster:true,reply:async()=>({message_id:"corrected-answer"})},
        prompt:"玉玉是瑞幸的，你去搜一下",config:correctionConfig,history:[],
        step:{id:"reply",task:"replyer",mode:"final"},channel:{id:"mock",type:"mock",model:"mock",modelConfig:{toolUse:true}}})
      assert.deepEqual(queries,["Steam 特惠","瑞幸 小黄油拿铁"])
      assert.equal(turn,3)
    } finally {
      if (savedKnowledge) toolRegistry.tools.set("knowledge_manage",savedKnowledge)
      else toolRegistry.tools.delete("knowledge_manage")
      mock.sendMessage = savedSend
    }
    mock.supportsVision = false
    await send({...imageEvent,message_id:"a6",message:[{type:"at",qq:"user-b"}]},"看看他的图片")
    assert(!Array.isArray(current().content) || !current().content.some(part => part.type === "image_url"))
  } finally {
    mock.sendMessage = originalSend
    mock.supportsNativeToolSearch = originalNative
    mock.protocol = originalProtocol
    mock.supportsVision = originalVision
    await chatService.clear(a)
    await chatService.clear(b)
    recentContextStore.clear()
    await configStore.save(config)
  }
}
