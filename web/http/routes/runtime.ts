import crypto from "node:crypto"
import { configStore } from "../../../config/store.js"
import { recentContextStore } from "../../../core/chat/recent-context.js"
import { commandObserver } from "../../../knowledge/command-observer.js"
import { memoryStore } from "../../../memory/store.js"
import { adapterRegistry } from "../../../models/adapters/registry.js"
import { sqliteClient } from "../../../core/storage/sqlite/client.js"
import { conversationStore } from "../../../core/chat/conversation-store.js"
import { authStats, clearWebSession, consumeQuickLogin, issueWebAccessToken, readWebHeaderToken, requireWebAuth as auth, setWebSessionCookie, validateConfiguredWebToken } from "../auth.js"
import { createWebTestEvent as webTestEvent, sanitizeWebId as sanitizeId } from "../request-context.js"
import { handleRoute } from "../route-handler.js"
import type { RouteApp, RouteRequest, RouteResponse } from "../route-handler.js"
import { toolRegistry } from "../../../tools/support/registry.js"
import { createWebMessageAdapter } from "../chat-message-adapter.js"
import { cacheWebDeliveryMedia, readWebDeliveryMedia } from "../../../core/media/media-cache.js"
import { sendWebChatResponse } from "../chat-stream.js"

const chatImageMime = /^image\/(?:png|jpeg|webp|gif)$/
function chatImageLimit(): number {
  const recognition = configStore.get().mediaRecognition as { remoteFetch?: { maxBytes?: unknown } } | undefined
  return Math.min(20 * 1024 * 1024, Math.max(1, Number(recognition?.remoteFetch?.maxBytes) || 4 * 1024 * 1024))
}

/** 注册运行状态、Web 测试会话、媒体缓存与渲染预览接口。 */
export function registerRuntimeRoutes(app: RouteApp): void {
  app.get("/api/health", handleRoute(async (_req, res) => {
    const { mediaCacheStats } = await import("../../../core/media/media-cache.js")
    const { buildCapabilityRegistry } = await import("../../../core/runtime/capability-registry.js")
    const capabilities = await buildCapabilityRegistry()
    res.json({
      ok: true,
      name: "yui-chat",
      mountedAt: configStore.get().web?.mountPath || "",
      capabilities: capabilities.summary,
      knowledge: commandObserver.stats(),
      memory: memoryStore.stats(),
      context: recentContextStore.stats(),
      mediaCache: await mediaCacheStats(),
      adapters: adapterRegistry.listAdapters(),
      storage: sqliteClient.status,
      auth: authStats(),
    })
  }))
  app.get("/api/capabilities", auth, handleRoute(async (_req, res) => {
    const { buildCapabilityRegistry } = await import("../../../core/runtime/capability-registry.js")
    res.json({ ok: true, registry: await buildCapabilityRegistry() })
  }))
  app.post("/api/auth/quick-login", handleRoute(async (req, res) => {
    const session = consumeQuickLogin(req.body?.code)
    setWebSessionCookie(req, res, session)
    res.json({ ok: true, result: { expiresAt: session.expiresAt, ttlMs: session.ttlMs } })
  }, { errorStatus: 401 }))
  app.post("/api/auth/session", handleRoute(async (req, res) => {
    if (!validateConfiguredWebToken(readWebHeaderToken(req))) throw new Error("静态 Web Token 未配置或无效")
    const session = issueWebAccessToken("web-token")
    setWebSessionCookie(req, res, session)
    res.json({ ok: true, result: { expiresAt: session.expiresAt, ttlMs: session.ttlMs } })
  }, { errorStatus: 401 }))
  app.post("/api/auth/logout", handleRoute(async (req, res) => {
    clearWebSession(req, res)
    res.json({ ok: true })
  }))
  app.get("/api/runtime", auth, async (_req: RouteRequest, res: RouteResponse) => {
    const { runtimeStats } = await import("../../../core/runtime/lifecycle.js")
    res.json({ ok: true, stats: runtimeStats() })
  })
  app.get("/api/daily-still", auth, handleRoute(async (_req, res) => {
    const { buildStickerExpressionStatus } = await import("../../../core/persona/sticker-expression-coordinator.js")
    const { listStickerExpressionChannels } = await import("../../../tools/builtins/sticker-expression.js")
    const allTools = await toolRegistry.list()
    const byName = new Map(allTools.map(item => [String(item.name || ""), item]))
    const channels = listStickerExpressionChannels(allTools).map(channel => {
      const item = byName.get(channel.name) || {}
      return {
        ...channel,
        enabled: item.enabled === true,
        common: item.common,
      }
    })
    const { dailyStillMoods, DEFAULT_DAILY_STILL_MOODS } = await import("../../../core/persona/daily-still-moods.js")
    const publicConfig = configStore.getPublic()
    const sticker = (publicConfig.persona as Record<string, unknown> | undefined)?.stickerExpression as Record<string, unknown> | undefined
    res.json({ ok: true, status: buildStickerExpressionStatus(publicConfig), channels, tools: channels, moods: dailyStillMoods(sticker?.moods), defaultMoods: DEFAULT_DAILY_STILL_MOODS })
  }))
  app.post("/api/daily-still/test", auth, handleRoute(async (req, res) => {
    const input = String(req.body?.text || "").trim().slice(0, 1000)
    const mode = ["conversation", "ambient", "idle"].includes(String(req.body?.mode)) ? String(req.body.mode) as "conversation" | "ambient" | "idle" : "conversation"
    if (mode !== "idle" && input.length < 2) throw new Error("请输入至少 2 个字符的聊天内容。")
    const groupId = String(req.body?.groupId || "").trim().slice(0, 64)
    const event = {
      isGroup: Boolean(groupId),
      isPrivate: !groupId,
      message_type: groupId ? "group" : "private",
      group_id: groupId,
      user_id: "web-test",
      sender: { user_id: "web-test", nickname: "Web 测试" },
      msg: input,
      raw_message: input,
    }
    const { stickerExpressionCoordinator } = await import("../../../core/persona/sticker-expression-coordinator.js")
    const testConfig = await configStore.load()
    // 管理台可以带上未保存的定格草稿，试运行不会写入配置。
    const draft = req.body?.draft
    if (draft && typeof draft === "object" && !Array.isArray(draft)) {
      const persona = (testConfig.persona && typeof testConfig.persona === "object" ? testConfig.persona : {}) as Record<string, unknown>
      persona.stickerExpression = { ...(persona.stickerExpression as Record<string, unknown> || {}), ...(draft as Record<string, unknown>) }
      const mutableConfig = testConfig as unknown as Record<string, unknown>
      mutableConfig.persona = persona
    }
    const result = await stickerExpressionCoordinator.preview({ config: testConfig, event, mode, text: input, reply: String(req.body?.reply || "").slice(0, 1000) })
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))
  app.post("/api/daily-still/gallery-stats", auth, handleRoute(async (req, res) => {
    const { stickerExpressionCoordinator } = await import("../../../core/persona/sticker-expression-coordinator.js")
    const testConfig = await configStore.load()
    // 与试运行一致：可以带上未保存的分组草稿计算覆盖情况。
    const moods = req.body?.moods
    if (Array.isArray(moods)) {
      const persona = (testConfig.persona && typeof testConfig.persona === "object" ? testConfig.persona : {}) as Record<string, unknown>
      persona.stickerExpression = { ...(persona.stickerExpression as Record<string, unknown> || {}), moods }
      ;(testConfig as unknown as Record<string, unknown>).persona = persona
    }
    const result = await stickerExpressionCoordinator.galleryStats({ config: testConfig, maxPages: Number(req.body?.maxPages) || undefined })
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))
  app.post("/api/daily-still/run", auth, handleRoute(async (req, res) => {
    const { stickerExpressionCoordinator } = await import("../../../core/persona/sticker-expression-coordinator.js")
    res.json({ ok: true, result: await stickerExpressionCoordinator.runIdle({ config: await configStore.load(), dryRun: req.body?.dryRun !== false, force: req.body?.force === true }) })
  }, { errorStatus: 400 }))
  app.get("/api/conversations", auth, async (req: RouteRequest, res: RouteResponse) => {
    const { chatService } = await import("../../../core/chat/chat-service.js")
    res.json({ ok: true, conversations: chatService.listConversations({ limit: Number(req.query.limit || 100) }) })
  })
  app.post("/api/chat/test", auth, handleRoute(async (req, res) => {
    const prompt = String(req.body?.prompt || "").trim()
    if (!prompt) throw new Error("请输入要测试的消息。")
    if (prompt.length > 4000) throw new Error("单条测试消息不能超过 4000 个字符。")
    const sessionId = sanitizeId(req.body?.sessionId || crypto.randomUUID())
    const channelId = String(req.body?.channelId || "").trim().slice(0, 120)
    const attachmentIds = req.body?.attachments ?? []
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 3) throw new Error("每条消息最多附带 3 张图片。")
    if (attachmentIds.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new Error("图片附件无效。")
    // 先建立断连监听，再异步准备附件；已取消的请求不能继续启动模型和工具。
    return sendWebChatResponse(req, res, async transport => {
      const images: string[] = []
      const userDisplayContent: unknown[] = [{ type: "text", text: prompt }]
      for (const id of attachmentIds) {
        transport.signal?.throwIfAborted()
        const image = await readWebDeliveryMedia(id)
        transport.signal?.throwIfAborted()
        if (!image || !chatImageMime.test(image.mimeType) || image.bytes.length > chatImageLimit()) throw new Error("图片附件无效、已过期或超过识图大小限制，请重新上传。")
        images.push(`data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`)
        const mount = String(configStore.get().web?.mountPath || "/yui-chat").replace(/\/$/, "")
        userDisplayContent.push({ type: "image", source: { kind: "url", value: `${mount}/api/chat/media/${id}`, mimeType: image.mimeType }, alt: image.name })
      }
      const { chatService } = await import("../../../core/chat/chat-service.js")
      transport.signal?.throwIfAborted()
      const event = webTestEvent(sessionId, prompt)
      event.img = images
      const result = await chatService.send(event, prompt, {
        channelId: channelId || undefined,
        source: "web-test",
        ...(images.length ? { userDisplayContent } : {}),
        disableTools: req.body?.enableTools !== true,
        ...transport,
        messageAdapter: createWebMessageAdapter(configStore.get() as unknown as Record<string, unknown>, transport.onDelivery),
        extraSystemPrompt: "当前是已登录管理台的 Web 对话。message_send 投递到当前网页，支持 Markdown、图片和转发内容。当前没有 QQ 用户、群聊或宿主消息事件；不要声称已向 QQ 发送消息或执行宿主命令。",
      })
      const { recordWebChatTest } = await import("../../../core/runtime/setup-guide.js")
      recordWebChatTest(result)
      // 回查必须用 chatService 实际持久化的键：任务配置 fallback 时 result.channel
      // 是实际应答渠道，而持久化键固定使用首选渠道 id，按渠道重算会 miss。
      let session: Awaited<ReturnType<typeof conversationStore.getWebTestSession>> = null
      let historyUnavailable = false
      if (result.conversationKey && result.historySaved !== false) {
        try {
          session = await conversationStore.getWebTestSession(String(result.conversationKey))
        } catch {
          // 模型回复已经完成；保留结果并由页面提示历史暂时无法读取。
          historyUnavailable = true
        }
      }
      return { ok: true, sessionId, result, session, historyUnavailable }
    })
  }, { errorStatus: 400 }))
  app.post("/api/chat/attachments", auth, handleRoute(async (req, res) => {
    const dataUrl = String(req.body?.dataUrl || "")
    const name = String(req.body?.name || "图片").slice(0, 160)
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/)
    if (!match || match[2].length > Math.ceil(chatImageLimit() / 3) * 4) throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片，大小不能超过当前识图限制。")
    const size = Buffer.from(match[2], "base64").length
    if (!size || size > chatImageLimit()) throw new Error("图片为空或超过当前识图大小限制。")
    const id = await cacheWebDeliveryMedia(dataUrl, { name })
    const mount = String(configStore.get().web?.mountPath || "/yui-chat").replace(/\/$/, "")
    res.json({ ok: true, id, name, url: `${mount}/api/chat/media/${id}` })
  }, { errorStatus: 400 }))
  app.post("/api/chat/media/preview", auth, handleRoute(async (req, res) => {
    const url = String(req.body?.url || "").trim()
    if (url.length > 4096 || !/^https?:\/\//i.test(url)) throw new Error("预览只支持 HTTP(S) 资源。")
    const config = configStore.get()
    const id = await cacheWebDeliveryMedia(url, { config })
    const mount = String(config.web?.mountPath || "/yui-chat").replace(/\/$/, "")
    res.json({ ok: true, url: `${mount}/api/chat/media/${id}` })
  }, { errorStatus: 400 }))
  app.get("/api/chat/media/:id", auth, handleRoute(async (req, res) => {
    const media = await readWebDeliveryMedia(String(req.params.id || ""))
    if (!media) return res.status(404).json({ ok: false, error: "媒体缓存已过期或不存在。" })
    const inline = /^(?:image\/(?:png|jpeg|gif|webp|avif)|audio\/(?:mpeg|mp4|ogg|wav|webm)|video\/(?:mp4|webm|ogg))$/i.test(media.mimeType)
    res.set({
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(media.name || "media")}`,
    })
    return res.type(inline ? media.mimeType : "application/octet-stream").send(media.bytes)
  }))
  app.get("/api/chat/test/sessions", auth, handleRoute(async (req, res) => {
    const sessions = await conversationStore.listWebTestSessions({ limit: Number(req.query.limit || 50) })
    res.json({ ok: true, sessions })
  }))
  app.get("/api/chat/test/sessions/:key", auth, handleRoute(async (req, res) => {
    const session = await conversationStore.getWebTestSession(String(req.params.key || ""))
    if (!session) return res.status(404).json({ ok: false, error: "测试会话已过期或不存在。" })
    res.json({ ok: true, session })
  }))
  app.delete("/api/chat/test/sessions/:key", auth, handleRoute(async (req, res) => {
    const key = String(req.params.key || "")
    const { chatService } = await import("../../../core/chat/chat-service.js")
    const cleared = await conversationStore.deleteWebTestSession(key)
    const runtimeCleared = await chatService.clearByKeys([key])
    res.json({ ok: true, cleared: Math.max(cleared, runtimeCleared) })
  }, { errorStatus: 400 }))
  app.post("/api/chat/test/clear", auth, handleRoute(async (req, res) => {
    const rawSessionId = String(req.body?.sessionId || "").trim()
    if (!rawSessionId) throw new Error("缺少测试会话 ID。")
    const sessionId = sanitizeId(rawSessionId)
    const { chatService } = await import("../../../core/chat/chat-service.js")
    const cleared = await chatService.clear(webTestEvent(sessionId, ""))
    res.json({ ok: true, sessionId, cleared, runtimeCleared: cleared })
  }, { errorStatus: 400 }))
  app.get("/api/subagent/runs", auth, async (req: RouteRequest, res: RouteResponse) => {
    const { chatService } = await import("../../../core/chat/chat-service.js")
    res.json({ ok: true, runs: chatService.listSubAgentRuns(Number(req.query.limit || 20)) })
  })
  app.post("/api/conversations/clear", auth, handleRoute(async (req, res) => {
    const { chatService } = await import("../../../core/chat/chat-service.js")
    if (req.body?.all === true) return res.json({ ok: true, cleared: await chatService.clearAll(), conversations: [] })
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : []
    if (!keys.length) throw new Error("keys or all=true is required")
    const cleared = await chatService.clearByKeys(keys)
    res.json({ ok: true, cleared, conversations: chatService.listConversations({ limit: 100 }) })
  }, { errorStatus: 400 }))
  app.get("/api/diagnostics", auth, handleRoute(async (_req, res) => {
    const { buildDiagnostics } = await import("../../../core/runtime/diagnostics.js")
    res.json({ ok: true, diagnostics: await buildDiagnostics() })
  }))
  app.get("/api/setup-guide", auth, handleRoute(async (_req, res) => {
    const { buildSetupGuide } = await import("../../../core/runtime/setup-guide.js")
    res.json({ ok: true, guide: await buildSetupGuide(configStore.getPublic()) })
  }))
  app.post("/api/runtime/end-all-conversations", auth, handleRoute(async (req, res) => {
    const { endAllConversationsRuntime } = await import("../../../core/runtime/lifecycle.js")
    res.json({ ok: true, result: await endAllConversationsRuntime(req.body || {}) })
  }, { errorStatus: 400 }))
  app.post("/api/runtime/cleanup-cache", auth, handleRoute(async (req, res) => {
    const { cleanupMediaCache, mediaCacheStats } = await import("../../../core/media/media-cache.js")
    const options = {
      mode: String(req.body?.mode || "expired"),
      cacheTtlMs: req.body?.cacheTtlMs,
    }
    const media = await cleanupMediaCache(options)
    res.json({
      ok: true,
      result: {
        mode: options.mode,
        media,
      },
      stats: {
        mediaCache: await mediaCacheStats(),
      },
    })
  }, { errorStatus: 400 }))
  const sendRenderTemplates = handleRoute(async (_req, res) => {
    const { renderApiOverview } = await import("../../../core/rendering/render-api-service.js")
    res.json({
      ok: true,
      render: await renderApiOverview(configStore.getPublic()),
    })
  })
  app.get("/api/render/templates", auth, sendRenderTemplates)
  app.get("/api/renderers", auth, sendRenderTemplates)
  app.post("/api/render/preview", auth, handleRoute(async (req, res) => {
    const { renderPreview } = await import("../../../core/rendering/render-api-service.js")
    res.json({ ok: true, preview: await renderPreview(req.body || {}, configStore.getPublic()) })
  }, { errorStatus: 400 }))
}
