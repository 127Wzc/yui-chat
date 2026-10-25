import { commandAvailability, commandEnabledSql, readCommandAvailability, type CommandAvailability } from "../../../../knowledge/command-availability.js"
import { searchKnowledgeDetailed } from "../../../../knowledge/retrieval.js"
import { knowledgeRepository } from "../../../../knowledge/repository.js"
import { knowledgeStore } from "../../../../knowledge/store.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import type { RouteApp } from "../../route-handler.js"
import { configStore } from "../../../../config/store.js"
import { updateConfigAndApply } from "../../runtime-config.js"
import { sqliteClient } from "../../../../core/storage/sqlite/client.js"
import { commandQuality, COMMAND_COMPLETENESS_ISSUE_LABELS } from "../../../../knowledge/command-query-service.js"
import { commandObserver } from "../../../../knowledge/command-observer.js"
import { prepareCommandCompleteness } from "../../../../knowledge/command-completeness.js"

type Row = Record<string, any>
function builtinPresentation(state: CommandAvailability) {
  return (document: Row, includeQuality = true): Row => {
    const metadata = document.metadata || JSON.parse(document.metadata_json || "{}")
    const command = { metadata: metadata.command || {}, id: metadata.commandId, title: document.title, retrievalText: document.content ?? metadata.command?.retrievalText ?? "" }
    const availability = commandAvailability(String(metadata.commandId), String(metadata.importSourceId || "yunzai"), metadata.command || {}, state)
    const exclusionReasons: string[] = [...(!availability.pluginEnabled ? ["插件已停用"] : []), ...(!availability.commandEnabled ? ["指令已停用"] : [])]
    const quality = includeQuality ? commandQuality(command, commandObserver.usageCounts) : null
    return {
      canDelete: true,
      searchable: !exclusionReasons.length,
      exclusionReasons,
      qualityScore: quality?.qualityScore,
      completenessStatus: quality?.completenessStatus,
      qualityIssues: quality?.issues.map(issue => COMMAND_COMPLETENESS_ISSUE_LABELS[issue] || issue),
      qualityDeductions: quality?.deductions,
      qualityDimensions: quality?.dimensions,
      qualityScoreCap: quality?.scoreCap,
      qualityCapReasons: quality?.capReasons,
      qualityRuleVersion: quality?.ruleVersion,
    }
  }
}

export async function builtinCommandStats(): Promise<Row> {
  const rows = await sqliteClient.all<Row>(`SELECT LENGTH(d.content) AS characters, COUNT(c.id) AS chunks, ${commandEnabledSql()} AS enabled FROM knowledge_documents d LEFT JOIN knowledge_chunks c ON c.document_id=d.id WHERE d.knowledge_base_id=? GROUP BY d.id`, ["builtin-commands"])
  const searchable = rows.filter(row => row.enabled)
  const pending = await sqliteClient.get("SELECT COUNT(*) AS n FROM knowledge_vector_tasks WHERE knowledge_base_id=?", ["builtin-commands"])
  return { pendingVectors: Number(pending?.n || 0), documents: rows.length, chunks: rows.reduce((sum, row) => sum + Number(row.chunks), 0), characters: rows.reduce((sum, row) => sum + Number(row.characters), 0), searchableDocuments: searchable.length, searchableChunks: searchable.reduce((sum, row) => sum + Number(row.chunks), 0), excludedDocuments: rows.length - searchable.length }
}

export function registerKnowledgeBaseRoutes(app: RouteApp): void {
  app.get("/api/knowledge/bases", auth, handleRoute(async (_req, res) => {
    const mode = (configStore.get().knowledge?.commandRetrieval as Record<string, unknown>)?.mode || "hybrid"
    const bases = await knowledgeStore.list()
    const builtin = bases.find(base => base.id === "builtin-commands")
    if (builtin) Object.assign(builtin, { retrievalMode: mode, stats: await builtinCommandStats() })
    res.json({ ok: true, bases })
  }))
  app.post("/api/knowledge/bases", auth, handleRoute(async (req, res) => {
    const base = await knowledgeStore.create(req.body || {})
    res.status(201).json({ ok: true, base })
  }, { errorStatus: 400 }))
  app.patch("/api/knowledge/bases/:id", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, base: await knowledgeStore.update(req.params.id, req.body || {}) })
  }, { errorStatus: 400 }))
  app.patch("/api/knowledge/bases/:id/retrieval", auth, handleRoute(async (req, res) => {
    if (req.params.id !== "builtin-commands") throw new Error("只有内置指令知识库支持专用检索策略设置")
    const mode = req.body?.mode
    if (mode !== undefined && mode !== "lexical" && mode !== "hybrid") throw new Error("检索方式只能是关键词或混合")
    const current = await knowledgeRepository.getBase(req.params.id)
    if (!current) throw new Error("内置指令知识库不存在")
    const vectorChanged = ["embeddingModel", "dimensions", "distanceMetric"].some(key => req.body?.[key] !== undefined && req.body[key] !== current.config?.[key])
    const settingsChanged = vectorChanged || req.body?.fieldDescription !== undefined || req.body?.description !== undefined
    const result = settingsChanged ? await knowledgeStore.updateBuiltinRetrieval(req.body || {}) : { base: current, index: null }
    if (mode !== undefined) await updateConfigAndApply(config => { (config.knowledge?.commandRetrieval as Record<string, unknown>).mode = mode; return config })
    res.json({ ok: true, ...result, mode: (configStore.get().knowledge?.commandRetrieval as Record<string, unknown>)?.mode || "hybrid" })
  }, { errorStatus: 400 }))
  app.delete("/api/knowledge/bases/:id", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, deleted: await knowledgeRepository.deleteBase(req.params.id) })
  }, { errorStatus: 400 }))
  app.post("/api/knowledge/bases/:id/sources/text", auth, handleRoute(async (req, res) => {
    const result = await knowledgeStore.ingestText({
      knowledgeBaseId: req.params.id,
      name: req.body?.name || "直接文本",
      content: req.body?.content,
      kind: req.body?.kind || "text",
      uri: req.body?.uri || "",
      metadata: req.body?.metadata || {},
    })
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))
  app.get("/api/knowledge/bases/:id/documents", auth, handleRoute(async (req, res) => {
    const builtin = req.params.id === "builtin-commands"
    const documents = await knowledgeRepository.listDocuments(req.params.id, { query: req.query.q, limit: builtin ? 10000 : req.query.limit })
    if (!builtin) return res.json({ ok: true, documents })
    await prepareCommandCompleteness(documents.map(document => {
      const metadata = (document.metadata || JSON.parse(String(document.metadata_json || "{}"))) as Row
      return { metadata: metadata.command || {}, title: document.title, retrievalText: document.content ?? metadata.command?.retrievalText ?? "" }
    }))
    const present = builtinPresentation(await readCommandAvailability())
    const rows = documents.map(document => ({ ...document, ...present(document) }))
    if (req.query.sort === "quality-asc" || req.query.sort === "quality-desc") {
      const direction = req.query.sort === "quality-asc" ? 1 : -1
      rows.sort((a, b) => direction * (Number(a.qualityScore) - Number(b.qualityScore)) || Number(b.updated_at) - Number(a.updated_at) || String(a.id).localeCompare(String(b.id)))
    }
    const limit = Math.max(1, Math.min(10000, Math.trunc(Number(req.query.limit) || 10000)))
    res.json({ ok: true, documents: rows.slice(0, limit) })
  }))
  app.get("/api/knowledge/bases/:id/documents/:documentId", auth, handleRoute(async (req, res) => {
    const document = await knowledgeRepository.getDocument(req.params.id, req.params.documentId)
    if (!document) return res.status(404).json({ ok: false, error: "知识文档不存在" })
    res.json({ ok: true, document })
  }))
  app.patch("/api/knowledge/bases/:id/documents/:documentId", auth, handleRoute(async (req, res) => {
    const result = await knowledgeStore.updateDocument({
      knowledgeBaseId: req.params.id,
      documentId: req.params.documentId,
      title: req.body?.title,
      content: req.body?.content,
    })
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))
  app.delete("/api/knowledge/bases/:id/documents/:documentId", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, result: await knowledgeStore.deleteDocument(req.params.id, req.params.documentId) })
  }, { errorStatus: 400 }))
  app.post("/api/knowledge/bases/:id/search", auth, handleRoute(async (req, res) => {
    const result = await searchKnowledgeDetailed(
      { isMaster: true, isGroup: false, user_id: "web-admin" },
      String(req.body?.query || ""),
      { knowledgeBaseIds: [req.params.id], limit: req.body?.limit, useVector: req.body?.useVector !== false, includeTrace: req.body?.compare === true },
    )
    res.json({ ok: true, ...result })
  }, { errorStatus: 400 }))
  app.get("/api/knowledge/bases/:id/grants", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, grants: await knowledgeRepository.listGrants(req.params.id) })
  }))
  app.post("/api/knowledge/bases/:id/grants", auth, handleRoute(async (req, res) => {
    await knowledgeRepository.setGrant({
      knowledgeBaseId: req.params.id,
      principalType: String(req.body?.principalType || ""),
      principalId: String(req.body?.principalId || ""),
      groupId: String(req.body?.groupId || ""),
      access: req.body?.access === "deny" ? "deny" : "allow",
      defaultActive: req.body?.defaultActive !== false,
    })
    res.json({ ok: true, grants: await knowledgeRepository.listGrants(req.params.id) })
  }, { errorStatus: 400 }))
  app.delete("/api/knowledge/bases/:id/grants/:grantId", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, deleted: await knowledgeRepository.deleteGrant(req.params.id, req.params.grantId), grants: await knowledgeRepository.listGrants(req.params.id) })
  }, { errorStatus: 400 }))
}
