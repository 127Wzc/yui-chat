import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter, once } from "node:events"
import { fileURLToPath } from "node:url"
import express from "express"
import compression from "compression"
import { createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-web-chat-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.chdir(path.resolve(root, "../.."))
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = {}
global.plugin = class {}
let sqliteClient, server, modelLogStore
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const boundedWait = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("stream fixture timed out")), 3000) })]) } finally { clearTimeout(timer) } }
try {
  const { configStore, tempDir } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  await sqliteClient.init(await configStore.load())
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { MessageSendTool } = await import("../output/runtime/tools/builtins/media.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { createWebApp } = await import("../output/runtime/web/http/app.js")
  const { createWebMessageAdapter } = await import("../output/runtime/web/http/chat-message-adapter.js")
  const { cacheWebDeliveryMedia, readWebDeliveryMedia } = await import("../output/runtime/core/media/media-cache.js")
  const { deliverMessageChain } = await import("../output/runtime/core/message-chain/delivery.js")
  const { conversationStore } = await import("../output/runtime/core/chat/conversation-store.js")
  const { deliverRenderedImage, deliverImages } = await import("../output/runtime/core/rendering/render-delivery.js")
  const { createWebTestEvent } = await import("../output/runtime/web/http/request-context.js")
  const { SendDiceTool, SendRpsTool } = await import("../output/runtime/tools/builtins/entertainment.js")
  const { renderRichContent } = await import("../output/runtime/web/client/shared/rich-content.js")
  const { filterRegistry } = await import("../output/runtime/filters/core/registry.js")
  const { createBuiltinFilters } = await import("../output/runtime/filters/builtins/index.js")
  for (const filter of createBuiltinFilters()) filterRegistry.register(filter)
  toolRegistry.register(new MessageSendTool())
  let toolRuns = 0
  toolRegistry.register({ name: "web_fixture", source: "builtin", category: "search", risk: "low", tags: ["search"], policy: {},
    description: "Read a fixture table", parameters: { type: "object", properties: {} }, execution: { effect: "read", retryPolicy: "none" },
    execute: () => { toolRuns++; return "| 名称 | 数量 |\n| --- | --- |\n| 测试 | 2 |" } })
  await configStore.update(config => {
    config.web.authToken = "web-chat-test-token"
    for (const model of config.models) model.visual = true
    config.tools.enabled = true
    config.tools.enabledTools = ["web_fixture", "message_send"]
    config.tools.promptSelection.enabled = false
    config.response.messageFilters = { enabled: true, filters: [{ id: "body", enabled: true, stage: "output", priority: 100,
      implementation: { type: "filter", id: "text_transform", arguments: { operation: "append", suffix: " [已过滤]" } } }] }
  })
  await fs.mkdir(tempDir, { recursive: true })
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64")
  const localImage = path.join(tempDir, "fixture.png")
  await fs.writeFile(localImage, image)
  const table = "# 结果\n\n| 名称 | 数量 |\n| --- | --- |\n| 测试 | 2 |"
  const parts = [{ type: "text", text: table }, { type: "image", source: { kind: "path", value: localImage } },
    { type: "forward", nodes: [{ nickname: "来源 <script>", parts: [{ type: "text", text: "**引用**" }, { type: "image", source: { kind: "bytes", value: image.toString("base64"), mimeType: "image/png" } }] }] }]
  let backgroundMode = false, imageMode = false, backgroundName = "web_background"
  let streamMode = "", streamGate = deferred(), streamAborted = deferred(), foregroundGate = deferred()
  const originalAdapter = adapterRegistry.get("mock")
  let receivedImages = []
  adapterRegistry.register({ ...originalAdapter, id: "mock", supportsTools: true, supportsVision: true, supportsStreaming: true,
    async sendMessage(request) {
      receivedImages = request.messages.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === "image_url") : [])
      const usage = { input: 1, output: 1, total: 2 }
      if (streamMode === "tool") {
        const executed = request.messages.some(item => item.role === "tool" && item.name === "web_wait")
        return { id: "foreground", text: executed ? "工具结束" : "", toolCalls: executed ? [] : [{ id: "foreground-call", name: "web_wait", arguments: { credential: "foreground-secret" } }], usage }
      }
      if (streamMode) {
        assert.equal(request.channel.stream, true)
        request.onDelta?.({ type: "reasoning", text: '分析摘要。api_key="a-secret"' })
        request.onDelta?.({ type: "text", text: "首段" })
        if (streamMode === "cancel") await new Promise((_, reject) => {
          const abort = () => { streamAborted.resolve(); reject(request.signal.reason) }
          request.signal.addEventListener("abort", abort, { once: true })
          if (request.signal.aborted) abort()
        })
        await streamGate.promise
        request.onDelta?.({ type: "text", text: "末段" })
        return { id: "streamed", text: "首段末段", reasoningText: '分析摘要。api_key="a-secret"', toolCalls: [], usage }
      }
      if (!request.tools?.length) return { id: "plain", text: "普通回复", toolCalls: [], usage }
      const latest = request.messages.filter(item => item.role === "tool").at(-1)
      if (imageMode) return { id: "drawing", text: latest ? "<EMPTY>" : "", toolCalls: latest ? [] : [{ id: "draw-call", name: "generate_image", arguments: { prompt: "画一只猫", referenceImages: [] } }], usage }
      if (backgroundMode) return { id: "background", text: latest ? "等待后台图片" : "", toolCalls: latest ? [] : [{ id: "background-call", name: backgroundName, arguments: {} }], usage }
      if (!latest) return { id: "call", text: "", toolCalls: [{ id: "fixture-call", name: "web_fixture", arguments: {} }], usage }
      if (latest.name === "web_fixture") return { id: "delivery", text: "", toolCalls: [{ id: "send-call", name: "message_send", arguments: { parts } }], usage }
      return { id: "done", text: "<EMPTY>", toolCalls: [], usage }
    } })
  const app = express()
  app.use(compression({ threshold: 0 }))
  let previewDownloads = 0
  app.get("/fixture-image", (_req, res) => { previewDownloads++; res.type("image/png").send(image) })
  app.use("/yui-chat", createWebApp())
  server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { "content-type": "application/json", "yui-chat-token": "web-chat-test-token" }
  const post = async (sessionId, enableTools) => {
    const response = await fetch(`${origin}/yui-chat/api/chat/test`, { method: "POST", headers, body: JSON.stringify({ prompt: "读取测试表格并投递", sessionId, enableTools }) })
    const payload = await response.json()
    assert(response.ok, JSON.stringify(payload))
    return payload
  }
  assert.equal((await post("plain")).session.messages.length, 2)
  assert.equal(toolRuns, 0, "tools stay off unless explicitly enabled")
  assert.equal((await post("string-false", "true")).session.messages.length, 2)
  assert.equal(toolRuns, 0, "only a boolean true enables execution")
  const upload = async (body, authorized = true) => fetch(`${origin}/yui-chat/api/chat/attachments`, { method: "POST", headers: authorized ? headers : { "content-type": "application/json" }, body: JSON.stringify(body) })
  const imageDataUrl = `data:image/png;base64,${image.toString("base64")}`
  assert.equal((await upload({ name: "test.png", dataUrl: imageDataUrl }, false)).status, 401)
  assert.equal((await upload({ name: "bad.svg", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" })).status, 400)
  const uploadedResponse = await upload({ name: "test.png", dataUrl: imageDataUrl })
  assert.equal(uploadedResponse.status, 200)
  const uploaded = await uploadedResponse.json()
  assert.equal((await fetch(`${origin}${uploaded.url}`)).status, 401)
  assert.equal((await fetch(`${origin}${uploaded.url}`, { headers })).status, 200)
  const withImage = await fetch(`${origin}/yui-chat/api/chat/test`, { method: "POST", headers, body: JSON.stringify({ prompt: "看看这张图片", sessionId: "uploaded-image", enableTools: false, attachments: [uploaded.id] }) })
  const imageTurn = await withImage.json()
  assert.equal(withImage.status, 200)
  assert(receivedImages.some(part => part.image_url.url === imageDataUrl), "the uploaded original reaches the vision input")
  assert(renderRichContent(imageTurn.session.messages.find(item => item.role === "user").content).includes(uploaded.url), "uploaded images remain visible in completed history")
  const imageHistory = await conversationStore.getWebTestSession(imageTurn.result.conversationKey)
  assert(renderRichContent(imageHistory.messages.find(item => item.role === "user").content).includes(uploaded.url))
  for (const attachments of [["/etc/passwd"], ["0".repeat(64)], Array(4).fill(uploaded.id)]) {
    const invalid = await fetch(`${origin}/yui-chat/api/chat/test`, { method: "POST", headers, body: JSON.stringify({ prompt: "invalid", attachments }) })
    assert.equal(invalid.status, 400, "attachment references cannot read arbitrary paths or expired entries")
  }
  const { registerRuntimeRoutes } = await import("../output/runtime/web/http/routes/runtime.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  const runtimeHandlers = new Map()
  registerRuntimeRoutes(Object.fromEntries(["get", "post", "delete"].map(method => [method, (route, ...handlers) => runtimeHandlers.set(`${method} ${route}`, handlers.at(-1))])))
  for (const failRead of [false, true]) {
    const readStarted = deferred(), releaseRead = deferred(), responseEvents = new EventEmitter()
    const originalRead = fs.readFile, originalSend = chatService.send
    const previousToolRuns = toolRuns
    let imageReads = 0, modelRuns = 0, handling
    fs.readFile = async function(file, ...args) {
      if (String(file).endsWith(`${uploaded.id}.bin`)) {
        imageReads++
        readStarted.resolve()
        await releaseRead.promise
        if (failRead) throw new Error("fixture image read failed after cancellation")
      }
      return originalRead.call(this, file, ...args)
    }
    chatService.send = async () => { modelRuns++; return { text: "must not run", historySaved: false } }
    const response = {
      writableLength: 0, set() { return this }, flushHeaders() {}, write() { return true },
      on: responseEvents.on.bind(responseEvents), end() { responseEvents.emit("close") },
      status() { throw new Error("canceled streams must not write JSON errors") }, json() { throw new Error("expected stream") },
    }
    try {
      handling = runtimeHandlers.get("post /api/chat/test")({ body: { prompt: "读取图片时取消", stream: true, enableTools: true, attachments: [uploaded.id, uploaded.id] }, query: {}, params: {} }, response)
      await boundedWait(readStarted.promise)
      assert(responseEvents.listenerCount("close") > 0, "disconnect listening starts before image reading")
      responseEvents.emit("close")
      releaseRead.resolve()
      await boundedWait(handling)
      assert.equal(modelRuns, 0, "canceling during image preparation never starts a model, even when tools are enabled")
      assert.equal(toolRuns, previousToolRuns)
      assert.equal(imageReads, 1, "cancellation prevents reading subsequent attachments")
    } finally {
      responseEvents.emit("close"); releaseRead.resolve()
      await handling?.catch(() => {}) // 失败回归也先结束在途请求，再恢复测试替身。
      fs.readFile = originalRead; chatService.send = originalSend
    }
  }
  adapterRegistry.get("mock").supportsVision = false
  await configStore.update(config => { for (const model of config.models) model.visual = false })
  const response = await post("rich", true)
  assert.equal(toolRuns, 1, JSON.stringify(response))
  assert(response.result.toolChain.some(item => item.name === "message_send" && item.status === "ok"))
  assert(response.session.messages.some(item => item.role === "tool" && item.name === "web_fixture" && renderRichContent(item.content).includes("<table")))
  const delivered = response.session.messages.find(item => Array.isArray(item.content))
  assert(delivered, JSON.stringify(response))
  const html = renderRichContent(delivered.content)
  assert.match(html, /<table/)
  assert.match(html, /已过滤/)
  assert.equal((html.match(/<img /g) || []).length, 2)
  assert.match(html, /yui-rich-forward/)
  assert(!html.includes("<script>"))
  assert(!JSON.stringify(delivered).includes(localImage), "display data never contains a local file path")
  const mediaPath = delivered.content.find(item => item.type === "image").source.value
  assert.equal((await fetch(`${origin}${mediaPath}`)).status, 401)
  const media = await fetch(`${origin}${mediaPath}`, { headers })
  assert.equal(media.status, 200)
  assert.equal(media.headers.get("content-type"), "image/png")
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), image)
  assert.match(media.headers.get("content-security-policy"), /sandbox/)
  const login = await fetch(`${origin}/yui-chat/api/auth/session`, { method: "POST", headers, body: "{}" })
  const cookie = login.headers.get("set-cookie").split(";")[0]
  assert.equal((await fetch(`${origin}${mediaPath}`, { headers: { cookie } })).status, 200, "browser images use the HttpOnly session cookie")
  const sessions = await (await fetch(`${origin}/yui-chat/api/chat/test/sessions`, { headers })).json()
  assert(sessions.sessions.every(item => !("messages" in item)), "the sidebar never downloads full transcripts")
  const detailUrl = `${origin}/yui-chat/api/chat/test/sessions/${encodeURIComponent(response.session.key)}`
  assert.equal((await fetch(detailUrl)).status, 401)
  assert.deepEqual((await (await fetch(detailUrl, { headers })).json()).session.messages, response.session.messages, "selected history retains rich content and tool results")
  assert.equal((await fetch(`${origin}/yui-chat/api/chat/test/sessions/not-a-web-key`, { headers })).status, 404)
  assert.equal(response.session.messages.filter(item => item.role === "assistant").length, 1, "delivered body is not repeated")

  const remoteImage = `${origin}/fixture-image`
  const preview = (url, requestHeaders = headers) => fetch(`${origin}/yui-chat/api/chat/media/preview`, { method: "POST", headers: requestHeaders, body: JSON.stringify({ url }) })
  assert.equal((await preview(remoteImage, { "content-type": "application/json" })).status, 401)
  await configStore.update(config => { config.security.linkSafety.allowPrivateHosts = false })
  for (const url of [remoteImage, "http://[::1]/image.png", "http://2130706433/image.png", "http://user:password@example.com/image.png", "file:///etc/passwd", "data:image/png;base64,AA=="]) {
    assert.equal((await preview(url)).status, 400, url)
  }
  assert.equal(previewDownloads, 0, "denied previews never reach the target")
  const crossOriginPreview = await preview(remoteImage, { cookie, "content-type": "application/json", origin: "https://untrusted.invalid" })
  assert.equal(crossOriginPreview.status, 401, "cookie-authenticated cross-origin previews are rejected")
  await configStore.update(config => { config.security.linkSafety.allowPrivateHosts = true })
  const cachedPreview = await (await preview(remoteImage)).json()
  assert(cachedPreview.ok, JSON.stringify(cachedPreview))
  assert.equal(previewDownloads, 1)
  assert.deepEqual(Buffer.from(await (await fetch(`${origin}${cachedPreview.url}`, { headers: { cookie } })).arrayBuffer()), image)
  for (const content of [
    { type: "image", source: { kind: "url", value: remoteImage } },
    { type: "image_url", image_url: { url: remoteImage } },
    `![图片](${remoteImage})`, `> ![图片](${remoteImage})`, `- ![图片](${remoteImage})`,
    `<img src="${remoteImage}" onerror="alert(1)">`,
    { type: "forward", nodes: [{ parts: [{ type: "image", source: { kind: "url", value: remoteImage } }] }] },
    { type: "video", source: { kind: "url", value: remoteImage } },
  ]) {
    const protectedHtml = renderRichContent(content, { cacheRemoteMedia: true })
    assert(!/\bsrc="https?:/i.test(protectedHtml), protectedHtml)
    assert.match(protectedHtml, /data-chat-media-url=/)
    assert(!protectedHtml.includes('onerror="'))
    assert.match(renderRichContent(content, { cacheRemoteMedia: true, mediaUrls: { [remoteImage]: cachedPreview.url } }), /(?:src|href)="\/yui-chat\/api\/chat\/media\//)
  }
  const deep = JSON.parse("[".repeat(4000) + "0" + "]".repeat(4000))
  assert.match(renderRichContent(deep), /已省略/)
  let nested = { type: "image", source: { kind: "url", value: remoteImage } }
  for (let i = 0; i < 4000; i++) nested = { content: [nested] }
  assert.match(renderRichContent(nested), /已省略/)
  const wide = renderRichContent(Array(10000).fill("item"))
  assert(wide.length < 40000 && wide.includes("已省略"), "wide results also have a shared node budget and an explicit notice")
  assert.match(renderRichContent({ data: [{ arbitrary: "ordinary log object" }] }), /ordinary log object/, "bounded display preserves ordinary object coercion")
  const protoInput = JSON.parse('{"__proto__":{"text":"inherited content"},"ordinary":"own value"}')
  assert.match(renderRichContent(protoInput), /own value/, "JSON keys cannot become inherited display fields")

  const listOriginal = conversationStore.listWebTestSessions
  try {
    conversationStore.listWebTestSessions = async () => { throw new Error("completion must use the keyed detail lookup") }
    assert((await post("keyed-detail")).session)
  } finally { conversationStore.listWebTestSessions = listOriginal }
  for (let i = 0; i < 50; i++) await conversationStore.save({
    id: `mock:p:web-test-large-${i}`, history: [{ role: "user", content: `large ${i}` }],
    turns: [{ id: "large", progress: [{ kind: "model", text: "x".repeat(450000) }] }],
  })
  const summaries = await (await fetch(`${origin}/yui-chat/api/chat/test/sessions`, { headers })).text()
  assert(Buffer.byteLength(summaries) < 20000, "large progress histories do not inflate the sidebar payload")
  for (let i = 0; i < 50; i++) await conversationStore.deleteWebTestSession(`mock:p:web-test-large-${i}`)

  const { createApiClient } = await import("../output/runtime/web/client/app/store/api.js")
  const streamingClient = createApiClient({ basePath: `${origin}/yui-chat`, getToken: () => headers["yui-chat-token"] })
  const firstChunk = deferred(), events = []
  streamMode = "stream"
  let finishedStream = false
  const streaming = streamingClient.requestStream("/api/chat/test", { method: "POST", body: JSON.stringify({ prompt: "流式测试", sessionId: "stream", stream: true, enableTools: true }) }, (type, event) => {
    events.push({ type, event })
    if (type === "progress" && event.text === "首段") firstChunk.resolve()
  }).then(result => { finishedStream = true; return result })
  await boundedWait(firstChunk.promise)
  assert.equal(finishedStream, false, "text arrives before the upstream request completes")
  assert(events.some(item => item.event.reasoning?.includes("分析摘要")))
  assert(!JSON.stringify(events).includes("a-secret"), "visible reasoning is redacted before transport")
  streamGate.resolve()
  const streamResult = await streaming
  assert.equal(streamResult.result.text, "首段末段")
  const processMessage = streamResult.session.messages.find(item => item.role === "process")
  assert(processMessage.progress.some(item => item.tools?.some(tool => tool.name === "web_fixture")))
  assert(!JSON.stringify(processMessage).includes("a-secret"), "process history is redacted too")
  streamMode = "cancel"
  streamGate = deferred(); streamAborted = deferred()
  const cancelController = new AbortController(), cancelFirst = deferred()
  const canceled = streamingClient.requestStream("/api/chat/test", { method: "POST", signal: cancelController.signal, body: JSON.stringify({ prompt: "停止测试", sessionId: "cancel", stream: true }) }, (type, event) => { if (type === "progress" && event.text === "首段") cancelFirst.resolve() })
  await boundedWait(cancelFirst.promise)
  cancelController.abort()
  await assert.rejects(canceled, /abort/i)
  await boundedWait(streamAborted.promise)
  streamMode = ""

  toolRegistry.register({ name: "web_wait", source: "builtin", category: "utility", risk: "low", tags: [], policy: {}, description: "Foreground progress fixture",
    parameters: { type: "object", properties: { credential: { type: "string" } } }, execution: { effect: "read", timeoutMs: 3000 },
    execute: async args => { assert.equal(args.credential, "foreground-secret", "observation must not mutate actual arguments"); await foregroundGate.promise; return "前台工具完成" } })
  await configStore.update(config => { config.tools.enabledTools.push("web_wait") })
  streamMode = "tool"
  const toolStarted = deferred(), toolEvents = []
  let toolRequestFinished = false
  const foreground = streamingClient.requestStream("/api/chat/test", { method: "POST", body: JSON.stringify({ prompt: "前台工具测试", sessionId: "foreground", stream: true, enableTools: true }) }, (type, event) => {
    toolEvents.push({ type, event })
    if (type === "progress" && event.kind === "tool" && event.name === "web_wait" && event.status === "running") toolStarted.resolve()
  }).then(result => { toolRequestFinished = true; return result })
  try {
    await boundedWait(toolStarted.promise)
    assert.equal(toolRequestFinished, false)
    assert(!JSON.stringify(toolEvents).includes("foreground-secret"))
  } finally { foregroundGate.resolve() }
  const foregroundResult = await foreground
  assert(toolEvents.some(item => item.event.kind === "tool" && item.event.status === "ok" && item.event.result === "前台工具完成"))
  assert(foregroundResult.session.messages.some(item => item.role === "process"))
  streamMode = ""

  let releaseBackground
  const backgroundGate = new Promise(resolve => { releaseBackground = resolve })
  toolRegistry.register({ name: "web_background", source: "builtin", category: "media", risk: "low", tags: ["media"], policy: {},
    description: "Background fixture", parameters: { type: "object", properties: {} }, execution: { effect: "read", backgroundSilent: true },
    autoDelivery: { via: "message_send", continueConversation: true },
    execute: async () => { await backgroundGate; return { status: "success", metadata: { messageSendPlan: { parts: [parts[1]] } } } } })
  await configStore.update(config => { config.tools.enabledTools.push("web_background") })
  backgroundMode = true
  const background = await post("background", true)
  assert(background.session.messages.some(item => ["running", "queued"].includes(item.status)))
  releaseBackground()
  let completed
  for (let i = 0; i < 100; i++) {
    completed = await conversationStore.getWebTestSession(background.session.key)
    if (completed?.messages.some(item => Array.isArray(item.content))) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(completed.messages.some(item => Array.isArray(item.content) && renderRichContent(item.content).includes("<img ")), "late automatic delivery updates the original persisted turn")
  assert(completed.messages.some(item => item.role === "tool" && item.status === "ok"))
  backgroundMode = false

  const noticeGate = deferred(), noticeCompleted = deferred()
  toolRegistry.register({ name: "web_background_notice", source: "builtin", category: "media", risk: "low", tags: [], policy: {},
    description: "Background start notice fixture", parameters: { type: "object", properties: {} },
    backgroundMessage: "正在准备后台媒体。", requiresFinalReply: false,
    autoDelivery: { via: "message_send", continueConversation: false },
    execution: { effect: "read", background: true },
    execute: async () => { await noticeGate.promise; noticeCompleted.resolve(); return "后台媒体完成" } })
  await configStore.update(config => { config.tools.enabledTools.push("web_background_notice") })
  backgroundMode = true; backgroundName = "web_background_notice"
  let notice
  try {
    notice = await post("background-notice", true)
    assert(notice.session.messages.some(item => Array.isArray(item.content) && item.content.some(part => part.type === "text" && part.text.includes("正在准备后台媒体。"))), "background start notices use the current Web adapter")
  } finally { noticeGate.resolve(); backgroundMode = false; backgroundName = "web_background" }
  await boundedWait(noticeCompleted.promise)
  for (let i = 0; i < 100; i++) {
    const session = await conversationStore.getWebTestSession(notice.session.key)
    if (session.messages.some(item => item.role === "tool" && item.name === "web_background_notice" && item.status === "ok")) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  // 拒绝发送的适配器必须优先于同一事件中仍可用的宿主 reply。
  for (const deny of [false, true]) {
    const completed = deferred()
    const result = await toolRegistry.execute("web_background_notice", {}, {
      config: configStore.get(), e: { isMaster: true, reply: () => { throw new Error("must not send directly") } },
      ...(deny ? { delivery: { adapter: { ...createWebMessageAdapter(configStore.get()), canSend: () => false } } } : {}),
      execution: { onBackgroundComplete: () => completed.resolve() },
    })
    assert.equal(Boolean(result.metadata.messageSendPlan), !deny, "host fallback remains available, but never overrides an adapter denial")
    await boundedWait(completed.promise)
  }

  const adapter = createWebMessageAdapter(configStore.get())
  const context = { config: configStore.get(), adapter }
  const forbidden = path.join(runtimeRoot, "outside.txt")
  await fs.writeFile(forbidden, "private")
  assert.equal((await deliverMessageChain([{ type: "image", source: { kind: "path", value: forbidden } }], context)).status, "failed")
  const strict = structuredClone(configStore.get())
  strict.security.linkSafety.allowPrivateHosts = false
  assert.equal((await deliverMessageChain([{ type: "image", source: { kind: "url", value: `${origin}/private` } }], { ...context, config: strict, adapter: createWebMessageAdapter(strict) })).status, "failed")
  assert.equal((await deliverMessageChain(parts, { ...context, destination: { type: "group", id: "123" } })).status, "failed")
  assert.equal(adapter.getDisplayContent().length, 0, "rejected deliveries cannot appear successful")
  const renderedContext = { e: createWebTestEvent("rendered"), config: configStore.get(), delivery: { adapter } }
  assert.match(await deliverRenderedImage({ buffer: image }, renderedContext), /当前网页/)
  assert.match(await deliverImages([{ buffer: image }], renderedContext), /当前网页/)
  assert.equal(adapter.getDisplayContent().length, 2, "render_image and multi-image helpers use the Web outlet")
  assert.match(renderRichContent(adapter.getDisplayContent()), /<img /)
  toolRegistry.register(new SendDiceTool())
  toolRegistry.register(new SendRpsTool())
  await configStore.update(config => { config.tools.enabledTools.push("send_dice", "send_rps") })
  await toolRegistry.execute("send_dice", { count: 1 }, { ...renderedContext, config: configStore.get() })
  await toolRegistry.execute("send_rps", { value: 1 }, { ...renderedContext, config: configStore.get() })
  assert.deepEqual(adapter.getDisplayContent().slice(-2).map(item => item.type), ["dice", "rps"])
  const sampleMedia = Buffer.from("media fixture")
  const mediaParts = ["audio", "video", "file"].map(type => ({ type, name: `fixture.${type}`, source: { kind: "bytes", value: sampleMedia.toString("base64"), mimeType: type === "audio" ? "audio/ogg" : type === "video" ? "video/mp4" : "application/octet-stream" } }))
  const sentMedia = await toolRegistry.execute("message_send", { parts: mediaParts }, { ...renderedContext, config: configStore.get() })
  assert.equal(sentMedia.receipt.status, "sent")
  for (const part of adapter.getDisplayContent().slice(-3)) {
    assert.match(part.source.value, /^\/yui-chat\/api\/chat\/media\/[a-f0-9]{64}$/)
    const resource = await fetch(`${origin}${part.source.value}`, { headers: { cookie } })
    assert.equal(resource.status, 200)
    assert.deepEqual(Buffer.from(await resource.arrayBuffer()), sampleMedia)
  }
  const mediaHtml = renderRichContent(adapter.getDisplayContent().slice(-3), { cacheRemoteMedia: true })
  assert.match(mediaHtml, /<audio /); assert.match(mediaHtml, /<video /); assert.match(mediaHtml, /fixture.file/)

  const { CommandHandoffTool } = await import("../output/runtime/tools/builtins/command.js")
  const { DrawHandoffTool } = await import("../output/runtime/tools/builtins/media.js")
  const { knowledgeStore } = await import("../output/runtime/knowledge/store.js")
  await knowledgeStore.init()
  toolRegistry.register(new CommandHandoffTool())
  toolRegistry.register(new DrawHandoffTool()) // 已有公开导出；不改变默认工具目录。
  await configStore.update(config => {
    config.tools.enabledTools.push("command_handoff", "draw_handoff")
    config.response.drawHandoff.enabled = true
  })
  const handoffArgs = { command: "#fixture", send: true }, drawingArgs = { prompt: "猫", sendCommand: true }
  const beforeCommands = adapter.getDisplayContent().length
  assert.match(await toolRegistry.execute("command_handoff", handoffArgs, { ...renderedContext, config: configStore.get() }), /已发送指令文本/)
  assert.match(await toolRegistry.execute("draw_handoff", drawingArgs, { ...renderedContext, config: configStore.get() }), /已发送绘图指令文本/)
  assert.equal(adapter.getDisplayContent().length, beforeCommands + 2)
  const suppressed = { ...renderedContext, config: configStore.get(), delivery: { adapter, allowCurrentChat: false } }
  assert.match(await toolRegistry.execute("command_handoff", handoffArgs, suppressed), /建议使用/)
  assert.match(await toolRegistry.execute("draw_handoff", drawingArgs, suppressed), /可使用/)
  const deniedAdapter = { ...adapter, canSend: () => false }
  const deniedContext = { ...renderedContext, config: configStore.get(), e: { isMaster: true, reply: () => { throw new Error("adapter denial must not fall back to QQ") } }, delivery: { adapter: deniedAdapter } }
  assert.match(await toolRegistry.execute("command_handoff", handoffArgs, deniedContext), /建议使用/)
  assert.match(await toolRegistry.execute("draw_handoff", drawingArgs, deniedContext), /可使用/)
  assert.equal(adapter.getDisplayContent().length, beforeCommands + 2, "suppression and denial never dispatch a command")
  const hostCommands = []
  const hostContext = { config: configStore.get(), e: { isMaster: true, reply: value => { hostCommands.push(value); return { message_id: "host-fixture" } } } }
  assert.match(await toolRegistry.execute("command_handoff", handoffArgs, hostContext), /已转交执行指令/)
  assert.match(await toolRegistry.execute("draw_handoff", drawingArgs, hostContext), /已发送绘图命令/)
  assert.equal(hostCommands.length, 2, "existing QQ handoff still uses the host when no adapter is supplied")

  const { MusicPlayTool } = await import("../output/runtime/tools/builtins/music.js")
  toolRegistry.register(new MusicPlayTool())
  await configStore.update(config => { config.tools.enabledTools.push("music_play") })
  const musicOutlet = createWebMessageAdapter(configStore.get())
  const musicAdapter = { ...musicOutlet, async prepare(part, context, resolveResource) {
    // 上游音乐服务使用固定样例；仍执行真实工具、两次 Registry 投递及 Web 缓存。
    const prepared = part.type === "audio" ? { ...part, source: { kind: "bytes", value: sampleMedia.toString("base64"), mimeType: "audio/ogg" } } : part
    return musicOutlet.prepare(prepared, context, resolveResource)
  } }
  const beforeMusicFetch = global.fetch
  global.fetch = async url => {
    assert.equal(String(url), "https://u.y.qq.com/cgi-bin/musicu.fcg")
    return new Response(JSON.stringify({ code: 0, search: { code: 0, data: { body: { song: { list: [{ mid: "fixtureMID", title: "测试歌曲", singer: [{ name: "测试歌手" }] }] } } } } }))
  }
  try {
    const music = await toolRegistry.execute("music_play", { keyword: "测试歌曲" }, { ...renderedContext, config: configStore.get(), delivery: { adapter: musicAdapter } })
    assert.equal(music.status, "success"); assert.equal(music.sentCount, 2)
    assert.deepEqual(musicOutlet.getDisplayContent().map(part => part.type), ["music", "audio"], "music card and audio both reuse the Web outlet without a QQ reply")
    const audio = musicOutlet.getDisplayContent()[1]
    assert.deepEqual(Buffer.from((await readWebDeliveryMedia(audio.source.value.split("/").at(-1))).bytes), sampleMedia)
  } finally { global.fetch = beforeMusicFetch }
  const realOpen = fs.open
  let smallFileReads = 0
  fs.open = async (...args) => {
    const file = await realOpen(...args)
    if (args[0] === localImage) {
      const read = file.read.bind(file), readFile = file.readFile.bind(file)
      file.read = (buffer, ...rest) => {
        assert(buffer.byteLength <= image.length + 1, "small local images must not allocate the 20 MiB ceiling")
        smallFileReads++
        return read(buffer, ...rest)
      }
      file.readFile = async (...options) => {
        smallFileReads++
        const bytes = await readFile(...options)
        assert(bytes.buffer.byteLength < 1024 * 1024, "a tiny image should use a small backing buffer")
        return bytes
      }
    }
    return file
  }
  try {
    const smallId = await cacheWebDeliveryMedia(localImage)
    assert(smallFileReads > 0)
    assert.deepEqual(Buffer.from((await readWebDeliveryMedia(smallId)).bytes), image)
  } finally { fs.open = realOpen }
  const largeLocal = path.join(tempDir, "large-local.png")
  const largeSize = 20 * 1024 * 1024 + 1
  const sparse = await fs.open(largeLocal, "w")
  try { await sparse.truncate(largeSize) } finally { await sparse.close() }
  assert.equal((await deliverMessageChain([{ type: "image", source: { kind: "path", value: largeLocal } }], context)).status, "sent", "local delivery has no added 20 MiB ceiling")
  const largePath = adapter.getDisplayContent().at(-1).source.value
  const largeResponse = await fetch(`${origin}${largePath}`, { headers })
  assert.equal(largeResponse.status, 200)
  assert.equal((await largeResponse.arrayBuffer()).byteLength, largeSize, "cache reads retain the complete local media")
  const inlineId = await cacheWebDeliveryMedia(`data:application/octet-stream;base64,${Buffer.alloc(largeSize).toString("base64")}`)
  assert.equal((await readWebDeliveryMedia(inlineId)).bytes.length, largeSize, "already-inline media has no added 20 MiB ceiling either")
  const abortedRead = new AbortController()
  abortedRead.abort()
  await assert.rejects(cacheWebDeliveryMedia(localImage, { signal: abortedRead.signal }), /abort/i)
  assert.equal((await deliverMessageChain([{ type: "file", name: "page.html", source: { kind: "bytes", value: Buffer.from("<script>alert(1)</script>").toString("base64"), mimeType: "text/html" } }], context)).status, "sent")
  const attachmentPath = adapter.getDisplayContent().at(-1).source.value
  const attachment = await fetch(`${origin}${attachmentPath}`, { headers })
  assert.equal(attachment.headers.get("content-type"), "application/octet-stream")
  assert.match(attachment.headers.get("content-disposition"), /^attachment/)
  const traversal = await fetch(`${origin}/yui-chat/api/chat/media/not-a-cache-key`, { headers })
  assert.equal(traversal.status, 404)
  await configStore.update(config => { config.tools.enabledTools = ["message_send"] })
  await assert.rejects(() => toolRegistry.execute("web_fixture", {}, { config: configStore.get(), e: { isMaster: true } }), /未启用/)
  assert.equal(toolRuns, 1)
  await conversationStore.deleteWebTestSession(response.session.key)
  assert(!(await conversationStore.listWebTestSessions()).some(item => item.sessionId === "rich"))
  for (const content of ["[x](javascript:alert(1))", '<img src="javascript:alert(1)" onerror="alert(1)">', { type: "file", source: { kind: "url", value: "javascript:alert(1)" } }]) {
    assert(!/(?:href|src)="javascript:|<script|onerror="/.test(renderRichContent(content)))
  }
  await configStore.update(config => { config.tools.enabledTools = ["web_fixture", "message_send"] })
  global.location = { hash: "", pathname: "/yui-chat", search: "", protocol: "http:", host: "localhost" }
  global.localStorage = { getItem: () => null, setItem() {} }
  const chatUrl = new URL("../output/runtime/web/client/features/chat/chat-tab.js", import.meta.url)
  const { ChatTab, chatMessagesFromStored, mergeChatProgress } = await import(chatUrl)
  const { createChatProgress } = await import("../output/runtime/core/chat/chat-progress.js")
  const progressFrames = []
  let merged = {}
  const progress = createChatProgress(frame => { progressFrames.push(frame); merged = mergeChatProgress(merged, frame) })
  const manyTools = Array.from({ length: 80 }, (_, i) => ({ name: `tool_${i}`, description: "D".repeat(1500), parameters: { type: "object", properties: { query: { type: "string", description: "P".repeat(2500) } } } }))
  progress.emit({ type: "model-start", id: "traffic", channel: "fixture", source: "subagent", tools: manyTools })
  for (let i = 0; i < 8; i++) {
    progress.emit({ type: "model-delta", id: "traffic", delta: { type: "text", text: "x" } })
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  progress.emit({ type: "model-delta", id: "traffic", delta: { type: "reasoning", text: 'api_key="' } })
  await new Promise(resolve => setTimeout(resolve, 50))
  progress.emit({ type: "model-delta", id: "traffic", delta: { type: "reasoning", text: 'masked-value"' } })
  progress.emit({ type: "model-end", id: "traffic", status: "failed", error: "fixture" })
  progress.finish()
  const trafficBytes = progressFrames.reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame)), 0)
  assert(trafficBytes < 350000, `incremental traffic unexpectedly amplified: ${trafficBytes}`)
  assert.equal(progressFrames.filter(frame => frame.tools).length, 1, "tool definitions are not repeated in deltas or completion")
  assert.deepEqual(merged, progress.snapshot()[0], "merged deltas preserve definitions, routing context, text, redaction and failure state")
  assert.equal(merged.text, "xxxxxxxx")
  assert(!JSON.stringify(progressFrames).includes("masked-value"))
  assert.match(merged.reasoning, /redacted/i)
  const { runSubAgent } = await import("../output/runtime/core/chat/subagent-executor.js")
  const scopedFrames = [], scopedProgress = createChatProgress(frame => scopedFrames.push(frame))
  const subConfig = structuredClone(configStore.get())
  subConfig.subAgent.maxConcurrency = 4
  subConfig.subAgent.maxDepth = 2
  let activeSubtasks = 0
  const scopedRuntime = {
    getActiveSubAgentRuns: () => activeSubtasks,
    changeActiveSubAgentRuns: delta => { activeSubtasks += delta },
    recordSubAgentRun() {},
    async runModelStepWithChannel(options) {
      options.onProgress({ type: "tool-start", id: "reused-call", round: 1, name: "same-tool" })
      if (options.prompt === "first") await runSubAgent({ task: "nested", config: subConfig, depth: 1, parentToolId: "reused-call", onProgress: options.onProgress }, scopedRuntime)
      await new Promise(resolve => setImmediate(resolve))
      options.onProgress({ type: "tool-end", id: "reused-call", round: 1, name: "same-tool", status: "ok", result: options.prompt })
      return { text: options.prompt, toolRounds: 1, channel: options.channel.id }
    },
  }
  scopedProgress.emit({ type: "tool-start", id: "reused-call", round: 1, name: "same-tool" })
  await Promise.all(["first", "second"].map(task => runSubAgent({ task, config: subConfig, parentToolId: "same-dispatch", onProgress: scopedProgress.emit }, scopedRuntime)))
  scopedProgress.emit({ type: "tool-end", id: "reused-call", round: 1, name: "same-tool", status: "ok", result: "root" })
  scopedProgress.finish()
  const scopedEntries = scopedProgress.snapshot()
  assert.equal(scopedEntries.length, 4, "root, parallel siblings and a nested subtask never merge reused tool IDs")
  assert.equal(new Set(scopedEntries.map(entry => entry.id)).size, 4)
  assert.deepEqual(scopedEntries.map(entry => entry.result).sort(), ["first", "nested", "root", "second"])
  assert(scopedEntries.every(entry => entry.status === "ok"))
  assert.equal(new Set(scopedFrames.map(entry => entry.id)).size, 4, "each completion updates its own start in the stream")
  assert.equal(activeSubtasks, 0)
  const { ChatProcessPanel } = await import("../output/runtime/web/client/features/chat/chat-process-panel.js")
  const { components } = await import("../output/runtime/web/client/ui/components.js")
  const nativeFetch = global.fetch
  const originalFileReader = global.FileReader
  const fallbackResponse = { ...response, session: null, result: { ...response.result, historySaved: false } }
  let fallback = false, failureMode = "", cancelReady = deferred(), typingStream
  const sentBodies = []
  const clientRequests = []
  global.fetch = async (url, options = {}) => {
    clientRequests.push({ url: String(url), method: options.method || "GET" })
    const chatPost = String(url).endsWith("/api/chat/test") && options.method === "POST"
    if (!String(url).includes("/api/chat/test") && !String(url).includes("/api/chat/media/preview") && !String(url).includes("/api/chat/attachments")) return new Response(JSON.stringify({ ok: true }))
    if (chatPost) sentBodies.push(JSON.parse(options.body))
    if (chatPost && failureMode === "error") return new Response('event: error\ndata: {"error":"模拟断流"}\n\n', { headers: { "content-type": "text/event-stream" } })
    if (chatPost && failureMode === "typing") return new Response(new ReadableStream({ start(controller) { typingStream = controller } }), { headers: { "content-type": "text/event-stream" } })
    if (chatPost && failureMode === "cancel") return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener("abort", () => controller.error(new DOMException("Canceled", "AbortError")), { once: true })
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"ok":true}\n\n'))
      cancelReady.resolve()
    } }), { headers: { "content-type": "text/event-stream" } })
    if (fallback && chatPost) return new Response(JSON.stringify(fallbackResponse))
    const clientHeaders = new Headers(options.headers)
    for (const [name, value] of Object.entries(headers)) clientHeaders.set(name, value)
    const response = await nativeFetch(new URL(url, origin), { ...options, headers: clientHeaders })
    return response
  }
  let view
  const makeApp = () => {
    const app = createSSRApp({ ...ChatTab, setup() { return view ||= ChatTab.setup() } })
    for (const [name, component] of Object.entries(components)) app.component(name, component)
    return app
  }
  try {
    assert.match(await renderToString(makeApp()), /启用工具/)
    assert.equal(view.enableTools.value, true, "Web chat enables tools by default")
    view.prompt.value = "原草稿"
    const textRead = deferred()
    const readingText = view.uploadFiles({ target: { files: [{ name: "typing.txt", type: "text/plain", size: 10, text: () => textRead.promise }], value: "selected" } })
    view.prompt.value = "读取期间继续输入的草稿"
    textRead.resolve("文件正文")
    await readingText
    assert.equal(view.prompt.value, "读取期间继续输入的草稿\n\n[文件：typing.txt]\n文件正文", "text reading preserves the latest edits")
    const overflowingRead = deferred()
    const overflowingUpload = view.uploadFiles({ target: { files: [{ name: "limit.txt", type: "text/plain", size: 20, text: () => overflowingRead.promise }], value: "selected" } })
    view.prompt.value = "x".repeat(3990)
    overflowingRead.resolve("文件正文")
    await overflowingUpload
    assert.equal(view.prompt.value, "x".repeat(3990), "length validation uses the latest draft and preserves it when the file no longer fits")
    const failedTextRead = deferred()
    const failedTextUpload = view.uploadFiles({ target: { files: [{ name: "failed.txt", type: "text/plain", size: 10, text: async () => { await failedTextRead.promise; throw new Error("fixture text read failure") } }], value: "selected" } })
    view.prompt.value = "失败时也保留新输入"
    failedTextRead.resolve()
    await failedTextUpload
    assert.equal(view.prompt.value, "失败时也保留新输入")
    view.prompt.value = ""
    await view.uploadFiles({ target: { files: [new File(["文本文件正文"], "notes.md", { type: "text/plain" })], value: "selected" } })
    assert(view.prompt.value.includes("notes.md") && view.prompt.value.includes("文本文件正文"), "text files are inserted into the editable prompt")
    const originalPrompt = view.prompt.value
    await view.uploadFiles({ target: { files: [new File(["x".repeat(4100)], "large.txt", { type: "text/plain" })], value: "selected" } })
    assert.equal(view.prompt.value, originalPrompt, "oversized text uploads leave the existing draft intact")
    global.FileReader = class {
      readAsDataURL() { this.result = imageDataUrl; queueMicrotask(() => this.onload()) }
    }
    await view.uploadFiles({ target: { files: [new File([image], "test.png", { type: "image/png" })], value: "selected" } })
    assert.equal(view.attachments.value.length, 1)
    assert((await renderToString(makeApp())).includes("图片附件"))
    const uploadedFromClient = view.attachments.value[0].id
    view.enableTools.value = false
    await view.send()
    assert.deepEqual(sentBodies.at(-1).attachments, [uploadedFromClient])
    assert.equal(sentBodies.at(-1).enableTools, false, "the default tool mode can still be switched off")
    assert.equal(view.attachments.value.length, 0)
    view.enableTools.value = true
    view.newConversation()
    failureMode = "typing"
    view.prompt.value = "测试逐段显示"
    const typing = view.send()
    for (let i = 0; i < 20 && !typingStream; i++) await new Promise(resolve => setImmediate(resolve))
    const emitTyping = (type, data) => typingStream.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
    emitTyping("progress", { id: "typing-model", kind: "model", source: "web-test", status: "running", text: "第一段" })
    for (let i = 0; i < 20 && view.liveText.value !== "第一段"; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(view.sending.value, true)
    assert((await renderToString(makeApp())).includes("第一段"), "the reply bubble renders before the request completes")
    emitTyping("progress", { id: "typing-model", kind: "model", textOffset: 3, text: "第二段" })
    for (let i = 0; i < 20 && view.liveText.value !== "第一段第二段"; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(view.liveText.value, "第一段第二段")
    emitTyping("complete", { ok: true, result: { text: "第一段第二段" } }); typingStream.close()
    await typing
    failureMode = ""
    view.newConversation()
    view.channelId.value = ""
    failureMode = "cancel"
    view.prompt.value = "first canceled turn"
    const stoppedTurn = view.send()
    await boundedWait(cancelReady.promise)
    view.stop()
    await stoppedTurn
    const interruptedSessionId = sentBodies.at(-1).sessionId
    failureMode = "error"
    view.prompt.value = "retry after cancellation"
    await view.send()
    assert.equal(sentBodies.at(-1).sessionId, interruptedSessionId)
    view.prompt.value = "retry after stream error"
    await view.send()
    assert.equal(sentBodies.at(-1).sessionId, interruptedSessionId, "an interrupted first turn keeps its identity on retry")
    view.newConversation()
    view.prompt.value = "explicit new conversation"
    await view.send()
    assert.notEqual(sentBodies.at(-1).sessionId, interruptedSessionId)
    failureMode = ""
    view.newConversation()
    view.enableTools.value = true
    view.prompt.value = "展示工具结果"
    await view.send()
    assert.equal(sentBodies.at(-1).enableTools, true)
    let page = await renderToString(makeApp())
    assert.match(page, /<table/)
    assert.match(page, /<img /)
    assert(!view.messages.value.some(item => item.role === "tool"), "tool observations do not occupy assistant bubbles")
    assert(!/class="chat-safe-note"/.test(page), "tool options are no longer a top-of-page banner")
    assert.match(page, /本轮执行过程/)
    assert(!page.includes("Read a fixture table"), "collapsed process does not mount its details")
    const recordedProcess = view.messages.value.find(item => item.role === "process")
    const toolEntry = recordedProcess.progress.find(item => item.kind === "tool" && item.name === "web_fixture")
    assert(toolEntry.result)
    const props = { entries: recordedProcess.progress, active: false }
    let processView
    const renderProcess = () => {
      const app = createSSRApp({ ...ChatProcessPanel, props: [], setup() { processView ||= ChatProcessPanel.setup(props); return { ...props, ...processView } } })
      for (const [name, component] of Object.entries(components)) app.component(name, component)
      return renderToString(app)
    }
    await renderProcess()
    processView.expanded.value = true
    processView.openEntries.value[String(toolEntry.id)] = true
    const detailsHtml = await renderProcess()
    assert.match(detailsHtml, /工具 · web_fixture/)
    assert.match(detailsHtml, /<table/)
    assert.match(detailsHtml, /已完成/)
    assert(!/src="https?:/i.test(processView.renderRichContent({ type: "image", source: { kind: "url", value: remoteImage } })), "tool detail rendering uses the protected preview path")
    assert(!/src="https?:/i.test(view.renderRichContent(`![图片](${remoteImage})`)), "all main chat previews use the same policy")
    const previewButton = { dataset: { chatMediaUrl: remoteImage }, disabled: false }
    await view.loadMediaPreview({ target: { closest: () => previewButton } })
    assert.match(view.renderRichContent(`![图片](${remoteImage})`), /src="\/yui-chat\/api\/chat\/media\//)
    assert.equal(previewButton.disabled, false)
    const requestStart = clientRequests.length
    await view.selectSession(sessions.sessions.find(item => item.sessionId === "rich"))
    assert(clientRequests.slice(requestStart).some(item => item.url.endsWith(encodeURIComponent(response.session.key))))
    assert(!clientRequests.slice(requestStart).some(item => /sessions\?/.test(item.url)), "selecting a conversation fetches only its own details")
    const legacy = chatMessagesFromStored([
      { role: "user", text: "legacy" },
      { role: "tool", name: "same", content: "first", status: "ok" },
      { role: "tool", name: "same", content: "second", status: "running" },
      { role: "assistant", text: "final" },
    ])
    assert.deepEqual(legacy.map(item => item.role), ["user", "process", "assistant"])
    assert.deepEqual(legacy[1].progress.map(item => item.result), ["first", "second"], "legacy and repeated tools retain all results")
    view.sending.value = true
    const runningPage = await renderToString(makeApp())
    const stopPosition = runningPage.indexOf('aria-label="停止生成"')
    assert(stopPosition > runningPage.indexOf('<footer class="chat-composer">'), "stop stays beneath the input")
    const composer = runningPage.match(/<footer class="chat-composer">[\s\S]*?<\/footer>/)?.[0]
    assert(composer.includes("停止生成") && composer.includes("上传图片或文本文件") && composer.includes("启用工具"))
    assert(runningPage.indexOf('class="chat-turn-actions"') > runningPage.indexOf("</textarea>"), "tools and uploads stay below the textarea")
    view.sending.value = false

    const { GenerateImageTool } = await import("../output/runtime/tools/builtins/image-generation.js")
    toolRegistry.register(new GenerateImageTool())
    await configStore.update(config => {
      config.tools.enabledTools.push("generate_image")
      config.apiProviders.push({ name: "web-image-test", type: "openai-images", baseURL: "https://example.invalid", apiKey: "", authType: "none", headers: {}, query: {} })
      config.models.push({ name: "web-image-test", modelIdentifier: "fixture-image", apiProvider: "web-image-test", adapter: "openai-images", purpose: "image", image: { protocol: "openai-images" }, params: {} })
      config.modelTasks.imageGeneration.modelList = ["web-image-test"]
    })
    const imageAdapter = adapterRegistry.get("openai-images")
    const generateImages = imageAdapter.generateImages
    const imageStarted = deferred(), imageGate = deferred()
    let imageRequests = 0
    imageAdapter.generateImages = async () => {
      imageRequests++
      imageStarted.resolve()
      await imageGate.promise
      return { images: [{ data: `data:image/png;base64,${image.toString("base64")}`, mimeType: "image/png" }] }
    }
    imageMode = true
    try {
      view.newConversation()
      view.prompt.value = "后台画一只猫"
      await view.send()
      await boundedWait(imageStarted.promise)
      const pendingImage = view.messages.value.find(item => item.role === "process")?.progress.find(entry => entry.name === "generate_image")
      assert(pendingImage && ["running", "queued", "accepted"].includes(pendingImage.status), "the real image tool is still running after the foreground response")
      assert(!view.messages.value.some(item => item.role === "assistant" && Array.isArray(item.content) && item.content.some(part => part.type === "image")))
      const beforePoll = clientRequests.length
      imageGate.resolve()
      for (let i = 0; i < 100; i++) {
        if (view.messages.value.some(item => item.role === "assistant" && Array.isArray(item.content) && item.content.some(part => part.type === "image"))) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const drawn = view.messages.value.find(item => item.role === "assistant" && Array.isArray(item.content) && item.content.some(part => part.type === "image"))
      assert(drawn, "the current Web conversation receives the image after background generation, without manual reload")
      assert.equal(drawn.content.filter(part => part.type === "image").length, 1)
      const drawPath = drawn.content.find(part => part.type === "image").source.value
      assert.match(drawPath, /^\/yui-chat\/api\/chat\/media\/[a-f0-9]{64}$/)
      assert.equal((await nativeFetch(`${origin}${drawPath}`)).status, 401)
      const cachedImage = await nativeFetch(`${origin}${drawPath}`, { headers: { cookie } })
      assert.equal(cachedImage.status, 200)
      assert.deepEqual(Buffer.from(await cachedImage.arrayBuffer()), image)
      assert.match(await renderToString(makeApp()), /<img /, "the actual chat component renders the received image")
      const detailPolls = clientRequests.slice(beforePoll).filter(item => /\/api\/chat\/test\/sessions\//.test(item.url))
      assert(detailPolls.length > 0, "existing current-session polling refreshes the background result")
      assert(!clientRequests.slice(beforePoll).some(item => /sessions\?/.test(item.url)))
      const drawSession = view.sessions.value.find(item => item.sessionId === sentBodies.at(-1).sessionId)
      const persisted = await (await nativeFetch(`${origin}/yui-chat/api/chat/test/sessions/${encodeURIComponent(drawSession.key)}`, { headers })).json()
      assert(persisted.session.messages.some(item => Array.isArray(item.content) && item.content.some(part => part.type === "image" && part.source.value === drawPath)), "refresh retains the generated image in the original turn")
      const finishedImage = persisted.session.messages.find(item => item.role === "tool" && item.name === "generate_image")
      assert.equal(finishedImage.status, "ok")
      assert.match(finishedImage.text, /生成完成并已发送/)
      assert.equal(imageRequests, 1, "late delivery never repeats the image generation request")
    } finally {
      imageGate.resolve()
      imageAdapter.generateImages = generateImages
      imageMode = false
      view.newConversation()
    }
    fallback = true
    view.prompt.value = "历史不可用时仍展示"
    await view.send()
    page = await renderToString(makeApp())
    assert.match(page, /<table/)
    assert.match(page, /<img /, "the client retains media even when the session cannot be read back")
  } finally { global.fetch = nativeFetch; global.FileReader = originalFileReader }
  const { cleanupMediaCache, mediaCacheStats } = await import("../output/runtime/core/media/media-cache.js")
  assert((await mediaCacheStats()).files > 0)
  assert((await cleanupMediaCache({ mode: "all" })).files > 0)
  assert.equal((await fetch(`${origin}${mediaPath}`, { headers })).status, 404, "the existing cache cleanup covers Web media")
  console.log("ok web chat: default UI tools, composer controls/uploads, vision and upload history, compressed-host live streaming, incremental Vue replies, registry, rich content, background delivery, auth and send/fallback")
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await modelLogStore?.flush?.()
  await sqliteClient?.close()
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}
process.exit(0)
