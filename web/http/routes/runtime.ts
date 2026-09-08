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
    const { chatService } = await import("../../../core/chat/chat-service.js")
    const event = webTestEvent(sessionId, prompt)
    const result = await chatService.send(event, prompt, {
      channelId: channelId || undefined,
      source: "web-test",
      disableTools: true,
      persistMemory: false,
    })
    const { recordWebChatTest } = await import("../../../core/runtime/setup-guide.js")
    recordWebChatTest(result)
    // 回查必须用 chatService 实际持久化的键：任务配置 fallback 时 result.channel
    // 是实际应答渠道，而持久化键固定使用首选渠道 id，按渠道重算会 miss。
    const session = result.conversationKey
      ? (await conversationStore.listWebTestSessions({ limit: 100 })).find(item => item.key === result.conversationKey) || null
      : null
    res.json({ ok: true, sessionId, result, session })
  }, { errorStatus: 400 }))
  app.get("/api/chat/test/sessions", auth, handleRoute(async (req, res) => {
    const sessions = await conversationStore.listWebTestSessions({ limit: Number(req.query.limit || 50) })
    res.json({ ok: true, sessions })
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
