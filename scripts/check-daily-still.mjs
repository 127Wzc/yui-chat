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
    parseStickerIntent,
    stickerExpressionProbabilityHit,
    stickerExpressionGate,
    stickerExpressionReceiptStatus,
    stickerExpressionVersionCurrent,
    isStickerExpressionScopeAllowed,
    stickerExpressionExplicitRequest,
  } = await import("../output/runtime/core/persona/sticker-expression-coordinator.js")
  const { isEmptyResponse } = await import("../output/runtime/core/chat/response-pipeline.js")
  const {
    selectStickerExpression,
    inspectStickerExpressionChannel,
    listStickerExpressionChannels,
    recordStickerExpressionSent,
    resetStickerExpressionState,
  } = await import("../output/runtime/tools/builtins/sticker-expression.js")
  const { buildStickerChannelArguments, projectStickerChannelOutput } = await import("../output/runtime/core/persona/sticker-channel-adapter.js")
  const { toolRegistry } = await import("../output/runtime/tools/support/registry.js")
  const { createBuiltinTools } = await import("../output/runtime/tools/builtins/index.js")

  assert.deepEqual(parseStickerIntent('{"shouldSend":true,"emotion":"安慰","intensity":0.8,"keyword":"温柔抱抱疲惫的朋友","tags":["安慰"]}'), {
    shouldSend: true, emotion: "安慰", intensity: 0.8, keyword: "温柔抱抱疲惫的朋友", tags: ["安慰"],
  })
  assert.equal(parseStickerIntent("不是 JSON"), null)
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
  assert.equal(imagTagServer.url, "https://imag-tag.559558.xyz/api/v1/mcp")
  assert.deepEqual(imagTagServer.allowedTools, ["search_images"])
  assert.equal(defaults.persona.stickerExpression.binding.primaryTool, "mcp_imagTag-mcp_search_images")
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
  toolRegistry.get = originalGet
  toolRegistry.execute = originalExecute
  await toolRegistry.destroy()
  console.log("Daily still checks passed (intent, probability, scope, selection-only, success dedupe).")
} finally {
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)
