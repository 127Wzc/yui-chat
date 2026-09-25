import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = await fs.mkdtemp(path.join(root, "cache", "daily-still-"))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
process.chdir(path.resolve(root, "../.."))
global.logger = { mark() {}, info() {}, warn() {}, error() {}, debug() {} }
global.Bot = { express: null, wsf: {}, uin: [] }
global.plugin = class {}

try {
  const { defaults } = await import("../output/runtime/config/defaults.js")
  const { migrateStickerExpressionTimes } = await import("../output/runtime/config/store.js")
  const {
    stickerExpressionProbabilityHit,
    stickerExpressionGate,
    stickerExpressionReceiptStatus,
    stickerExpressionVersionCurrent,
    isStickerExpressionScopeAllowed,
    stickerExpressionExplicitRequest,
    stickerExpressionPickMode,
    noteExternalStickerDelivery,
  } = await import("../output/runtime/core/persona/sticker-expression-coordinator.js")
  const { isEmptyResponse } = await import("../output/runtime/core/chat/response-pipeline.js")
  const {
    selectStickerExpression,
    selectStickerByTags,
    inspectStickerExpressionChannel,
    listStickerExpressionChannels,
    recordStickerExpressionSent,
    resetStickerExpressionState,
  } = await import("../output/runtime/tools/builtins/sticker-expression.js")
  const { buildStickerChannelArguments, projectStickerChannelOutput } = await import("../output/runtime/core/persona/sticker-channel-adapter.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { adapterRegistry } = await import("../output/runtime/models/adapters/registry.js")
  const { TypeSafeAdapter } = await import("../output/runtime/models/adapters/typesafe.js")
  const { decideDailyStill, avoidRepeatedMood, dailyStillImageOptionLabel } = await import("../output/runtime/core/persona/daily-still-decider.js")
  const { dailyStillMoods, pickIdleMood, matchMoodByKeywords, moodAvailableAt, parseStillDescription, summarizeGallery } = await import("../output/runtime/core/persona/daily-still-moods.js")
  const { stickerExpressionCoordinator } = await import("../output/runtime/core/persona/sticker-expression-coordinator.js")
  const { createBuiltinTools } = await import("../output/runtime/tools/builtins/index.js")

  const { initDraft, buildConfig } = await import("../output/runtime/web/client/features/daily-still/daily-still-draft.js")
  const { DailyStillMoodSelect } = await import("../output/runtime/web/client/features/daily-still/daily-still-mood-select.js")
  const defaultSticker = defaults.persona.stickerExpression
  assert.equal(defaultSticker.ambient.intervalSeconds, 3600)
  assert.equal(defaultSticker.idle.intervalSeconds, 3600)
  assert.equal(defaultSticker.idle.minIdleSeconds, 3600)
  assert.deepEqual(defaultSticker.idle.allowedHours, { start: "09:00", end: "23:00" })
  assert.equal(defaultSticker.recentWindowSeconds, 21600)
  const form = initDraft(defaults, [])
  assert.equal(form.ambientIntervalMinutes, 60)
  assert.equal(form.idleIntervalMinutes, 60)
  assert.equal(form.recentWindowHours, 6)
  const savedForm = buildConfig(form, [])
  assert.equal(savedForm.ambient.intervalSeconds, 3600)
  assert.equal(savedForm.idle.intervalSeconds, 3600)
  assert.equal(savedForm.recentWindowSeconds, 21600)
  let emitted
  const select = DailyStillMoodSelect.setup({ modelValue: [], options: ["开心", "安慰"], emptyMeansAll: true }, { emit: (_event, value) => { emitted = value } })
  select.start()
  assert.deepEqual(select.draft.value, ["开心", "安慰"])
  select.confirm()
  assert.deepEqual(emitted, []) // 全选保留“全部”的含义，新增分组也自动加入。
  select.toggle("开心")
  select.confirm()
  assert.deepEqual(emitted, ["安慰"])
  const idleSelect = DailyStillMoodSelect.setup({ modelValue: [], options: ["开心", "安慰"], emptyMeansAll: false }, { emit() {} })
  idleSelect.start()
  assert.deepEqual(idleSelect.draft.value, [])
  const intervalConfig = { persona: { stickerExpression: { cooldownSeconds: 0, attemptIntervalSeconds: 0, ambient: { intervalSeconds: 3600 } } } }
  assert.equal(stickerExpressionGate(intervalConfig, { lastAmbientAttemptAt: 1000 }, 3600999, "ambient"), "ambient-interval")
  assert.equal(stickerExpressionGate(intervalConfig, { lastAmbientAttemptAt: 1000 }, 3601000, "ambient"), "ok")
  assert.equal(stickerExpressionGate(intervalConfig, { lastAmbientAttemptAt: 1000 }, 2000, "conversation"), "ok")

  // 情绪分组：未配置或全部无效时回到默认分组；时段支持跨午夜。
  const moods = dailyStillMoods(undefined)
  assert.ok(moods.length >= 10)
  assert.deepEqual(dailyStillMoods([{ name: "", tags: [] }]).map(item => item.name), moods.map(item => item.name))
  assert.equal(moodAvailableAt({ hours: "21:00-02:00" }, new Date(2026, 0, 1, 23, 0)), true)
  assert.equal(moodAvailableAt({ hours: "21:00-02:00" }, new Date(2026, 0, 1, 12, 0)), false)
  assert.equal(pickIdleMood(moods, ["晚安"], new Date(2026, 0, 1, 12, 0)), null)
  assert.equal(pickIdleMood(moods, ["晚安", "冒泡"], new Date(2026, 0, 1, 12, 0), 0.9)?.name, "冒泡")
  assert.equal(matchMoodByKeywords(moods, "今天又加班到十点，好累")?.mood.name, "疲惫")
  assert.equal(matchMoodByKeywords(moods, "请问这个接口的参数是什么类型"), null)
  // 空闲情绪优先避开最近发过的分组；全部发过时仍可选。
  assert.equal(pickIdleMood(moods, ["冒泡", "摸鱼"], new Date(2026, 0, 1, 12, 0), 0, ["冒泡"])?.name, "摸鱼")
  assert.equal(pickIdleMood(moods, ["冒泡"], new Date(2026, 0, 1, 12, 0), 0, ["冒泡"])?.name, "冒泡")

  // 图库描述固定四段；心情词拆分后参与统计。
  const sampleDescription = "主体: 二次元猫耳白发少女。文字: 摸摸笨蛋。心情/氛围: 可爱、治愈、宠溺、温馨。表述含义: 通常用于安慰朋友或恋人，带有一种宠溺的玩笑感。"
  const parsedDescription = parseStillDescription(sampleDescription)
  assert.equal(parsedDescription.subject, "二次元猫耳白发少女")
  assert.equal(parsedDescription.caption, "摸摸笨蛋")
  assert.deepEqual(parsedDescription.moods, ["可爱", "治愈", "宠溺", "温馨"])
  assert.match(parsedDescription.meaning, /^通常用于安慰/)
  assert.deepEqual(parseStillDescription("一张普通图片"), { subject: "", caption: "", moods: [], meaning: "" })
  const optionLabel = dailyStillImageOptionLabel(sampleDescription)
  assert.match(optionLabel, /^心情：可爱、治愈、宠溺、温馨；含义：/)
  assert.ok(optionLabel.length <= 61)
  const gallery = summarizeGallery([
    { id: "1", description: sampleDescription, tags: ["安慰", "可爱"] },
    { id: "2", description: "心情/氛围: 可爱、无奈。", tags: ["无奈"] },
    { id: "3", description: "无模板", tags: [] },
  ], moods, 3)
  assert.equal(gallery.scanned, 3)
  assert.equal(gallery.described, 2)
  assert.deepEqual(gallery.terms[0], { term: "可爱", count: 2, coveredBy: ["卖萌"] })
  assert.deepEqual(gallery.terms.find(item => item.term === "治愈").coveredBy, ["安慰"])
  assert.deepEqual(gallery.terms.find(item => item.term === "温馨").coveredBy, [])
  const comfortStats = gallery.moods.find(item => item.name === "安慰")
  assert.equal(comfortStats.images, 1)
  assert.deepEqual(comfortStats.tags.slice(0, 2), [{ tag: "安慰", count: 1 }, { tag: "摸摸头", count: 0 }])

  // 最近发过同一情绪：次选概率够高时改选，否则保持原选择。
  const tiredMood = moods.find(item => item.name === "疲惫")
  const repeated = { send: true, reason: "model-selected", source: "model", mood: moods.find(item => item.name === "安慰"), sendScore: 0.9, confidence: 0.6, probabilities: { 安慰: 0.6, 疲惫: 0.4, none: 0 }, model: "jev", error: "" }
  const switched = avoidRepeatedMood(repeated, moods, ["安慰"], 0.3)
  assert.equal(switched.mood.name, tiredMood.name)
  assert.equal(switched.repeatAvoided, "安慰")
  assert.equal(avoidRepeatedMood(repeated, moods, ["安慰"], 0.5).mood.name, "安慰")
  assert.equal(avoidRepeatedMood(repeated, moods, [], 0.3).mood.name, "安慰")
  assert.equal(avoidRepeatedMood({ ...repeated, source: "keywords" }, moods, ["安慰"], 0.3).mood.name, "安慰")

  // TypeSafe 端点：Base URL 可填到 /v1，也可以是完整 /systemone。
  const typesafe = new TypeSafeAdapter()
  assert.equal(typesafe.endpoint({ baseURL: "" }).toString(), "https://api.typesafe.ai/v1/systemone")
  assert.equal(typesafe.endpoint({ baseURL: "https://proxy.test/v1/systemone/" }).toString(), "https://proxy.test/v1/systemone")
  assert.equal(adapterRegistry.listAdapters().find(item => item.id === "typesafe")?.supportsDecision, true)
  // TypeSafe 请求体与响应解析：非数字字段丢弃，错误响应带上服务端消息。
  const originalFetch = globalThis.fetch
  const fetchCalls = []
  let fetchReply = { status: 200, body: { model: "jev-1.13.0", answers: { send_now: { type: "noul", noul: "0.82" }, mood: { type: "choice", choice: "疲惫", confidence: 0.7, probabilities: { 疲惫: 0.7, none: "x" } } }, usage: { input_tokens: 812, output_tokens: 24 } } }
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return new Response(JSON.stringify(fetchReply.body), { status: fetchReply.status, headers: { "Content-Type": "application/json" } })
  }
  try {
    const channel = { baseURL: "https://api.typesafe.ai/v1", apiKey: "secret", authType: "bearer", model: "jev-latest" }
    const parsed = await typesafe.decide({ channel, state: { 对方: "好累" }, questions: { send_now: { type: "noul", instructions: "?" } } })
    assert.equal(fetchCalls[0].url, "https://api.typesafe.ai/v1/systemone")
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer secret")
    assert.deepEqual(Object.keys(JSON.parse(fetchCalls[0].init.body)).sort(), ["model", "questions", "state"])
    assert.equal(parsed.model, "jev-1.13.0")
    assert.equal(parsed.answers.send_now.noul, 0.82)
    assert.equal(parsed.answers.mood.choice, "疲惫")
    assert.deepEqual(parsed.answers.mood.probabilities, { 疲惫: 0.7 })
    fetchReply = { status: 401, body: { error: { message: "invalid api key" } } }
    await assert.rejects(typesafe.decide({ channel, state: {}, questions: {} }), /401.*invalid api key/)
    await assert.rejects(typesafe.decide({ channel: { ...channel, apiKey: "" }, state: {}, questions: {} }), /API Key/)
    // 收到响应前连接被断开时重试一次。
    let dropped = 0
    fetchReply = { status: 200, body: { model: "jev", answers: {} } }
    const replyFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (dropped++ === 0) throw new TypeError("fetch failed", { cause: new Error("other side closed") })
      return replyFetch(url, init)
    }
    assert.equal((await typesafe.decide({ channel, state: {}, questions: {} })).model, "jev")
    assert.equal(dropped, 2)
  } finally {
    globalThis.fetch = originalFetch
  }

  // 决策：未配置模型走关键词；模型分值低于阈值不发送；请求失败回退关键词。
  const decisionConfig = {
    apiProviders: [{ name: "ts", type: "typesafe", baseURL: "https://api.typesafe.ai/v1", apiKey: "k", authType: "bearer" }],
    models: [{ name: "jev", modelIdentifier: "jev-latest", apiProvider: "ts", adapter: "typesafe", purpose: "decision", capabilities: { chat: false, embedding: false } }],
    modelTasks: {}, chat: {},
  }
  const baseInput = { config: decisionConfig, moods, state: { 对方: "今天又加班到十点，好累" }, plainText: "今天又加班到十点，好累", now: new Date(2026, 0, 1, 12, 0) }
  const keywordOnly = await decideDailyStill({ ...baseInput, decision: {} })
  assert.equal(keywordOnly.source, "keywords")
  assert.equal(keywordOnly.mood?.name, "疲惫")
  const originalDecide = adapterRegistry.decide
  const decideCalls = []
  let decideAnswer = { send_now: { type: "noul", noul: 0.3 }, mood: { type: "choice", choice: "疲惫", confidence: 0.9, probabilities: { 疲惫: 0.95 } } }
  adapterRegistry.decide = async request => {
    decideCalls.push(request)
    if (decideAnswer instanceof Error) throw decideAnswer
    return { model: "jev-1.13.0", answers: decideAnswer, usage: {} }
  }
  const lowScore = await decideDailyStill({ ...baseInput, decision: { model: "jev", sendThreshold: 0.6 } })
  assert.equal(lowScore.send, false)
  assert.equal(lowScore.reason, "not-a-moment")
  assert.equal(decideCalls[0].channel.type, "typesafe")
  assert.ok(Object.hasOwn(decideCalls[0].questions.mood.criteria, "none"))
  assert.equal(Object.hasOwn(decideCalls[0].questions.mood.criteria, "冒泡"), false)
  decideAnswer = { send_now: { type: "noul", noul: 0.9 }, mood: { type: "choice", choice: "安慰", confidence: 0.2 } }
  assert.equal((await decideDailyStill({ ...baseInput, decision: { model: "jev" } })).reason, "mood-uncertain")
  decideAnswer = { send_now: { type: "noul", noul: 0.9 }, mood: { type: "choice", choice: "安慰", confidence: 0.8 } }
  const accepted = await decideDailyStill({ ...baseInput, decision: { model: "jev" } })
  assert.equal(accepted.send, true)
  assert.equal(accepted.mood?.name, "安慰")
  decideAnswer = new Error("401 invalid key")
  const failed = await decideDailyStill({ ...baseInput, decision: { model: "jev" } })
  assert.equal(failed.source, "keywords")
  assert.match(failed.error, /invalid key/)
  // 选图方式按入口配置；冒泡默认最新，旧版全局 pickMode 只回退到对话和旁观。
  assert.equal(stickerExpressionPickMode({}, "conversation"), "mood")
  assert.equal(stickerExpressionPickMode({}, "idle"), "latest")
  assert.equal(stickerExpressionPickMode({ pickMode: "image" }, "ambient"), "image")
  assert.equal(stickerExpressionPickMode({ pickMode: "image" }, "idle"), "latest")
  assert.equal(stickerExpressionPickMode({ pickMode: "image", conversation: { pick: "latest" } }, "conversation"), "latest")
  assert.equal(stickerExpressionPickMode({ idle: { pick: "image" } }, "idle"), "latest")
  assert.equal(stickerExpressionPickMode({ idle: { pick: "mood" } }, "idle"), "mood")
  assert.equal(stickerExpressionProbabilityHit(0, 0), false)
  assert.equal(stickerExpressionProbabilityHit(100, 0.999), true)
  assert.equal(stickerExpressionExplicitRequest("给我发个表情包"), true)
  assert.equal(stickerExpressionExplicitRequest("不要发图片"), false)
  assert.equal(isEmptyResponse("<EMPTY>"), true)
  const gateConfig = { persona: { stickerExpression: { cooldownSeconds: 1, attemptIntervalSeconds: 2, dailyQuota: 2 } } }
  const migrated = migrateStickerExpressionTimes({ persona: { stickerExpression: {
    cooldownMs: 1500,
    ambient: { windowMs: 2500 },
    idle: { intervalMinutes: 2, minIdleMinutes: 3 },
    recentWindowMinutes: 4,
    contextTtlMs: 5000,
    intentTimeoutMs: 6000,
    moodDecayMinutes: 7,
  } } })
  const migratedSticker = migrated.persona.stickerExpression
  assert.equal(migratedSticker.cooldownSeconds, 1.5)
  assert.equal(migratedSticker.ambient.windowSeconds, 2.5)
  assert.equal(migratedSticker.idle.intervalSeconds, 120)
  assert.equal(migratedSticker.idle.minIdleSeconds, 180)
  assert.equal(migratedSticker.recentWindowSeconds, 240)
  assert.equal(migratedSticker.contextTtlSeconds, 5)
  assert.equal(migratedSticker.intentTimeoutSeconds, 6)
  assert.equal(migratedSticker.moodDecaySeconds, 420)
  assert.equal(Object.hasOwn(migratedSticker, "cooldownMs"), false)
  assert.equal(stickerExpressionGate(gateConfig, { lastSuccessAt: 9000, lastAttemptAt: 0, sentCount: 0 }, 9500), "cooldown")
  assert.equal(stickerExpressionGate(gateConfig, { lastSuccessAt: 0, lastAttemptAt: 9000, sentCount: 0 }, 9500), "attempt-interval")
  assert.equal(stickerExpressionGate(gateConfig, { lastSuccessAt: 0, lastAttemptAt: 0, sentCount: 2 }, 9500), "daily-quota")
  assert.equal(stickerExpressionGate(gateConfig, { lastSuccessAt: 0, lastAttemptAt: 0, sentCount: 1 }, 9500), "ok")
  assert.equal(stickerExpressionReceiptStatus({ status: "success", value: { receipt: { status: "sent", sentCount: 1 } } }), "sent")
  assert.equal(stickerExpressionReceiptStatus({ status: "success", value: { receipt: { status: "partial", sentCount: 1 } } }), "partial")
  assert.equal(stickerExpressionReceiptStatus({ status: "ambiguous" }), "ambiguous")
  assert.equal(stickerExpressionVersionCurrent(2, 1), false)
  assert.equal(stickerExpressionVersionCurrent(2, 2), true)
  assert.equal(stickerExpressionVersionCurrent(2, undefined), true)
  const imagTagServer = defaults.mcp.servers["imagTag-mcp"]
  assert.equal(defaults.mcp.enabled, false)
  assert.equal(imagTagServer.enabled, false)
  assert.equal(imagTagServer.transport, "streamableHttp")
  assert.equal(imagTagServer.url, "https://imag-tag.559558.xyz//api/v1/mcp/public")
  assert.deepEqual(imagTagServer.allowedTools, ["search_images"])
  assert.equal(defaults.persona.stickerExpression.binding.primaryTool, "mcp_imagTag-mcp_search_images")
  assert.equal(defaults.persona.stickerExpression.decision.model, "")
  assert.equal(createBuiltinTools().some(tool => tool.name === "sticker_search"), false)
  const scoped = { ...defaults, enabled: undefined, persona: { stickerExpression: { enabled: true, privateEnabled: false, groupScope: { allowlist: ["100"], blocklist: ["101"] } } } }
  assert.equal(isStickerExpressionScopeAllowed({ isGroup: true, group_id: "100" }, scoped), true)
  assert.equal(isStickerExpressionScopeAllowed({ isGroup: true, group_id: "101" }, scoped), false)
  assert.equal(isStickerExpressionScopeAllowed({ isGroup: true, group_id: "102" }, scoped), false)
  assert.equal(isStickerExpressionScopeAllowed({ isPrivate: true, user_id: "u" }, scoped), false)

  const originalGet = toolRegistry.get
  const originalExecute = toolRegistry.execute
  let searchCalls = 0
  toolRegistry.get = name => name === "mcp_gallery_search_images" ? { name, mcp: { serverName: "gallery", originalName: "search_images" }, common: { source: "mcp" } } : null
  toolRegistry.execute = async () => {
    searchCalls++
    return { structuredContent: { images: [{ id: "pat", url: "https://example.test/pat.gif", description: "安慰抱抱", tags: ["安慰"], score: 0.8 }] } }
  }
  const config = { tools: { enabled: true }, mcp: { enabled: true, servers: { gallery: { enabled: true, allowedTools: ["search_images"] } } } }
  const context = { config, e: { isGroup: true, group_id: "100", user_id: "u" }, toolConfig: { primaryTool: "mcp_gallery_search_images", candidateCount: 10, selectionMode: "best" } }
  resetStickerExpressionState()
  const first = await selectStickerExpression({ keyword: "安慰疲惫的朋友" }, context, { trackRecent: false })
  const second = await selectStickerExpression({ keyword: "安慰疲惫的朋友" }, context, { trackRecent: false })
  assert.equal(first.status, "selected")
  assert.equal(second.status, "selected")
  assert.equal(searchCalls, 2)
  assert.equal(first.selected.url, second.selected.url)
  let releaseConcurrent
  const delayed = new Promise(resolve => { releaseConcurrent = resolve })
  let concurrentCalls = 0
  toolRegistry.execute = async () => {
    concurrentCalls++
    await delayed
    return { structuredContent: { images: [{ id: "concurrent", url: "https://example.test/concurrent.gif", description: "安慰", tags: ["安慰"] }] } }
  }
  const concurrentOne = selectStickerExpression({ keyword: "安慰疲惫的朋友" }, context, { trackRecent: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  const concurrentTwo = await selectStickerExpression({ keyword: "安慰疲惫的朋友" }, context, { trackRecent: false })
  assert.equal(concurrentTwo.status, "skipped")
  releaseConcurrent()
  assert.equal((await concurrentOne).status, "selected")
  recordStickerExpressionSent(first.scope, first.binding.serverName, "concurrent", 120)
  const third = await selectStickerExpression({ keyword: "安慰疲惫的朋友" }, context, { trackRecent: false })
  assert.equal(third.status, "skipped")
  assert.equal(concurrentCalls, 2)
  resetStickerExpressionState()
  toolRegistry.get = name => name === "sticker_pick" ? { name, common: { source: "builtin", execution: { effect: "read" } } } : null
  toolRegistry.execute = async (name, args) => {
    assert.equal(name, "sticker_pick")
    assert.equal(args.keyword, "安慰疲惫的朋友")
    return { images: [{ id: "replacement", url: "https://example.test/replacement.gif", description: "安慰", tags: ["安慰"] }] }
  }
  const replacement = await selectStickerExpression({ keyword: "安慰疲惫的朋友" }, { ...context, toolConfig: { tool: "sticker_pick", candidateCount: 10, selectionMode: "best" } }, { trackRecent: false })
  assert.equal(replacement.status, "selected")
  assert.equal(replacement.binding.toolName, "sticker_pick")

  const compatibleTool = {
    name: "custom_gallery",
    common: {
      source: "custom",
      descriptionZh: "返回图片候选的只读搜图",
      execution: { effect: "read" },
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          tags: { type: "array" },
          count: { type: "integer" },
        },
        required: ["keyword"],
      },
    },
  }
  const compatible = inspectStickerExpressionChannel(compatibleTool)
  assert.equal(compatible.eligible, true)
  const incompatibleTool = {
    name: "write_gallery",
    common: {
      source: "custom",
      descriptionZh: "图片写入",
      execution: { effect: "non_idempotent" },
      parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
    },
  }
  const incompatible = inspectStickerExpressionChannel(incompatibleTool)
  assert.equal(incompatible.eligible, false)
  assert.equal(listStickerExpressionChannels([compatibleTool, incompatibleTool]).length, 1)
  const semanticAdapterTool = {
    name: "mcp_imagTag-mcp_search_images",
    mcp: { serverName: "imagTag-mcp", originalName: "search_images" },
    common: { source: "mcp", execution: { effect: "read" }, parameters: { type: "object", properties: { keyword: { type: "string" } } } },
  }
  assert.deepEqual(buildStickerChannelArguments(semanticAdapterTool, { keyword: "安慰", tags: [], count: 10 }), {
    keyword: "安慰", count: 10, match: "semantic", sort: "relevance",
  })
  assert.deepEqual(projectStickerChannelOutput({ structuredContent: { images: [{ url: "https://example.test/a.gif" }] } }, semanticAdapterTool), [{ url: "https://example.test/a.gif" }])
  // 按标签检索时省略空关键词；sort 只发给声明或已知支持的渠道。
  assert.deepEqual(buildStickerChannelArguments(semanticAdapterTool, { keyword: "", tags: ["安慰"], count: 30, sort: "latest" }), {
    match: "semantic", sort: "latest", tags: ["安慰"], count: 30,
  })
  assert.deepEqual(buildStickerChannelArguments(compatibleTool, { keyword: "", tags: ["安慰"], count: 30, sort: "latest" }), { tags: ["安慰"], count: 30 })
  const mappedTool = {
    name: "custom_gallery_mapped",
    common: {
      source: "custom",
      execution: { effect: "read" },
      stickerExpressionChannel: {
        version: 1, input: "keyword-tags-count", output: "images", readOnly: true,
        inputMapping: { keyword: "query", tags: "labels", count: "limit" },
        fixedArguments: { mode: "semantic" },
        outputMapping: { candidatesPath: "data.items", idField: "key", urlField: "image_url" },
      },
    },
  }
  assert.deepEqual(buildStickerChannelArguments(mappedTool, { keyword: "安慰", tags: ["抱抱"], count: 10 }), {
    query: "安慰", labels: ["抱抱"], limit: 10, mode: "semantic",
  })
  assert.deepEqual(projectStickerChannelOutput({ data: { items: [{ key: "mapped", image_url: "https://example.test/mapped.gif" }] } }, mappedTool), [{ id: "mapped", url: "https://example.test/mapped.gif" }])

  resetStickerExpressionState()
  const fallbackCalls = []
  toolRegistry.get = name => ["primary_channel", "fallback_channel"].includes(name)
    ? { name, common: { source: "custom", execution: { effect: "read" } } }
    : null
  toolRegistry.execute = async (name) => {
    fallbackCalls.push(name)
    if (name === "primary_channel") return { status: "error", error: "primary unavailable" }
    return { images: [{ id: "fallback", url: "https://example.test/fallback.gif", description: "安慰抱抱" }] }
  }
  const fallback = await selectStickerExpression({ keyword: "安慰疲惫的朋友" }, {
    ...context,
    toolConfig: { primaryTool: "primary_channel", fallbackTool: "fallback_channel", candidateCount: 10, selectionMode: "best" },
  }, { trackRecent: false })
  assert.equal(fallback.status, "selected")
  assert.deepEqual(fallbackCalls, ["primary_channel", "fallback_channel"])
  assert.equal(fallback.binding.toolName, "fallback_channel")
  assert.equal(fallback.errors[0].code, "TOOL_RESPONSE_ERROR")
  resetStickerExpressionState()
  const tagFallbackCalls = []
  toolRegistry.get = name => name === "tagged_gallery" ? { name, common: { source: "custom", execution: { effect: "read" } } } : null
  toolRegistry.execute = async (_name, args) => {
    tagFallbackCalls.push(args)
    return args.tags
      ? { images: [] }
      : { images: [{ id: "tag-fallback", url: "https://example.test/tag-fallback.gif", description: "温柔安慰疲惫的朋友", tags: ["安慰"] }] }
  }
  const tagFallback = await selectStickerExpression({ keyword: "温柔安慰疲惫的朋友", tags: ["安慰", "疲惫", "低落"] }, {
    ...context,
    toolConfig: { primaryTool: "tagged_gallery", candidateCount: 10, selectionMode: "best" },
  }, { trackRecent: false })
  assert.equal(tagFallback.status, "selected")
  assert.equal(tagFallback.selected.id, "tag-fallback")
  assert.deepEqual(tagFallbackCalls, [
    { keyword: "温柔安慰疲惫的朋友", tags: ["安慰", "疲惫"], count: 10 },
    { keyword: "温柔安慰疲惫的朋友", count: 10 },
  ])
  assert.equal(tagFallback.errors[0].code, "TAG_FILTER_NO_MATCH")

  // 标签候选池：按标签顺序合并，达到 topK 后停止；排除近期已发送。
  resetStickerExpressionState()
  const poolCalls = []
  toolRegistry.get = name => name === "pool_gallery" ? { name, common: { source: "custom", execution: { effect: "read" }, parameters: { type: "object", properties: { keyword: { type: "string" }, tags: { type: "array" }, count: { type: "integer" }, sort: { type: "string" }, match: { type: "string" }, page: { type: "integer" } } } } } : null
  toolRegistry.execute = async (_name, args) => {
    poolCalls.push(args)
    const byTag = {
      安慰: [{ id: "a1", url: "https://example.test/a1.gif" }, { id: "a2", url: "https://example.test/a2.gif" }],
      摸摸头: [{ id: "a2", url: "https://example.test/a2.gif" }, { id: "b1", url: "https://example.test/b1.gif" }, { id: "b2", url: "https://example.test/b2.gif" }],
    }
    return { images: args.tags ? (byTag[args.tags[0]] || []) : [{ id: "fuzzy", url: "https://example.test/fuzzy.gif" }] }
  }
  const poolContext = { ...context, toolConfig: { primaryTool: "pool_gallery", candidateCount: 30, topK: 3 } }
  const pooled = await selectStickerByTags({ tags: ["安慰", "摸摸头", "抱抱"], fallbackKeyword: "安慰" }, poolContext, { excludeIds: new Set(["a1"]), random: () => 0.99 })
  assert.equal(pooled.status, "selected")
  assert.deepEqual(pooled.ranked.map(item => item.id), ["a2", "b1", "b2"])
  assert.equal(pooled.selected.id, "b2")
  assert.deepEqual(poolCalls, [{ tags: ["安慰"], count: 30, sort: "latest" }, { tags: ["摸摸头"], count: 30, sort: "latest" }])
  poolCalls.length = 0
  const fuzzy = await selectStickerByTags({ tags: ["不存在"], fallbackKeyword: "安慰" }, poolContext, { random: () => 0 })
  assert.equal(fuzzy.selected.id, "fuzzy")
  assert.deepEqual(poolCalls[1], { keyword: "安慰", count: 30, sort: "latest", match: "fuzzy" })

  // 空闲试运行不调用决策模型。
  decideCalls.length = 0
  const idleConfig = { ...decisionConfig, tools: { enabled: true }, persona: { stickerExpression: { enabled: true, binding: { primaryTool: "pool_gallery", candidateCount: 30, topK: 3 }, decision: { model: "jev" }, idle: { moods: ["安慰"], pick: "mood" } } } }
  const idlePreview = await stickerExpressionCoordinator.preview({ config: idleConfig, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "idle" })
  assert.equal(idlePreview.ok, true)
  assert.equal(idlePreview.mood, "安慰")
  assert.equal(decideCalls.length, 0)
  // 冒泡默认取最新上传的一张，不调用决策，也不按标签检索。
  poolCalls.length = 0
  const latestConfig = { ...idleConfig, persona: { stickerExpression: { ...idleConfig.persona.stickerExpression, idle: { pick: "latest" } } } }
  const latestPreview = await stickerExpressionCoordinator.preview({ config: latestConfig, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "idle" })
  assert.equal(latestPreview.ok, true)
  assert.equal(latestPreview.pickMode, "latest")
  assert.equal(latestPreview.selection.selected.id, "fuzzy")
  assert.deepEqual(poolCalls, [{ count: 30, sort: "latest", page: 1 }])
  assert.equal(decideCalls.length, 0)
  // 持久化发送记录只在配置的 6 小时内排除；恰好到期即可重新选择。
  const dedupeEvent = { isGroup: true, group_id: "dedupe-window", user_id: "u" }
  const originalNow = Date.now
  const sentTime = originalNow()
  try {
    Date.now = () => sentTime
    await noteExternalStickerDelivery(dedupeEvent, { stickerExpression: { selectedId: "fuzzy", serverName: "pool_gallery" } })
    resetStickerExpressionState() // 模拟重启后仅保留持久化记录。
    Date.now = () => sentTime + 21600000 - 1
    assert.equal((await stickerExpressionCoordinator.preview({ config: latestConfig, event: dedupeEvent, mode: "idle" })).ok, false)
    Date.now = () => sentTime + 21600000
    assert.equal((await stickerExpressionCoordinator.preview({ config: latestConfig, event: dedupeEvent, mode: "idle" })).selection.selected.id, "fuzzy")
  } finally {
    Date.now = originalNow
  }
  // 真实投递链（模拟宿主回执）：保存尝试后，成功计数与去重记录仍须写回当前状态。
  const { configStore, dataDir } = await import("../output/runtime/config/store.js")
  const savedGetConfig = configStore.get
  const savedSegment = global.segment
  const hostReplies = []
  global.segment = { image: value => ({ type: "image", data: { file: value } }) }
  const savedGetTool = toolRegistry.get
  const savedExecute = toolRegistry.execute
  const sendTool = createBuiltinTools().find(tool => tool.name === "message_send")
  const sendConfig = { ...latestConfig, persona: { stickerExpression: { ...latestConfig.persona.stickerExpression,
    conversation: { enabled: true, probabilityPercent: 100, pick: "latest" },
    groupScope: { allowlist: ["receipt-test"] }, cooldownSeconds: 0, attemptIntervalSeconds: 0, dailyQuota: 1,
  } } }
  try {
    configStore.get = () => sendConfig
    toolRegistry.get = name => name === "message_send" ? sendTool : savedGetTool(name)
    toolRegistry.execute = async (name, ...args) => name === "message_send"
      ? sendTool.execute(...args) : savedExecute(name, ...args)
    const sendEvent = { isGroup: true, group_id: "receipt-test", user_id: "u", reply: async (payload, quote) => {
      hostReplies.push({ payload, quote })
      return { message_id: "still-image" }
    } }
    const delivered = await stickerExpressionCoordinator.afterConversation(sendEvent, { config: sendConfig, botText: "你好" })
    assert.equal(delivered.sent, true, JSON.stringify(delivered))
    assert.equal(hostReplies[0].quote, false)
    assert.equal(hostReplies[0].payload.type, "image")
    // 普通 message_send 仍使用全局默认的引用回复。
    await sendTool.execute({ parts: [{ type: "text", text: "normal message" }] }, { config: sendConfig, e: sendEvent })
    assert.equal(hostReplies[1].quote, true)
    const savedState = JSON.parse(await fs.readFile(path.join(dataDir, "daily-still-state.json"), "utf8"))
    assert.equal(savedState.scopes["group:receipt-test"].sentCount, 1)
    assert.equal(savedState.scopes["group:receipt-test"].recent[0].id, "fuzzy")
    assert.equal((await stickerExpressionCoordinator.afterConversation(sendEvent, { config: sendConfig, botText: "你好" })).reason, "daily-quota")
    // 旁观定时入口同样不引用触发消息。
    sendConfig.persona.stickerExpression.groupScope.allowlist.push("ambient-quote", "idle-quote")
    sendConfig.persona.stickerExpression.ambient = { enabled: true, probabilityPercent: 100, windowSeconds: 1, pick: "latest" }
    stickerExpressionCoordinator.observeGroupMessage({ ...sendEvent, group_id: "ambient-quote", __yuiChatReplied: false })
    const deadline = Date.now() + 5000
    while ((hostReplies.length < 3 || stickerExpressionCoordinator.stats().runningScopes > 0) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(hostReplies.length, 3)
    assert.equal(hostReplies[2].quote, false)
    assert.equal(hostReplies[2].payload.type, "image")
    // 冷场入口通过群发送接口直接发图，不附加 reply 片段。
    const { recentContextStore } = await import("../output/runtime/core/chat/recent-context.js")
    const savedLatestMessageAt = recentContextStore.latestMessageAt
    const idlePayloads = []
    try {
      stickerExpressionCoordinator.observeGroupMessage({ ...sendEvent, group_id: "idle-quote", __yuiChatReplied: true })
      recentContextStore.latestMessageAt = () => Date.now() - 3600001
      sendConfig.persona.stickerExpression.idle = { enabled: true, probabilityPercent: 100, pick: "latest", groups: ["idle-quote"], minIdleSeconds: 3600, allowedHours: { start: "00:00", end: "23:59" } }
      const idleResult = await stickerExpressionCoordinator.runIdle({ config: sendConfig, bot: { pickGroup: () => ({ sendMsg: async payload => { idlePayloads.push(payload); return { message_id: "idle-still" } } }) } })
      assert.equal(idleResult.results[0].sent, true, JSON.stringify(idleResult))
      assert.equal(idlePayloads[0].type, "image")
    } finally {
      recentContextStore.latestMessageAt = savedLatestMessageAt
    }
  } finally {
    stickerExpressionCoordinator.stop()
    global.segment = savedSegment
    configStore.get = savedGetConfig
    toolRegistry.get = savedGetTool
    toolRegistry.execute = savedExecute
  }
  // 对话也可以配置为最新，同样不调用决策。
  const latestConversation = await stickerExpressionCoordinator.preview({ config: { ...latestConfig, persona: { stickerExpression: { ...latestConfig.persona.stickerExpression, conversation: { pick: "latest" } } } }, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "conversation", text: "好累" })
  assert.equal(latestConversation.pickMode, "latest")
  assert.equal(decideCalls.length, 0)
  // 对话试运行：send_now 低于阈值时只调用一次决策，不查询图库。
  poolCalls.length = 0
  decideAnswer = { send_now: { type: "noul", noul: 0.2 }, mood: { type: "choice", choice: "疲惫", confidence: 0.9 } }
  const lowPreview = await stickerExpressionCoordinator.preview({ config: idleConfig, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "conversation", text: "今天又加班到十点，好累" })
  assert.equal(lowPreview.ok, false)
  assert.equal(lowPreview.reason, "not-a-moment")
  assert.equal(decideCalls.length, 1)
  assert.equal(poolCalls.length, 0)

  // 对话可以限定候选分组，决策选项只包含这些分组。
  decideCalls.length = 0
  decideAnswer = { send_now: { type: "noul", noul: 0.9 }, mood: { type: "choice", choice: "安慰", confidence: 0.8 } }
  const subsetConfig = { ...idleConfig, persona: { stickerExpression: { ...idleConfig.persona.stickerExpression, conversation: { pick: "mood", moods: ["安慰", "疲惫"] } } } }
  await stickerExpressionCoordinator.preview({ config: subsetConfig, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "conversation", text: "好累" })
  assert.deepEqual(Object.keys(decideCalls[0].questions.mood.criteria), ["安慰", "疲惫", "none"])

  // 精选模式：按原文语义召回，一次决策同时判断是否发送和挑哪张。
  const semanticCalls = []
  toolRegistry.get = name => name === "pool_gallery" ? { name, common: { source: "custom", execution: { effect: "read" }, parameters: { type: "object", properties: { keyword: { type: "string" }, count: { type: "integer" }, sort: { type: "string" }, match: { type: "string" }, page: { type: "integer" } } } } } : null
  toolRegistry.execute = async (_name, args) => {
    semanticCalls.push(args)
    return { images: [
      { id: "s1", url: "https://example.test/s1.gif", description: "心情/氛围: 开心、庆祝。表述含义: 用于祝贺好消息。" },
      { id: "s2", url: "https://example.test/s2.gif", description: sampleDescription },
      { id: "s3", url: "https://example.test/s3.gif", description: "心情/氛围: 无奈。" },
    ] }
  }
  decideCalls.length = 0
  decideAnswer = { send_now: { type: "noul", noul: 0.9 }, pick: { type: "choice", choice: "图2", confidence: 0.7, probabilities: { 图1: 0.3, 图2: 0.7 } } }
  const imageConfig = { ...idleConfig, persona: { stickerExpression: { ...idleConfig.persona.stickerExpression, pickMode: "image", imagePoolSize: 12 } } }
  const picked = await stickerExpressionCoordinator.preview({ config: imageConfig, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "conversation", text: "摸摸头安慰我一下" })
  assert.equal(picked.ok, true)
  assert.equal(picked.pickMode, "image")
  assert.equal(picked.selection.selected.id, "s2")
  assert.equal(picked.mood, "可爱")
  assert.deepEqual(picked.decision.probabilities, { s1: 0.3, s2: 0.7 })
  assert.deepEqual(semanticCalls, [{ keyword: "摸摸头安慰我一下", count: 12, sort: "relevance", match: "semantic" }])
  assert.deepEqual(Object.keys(decideCalls[0].questions.pick.criteria), ["图1", "图2", "图3", "none"])
  decideAnswer = { send_now: { type: "noul", noul: 0.9 }, pick: { type: "choice", choice: "none", confidence: 0.8 } }
  assert.equal((await stickerExpressionCoordinator.preview({ config: imageConfig, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "conversation", text: "摸摸头" })).reason, "no-image-fit")
  // 没有决策模型时精选模式退回情绪模式，不做语义召回。
  semanticCalls.length = 0
  const noModelConfig = { ...imageConfig, persona: { stickerExpression: { ...imageConfig.persona.stickerExpression, decision: { model: "" } } } }
  const fallbackMood = await stickerExpressionCoordinator.preview({ config: noModelConfig, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "conversation", text: "今天加班好累" })
  assert.equal(fallbackMood.pickMode, "mood")
  assert.equal(semanticCalls.some(args => args.match === "semantic"), false)
  // 语义召回太少时退回情绪模式。
  toolRegistry.execute = async (_name, args) => {
    semanticCalls.push(args)
    return { images: args.match === "semantic" ? [{ id: "only", url: "https://example.test/only.gif", description: sampleDescription }] : [{ id: "t1", url: "https://example.test/t1.gif" }] }
  }
  decideAnswer = { send_now: { type: "noul", noul: 0.9 }, mood: { type: "choice", choice: "疲惫", confidence: 0.8 } }
  const smallPool = await stickerExpressionCoordinator.preview({ config: imageConfig, event: { isGroup: true, group_id: "100", user_id: "u" }, mode: "conversation", text: "今天加班好累" })
  assert.equal(smallPool.pickMode, "mood")
  assert.equal(smallPool.pickFallback, "semantic-pool-1")
  assert.equal(smallPool.ok, true)
  assert.equal(smallPool.mood, "疲惫")
  adapterRegistry.decide = originalDecide

  // 图库扫描：按最新分页读取，拿到总数后停止；统计覆盖情况。
  const scanCalls = []
  toolRegistry.execute = async (_name, args) => {
    scanCalls.push(args)
    const start = (args.page - 1) * args.count
    return { total: 120, images: Array.from({ length: Math.max(0, Math.min(args.count, 120 - start)) }, (_, index) => ({ id: `g${start + index}`, url: `https://example.test/g${start + index}.gif`, description: sampleDescription, tags: ["安慰"] })) }
  }
  const scanned = await stickerExpressionCoordinator.galleryStats({ config: { ...idleConfig, persona: { stickerExpression: { ...idleConfig.persona.stickerExpression, binding: { primaryTool: "pool_gallery" } } } } })
  assert.equal(scanned.ok, true)
  assert.equal(scanned.stats.scanned, 120)
  assert.equal(scanned.stats.total, 120)
  assert.deepEqual(scanCalls.map(args => args.page), [1, 2, 3])
  assert.equal(scanCalls[0].count, 50)
  assert.equal(scanCalls[0].sort, "latest")
  assert.equal(scanned.stats.moods.find(item => item.name === "安慰").images, 120)

  toolRegistry.get = originalGet
  toolRegistry.execute = originalExecute
  await toolRegistry.destroy()
  console.log("Daily still checks passed (moods, decision, tag pool, image pick, gallery stats, idle without model, scope, dedupe).")
} finally {
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)
