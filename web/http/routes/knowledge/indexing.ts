import { knowledgeIndexJobs } from "../../../../knowledge/index-jobs.js"
import { sqliteClient } from "../../../../core/storage/sqlite/client.js"
import { hostRuntime } from "../../../../core/runtime/host-runtime.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import type { RouteApp } from "../../route-handler.js"

function parsePayload(value: unknown): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(String(value)) : {}
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function serializeJob(job: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...job, progress: parsePayload(job.progress_json) || null }
}

export function registerKnowledgeIndexRoutes(app: RouteApp): void {
  app.get("/api/knowledge/index-jobs", auth, handleRoute(async (req, res) => {
    const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize || req.query.limit) || 10))
    const page = Math.max(1, Number(req.query.page) || 1)
    const baseId = String(req.query.baseId || "").trim()
    await knowledgeIndexJobs.cleanupExpired()
    const where = baseId ? " WHERE knowledge_base_id=?" : ""
    const params = baseId ? [baseId] : []
    const total = await sqliteClient.get(`SELECT COUNT(*) AS count FROM knowledge_index_jobs${where}`, params)
    const jobs = baseId
      ? await sqliteClient.all("SELECT * FROM knowledge_index_jobs WHERE knowledge_base_id=? ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?", [baseId, pageSize, (page - 1) * pageSize])
      : await sqliteClient.all("SELECT * FROM knowledge_index_jobs ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?", [pageSize, (page - 1) * pageSize])
    res.json({ ok: true, jobs: jobs.map(serializeJob), pagination: { page, pageSize, total: Number(total?.count || 0) }, vector: sqliteClient.status.vector })
  }))
  app.post("/api/knowledge/bases/:id/rebuild", auth, handleRoute(async (req, res) => {
    const immediate = req.body?.immediate === true
    const result = await knowledgeIndexJobs.queue(req.params.id, { immediate, start: !immediate && req.body?.start !== false })
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))
  app.post("/api/knowledge/index-jobs/run", auth, handleRoute(async (_req, res) => {
    res.json({ ok: true, result: await knowledgeIndexJobs.runNext() })
  }, { errorStatus: 400 }))
  app.post("/api/knowledge/index-jobs/:id/retry", auth, handleRoute(async (req, res) => {
    const result = await knowledgeIndexJobs.retry(req.params.id)
    if (result.status === "queued" && req.body?.start !== false) {
      Promise.resolve()
        .then(() => knowledgeIndexJobs.runNext(req.params.id))
        .catch(error => hostRuntime.logger?.warn?.("[yui-chat] 重试向量索引后台启动失败", error))
    }
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))
  app.post("/api/knowledge/index-jobs/:id/cancel", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, canceled: await knowledgeIndexJobs.cancel(req.params.id) })
  }, { errorStatus: 400 }))
  app.delete("/api/knowledge/index-jobs/:id", auth, handleRoute(async (req, res) => {
    res.json({ ok: true, deleted: await knowledgeIndexJobs.remove(req.params.id) })
  }, { errorStatus: 400 }))
}
