import { requireWebAuth as auth } from "../auth.js"
import { handleRoute } from "../route-handler.js"
import { modelLogStore } from "../../../core/observability/model-log.js"
import type { UnknownRecord } from "../../../core/message/types.js"

interface WebRequest {
  query?: UnknownRecord
  body?: unknown
  params?: Record<string, unknown>
}

interface WebResponse {
  json(payload: UnknownRecord): unknown
  status(code: number): WebResponse
}

interface WebApp {
  get(path: string, ...handlers: unknown[]): unknown
  post(path: string, ...handlers: unknown[]): unknown
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function request(value: unknown): WebRequest {
  return record(value) as WebRequest
}

function response(value: unknown): WebResponse {
  return value as WebResponse
}

function parseTime(value: unknown, fallback = 0, endOfDay = false): number {
  if (value === undefined || value === null || value === "") return fallback
  const raw = String(value).trim()
  if (/^\d+$/.test(raw)) return Number(raw)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`)
    : new Date(raw)
  const time = date.getTime()
  return Number.isFinite(time) ? time : fallback
}

function runFilters(query: UnknownRecord = {}): UnknownRecord {
  return {
    from: parseTime(query.from, 0),
    to: parseTime(query.to, 0, true),
    status: String(query.status || "").trim().slice(0, 30),
    model: String(query.model || "").trim().slice(0, 160),
    purpose: String(query.purpose || "").trim().slice(0, 80),
    source: String(query.source || "").trim().slice(0, 80),
    userId: String(query.userId || "").trim().slice(0, 80),
    groupId: String(query.groupId || "").trim().slice(0, 80),
    query: String(query.query || "").trim().slice(0, 80),
    cursor: String(query.cursor || "").trim(),
    limit: Math.max(1, Math.min(100, Number(query.limit) || 50)),
  }
}

function missingRunError(): Error & { statusCode: number } {
  return Object.assign(new Error("日志运行不存在或已过期"), { statusCode: 404 })
}

/** 注册日志查询与清理接口；日志详情只读，清理仍通过统一存储队列执行。 */
export function registerObservabilityRoutes(app: WebApp): void {
  app.get("/api/logs/summary", auth, handleRoute(async (rawRequest, rawResponse) => {
    const req = request(rawRequest)
    const res = response(rawResponse)
    const from = parseTime(req.query?.from, Date.now() - 86400000 * 7)
    const to = parseTime(req.query?.to, Date.now(), true)
    res.json({ ok: true, summary: await modelLogStore.summary({ ...runFilters(req.query), from, to }) })
  }))

  app.get("/api/logs/runs", auth, handleRoute(async (rawRequest, rawResponse) => {
    const req = request(rawRequest)
    const res = response(rawResponse)
    res.json({ ok: true, ...(await modelLogStore.listRuns(runFilters(req.query))) })
  }))

  app.get("/api/logs/runs/:id", auth, handleRoute(async (rawRequest, rawResponse) => {
    const req = request(rawRequest)
    const res = response(rawResponse)
    const result = await modelLogStore.getRun(req.params?.id)
    if (!result) throw missingRunError()
    res.json({ ok: true, ...result })
  }))

  app.get("/api/logs/model-calls/:id/detail", auth, handleRoute(async (rawRequest, rawResponse) => {
    const req = request(rawRequest)
    const res = response(rawResponse)
    const result = await modelLogStore.getModelCallDetail(req.params?.id)
    if (!result) throw Object.assign(new Error("模型调用不存在或已过期"), { statusCode: 404 })
    res.json({ ok: true, ...result })
  }))

  app.get("/api/logs/runs/:id/conversation", auth, handleRoute(async (rawRequest, rawResponse) => {
    const req = request(rawRequest)
    const res = response(rawResponse)
    const result = await modelLogStore.getConversation(req.params?.id)
    if (!result) throw missingRunError()
    res.json({ ok: true, ...result })
  }))

  app.post("/api/logs/cleanup", auth, handleRoute(async (rawRequest, rawResponse) => {
    const req = request(rawRequest)
    const res = response(rawResponse)
    const body = record(req.body)
    const filters = runFilters(body)
    const before = parseTime(body.before, 0, false)
    const all = body.all === true
    if (!all && !before && !filters.status && !filters.model && !filters.purpose && !filters.source && !filters.userId && !filters.groupId && !filters.query) {
      throw new Error("清理日志需要提供 before、筛选条件或 all=true")
    }
    const result = await modelLogStore.cleanup({ before, filters, dryRun: body.dryRun === true, all })
    res.json({ ok: true, result })
  }, { errorStatus: 400 }))
}
