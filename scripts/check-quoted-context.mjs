import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"

/** 在 smoke 已建立的隔离运行根内验证真实对话组装，模型请求使用本地桩。 */
export async function checkQuotedContext(image) {
  const { resolveMediaContext, recentImageRecallMode, conversationImageFollowup, buildMediaUserContent } = await import("../output/runtime/core/message/media-context.js")
  const { mediaCacheDir, prepareMediaForVision } = await import("../output/runtime/core/media/media-cache.js")
  const { buildUserMessage } = await import("../output/runtime/core/persona/persona-chain.js")
  const { contentToText, extractMessageContext } = await import("../output/runtime/core/message/message-context.js")
  const { messagesForResponses } = await import("../output/runtime/models/adapters/openai/responses/request-adapter.js")
  const { configStore } = await import("../output/runtime/config/store.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const { recentContextStore } = await import("../output/runtime/core/chat/recent-context.js")
  const config = JSON.parse(JSON.stringify(await configStore.load()))
  const options = { quoteAsCurrent: true }
  const event = { isGroup: true, group_id: "quote-tests", user_id: "requester", message_id: "request", sender: { nickname: "提问者" } }
  const quotedText = "部署问题：\n1. 登录失败\n2. 图片很慢"
  const quote = { message_id: "quoted", sender: { user_id: "author", nickname: "原作者" }, message: [{ type: "text", text: quotedText }] }
  const textEvent = { ...event, reply_id: "quoted", source: quote }
  const resolved = await resolveMediaContext(textEvent, "埋埋看看这个", config, options)
  assert.equal(resolved.quote.text, quotedText, "引用正文须保留换行")
  assert.equal(recentImageRecallMode(resolved, "埋埋看看这个"), "none", "文字引用不能回看无关图片")
  assert(!conversationImageFollowup("再看看这个"), "新的省略式指代应遵循邻近消息，不能直接绑定旧会话图片")
  assert(conversationImageFollowup("第二张里面是什么，再仔细看看"))
  const textMessage = buildUserMessage(event, "埋埋看看这个", config, { media: resolved, vision: true })
  assert(contentToText(textMessage.content).includes(quotedText))
  assert(contentToText(textMessage.content).indexOf(quotedText) < contentToText(textMessage.content).indexOf("提问者"))
  assert.equal(extractMessageContext({ message: [{ type: "text", text: "原始敏感正文" }] }, "过滤后的正文").text, "过滤后的正文")

  const bad = await resolveMediaContext({ ...event, reply_id: "wanted", getReply: async () => [{ message_id: "wrong", text: "不该出现" }] }, "看看这个", config, options)
  assert.equal(bad.quote.status, "unavailable")
  assert.equal(bad.quote.messageId, "wanted")
  assert(!buildMediaUserContent("看看这个", bad).includes("不该出现"))
  assert.equal(recentImageRecallMode(bad, "看看这个"), "none")
  const partial = await resolveMediaContext({ ...event, source: { seq: "sequence", user_id: "author" }, getReply: async () => ({ text: quotedText }) }, "看看这个", config, options)
  assert.equal(partial.quote.messageId, "sequence")
  assert.equal(partial.quote.sender.userId, "author")

  // 引用事件里的图片 URL 可能已经过期；必须先按引用 ID 重新读取消息，
  // getReply/历史和事件快照都只能作为失败时的兼容回退。
  const staleQuoteImage = "data:image/png;base64,AAAA"
  const freshQuoteImage = "data:image/png;base64,QUJDRA=="
  let getMessageCalls = 0
  let getReplyCalls = 0
  const freshQuoteEvent = {
    ...event,
    reply_id: "fresh-quote",
    source: { message_id: "fresh-quote", sender: { user_id: "author", nickname: "原作者" }, message: [{ type: "image", url: staleQuoteImage }] },
    getMessage: async messageId => {
      getMessageCalls += 1
      assert.equal(messageId, "fresh-quote")
      return { message_id: "fresh-quote", sender: { user_id: "author", nickname: "原作者" }, message: [{ type: "image", url: freshQuoteImage }] }
    },
    getReply: async () => {
      getReplyCalls += 1
      return { message_id: "fresh-quote", message: [{ type: "image", url: staleQuoteImage }] }
    },
  }
  const freshResolved = await resolveMediaContext(freshQuoteEvent, "埋埋看看这个", config, options)
  assert.equal(getMessageCalls, 1)
  assert.equal(getReplyCalls, 0)
  assert.equal(freshResolved.quote.attachments.find(item => item.source === "quote")?.url, freshQuoteImage)
  const freshPrepared = await prepareMediaForVision(freshResolved, config)
  const freshAttachment = freshPrepared.attachments.find(item => item.source === "quote" && item.kind === "image")
  assert.equal(freshAttachment.preparedUrl, freshQuoteImage)
  assert.equal(freshAttachment.cacheKey, undefined, "引用图片不能产生会话缓存键")
  assert.notEqual(freshAttachment.cached, true, "引用图片不能命中图片缓存")
  const freshCacheId = crypto.createHash("sha256").update(freshQuoteImage).digest("hex")
  for (const suffix of [".json", ".bin"]) {
    await assert.rejects(fs.access(`${mediaCacheDir}/${freshCacheId}${suffix}`), "引用图片正文不能写入媒体缓存")
  }

  const imageEvent = { ...event, reply_id: "quoted", source: { ...quote, message: [{ type: "image", url: image }] }, img: [image] }
  const disabled = await resolveMediaContext(imageEvent, "埋埋看看这个", { mediaRecognition: { includeQuotedMedia: false } }, options)
  assert(disabled.attachments.every(item => item.visionEligible === false), "宿主重复展开不能绕过引用媒体开关")
  const avatar = await resolveMediaContext({ ...textEvent, message: [{ type: "at", qq: "another-user" }] }, "埋埋看看这个", config, options)
  assert(!avatar.attachments.some(item => item.source === "at-avatar"), "引用文字不能自动切到被提及者头像")
  const automatic = await resolveMediaContext(imageEvent, "埋埋觉得呢", config, options)
  assert.equal(automatic.attachments.filter(item => item.visionEligible).length, 1)
  const prepared = await prepareMediaForVision(automatic, config)
  const visionContent = buildMediaUserContent("埋埋觉得呢", prepared, true)
  assert.equal(visionContent.filter(part => part.type === "image_url").length, 1)
  assert(visionContent[0].text.includes("主要对象"))
  assert(visionContent.at(-1).text.includes("埋埋觉得呢"))
  const responseInput = messagesForResponses([{ role: "user", content: visionContent }])
  assert.equal(responseInput[0].content.filter(part => part.type === "input_image").length, 1)
  assert(responseInput[0].content.some(part => part.text?.includes("原作者")))

  const newImage = "data:image/png;base64,AAAA"
  const bothEvent = { ...imageEvent, img: [], message: [{ type: "image", url: newImage }] }
  for (const [prompt, count, source] of [["只看这次新发的图", 1, "current"], ["只看引用的图", 1, "quote"], ["对比这次新发的图和引用图", 2, null]]) {
    const selected = await resolveMediaContext(bothEvent, prompt, config, options)
    const included = selected.attachments.filter(item => item.visionEligible)
    assert.equal(included.length, count, prompt)
    if (source) assert.equal(included[0].source, source, prompt)
  }
  const management = await resolveMediaContext(imageEvent, "撤回这条消息", config, options)
  assert(management.attachments.every(item => !item.visionEligible))
  const duplicateCurrent = await resolveMediaContext({ ...event, message: [{ type: "image", url: image }], img: [image] }, "看看这个", config, options)
  assert.equal(duplicateCurrent.attachments.filter(item => item.visionEligible).length, 1, "当前图片也须在预取前去重")
  const manyImages = await resolveMediaContext({
    ...bothEvent,
    source: { ...quote, message: [image, "data:image/png;base64,BBBB", "data:image/png;base64,CCCC"].map(url => ({ type: "image", url })) },
  }, "对比这次新图和引用图片", config, options)
  const limited = await prepareMediaForVision(manyImages, { ...config, mediaRecognition: { ...config.mediaRecognition, remoteFetch: { ...config.mediaRecognition.remoteFetch, maxAttachments: 2 } } })
  assert.deepEqual(limited.attachments.filter(item => item.preparedUrl).map(item => item.imageNumber), [1, 4], "附件限额须保留两侧来源及原始编号")
  assert(limited.attachments.filter(item => item.limitSkipped).length === 2)
  const unsupported = await resolveMediaContext({ ...event, source: { message: [{ type: "record", url: "https://example.invalid/audio" }] } }, "听听这个", config, options)
  const unsupportedContent = buildMediaUserContent("听听这个", unsupported, true)
  assert.equal(typeof unsupportedContent, "string")
  assert(!unsupportedContent.includes("https://example.invalid/audio"))

  const mock = adapterRegistry.get("mock")
  const originalSend = mock.sendMessage
  const originalVision = mock.supportsVision
  const requests = []
  try {
    mock.supportsVision = true
    mock.sendMessage = async ({ messages, event: caller }) => {
      requests.push({ messages, caller })
      return { id: `quoted-turn-${requests.length}`, text: "第二点主要是图片加载问题。", toolCalls: [], stopReason: "end_turn", usage: { input: 1, output: 1, total: 2, source: "reported" } }
    }
    const send = (e, prompt) => chatService.send(e, prompt, { disableTools: true, persistMemory: false })
    const lastContent = () => requests.at(-1).messages.findLast(item => item.role === "user").content
    recentContextStore.record({ ...event, message_id: "unrelated", message: [{ type: "image", url: newImage }] })
    const textResult = await send(textEvent, "埋埋看看这个")
    assert.equal(requests.at(-1).caller.user_id, "requester", "引用作者不能成为权限主体")
    assert.equal(typeof lastContent(), "string", "引用纯文字不应补入邻近图片")
    assert(lastContent().includes(quotedText))
    assert((await chatService.getHistory(textResult.conversationKey)).some(item => String(item.content).includes(quotedText)))
    await send(event, "那第二点呢")
    assert(requests.at(-1).messages.some(item => String(item.content).includes(quotedText)))
    await send({ ...textEvent, source: { ...quote, message: [{ type: "text", text: "长引用".repeat(50000) }] } }, "看看这个")
    assert(lastContent().length < 12000 && lastContent().includes("可能不完整"), "过长引用必须有界并声明截取")

    const imageResult = await send(bothEvent, "比较这两张图")
    const saved = (await chatService.getHistory(imageResult.conversationKey)).findLast(item => item.role === "user")
    assert.equal(saved.metadata.imageReferences.length, 1, "引用图片只在当前请求使用，不能写入会话图片引用")
    assert(saved.metadata.imageReferences.every(item => item.source !== "quote"))
    assert(!JSON.stringify(saved).includes(image.split(",")[1]), "历史不得保存图片二进制正文")
    await send(event, "第二张里面是什么，再仔细看看")
    assert.equal(lastContent().filter(part => part.type === "image_url").length, 1, "后续只可回看上一轮的普通图片")
    assert(contentToText(lastContent()).includes("上轮讨论的"))
    const history = await chatService.getHistory(imageResult.conversationKey)
    history.findLast(item => item.role === "user").metadata.imageReferences.forEach(item => { item.cacheKey = "0".repeat(64) })
    await send(event, "再仔细看看")
    assert.equal(typeof lastContent(), "string")
    assert(lastContent().includes("图片读取失败"), "失效缓存不能改看群里其他图片")

    const disabledConfig = JSON.parse(JSON.stringify(config))
    disabledConfig.mediaRecognition.enabled = false
    await configStore.save(disabledConfig)
    await send(textEvent, "看看这个")
    assert(lastContent().includes(quotedText), "媒体关闭时仍应识别引用文字")
    await send(imageEvent, "看看这个")
    assert.equal(typeof lastContent(), "string")

    const filterConfig = JSON.parse(JSON.stringify(config))
    filterConfig.response.messageFilters = { enabled: true, filters: [{ id: "quote-redact", enabled: true, stage: "input", priority: 100, implementation: { type: "filter", id: "keyword_filter", arguments: { keywords: "登录失败", action: "remove" } } }] }
    await configStore.save(filterConfig)
    await send(textEvent, "看看这个")
    assert(!lastContent().includes("登录失败"), "引用正文必须经过输入过滤")
    mock.supportsVision = false
    await send(imageEvent, "看看这个")
    assert.equal(typeof lastContent(), "string")
    assert(lastContent().includes("本轮未提供图片内容"))
  } finally {
    mock.sendMessage = originalSend
    mock.supportsVision = originalVision
    await chatService.clear(event)
    recentContextStore.clear()
    await configStore.save(config)
  }
}
