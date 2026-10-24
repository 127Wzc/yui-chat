import { builtinCommandStats } from "./bases.js"
import { sqliteClient } from "../../../../core/storage/sqlite/client.js"
import { knowledgeIndexJobs } from "../../../../knowledge/index-jobs.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute, type RouteApp } from "../../route-handler.js"
import { commandImports } from "../../../../knowledge/command-import.js"
import { commandObserver } from "../../../../knowledge/command-observer.js"

const validRevision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

export function registerCommandKnowledgeRoutes(app: RouteApp): void {
  app.post("/api/knowledge/commands/collect", auth, handleRoute(async (_req, res) => {
    const bundle = await commandObserver.collectLoadedCommands()
    res.json({ ok: true, bundle, collectedAt: new Date().toISOString(), pluginCount: new Set(bundle.documents.map(row => row.metadata.pluginKey)).size })
  }, { errorStatus: 400 }))
  app.get("/api/knowledge/commands/vector-status", auth, handleRoute(async (_req, res) => {
    const counts = await sqliteClient.get("SELECT COUNT(*) AS pending,SUM(CASE WHEN attempts>0 THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN attempts>=3 THEN 1 ELSE 0 END) AS exhausted FROM knowledge_vector_tasks WHERE knowledge_base_id=?", ["builtin-commands"])
    const base = await sqliteClient.get("SELECT embedding_model_name FROM knowledge_bases WHERE id=?", ["builtin-commands"])
    const failures = await sqliteClient.all("SELECT kind,owner_id,error,attempts FROM knowledge_vector_tasks WHERE knowledge_base_id=? AND error<>'' ORDER BY updated_at LIMIT 10", ["builtin-commands"])
    res.json({ ok: true, pending: Number(counts?.pending || 0), failed: Number(counts?.failed || 0), exhausted: Number(counts?.exhausted || 0), configured: Boolean(base?.embedding_model_name), available: Boolean(sqliteClient.status.vector?.available), failures, retryLimit: 3 })
  }))
  app.post("/api/knowledge/commands/retry-vectors", auth, handleRoute(async (_req, res) => {
    await sqliteClient.run("UPDATE knowledge_vector_tasks SET attempts=0,retry_at=0,error='',updated_at=MAX(updated_at+1,?) WHERE knowledge_base_id=? AND attempts>0", [Date.now(), "builtin-commands"])
    knowledgeIndexJobs.scheduleAvailable(); res.json({ ok: true })
  }))
  app.patch("/api/knowledge/commands/availability", auth, handleRoute(async (req, res) => {
    const result = await commandImports.setAvailability(req.body || {})
    commandObserver.applyAvailability(result.availability)
    res.json({ ok: true, ...result, stats: await builtinCommandStats() })
  }, { errorStatus: 400 }))
  app.get("/api/knowledge/commands/catalog", auth, handleRoute(async (_req, res) => { res.json({ ok: true, commands: await commandImports.list() }) }))
  app.delete("/api/knowledge/commands", auth, handleRoute(async (req, res) => {
    if (!validRevision(req.body?.expectedRevision) || !Array.isArray(req.body?.ids) || !req.body.ids.length) throw new Error("请选择条目并读取当前版本")
    const result = await commandImports.apply({ schemaVersion: 1, sourceId: req.body.sourceId, documents: [], deletedIds: req.body.ids }, { expectedRevision: req.body.expectedRevision, operation: "delete" })
    await commandObserver.load(); res.json({ ok: true, ...result })
  }, { errorStatus: 400 }))
  app.post("/api/knowledge/commands/import-preview", auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await commandImports.preview(req.body?.bundle, { ...(req.body?.options || {}), operation: "import" }) }) }, { errorStatus: 400 }))
  app.post("/api/knowledge/commands/import", auth, handleRoute(async (req, res) => {
    if (!validRevision((req.body?.options as Record<string, unknown>)?.expectedRevision)) throw new Error("请先预览本次导入")
    const result = await commandImports.apply(req.body?.bundle, { ...(req.body?.options || {}), operation: "import" })
    await commandObserver.load()
    res.json({ ok: true, ...result })
  }, { errorStatus: 400 }))
  app.get("/api/knowledge/commands/export", auth, handleRoute(async (req, res) => { res.json({ ok: true, bundle: await commandImports.export(String(req.query.sourceId || "yunzai")) }) }))
  app.get("/api/knowledge/commands/import-logs", auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await commandImports.logs(Number(req.query.page) || 1) }) }))
  app.get("/api/knowledge/commands/import-logs/:id", auth, handleRoute(async (req, res) => { res.json({ ok: true, changes: await commandImports.log(req.params.id) }) }))
  app.get("/api/knowledge/commands/:id/history", auth, handleRoute(async (req, res) => {
    const current = (await commandImports.list()).find(row => row.id === req.params.id), history = await commandImports.history(req.params.id)
    const sourceId = current?.sourceId || history[0]?.snapshot.sourceId
    if (!sourceId) throw new Error("指令或历史不存在")
    const preview = await commandImports.preview({ schemaVersion: 1, sourceId, documents: [] })
    res.json({ ok: true, command: current || null, history, revision: preview.revision })
  }, { errorStatus: 404 }))
  app.post("/api/knowledge/commands/:id/restore", auth, handleRoute(async (req, res) => {
    if (!validRevision(req.body?.expectedRevision)) throw new Error("请先读取当前历史")
    const result = await commandImports.restore(req.params.id, Number(req.body?.historyId), req.body.expectedRevision)
    await commandObserver.load(); res.json({ ok: true, ...result })
  }, { errorStatus: 400 }))
  app.put("/api/knowledge/commands/:id", auth, handleRoute(async (req, res) => {
    const command = (await commandImports.list()).find(row => row.id === req.params.id)
    if (!command) throw new Error("指令不存在")
    if (!validRevision(req.body?.expectedRevision)) throw new Error("请先读取当前版本")
    const document = { id: command.id, title: req.body?.title ?? command.title, retrievalText: req.body?.retrievalText, metadata: command.metadata }
    const result = await commandImports.apply({ schemaVersion: 1, sourceId: command.sourceId, documents: [document] }, { expectedRevision: req.body.expectedRevision, operation: "edit", policy: "overwrite" })
    await commandObserver.load(); res.json({ ok: true, ...result })
  }, { errorStatus: 400 }))
  app.delete("/api/knowledge/commands/:id", auth, handleRoute(async (req, res) => {
    const command = (await commandImports.list()).find(row => row.id === req.params.id)
    if (!command) throw new Error("指令不存在")
    if (!validRevision(req.body?.expectedRevision)) throw new Error("请先读取当前版本")
    const result = await commandImports.apply({ schemaVersion: 1, sourceId: command.sourceId, documents: [], deletedIds: [command.id] }, { expectedRevision: req.body.expectedRevision, operation: "delete" })
    await commandObserver.load(); res.json({ ok: true, ...result })
  }, { errorStatus: 400 }))
}
