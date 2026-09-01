import { knowledgeRepository } from "../../../../knowledge/repository.js"
import { knowledgeStore } from "../../../../knowledge/store.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import type { RouteApp } from "../../route-handler.js"

export function registerKnowledgeBaseRoutes(app: RouteApp): void {
  app.get("/api/knowledge/bases", auth, handleRoute(async (_req, res) => {
    res.json({ ok: true, bases: await knowledgeStore.list() })
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
    res.json({ ok: true, ...(await knowledgeStore.updateBuiltinRetrieval(req.body || {})) })
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
    res.json({ ok: true, documents: await knowledgeRepository.listDocuments(req.params.id, { query: req.query.q, limit: req.query.limit }) })
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
    const results = await knowledgeStore.search(
      { isMaster: true, isGroup: false, user_id: "web-admin" },
      String(req.body?.query || ""),
      { knowledgeBaseIds: [req.params.id], limit: Number(req.body?.limit) || 8, useVector: req.body?.useVector !== false },
    )
    res.json({ ok: true, results })
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
