import { configStore } from "../../../config/store.js"
import { recentContextStore } from "../../../core/chat/recent-context.js"
import { commandObserver } from "../../../knowledge/command-observer.js"
import { knowledgeStore } from "../../../knowledge/store.js"
import { memoryStore } from "../../../memory/store.js"
import { groupCaptureStore } from "../../../memory/group-capture.js"
import { userSettingsStore } from "../../../user/settings.js"
import { requireWebAuth as auth } from "../auth.js"
import { commandKnowledgeView } from "../serializers.js"
import { handleRoute } from "../route-handler.js"
import type { RouteApp, RouteRequest, RouteResponse, UnknownRecord } from "../route-handler.js"
import { registerKnowledgeBaseRoutes } from "./knowledge/bases.js"
import { registerKnowledgeIndexRoutes } from "./knowledge/indexing.js"
import { registerKnowledgeAccessRoutes } from "./knowledge/access.js"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 注册知识库、群记忆、输出状态与主动问候管理接口。 */
export function registerKnowledgeRoutes(app: RouteApp): void {
  registerKnowledgeBaseRoutes(app)
  registerKnowledgeIndexRoutes(app)
  registerKnowledgeAccessRoutes(app)
  app.get("/api/knowledge", auth, handleRoute(async (req, res) => {
    const query = String(req.query.q || "")
    const recommendation = query ? await commandObserver.recommendCommandsHybrid(query, { limit: 20 }) : null
    const rows = recommendation ? recommendation.results : commandObserver.searchableCommands().slice(0, 100)
    res.json({
      ok: true,
      stats: commandObserver.stats(),
      digest: commandObserver.digest({ limit: Number(req.query.limit || 20) }),
      quality: commandObserver.qualityReport({ limit: Number(req.query.limit || 20) }),
      recommendation,
      results: rows.map(commandKnowledgeView),
    })
  }))
  app.get("/api/knowledge/digest", auth, (req: RouteRequest, res: RouteResponse) => {
    res.json({ ok: true, digest: commandObserver.digest({ limit: Number(req.query.limit || 20) }) })
  })
  app.get("/api/knowledge/quality", auth, (req: RouteRequest, res: RouteResponse) => {
    res.json({ ok: true, quality: commandObserver.qualityReport({ limit: Number(req.query.limit || 30) }) })
  })
  app.post("/api/knowledge/manual-command", auth, handleRoute(async (req, res) => {
    const command = await commandObserver.upsertManualCommand(req.body || {})
    const sync = await knowledgeStore.syncBuiltinCommands(commandObserver.searchableCommands())
    res.json({
      ok: true,
      command: commandKnowledgeView(command),
      sync,
      stats: commandObserver.stats(),
      digest: commandObserver.digest({ limit: 20 }),
      quality: commandObserver.qualityReport({ limit: 20 }),
    })
  }, { errorStatus: 400 }))
  app.get("/api/knowledge/commands/:id", auth, handleRoute(async (req, res) => {
    const command = commandObserver.commands.find(item => item.id === req.params.id)
    if (!command) {
      throw Object.assign(new Error("未找到这条指令说明，请刷新列表后重试。"), { statusCode: 404 })
    }
    res.json({ ok: true, command: commandKnowledgeView(command) })
  }, { errorStatus: 404 }))
  app.delete("/api/knowledge/commands/:id", auth, handleRoute(async (req, res) => {
    const result = await commandObserver.deleteCuratedCommand(req.params.id)
    const sync = await knowledgeStore.syncBuiltinCommands(commandObserver.searchableCommands())
    res.json({
      ok: true,
      result,
      sync,
      stats: commandObserver.stats(),
      digest: commandObserver.digest({ limit: 20 }),
      quality: commandObserver.qualityReport({ limit: 20 }),
    })
  }, { errorStatus: 400 }))
  app.get("/api/memory", auth, handleRoute(async (req, res) => {
    await memoryStore.load()
    res.json({
      ok: true,
      stats: memoryStore.stats(),
      capture: await groupCaptureStore.summary(),
      profiles: await memoryStore.listProfiles({ limit: Number(req.query.limit || 50), factLimit: 50 }),
      targets: await memoryStore.listManagedScopes({
        limit: Number(req.query.limit || 200),
        query: req.query.q,
        scopeType: req.query.scopeType,
      }),
    })
  }))
  app.get("/api/memory/captures", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, capture: await groupCaptureStore.summary({ includeMessageStats: req.query.light !== "1" }) })
  }))
  app.put("/api/memory/captures/:scopeType/:scopeId", auth, handleRoute(async (req, res) => {
    // 群策略默认继承系统值；overrides 中明确开启的字段才使用本群值。
    const policy = await groupCaptureStore.setPolicy(req.params.scopeType, req.params.scopeId, {
      enabled: req.body?.enabled,
      overrides: req.body?.overrides,
      retentionDays: req.body?.retentionDays,
      tokenLimit: req.body?.tokenLimit,
      promptTemplate: req.body?.promptTemplate,
      modelName: req.body?.modelName,
      maxTokens: req.body?.maxTokens,
      minConfidence: req.body?.minConfidence,
      retrievalResultLimit: req.body?.retrievalResultLimit,
    })
    res.json({ ok: true, policy, capture: await groupCaptureStore.summary() })
  }, { errorStatus: 400 }))
  app.get("/api/memory/captures/:scopeType/:scopeId/messages", auth, handleRoute(async (req, res) => {
    const messages = await groupCaptureStore.listMessagePage(req.params.scopeType, req.params.scopeId, {
      query: req.query.q,
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.pageSize || req.query.limit || 50),
      order: req.query.order,
      from: req.query.from,
      to: req.query.to,
    })
    res.json({ ok: true, messages })
  }, { errorStatus: 400 }))
  app.post("/api/memory/captures/:scopeType/:scopeId/history", auth, handleRoute(async (req, res) => {
    // limit 缺省时由 store 决定：按日期补录默认拉满单次上限，按数量补录默认 100。
    const result = await groupCaptureStore.backfillHistory(req.params.scopeType, req.params.scopeId, {
      limit: req.body?.limit,
      sinceAt: req.body?.sinceAt,
      beforeMessageId: req.body?.beforeMessageId,
      continueFromOldest: req.body?.continueFromOldest === true,
    })
    res.json({ ok: true, result, capture: await groupCaptureStore.summary() })
  }, { errorStatus: 400 }))
  app.get("/api/memory/captures/group/:groupId/calendar", auth, handleRoute(async (req, res) => {
    const calendar = await groupCaptureStore.getDailyCalendar("group", req.params.groupId, {
      fromDay: req.query.fromDay,
      toDay: req.query.toDay,
      days: req.query.days,
    })
    res.json({ ok: true, calendar })
  }, { errorStatus: 400 }))
  app.get("/api/memory/captures/:scopeType/:scopeId/windows", auth, handleRoute(async (req, res) => {
    const windows = await groupCaptureStore.listWindowPage(req.params.scopeType, req.params.scopeId, {
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.pageSize || req.query.limit || 20),
    })
    res.json({ ok: true, windows })
  }, { errorStatus: 400 }))
  app.get("/api/memory/captures/:scopeType/:scopeId/windows/:windowId", auth, handleRoute(async (req, res) => {
    const detail = await groupCaptureStore.getWindowDetail(req.params.scopeType, req.params.scopeId, req.params.windowId, { limit: Number(req.query.limit || 1000) })
    res.json({ ok: true, detail })
  }, { errorStatus: 400 }))
  app.get("/api/memory/captures/:scopeType/:scopeId/memories", auth, handleRoute(async (req, res) => {
    const memories = await groupCaptureStore.listDerivedMemories(req.params.scopeType, req.params.scopeId, { limit: Number(req.query.limit || 100) })
    res.json({ ok: true, memories })
  }, { errorStatus: 400 }))
  app.get("/api/memory/captures/:scopeType/:scopeId/memories/duplicates", auth, handleRoute(async (req, res) => {
    const plan = await groupCaptureStore.duplicateMemoryPlan(req.params.scopeType, req.params.scopeId)
    res.json({ ok: true, plan })
  }, { errorStatus: 400 }))
  app.post("/api/memory/captures/:scopeType/:scopeId/memories/duplicates/merge", auth, handleRoute(async (req, res) => {
    const result = await groupCaptureStore.mergeDuplicateMemories(req.params.scopeType, req.params.scopeId, arrayValue(req.body?.ids))
    res.json({ ok: true, result, stats: memoryStore.stats() })
  }, { errorStatus: 400 }))
  app.post("/api/memory/captures/:scopeType/:scopeId/extract", auth, handleRoute(async (req, res) => {
    const queued = await groupCaptureStore.queueExtraction(req.params.scopeType, req.params.scopeId)
    const windowPage = await groupCaptureStore.listWindowPage(req.params.scopeType, req.params.scopeId, { page: 1, pageSize: 20 })
    res.json({ ok: true, windows: windowPage.items, windowPage, queued, capture: await groupCaptureStore.summary() })
  }, { errorStatus: 400 }))
  app.get("/api/memory/captures/:scopeType/:scopeId/reextract-preview", auth, handleRoute(async (req, res) => {
    const plan = await groupCaptureStore.previewReextraction(req.params.scopeType, req.params.scopeId, { startAt: req.query.startAt, endAt: req.query.endAt })
    res.json({ ok: true, plan })
  }, { errorStatus: 400 }))
  app.post("/api/memory/captures/:scopeType/:scopeId/reextract", auth, handleRoute(async (req, res) => {
    const options = req.body?.windowStarts !== undefined
      ? { windowStarts: req.body.windowStarts }
      : { startAt: req.body?.startAt, endAt: req.body?.endAt }
    const result = await groupCaptureStore.queueReextraction(req.params.scopeType, req.params.scopeId, options)
    const windowPage = await groupCaptureStore.listWindowPage(req.params.scopeType, req.params.scopeId, { page: 1, pageSize: 20 })
    res.json({ ok: true, result, windows: windowPage.items, windowPage, capture: await groupCaptureStore.summary() })
  }, { errorStatus: 400 }))
  app.delete("/api/memory/captures/:scopeType/:scopeId/data", auth, handleRoute(async (req, res) => {
    const requestedMode = String(req.body?.mode || "raw")
    const mode = ["raw", "derived", "all"].includes(requestedMode) ? requestedMode : "raw"
    const result = await groupCaptureStore.clear(req.params.scopeType, req.params.scopeId, mode)
    res.json({ ok: true, result, capture: await groupCaptureStore.summary(), stats: memoryStore.stats() })
  }, { errorStatus: 400 }))
  app.get("/api/memory/groups/:groupId/workspace", auth, handleRoute(async (req, res) => {
    const workspace = await memoryStore.getGroupWorkspace(req.params.groupId, {
      groupQuery: req.query.groupQuery,
      groupPage: Number(req.query.groupPage || 1),
      memberQuery: req.query.memberQuery,
      memberLimit: Number(req.query.memberLimit || 80),
      pageSize: Number(req.query.pageSize || 20),
    })
    res.json({ ok: true, workspace })
  }, { errorStatus: 400 }))
  app.get("/api/memory/groups/:groupId/members/:userId", auth, handleRoute(async (req, res) => {
    const workspace = await memoryStore.getGroupMemberWorkspace(req.params.groupId, req.params.userId, {
      groupQuery: req.query.groupQuery,
      groupPage: Number(req.query.groupPage || 1),
      globalQuery: req.query.globalQuery,
      globalPage: Number(req.query.globalPage || 1),
      pageSize: Number(req.query.pageSize || 20),
    })
    res.json({ ok: true, workspace })
  }, { errorStatus: 400 }))
  app.post("/api/memory/groups/:groupId/facts", auth, handleRoute(async (req, res) => {
    const groupId = String(req.params.groupId || "").trim()
    const item = await memoryStore.saveScopedMemory({
      scopeType: "group", ownerId: groupId, groupId, id: req.body?.id, text: req.body?.text, tags: req.body?.tags,
    })
    res.json({
      ok: true,
      item,
      workspace: await memoryStore.getGroupWorkspace(groupId, { pageSize: 20 }),
      stats: memoryStore.stats(),
    })
  }, { errorStatus: 400 }))
  app.delete("/api/memory/groups/:groupId/facts/:id", auth, handleRoute(async (req, res) => {
    const groupId = String(req.params.groupId || "").trim()
    const result = await memoryStore.deleteScopedMemory({ scopeType: "group", ownerId: groupId, groupId, memoryId: req.params.id })
    if (!result.ok) throw new Error("未找到这条群公共记忆。")
    res.json({ ok: true, result, workspace: await memoryStore.getGroupWorkspace(groupId, { pageSize: 20 }), stats: memoryStore.stats() })
  }, { errorStatus: 400 }))
  app.post("/api/memory/groups/:groupId/members/:userId/facts", auth, handleRoute(async (req, res) => {
    const groupId = String(req.params.groupId || "").trim()
    const scopeType = req.body?.scopeType === "user" ? "user" : "user_group"
    const item = await memoryStore.saveScopedMemory({
      scopeType, ownerId: req.params.userId, groupId, id: req.body?.id, text: req.body?.text, tags: req.body?.tags,
    })
    res.json({
      ok: true,
      item,
      workspace: await memoryStore.getGroupMemberWorkspace(groupId, req.params.userId, { pageSize: 20 }),
      stats: memoryStore.stats(),
    })
  }, { errorStatus: 400 }))
  app.delete("/api/memory/groups/:groupId/members/:userId/facts/:id", auth, handleRoute(async (req, res) => {
    const groupId = String(req.params.groupId || "").trim()
    const scopeType = req.query.scopeType === "user" ? "user" : "user_group"
    const result = await memoryStore.deleteScopedMemory({ scopeType, ownerId: req.params.userId, groupId, memoryId: req.params.id })
    if (!result.ok) throw new Error("未找到这条成员记忆。")
    res.json({ ok: true, result, workspace: await memoryStore.getGroupMemberWorkspace(groupId, req.params.userId, { pageSize: 20 }), stats: memoryStore.stats() })
  }, { errorStatus: 400 }))
  app.get("/api/memory/scopes/:scopeType/:ownerId", auth, handleRoute(async (req, res) => {
    const scope = await memoryStore.getManagedScope(req.params.scopeType, req.params.ownerId)
    res.json({ ok: true, scope })
  }, { errorStatus: 400 }))
  app.post("/api/memory/scopes/:scopeType/:ownerId/facts", auth, handleRoute(async (req, res) => {
    const item = await memoryStore.saveManagedMemory({
      scopeType: req.params.scopeType,
      ownerId: req.params.ownerId,
      id: req.body?.id,
      text: req.body?.text,
      tags: req.body?.tags,
    })
    res.json({
      ok: true,
      item,
      scope: await memoryStore.getManagedScope(req.params.scopeType, req.params.ownerId),
      targets: await memoryStore.listManagedScopes({ limit: 200 }),
      stats: memoryStore.stats(),
    })
  }, { errorStatus: 400 }))
  app.delete("/api/memory/scopes/:scopeType/:ownerId/facts/:id", auth, handleRoute(async (req, res) => {
    const result = await memoryStore.deleteManagedMemory(req.params.scopeType, req.params.ownerId, req.params.id)
    if (!result.ok) throw new Error("未找到这条长期记忆。")
    res.json({
      ok: true,
      result,
      scope: await memoryStore.getManagedScope(req.params.scopeType, req.params.ownerId),
      targets: await memoryStore.listManagedScopes({ limit: 200 }),
      stats: memoryStore.stats(),
    })
  }, { errorStatus: 400 }))
  app.post("/api/memory/profile", auth, handleRoute(async (req, res) => {
    const result = await memoryStore.setProfile(req.body?.userId, req.body?.profile || req.body || {}, { replace: req.body?.replace === true })
    res.json({
      ok: true,
      result,
      stats: memoryStore.stats(),
      profiles: await memoryStore.listProfiles({ limit: 50, factLimit: 50 }),
    })
  }, { errorStatus: 400 }))
  app.post("/api/memory/fact", auth, handleRoute(async (req, res) => {
    const userId = String(req.body?.userId || "").trim()
    const id = String(req.body?.id || "").trim()
    const text = String(req.body?.text || "").trim()
    if (!userId || !text) throw new Error("用户 QQ 和记忆内容不能为空。")
    const item = id
      ? await memoryStore.updateMemory(userId, id, { text })
      : await memoryStore.addFact({ user_id: userId, isGroup: false }, text, { source: "manual", save: true })
    res.json({ ok: true, item, stats: memoryStore.stats(), profiles: await memoryStore.listProfiles({ limit: 50, factLimit: 50 }) })
  }, { errorStatus: 400 }))
  app.delete("/api/memory/:userId/facts/:id", auth, handleRoute(async (req, res) => {
    const result = await memoryStore.forgetMemory({ user_id: req.params.userId, isGroup: false }, req.params.id)
    if (!result.ok) throw new Error("未找到这条长期记忆。")
    res.json({ ok: true, result, stats: memoryStore.stats(), profiles: await memoryStore.listProfiles({ limit: 50, factLimit: 50 }) })
  }, { errorStatus: 400 }))
  app.get("/api/output", auth, async (_req: RouteRequest, res: RouteResponse) => {
    await userSettingsStore.load()
    const { buildPersonaDigest } = await import("../../../core/persona/persona-digest.js")
    const { buildInitiativeGreetingStatus } = await import("../../../core/persona/initiative-greeting.js")
    const config = configStore.getPublic()
    res.json({
      ok: true,
      response: config.response,
      context: config.context,
      persona: await buildPersonaDigest(config),
      initiativeGreeting: buildInitiativeGreetingStatus(config),
      contextStats: recentContextStore.stats(),
      userSettingsCount: userSettingsStore.count(),
    })
  })
  app.get("/api/persona/initiative-greeting", auth, handleRoute(async (_req, res) => {
    const { buildInitiativeGreetingStatus } = await import("../../../core/persona/initiative-greeting.js")
    res.json({ ok: true, status: buildInitiativeGreetingStatus(await configStore.load()) })
  }))
  app.post("/api/persona/initiative-greeting/preview", auth, handleRoute(async (req, res) => {
    const { generateInitiativeGreeting, initiativeGreetingScheduler } = await import("../../../core/persona/initiative-greeting.js")
    const config = await configStore.load()
    const persona = record(config.persona)
    const initiativeGreeting = record(persona.initiativeGreeting)
    const groupId = String(req.body?.groupId || req.body?.group || (Array.isArray(initiativeGreeting.groups) ? initiativeGreeting.groups[0] : "") || "").trim()
    if (req.body?.all === true) {
      const result = await initiativeGreetingScheduler.runOnce({ config, force: true, dryRun: true, text: req.body?.text })
      return res.json({ ok: true, result, status: initiativeGreetingScheduler.stats() })
    }
    const text = req.body?.text || await generateInitiativeGreeting({
      isGroup: true,
      group_id: groupId || "preview",
      user_id: "web-preview",
      msg: initiativeGreeting.prompt || "打个招呼",
      raw_message: initiativeGreeting.prompt || "打个招呼",
      sender: { user_id: "web-preview", nickname: "Web Preview" },
    }, config)
    res.json({ ok: true, result: { groupId: groupId || "preview", text, dryRun: true }, status: initiativeGreetingScheduler.stats() })
  }, { errorStatus: 400 }))
  app.post("/api/knowledge/rescan", auth, handleRoute(async (_req, res) => {
    const commands = await commandObserver.scan()
    const sync = await knowledgeStore.syncBuiltinCommands(commandObserver.searchableCommands())
    res.json({ ok: true, commands: commands.length, sync, scan: commandObserver.scanStatus(), stats: commandObserver.stats() })
  }, { errorStatus: 400 }))
}
