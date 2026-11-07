import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { once } from "node:events"
import express from "express"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yui-chat-message-chain-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = pluginRoot
process.chdir(path.resolve(pluginRoot, "../.."))
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.segment = Object.fromEntries(["image", "record", "video", "file", "at", "reply", "dice", "rps"].map(type => [type, value => ({ type, [type === "at" ? "qq" : "file"]: value })]))
global.plugin = class {
  constructor(options = {}) { Object.assign(this, options) }
  async reply(...args) { return this.e.reply(...args) }
}
let sqliteClient, server, modelLogStore, registry
try {
  const { configStore, dataDir, cacheDir, tempDir } = await import("../output/runtime/config/store.js")
  ;({ sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js"))
  ;({ modelLogStore } = await import("../output/runtime/core/observability/model-log.js"))
  const { SqliteRuntimeConfigRepository } = await import("../output/runtime/core/storage/sqlite/runtime-config-repository.js")
  const config = await configStore.load()
  await sqliteClient.init(config)
  await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
  const { filterRegistry } = await import("../output/runtime/filters/core/registry.js")
  const { createBuiltinFilters } = await import("../output/runtime/filters/builtins/index.js")
  for (const definition of createBuiltinFilters()) filterRegistry.register(definition)
  const { deliverMessageChain, replyMessageChain } = await import("../output/runtime/core/message-chain/delivery.js")
  const { mediaResourceFromValue, MessageChainBuilder } = await import("../output/runtime/core/message-chain/builder.js")
  const { deliverRenderedImage } = await import("../output/runtime/core/rendering/render-delivery.js")
  const { textMessageChain } = await import("../output/runtime/core/message/cq-code.js")
  const { validateConfig } = await import("../output/runtime/config/validator.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  registry = toolRegistry
  const { MessageSendTool } = await import("../output/runtime/tools/builtins/media.js")
  const { SendDiceTool, SendRpsTool } = await import("../output/runtime/tools/builtins/entertainment.js")
  for (const tool of [new MessageSendTool(), new SendDiceTool(), new SendRpsTool()]) registry.register(tool)
  const mediaRule = { id: "proxy", name: "媒体反代", enabled: true, stage: "output", target: "media", priority: 100,
    implementation: { type: "filter", id: "regex_replace", arguments: { pattern: "^https://origin\\.example/", replacement: "https://proxy.example/", flags: "" } } }
  const textRule = { id: "body", enabled: true, stage: "output", priority: 100,
    implementation: { type: "filter", id: "text_transform", arguments: { operation: "append", suffix: "!" } } }
  await configStore.update(draft => {
    draft.web.authToken = "message-chain-test-local"
    draft.tools.enabled = true
    draft.tools.enabledTools = ["message_send", "send_dice", "send_rps", "custom_media"]
    draft.response.messageFilters = { enabled: true, runtimeVariables: {}, filters: [mediaRule, textRule] }
  })
  global.segment = Object.fromEntries(["image", "record", "video", "file", "at", "reply", "dice", "rps"].map(type => [type, value => ({ type, [type === "at" ? "qq" : "file"]: value })]))
  const current = () => configStore.get()
  const sent = []
  const nativeReceipt = { message_id: "chain-receipt" }
  const e = { isGroup: true, isMaster: true, group_id: "20001", user_id: "10001", sender: { role: "owner" },
    reply: async (payload, quote, options) => { sent.push({ payload, quote, options }); return nativeReceipt } }
  const chain = [
    { type: "text", text: "正文 https://origin.example/text" },
    { type: "image", source: { kind: "url", value: "https://origin.example/a.png?q=1%2F2&sign=abc" } },
    { type: "image", source: mediaResourceFromValue(Buffer.from("inline-image")) },
    { type: "music", platform: "custom", url: "https://origin.example/page", audio: "https://origin.example/a.mp3", image: "https://origin.example/cover.png" },
    { type: "forward", nodes: [{ nickname: "来源", userId: "42", parts: [{ type: "text", text: "节点正文" }, { type: "image", source: { kind: "url", value: "https://origin.example/node.png" } }] }] },
  ]
  const original = structuredClone(chain)
  const receipt = await deliverMessageChain(chain, { e, config: current(), recordImages: false })
  assert.equal(receipt.status, "sent")
  assert.equal(sent.length, 3, "text/images, music, forward retain their separate ordered batches")
  assert.equal(sent[0].payload[0], "正文 https://origin.example/text!", "media rules never rewrite body URLs")
  assert.equal(sent[0].payload[1].file, "https://proxy.example/a.png?q=1%2F2&sign=abc")
  assert.match(sent[0].payload[2].file, /^base64:\/\//, "inline media is not rewritten")
  assert.equal(sent[1].payload.data.audio, "https://proxy.example/a.mp3")
  assert.equal(sent[1].payload.data.image, "https://proxy.example/cover.png")
  assert.equal(sent[1].payload.data.url, "https://origin.example/page", "music jump links are not media resources")
  assert.equal(sent[2].payload.data[0].message[0], "节点正文!")
  assert.equal(sent[2].payload.data[0].message[1].file, "https://proxy.example/node.png")
  assert.deepEqual(chain, original, "filtering never edits shared tool results")
  assert(receipt.filterTraces.some(trace => trace.target === "media" && trace.path.includes("nodes")))
  assert(!JSON.stringify(receipt.filterTraces).includes("sign="), "traces contain locations, not media URLs")

  sent.length = 0
  assert.equal(await replyMessageChain([{ type: "text", text: "已过滤!" }], { e, config: current(), textFiltered: true, quote: true, replyOptions: { recallMsg: 5 } }), nativeReceipt)
  assert.equal(sent[0].payload, "已过滤!")
  assert.equal(sent[0].quote, true)
  assert.deepEqual(sent[0].options, { recallMsg: 5 })
  assert.deepEqual(textMessageChain("[CQ:at,qq=123]你好[CQ:image,file=https://origin.example/a.png]"), [{ type: "mention", userId: "123" }, { type: "text", text: " 你好" }])

  assert.equal(cacheDir, path.join(dataDir, "cache"))
  assert.equal(tempDir, path.join(cacheDir, "temp"))
  const file = path.join(tempDir, "unchanged.png")
  await fs.mkdir(tempDir, { recursive: true })
  await fs.writeFile(file, "test media")
  const local = await deliverMessageChain([{ type: "image", source: { kind: "path", value: file } }], { e, config: current(), recordImages: false })
  assert.equal(local.status, "sent")
  assert.equal(sent.at(-1).payload.file, await fs.realpath(file))
  const relativePath = path.relative(process.cwd(), file)
  assert.equal((await deliverMessageChain(new MessageChainBuilder().file(relativePath).build(), { e, config: current(), recordImages: false })).status, "sent")
  assert.equal(sent.at(-1).payload.file, await fs.realpath(file), "relative media paths resolve from the process working directory before policy checks")
  const oldTemp = path.join(runtimeRoot, "cache/temp")
  await fs.mkdir(oldTemp, { recursive: true })
  const oldFile = path.join(oldTemp, "legacy.png")
  await fs.writeFile(oldFile, "old cache")
  const beforeOld = sent.length
  const oldDelivery = await deliverMessageChain(new MessageChainBuilder().image(oldFile).build(), { e, config: current(), recordImages: false })
  assert.equal(oldDelivery.status, "failed")
  assert.match(oldDelivery.error, /允许的目录/)
  assert.equal(sent.length, beforeOld, "old cache paths are not silently added to the default media policy")
  const strict = structuredClone(current())
  strict.security.linkSafety.allowPrivateHosts = false
  strict.response.messageFilters.filters = [{ ...mediaRule, implementation: { ...mediaRule.implementation, arguments: { pattern: "^https://origin\\.example/", replacement: "http://127.0.0.1/" } } }]
  const beforeUnsafe = sent.length
  assert.equal((await deliverMessageChain([chain[1]], { e, config: strict })).status, "failed")
  assert.equal(sent.length, beforeUnsafe, "rewritten URLs are validated before host access")
  const unsupported = await deliverMessageChain([{ type: "image", file: "https://origin.example/native.png" }], { e, config: current() })
  assert.equal(unsupported.status, "failed", "the internal boundary never guesses native media fields")
  assert.match(unsupported.error, /source/)

  sent.length = 0
  await deliverRenderedImage({ url: "https://origin.example/render.png" }, { e, config: current() })
  assert.equal(sent[0].payload.file, "https://proxy.example/render.png")
  await deliverRenderedImage({ buffer: Buffer.from("89504e470d0a1a0a", "hex") }, { e, config: current() })
  assert.match(sent[1].payload.file, /^base64:\/\//, "rendered binary pictures are expressed as resources")
  await registry.execute("send_dice", { count: 2 }, { e, config: current() })
  assert.deepEqual(sent[2].payload.map(part => part.type), ["dice", "dice"])
  await registry.execute("send_rps", { value: 3 }, { e, config: current() })
  assert.equal(sent[3].payload.type, "rps")
  assert.equal(sent[3].payload.file, 3)

  const { sendChatOutput } = await import("../output/runtime/core/chat/output-service.js")
  const { userSettingsStore } = await import("../output/runtime/user/settings.js")
  await userSettingsStore.set(e, { mode: "text" })
  await sendChatOutput(e, { text: "最终正文", channel: "mock" }, current(), { armContinuation: false })
  assert.match(sent.at(-1).payload, /最终正文!$/)
  assert(!sent.at(-1).payload.endsWith("!!"), "final replies never apply body filters twice")
  let voiceCalls = 0
  filterRegistry.register({ id: "test_voice", stages: ["output"], effects: ["delivery"], resultKinds: ["record"], apply() { voiceCalls++; return { kind: "record", data: Buffer.from("voice"), continueText: false } } })
  const voiceConfig = structuredClone(current())
  voiceConfig.response.messageFilters.filters = [{ ...textRule, implementation: { type: "filter", id: "test_voice", arguments: {} } }]
  await sendChatOutput(e, { text: "语音正文", channel: "mock" }, voiceConfig, { armContinuation: false })
  assert.equal(voiceCalls, 1)
  assert.equal(sent.at(-1).payload.type, "record")
  assert.match(sent.at(-1).payload.file, /^base64:\/\//)
  assert.equal(sent.at(-1).quote, current().response.quoteReply, "voice replies keep their configured quoting")
  const { sendTaskMessage } = await import("../output/runtime/core/scheduling/schedule-task-service.js")
  const blockedConfig = structuredClone(current())
  blockedConfig.response.messageFilters.filters = [{ ...textRule, implementation: { type: "filter", id: "keyword_filter", arguments: { keywords: "blocked", action: "block" } } }]
  const countBeforeBlocked = sent.length
  global.Bot.pickGroup = () => ({ sendMsg: async () => assert.fail("blocked reminder must not reach the host") })
  await assert.rejects(() => sendTaskMessage({ scopeType: "group", groupId: "20001", userId: "10001", content: "blocked" }, blockedConfig), /关键词|拦截/)
  assert.equal(sent.length, countBeforeBlocked)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(() => deliverMessageChain([chain[1]], { e, config: current(), signal: cancelled.signal }), { name: "AbortError" })
  assert.equal(sent.length, countBeforeBlocked)
  const failedReceipt = await deliverMessageChain([chain[1]], { e: { ...e, reply: async () => false }, config: current() })
  assert.equal(failedReceipt.status, "failed")
  assert.equal(failedReceipt.sentCount, 0)
  sent.length = 4

  // Load a real Custom package and exercise the model's automatic delivery path.
  const { customToolManager } = await import("../output/runtime/tools/custom/manager.js")
  const dir = path.join(runtimeRoot, "custom-media-fixture")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module" }))
  await fs.writeFile(path.join(dir, "index.js"), `
export function createTools() {
  const sources = {
    url: { kind: "url", value: "https://origin.example/custom.png" },
    path: { kind: "path", value: ${JSON.stringify(file)} },
    bytes: { kind: "bytes", value: Buffer.from("custom-bytes").toString("base64"), mimeType: "image/png" },
  }
  return [{
    name: "custom_media", category: "media", risk: "low", tags: ["test"], policy: {}, description: "Test image lookup",
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["url", "path", "bytes"] } } },
    execution: { effect: "read" }, autoDelivery: { via: "message_send", batching: "merge", continueConversation: true },
    execute(args = {}) { return { status: "success", content: "https://origin.example/candidate", metadata: { messageSendPlan: { parts: [{ type: "image", source: sources[args.kind || "url"] }] } } } },
  }]
}
`)

  const loaded = await customToolManager.instantiatePackage({ id: "test", dir, manifest: {} })
  registry.register(loaded.tools[0])
  const raw = await registry.execute("custom_media", {}, { e, config: current() })
  assert.equal(raw.content, "https://origin.example/candidate", "observation URLs retain their original meaning")
  assert.equal(sent.length, 4, "returning a plan is not already a delivery")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { chatService } = await import("../output/runtime/core/chat/chat-service.js")
  let modelCalls = 0
  let requestedKind = "url"
  const adapter = { id: "chain-test", supportsTools: true, supportsVision: false, supportsStreaming: false, supportsEmbeddings: false,
    async sendMessage() {
      modelCalls++
      return { id: `model-${modelCalls}`, text: modelCalls === 1 ? "" : "完成", usage: { input: 1, output: 1, total: 2, source: "reported" }, toolCalls: modelCalls === 1 ? [{ id: "custom-call", name: "custom_media", arguments: { kind: requestedKind } }] : [] }
    } }
  adapterRegistry.register(adapter)
  const result = await chatService.runModelStepWithChannel({ e, prompt: "发一张测试图片", config: current(), history: [], step: { id: "reply", task: "replyer", mode: "final" }, channel: { id: "chain-test", type: "chain-test", model: "mock", modelConfig: { toolUse: true }, timeoutMs: 1000 } })
  assert.equal(result.text, "完成")
  assert.equal(modelCalls, 2)
  assert.equal(sent.at(-1).payload.file, "https://proxy.example/custom.png")
  assert(result.toolChain.some(trace => trace.name === "message_send" && trace.status === "ok"))
  const deniedConfig = structuredClone(current())
  deniedConfig.tools.enabledTools = ["custom_media"]
  await assert.rejects(() => registry.execute("message_send", { parts: raw.metadata.messageSendPlan.parts }, { e: { ...e, isMaster: false }, config: deniedConfig }), /未启用|不允许|disabled|允许|权限/)

  // Authenticated configuration round-trip and dry run use the same target rules.
  const { createWebApp } = await import("../output/runtime/web/http/app.js")
  const app = express()
  app.use("/yui-chat", createWebApp())
  server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  async function api(endpoint, body, authorized = true) {
    const response = await fetch(`${origin}/yui-chat${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { "yui-chat-token": "message-chain-test-local" } : {}) }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await api("/api/message-filters/test", { filter: mediaRule, text: "https://origin.example/test.png" }, false)).status, 401)
  const tested = await api("/api/message-filters/test", { filter: mediaRule, text: "https://origin.example/test.png" })
  assert.equal(tested.status, 200)
  assert.equal(tested.body.result.output, "https://proxy.example/test.png")
  assert.equal(tested.body.result.target, "media")
  const saved = await fetch(`${origin}/yui-chat/api/message-filters`, { method: "PUT", headers: { "content-type": "application/json", "yui-chat-token": "message-chain-test-local" }, body: JSON.stringify({ enabled: true, filters: [mediaRule, textRule] }) })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).filtering.filters[0].target, "media")
  assert.equal(current().response.messageFilters.filters[0].target, "media", "SQLite-backed configuration preserves the selected field target")
  assert.equal(current().response.messageFilters.filters[1].target, "text", "old body rules acquire the same effective default")
  const badTarget = { ...mediaRule, stage: "input" }
  assert.equal(validateConfig({ ...current(), response: { ...current().response, messageFilters: { filters: [badTarget] } } }).ok, false)
  assert.equal((await api("/api/message-filters/test", { filter: badTarget, text: "https://origin.example/test.png" })).status, 400)
  const voiceTarget = { ...mediaRule, implementation: { type: "filter", id: "voice_output", arguments: {} } }
  assert.equal((await api("/api/message-filters/test", { filter: voiceTarget, text: "https://origin.example/test.png" })).status, 400)
  assert.equal(sent.at(-1).payload.file, "https://proxy.example/custom.png", "dry runs never send a host message")
  for (const kind of ["path", "bytes"]) {
    requestedKind = kind
    modelCalls = 0
    const before = sent.length
    const run = await chatService.runModelStepWithChannel({ e, prompt: "发一张测试图片", config: current(), history: [], step: { id: "reply", task: "replyer", mode: "final" }, channel: { id: "chain-test", type: "chain-test", model: "mock", modelConfig: { toolUse: true }, timeoutMs: 1000 } })
    assert.equal(run.text, "完成")
    assert.equal(modelCalls, 2)
    assert.equal(sent.length, before + 1, "each Custom resource is automatically delivered once")
    assert.equal(sent.at(-1).payload.file, kind === "path" ? await fs.realpath(file) : `base64://${Buffer.from("custom-bytes").toString("base64")}`)
    assert(run.toolChain.some(trace => trace.name === "message_send" && trace.status === "ok"))
  }
  const { hostRuntime } = await import("../output/runtime/core/runtime/host-runtime.js")
  const { validateOutboundMessageChain } = await import("../output/runtime/core/message-chain/validation.js")
  for (const bad of [
    [{ type: "image", file: "https://origin.example/native.png" }],
    [{ type: "image", data: { file: "https://origin.example/native.png" } }],
    [{ type: "text", data: { text: "native" } }],
    [{ type: "image", source: { kind: "platform", value: "https://origin.example/disguised.png" } }],
    [{ type: "image", source: { kind: "bytes", value: "file:///tmp/test.png" } }],
    [{ type: "forward", nodes: [{ parts: [{ type: "image", file: "https://origin.example/nested.png" }] }] }],
    [{ type: "forward", nodes: [{ parts: [{ type: "forward", nodes: [] }] }] }],
  ]) {
    assert(validateOutboundMessageChain(bad).length > 0)
    const before = sent.length
    const invalid = await new MessageSendTool().execute({ parts: bad }, { e, config: current() })
    assert.equal(invalid.kind, "error")
    assert.equal(sent.length, before, "native, nested-native and disguised URL shapes are rejected before sending")
  }
  assert.deepEqual(validateOutboundMessageChain([{ type: "text", text: "\n" }]), [], "format validation preserves intentional text spacing")
  for (const failure of [false, { status: "error" }, { success: false }, { error: "failure" }]) {
    let observedCount = 0
    const observed = hostRuntime.observeMessageSends({ reply: async () => failure }, () => { observedCount++ })
    const failed = await deliverMessageChain([{ type: "text", text: "失败" }], { e: observed, config: current(), textFiltered: true })
    assert.equal(failed.status, "failed")
    assert.equal(failed.sentCount, 0)
    assert.equal(observedCount, 0)
  }
  let tracked = 0
  const originEvent = { value: "original", reply: async function(payload) { assert.equal(this, originEvent); return { message_id: payload } } }
  const observed = hostRuntime.observeMessageSends(originEvent, () => { tracked++ })
  const observedReceipt = await replyMessageChain([{ type: "text", text: "观察回执" }], { e: observed, config: current(), textFiltered: true })
  assert.equal(tracked, 1)
  assert.equal(observedReceipt.message_id, "观察回执")
  const targets = []
  const account = { pickGroup(id) { return { sendMsg: async payload => { targets.push({ type: "group", id, payload }); return { message_id: "target-group" } } } },
    pickFriend(id) { return { sendMsg: async payload => { targets.push({ type: "user", id, payload }); return { message_id: "target-user" } } } } }
  global.Bot["test-account"] = account
  for (const type of ["group", "user"]) {
    await replyMessageChain([{ type: "text", text: "指定目标" }], { config: current(), destination: { type, id: "12345", accountId: "test-account" }, textFiltered: true })
    assert.equal(targets.at(-1).type, type)
    assert.equal(targets.at(-1).id, 12345)
    assert.equal(targets.at(-1).payload, "指定目标")
  }
  await assert.rejects(() => replyMessageChain([{ type: "text", text: "不可发送" }], { config: current(), destination: { type: "group", id: "12345", accountId: "missing-account" } }), /无法获取群/)
  const synthetic = hostRuntime.messageEvent({ bot: account, isGroup: true, group_id: "12345" }, { type: "group", id: "12345" })
  assert.equal(synthetic.reply, undefined, "internal events carry an explicit destination rather than a native reply function")
  assert.equal(hostRuntime.canSendMessage(synthetic), true)
  await replyMessageChain([{ type: "text", text: "主动消息" }], { e: synthetic, config: current(), textFiltered: true })
  assert.equal(targets.at(-1).payload, "主动消息")
  const { YuiChatCommandHandlers } = await import("../output/runtime/apps/chat.js")
  const command = new YuiChatCommandHandlers({})
  command.e = e
  const beforeCommand = sent.length
  await command.sendText("管理指令", true, { recallMsg: 3 })
  assert.equal(sent.length, beforeCommand + 1)
  assert.equal(sent.at(-1).payload, "管理指令", "native commands preserve literal text rather than reapplying model filters")
  assert.equal(sent.at(-1).quote, true)
  assert.deepEqual(sent.at(-1).options, { recallMsg: 3 })
  // Large byte resources reach the real Registry/delivery path without regex stack growth.
  for (const size of [4_000_000, 8_000_000]) {
    const value = Buffer.alloc(size, 65).toString("base64")
    const parts = [{ type: "image", source: { kind: "bytes", value, mimeType: "image/png" } }]
    assert.deepEqual(validateOutboundMessageChain(parts), [])
    const before = sent.length
    const large = await registry.execute("message_send", { parts }, { e, config: current() })
    assert.equal(large.receipt.status, "sent")
    assert.equal(sent.length, before + 1)
    assert.equal(sent.at(-1).payload.file, `base64://${value}`)
    sent.pop()
  }
  for (const value of ["AAAA", "AAA=", "AA==", "aGVsbG8="]) {
    assert.deepEqual(validateOutboundMessageChain([{ type: "file", source: { kind: "bytes", value } }]), [])
  }
  for (const value of ["AAA", "A===", "AA=A", "====", "AAAA====", "AAA\n", "AAA-", "AAA_", "AA A", "AAA\u0000"]) {
    const parts = [{ type: "file", source: { kind: "bytes", value } }]
    assert(validateOutboundMessageChain(parts).some(issue => issue.includes("Base64")), `reject malformed Base64: ${JSON.stringify(value)}`)
    const before = sent.length
    assert.equal((await new MessageSendTool().execute({ parts }, { e, config: current() })).kind, "error")
    assert.equal(sent.length, before)
  }
  // Convenience inputs normalize once; callers and adapters still exchange canonical resources.
  const bytes = Uint8Array.from([0, 1, 2, 3, 4]).subarray(1, 4)
  const byteChain = new MessageChainBuilder().image(bytes).audio(Buffer.from("voice-bytes")).video(bytes).file(bytes).build()
  bytes.fill(9)
  assert.equal(byteChain[0].source.value, Buffer.from([1, 2, 3]).toString("base64"))
  for (const part of byteChain) assert.equal(part.source.kind, "bytes")
  const beforeBytes = sent.length
  await deliverMessageChain(byteChain, { e, config: current(), recordImages: false })
  assert.equal(sent.length - beforeBytes, 4)
  assert(sent.slice(beforeBytes).every(item => item.payload.file.startsWith("base64://")))
  const { serializeForModel } = await import("../output/runtime/core/message-chain/serialize.js")
  const { contentForOpenAI, contentToText: adapterContentToText } = await import("../output/runtime/models/adapters/base.js")
  const { messagesForResponses } = await import("../output/runtime/models/adapters/openai/responses/request-adapter.js")
  const { contentPartToText } = await import("../output/runtime/models/protocol/normalize.js")
  const imageData = `data:image/png;base64,${byteChain[0].source.value}`
  const { messagesToGeminiContents } = await import("../output/runtime/models/adapters/gemini.js")
  const geminiImage = messagesToGeminiContents([{ role: "user", content: [byteChain[0]] }])[0].parts[0].inlineData
  assert.equal(geminiImage.data, byteChain[0].source.value)
  assert.equal(geminiImage.mimeType, "image/png")
  const { extractMessageChain } = await import("../output/runtime/core/message-chain/inbound.js")
  assert.equal(extractMessageChain({ message: [{ type: "image", file: "opaque-host-id" }] })[0].type, "extension")
  const { extractMessageContext } = await import("../output/runtime/core/message/message-context.js")
  assert.equal(extractMessageContext({ message: [{ type: "image", url: "platform-image:receipt:0" }] }).images[0].url, "platform-image:receipt:0")
  assert.equal(extractMessageChain({ message: [{ type: "image", file: imageData }] })[0].source.kind, "bytes")
  assert.equal(contentForOpenAI([byteChain[0]])[0].image_url.url, imageData)
  assert.equal(messagesForResponses([{ role: "user", content: [byteChain[0]] }])[0].content[0].image_url, imageData)
  assert(!contentPartToText(byteChain[1]).includes(byteChain[1].source.value))
  assert(!adapterContentToText(byteChain).includes(byteChain[0].source.value))
  const { createExecutionRuntime } = await import("../output/runtime/tools/support/execution-runtime.js")
  const dedupe = createExecutionRuntime({ runId: "send-dedupe", event: e })
  const sendTool = registry.get("message_send")
  const sendCall = { name: "message_send", arguments: { parts: [{ type: "text", text: "仅发送一次" }], target: "ignored-a" } }
  const guard = dedupe.guardToolCall({ tool: sendTool, call: sendCall })
  assert.equal(guard.decision, "allow")
  const sendResult = await dedupe.executeTool({ guard, invoke: args => registry.execute("message_send", args, { e, config: current() }) })
  assert.equal(sendResult.status, "success")
  dedupe.recordExecution({ guard, call: sendCall, result: sendResult })
  const beforeDuplicate = sent.length
  const duplicateGuard = dedupe.guardToolCall({ tool: sendTool, call: { ...sendCall, arguments: { ...sendCall.arguments, target: "ignored-b" } } })
  assert.equal(duplicateGuard.decision, "skip", "changing an ignored target cannot bypass successful-send deduplication")
  assert.equal(sent.length, beforeDuplicate)
  assert(!dedupe.formatToolContent(byteChain).includes(byteChain[0].source.value))
  assert(!serializeForModel(byteChain).includes(byteChain[0].source.value), "convenient byte inputs never expose their body to the model serializer")
  const localConfig = structuredClone(current())
  const allowedDir = path.join(runtimeRoot, "allowed-media")
  await fs.mkdir(allowedDir)
  const allowedFile = path.join(allowedDir, "with space.txt")
  await fs.writeFile(allowedFile, "allowed media")
  localConfig.response.render.delivery.allowedLocalPaths = [allowedDir]
  const pathChain = new MessageChainBuilder().image(file).audio(file).video(file).file(file).build()
  assert(pathChain.every(part => part.source.kind === "path"))
  assert.equal((await deliverMessageChain(pathChain, { e, config: localConfig, recordImages: false })).status, "sent")
  const beforeDeniedPath = sent.length
  const extraPathChain = new MessageChainBuilder().file(allowedFile).build()
  assert.equal((await deliverMessageChain(extraPathChain, { e, config: current(), recordImages: false })).status, "failed")
  assert.equal(sent.length, beforeDeniedPath, "unlisted directories are rejected")
  assert.equal((await deliverMessageChain(extraPathChain, { e, config: localConfig, recordImages: false })).status, "sent")
  assert.equal((await deliverMessageChain(new MessageChainBuilder().file(pathToFileURL(allowedFile).href).build(), { e, config: localConfig, recordImages: false })).status, "sent")
  // Both the configured root and supplied paths may name the same directory through aliases.
  const aliasDir = path.join(runtimeRoot, "allowed-alias")
  await fs.symlink(allowedDir, aliasDir, "dir")
  const aliasConfig = structuredClone(current())
  aliasConfig.response.render.delivery.allowedLocalPaths = [path.join(runtimeRoot, "not-created"), aliasDir]
  for (const value of [allowedFile, await fs.realpath(allowedFile), path.join(aliasDir, path.basename(allowedFile))]) {
    assert.equal((await deliverMessageChain(new MessageChainBuilder().file(value).build(), { e, config: aliasConfig, recordImages: false })).status, "sent")
    assert.equal(sent.at(-1).payload.file, await fs.realpath(allowedFile))
  }
  assert.equal((await deliverMessageChain(new MessageChainBuilder().file(await fs.realpath(file)).build(), { e, config: current(), recordImages: false })).status, "sent", "default cache accepts its real path, including macOS /private/var aliases")
  const sibling = `${allowedDir}-other`
  await fs.mkdir(sibling)
  const outsideFile = path.join(sibling, "outside.txt")
  await fs.writeFile(outsideFile, "outside media")
  const linkedFile = path.join(allowedDir, "linked.txt")
  await fs.symlink(outsideFile, linkedFile)
  for (const value of [outsideFile, linkedFile, path.join(allowedDir, "..", path.basename(sibling), "outside.txt")]) {
    const count = sent.length
    assert.equal((await deliverMessageChain(new MessageChainBuilder().file(value).build(), { e, config: localConfig, recordImages: false })).status, "failed")
    assert.equal(sent.length, count, "directory boundaries and symlink escapes are rejected before host sending")
  }
  for (const kind of ["platform", "cache", "file"]) {
    const count = sent.length
    assert.equal((await deliverMessageChain([{ type: "file", source: { kind, value: pathToFileURL(outsideFile).href } }], { e, config: localConfig })).status, "failed")
    assert.equal(sent.length, count, "resource labels cannot bypass path checks")
  }
  assert.equal(validateConfig({ ...localConfig, response: { ...localConfig.response, render: { ...localConfig.response.render, delivery: { allowedLocalPaths: ["relative/path"] } } } }).ok, false)
  await configStore.update(draft => { draft.response.render.delivery.allowFilePathImages = true })
  assert(!Object.hasOwn(current().response.render.delivery, "allowFilePathImages"), "the obsolete switch is removed during normalization")
  const cacheRef = { kind: "path", value: file, name: "resource-name", mimeType: "image/png" }
  const copiedRef = new MessageChainBuilder().image(cacheRef).build()[0].source
  assert.deepEqual(copiedRef, cacheRef)
  assert.notEqual(copiedRef, cacheRef)

  // Every public outbound type can travel through both message_send and a forward node.
  const allBasic = new MessageChainBuilder().text("完整消息").mention("10001").reply("quoted-id")
    .image("https://origin.example/types.png").audio(Buffer.from("voice"))
    .video(Uint8Array.of(1, 2)).file(cacheRef).music({ platform: "qq", id: "42" }).dice().rps(2).build()
  assert.deepEqual(validateOutboundMessageChain(allBasic), [])
  const directTypes = await registry.execute("message_send", { parts: allBasic }, { e, config: current() })
  assert.equal(directTypes.kind, "delivery")
  assert.equal(directTypes.receipt.sentCount, allBasic.length)
  const forwardedTypes = await registry.execute("message_send", { parts: [{ type: "forward", nodes: [{ parts: allBasic }] }] }, { e, config: current() })
  assert.equal(forwardedTypes.receipt.status, "sent")
  const nodePayload = sent.at(-1).payload.data[0].message
  assert.deepEqual(nodePayload.map(part => typeof part === "string" ? "text" : part.type), ["text", "at", "reply", "image", "record", "video", "file", "music", "dice", "rps"])
  assert.equal(nodePayload[3].file, "https://proxy.example/types.png")
  const invalidRpsParts = [{ type: "forward", nodes: [{ parts: [{ type: "rps", value: 4 }] }] }]
  const invalidRps = await new MessageSendTool().execute({ parts: invalidRpsParts }, { e, config: current() })
  assert.equal(invalidRps.kind, "error")
  await assert.rejects(() => registry.execute("message_send", { parts: invalidRpsParts }, { e, config: current() }), { code: "TOOL_ARGUMENTS_INVALID" })
  await assert.rejects(() => registry.execute("message_send", { parts: [{ type: "forward", nodes: [{ parts: [{ type: "forward", nodes: [] }] }] }] }, { e, config: current() }), { code: "TOOL_ARGUMENTS_INVALID" })

  const { yunzaiMessageAdapter } = await import("../output/runtime/core/runtime/host-runtime.js")
  const originalImageFactory = global.segment.image
  delete global.segment.image
  assert.equal(yunzaiMessageAdapter.supports("image"), false)
  const unsupportedMedia = await deliverMessageChain(new MessageChainBuilder().text("仍可发送").image("https://origin.example/unavailable.png").build(), { e, config: current(), recordImages: false })
  assert.equal(unsupportedMedia.status, "partial")
  assert.equal(unsupportedMedia.sentCount, 1)
  global.segment.image = originalImageFactory

  const partialPayloads = []
  const partialResult = await deliverMessageChain(new MessageChainBuilder().text("第一段").audio(Buffer.from("audio")).text("第三段").build(), {
    e: { reply: async payload => { partialPayloads.push(payload); return partialPayloads.length === 2 ? false : { message_id: `partial-${partialPayloads.length}` } } },
    config: current(), recordImages: false,
  })
  assert.equal(partialPayloads.length, 3, "a failed send is recorded without retrying or resending successful batches")
  assert.equal(partialResult.status, "partial")
  assert.deepEqual(partialResult.parts.map(part => part.status), ["sent", "failed", "sent"])
  assert.deepEqual(partialResult.messageIds, ["partial-1", "partial-3"])

  // Forward creation and delivery must both use the explicit destination account.
  const destinationPayloads = []
  const targetOwner = {
    async makeForwardMsg(nodes) { assert.equal(this, targetOwner); return { targetForward: nodes } },
    async sendMsg(payload) { assert.equal(this, targetOwner); destinationPayloads.push(payload); return { message_id: "destination-forward" } },
  }
  global.Bot["forward-account"] = { uin: "56789", pickGroup: () => targetOwner }
  const targetedForward = await deliverMessageChain([{ type: "forward", nodes: [{ parts: [{ type: "text", text: "目标账号" }] }] }], {
    e: { ...e, group: { makeForwardMsg() { assert.fail("must not construct a forward using the source conversation") } } },
    destination: { type: "group", id: "12345", accountId: "forward-account" }, config: current(), recordImages: false,
  })
  assert.equal(targetedForward.status, "sent")
  assert.equal(destinationPayloads[0].targetForward[0].user_id, "56789")

  const originalBotIds = global.Bot.uin
  global.Bot.uin = ["11111", "22222"]
  await deliverMessageChain([{ type: "forward", nodes: [{ parts: [{ type: "text", text: "当前账号" }] }] }], {
    e: { ...e, self_id: "33333" }, config: current(), recordImages: false,
  })
  assert.equal(sent.at(-1).payload.data[0].user_id, "33333", "current-account forwards never use the host's aggregate bot ID list")
  global.Bot.uin = originalBotIds

  // A different adapter can use entirely different payloads and batching, with shared filters and receipt handling.
  const alternativeSends = []
  const alternativeReceipt = { token: "alternative-receipt" }
  const alternative = {
    id: "test-only",
    supports: () => true,
    canSend: () => true,
    async prepare(part, context, resolveResource) {
      let value = part.text
      if ("source" in part) value = await resolveResource(part.source)
      if (part.type === "forward") value = await Promise.all(part.nodes.map(async node => Promise.all(node.parts.map(async item => (await this.prepare(item, context, resolveResource)).payload))))
      return { payload: { kind: part.type, value }, standalone: false, allowQuote: true }
    },
    async send(payload, context) { alternativeSends.push({ payload, quote: context.quote }); return { receipt: alternativeReceipt, messageIds: ["alternative-id"] } },
  }
  const alternativeChain = new MessageChainBuilder().image("https://origin.example/alternative.png").audio(Buffer.from("alternative"))
    .forward([{ parts: [{ type: "image", source: { kind: "url", value: "https://origin.example/alternative-node.png" } }] }]).build()
  const alternativeResult = await deliverMessageChain(alternativeChain, {
    adapter: alternative, e: { reply() { assert.fail("a selected adapter must not use the default host sender") } },
    config: current(), recordImages: false, quote: true,
  })
  assert.equal(alternativeSends.length, 1, "batching follows adapter metadata rather than native segment types")
  assert.equal(alternativeSends[0].payload[0].value, "https://proxy.example/alternative.png")
  assert.equal(alternativeSends[0].payload[2].value[0][0].value, "https://proxy.example/alternative-node.png")
  assert.equal(alternativeSends[0].quote, true)
  assert.deepEqual(alternativeResult.messageIds, ["alternative-id"], "receipts use adapter-normalized IDs, even without a native message_id")
  assert.equal(await replyMessageChain([{ type: "text", text: "alternate" }], { adapter: alternative, config: current(), recordImages: false }), alternativeReceipt)
  const beforePrivateForward = alternativeSends.length
  const privateForward = await deliverMessageChain([{ type: "forward", nodes: [{ parts: [{ type: "music", platform: "custom", audio: "http://127.0.0.1/private.mp3" }] }] }], {
    adapter: alternative, config: strict, recordImages: false,
  })
  assert.equal(privateForward.status, "failed")
  assert.equal(alternativeSends.length, beforePrivateForward, "nested music media retains URL policy before platform conversion")
  // Regression: the real MCP result is valid; Responses padded unrelated image fields.
  const { validateToolArguments, responsesToolDefinition, modelToolDefinition } = await import("../output/runtime/tools/support/contract.js")
  const messageTool = new MessageSendTool()
  const responsesDefinition = responsesToolDefinition(messageTool)
  assert.equal(responsesDefinition.strict, false, "Responses must preserve optional tool fields instead of auto-requiring them")
  assert.deepEqual(responsesDefinition.parameters, modelToolDefinition(messageTool).function.parameters)
  const incompleteSource = { parts: [{ type: "image", source: { kind: "url" } }] }
  assert.equal(validateToolArguments(messageTool, incompleteSource).ok, true)
  const incompleteResult = await registry.execute("message_send", incompleteSource, { e, config: current() })
  assert.equal(incompleteResult.metadata.validationError, true)
  assert.equal(incompleteResult.metadata.retryable, true, "resource omissions remain correctable before dispatch")
  for (const malformed of [
    { type: "text", source: { kind: "url", value: "https://origin.example/wrong.png" } },
    { type: "reply", text: "missing message ID" },
    { type: "rps", value: 4 },
    { type: "music", platform: "unknown", id: "42" },
  ]) assert.equal(validateToolArguments(messageTool, { parts: [malformed] }).ok, false, "anyOf validates the selected part shape")

  const { McpToolAdapter } = await import("../output/runtime/mcp/index.js")
  const mcpName = "schema-fixture"
  const mcpConfig = { enabled: true, transport: "streamableHttp", url: "https://example.invalid/mcp", allowedTools: ["search_images"] }
  await configStore.update(draft => { draft.mcp.enabled = true; draft.mcp.servers[mcpName] = mcpConfig })
  let mcpCalls = 0
  const mcpTool = new McpToolAdapter(mcpName, {
    async callTool(request) {
      assert.equal(request.name, "search_images")
      mcpCalls++
      return { content: [], structuredContent: { images: [{ url: "https://origin.example/mcp-regression.gif" }] } }
    },
  }, { name: "search_images", description: "Search images", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }, mcpConfig)
  registry.register(mcpTool)
  const mcpResult = await registry.execute(mcpTool.name, {}, { e, config: current() })
  const paddedImage = {
    type: "image", source: { kind: "url", value: mcpResult.structuredContent.images[0].url, mimeType: "image/gif", name: "开心表情包" },
    value: 2, text: "", userId: "", messageId: "", platform: "qq", id: "", url: "", audio: "", title: "", singer: "", image: "",
    name: "开心表情包", description: "欢呼", nodes: [{ nickname: "", userId: "", time: 0, parts: [] }],
  }
  const paddedOriginal = structuredClone(paddedImage)
  const beforePaddedSend = sent.length
  const paddedResult = await registry.execute("message_send", { parts: [paddedImage] }, { e, config: current() })
  assert.equal(mcpCalls, 1)
  assert.equal(paddedResult.receipt.status, "sent")
  assert.equal(sent.length, beforePaddedSend + 1, "an MCP image with irrelevant empty fields sends once")
  assert.equal(sent.at(-1).payload.type, "image")
  assert.equal(sent.at(-1).payload.file, "https://proxy.example/mcp-regression.gif")
  assert.deepEqual(paddedImage, paddedOriginal)
  for (const empty of ["", null, undefined]) {
    assert.deepEqual(validateOutboundMessageChain([{ type: "image", source: paddedImage.source, file: empty, url: empty, path: empty, src: empty }]), [])
  }
  for (const key of ["file", "url", "path", "src"]) {
    const beforeConflict = sent.length
    const conflict = await registry.execute("message_send", { parts: [{ type: "image", source: paddedImage.source, [key]: "https://origin.example/conflict.png" }] }, { e, config: current() })
    assert.equal(conflict.kind, "error")
    assert.equal(sent.length, beforeConflict, "nonempty native media fields are still rejected")
  }
  console.log(`message_send definition: ${JSON.stringify(responsesDefinition).length} chars (previously 5653)`)
  console.log("ok message chain: canonical formats, convenient media inputs, replaceable adapters, ordered partial delivery, field filters, forwards, native receipts, Custom automatic delivery, permissions and authenticated dry runs")
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await modelLogStore?.stop?.({ flush: true })
  await registry?.destroy?.()
  await sqliteClient?.close?.()
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)
