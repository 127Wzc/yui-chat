import { normalizeLangfuseBaseUrl, validLangfuseBaseUrl } from "../../config/langfuse.js"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { configStore } from "../../config/store.js"
import { sqliteClient } from "../storage/sqlite/client.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import { redactErrorText } from "../shared/error-details.js"
import { fetchWithTimeout } from "../network/fetch-timeout.js"

type Row = Record<string, unknown>
interface Settings {
  enabled: boolean; baseUrl: string; publicKey: string; secretKey: string; environment: string
  sampleRate: number; backgroundSampleRate: number; monthlyUnitLimit: number; captureContent: boolean
}
interface Session extends Row { session_id: string; trace_id: string; root_span_id: string; root_queued: number }
interface Context { scope: string; source: string; turnId: string; session?: Promise<Session> }
interface Call {
  id: string; started: number; session: Session; scope: string; target: string; settings: Settings
  options: Row; input?: unknown; finished?: boolean
}
interface Queued { id: string; target: string; scope: string; session: Session; span: Row; settings: Settings }
interface ReporterOptions {
  config?: () => unknown
  now?: () => number
  send?: (settings: Settings, spans: Row[]) => Promise<void>
}

const QUEUE_LIMIT = 1000
const QUEUE_BYTES = 8 * 1024 * 1024
const MEMORY_LIMIT = 100
const hash = (value: string): string => createHash("sha256").update(value).digest("hex")
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown): string => String(value ?? "")

/** 内容只允许有界 JSON；不导出向量、媒体二进制、鉴权字段或带参数的资源 URL。 */
export function langfuseContent(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 6) return "<truncated>"
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "<omitted-binary>"
  if (typeof value === "string") {
    let result = value
    for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("<redacted>")
    return redactErrorText(result, 6000, true)
      .replace(/https?:\/\/[^\s"'<>]+/gi, "<omitted-url>")
      .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "<omitted-binary>")
  }
  if (Array.isArray(value)) return value.slice(0, 30).map(item => langfuseContent(item, secrets, depth + 1))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
    key, /token|key|secret|password|credential|authorization|cookie|encrypted|embedding|vector|base64|bytes|image_url|\bdata\b/i.test(key)
      ? "<omitted>" : langfuseContent(item, secrets, depth + 1),
  ]))
  return typeof value === "number" && !Number.isFinite(value) ? null : value ?? null
}

function contentString(value: unknown, settings: Settings): string {
  const sanitized = langfuseContent(value, [settings.publicKey, settings.secretKey])
  const serialized = JSON.stringify(sanitized)
  return serialized.length <= 12000 ? serialized : JSON.stringify({ truncated: true, preview: serialized.slice(0, 10000) })
}

function attribute(key: string, value: unknown): Row {
  return { key, value: typeof value === "number" ? { doubleValue: value } : { stringValue: text(value) } }
}

async function sendOtlp(settings: Settings, spans: Row[]): Promise<void> {
  await fetchWithTimeout(`${normalizeLangfuseBaseUrl(settings.baseUrl)}/api/public/otel/v1/traces`, {
    method: "POST", redirect: "error", timeoutMs: 5000,
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${settings.publicKey}:${settings.secretKey}`).toString("base64")}`, "x-langfuse-ingestion-version": "4" },
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [attribute("service.name", "yui-chat")] }, scopeSpans: [{ scope: { name: "yui-chat.langfuse" }, spans }] }] }),
    consume: async response => {
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Langfuse HTTP ${response.status}`) }
      const reader = response.body?.getReader()
      if (!reader) return
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > 8192) throw new Error("Langfuse response too large")
          chunks.push(value)
        }
      } finally { await reader.cancel() }
      const body = Buffer.concat(chunks).toString("utf8")
      const partial = record(body ? record(JSON.parse(body)).partialSuccess : null)
      if (Number(partial.rejectedSpans || 0) > 0) throw new Error("Langfuse rejected observations")
    },
  })
}

/** 仅导出 Registry 模型调用；不创建额外包装、工具、数据库检索或评分记录。 */
export class LangfuseReporter {
  private readonly context = new AsyncLocalStorage<Context>()
  private readonly config: () => unknown
  private readonly now: () => number
  private readonly send: NonNullable<ReporterOptions["send"]>
  private queue: Promise<unknown> = Promise.resolve()
  private pending: Queued[] = []
  private readonly sessions = new Map<string, Session>()
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing: Promise<void> | null = null
  private lastError = ""
  private sent = 0
  private skipped = 0
  private writeFailures = 0
  private stopped = false

  constructor(options: ReporterOptions = {}) {
    this.config = options.config || (() => configStore.get())
    this.now = options.now || Date.now
    this.send = options.send || sendOtlp
  }

  private settings(): Settings { return record(record(this.config()).logging).langfuse as Settings }
  private ready(settings = this.settings()): boolean {
    return !!settings?.enabled && validLangfuseBaseUrl(settings.baseUrl) && !!settings.publicKey && !!settings.secretKey
  }
  private target(settings: Settings): string { return hash(`${normalizeLangfuseBaseUrl(settings.baseUrl)}\n${settings.publicKey}`) }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined /* 调用方保留待写记录并设置诊断。 */)
    return result
  }
  private fault(): void { this.lastError = "Langfuse 上报或持久化失败，待处理记录已保留。" }

  start(): void {
    this.stopped = false
    if (this.timer || !this.ready()) return
    this.timer = setInterval(() => { void this.flush().catch(() => this.fault()) }, 5000)
    this.timer.unref()
  }

  withConversation<T>(event: unknown, source: unknown, run: () => Promise<T>): Promise<T> {
    const e = record(event)
    const user = text(e.user_id)
    if (!user || !this.ready()) return run()
    const scope = isGroupEvent(e) ? `g:${groupIdFromEvent(e)}:${user}` : `p:${user}`
    // 不包含渠道/模型、历史 TTL 或当轮消息 ID；换模型和历史过期均不切 Trace。
    return this.context.run({ scope: `${text(e.self_id)}\n${scope}`, source: text(source) || "chat", turnId: randomUUID() }, run)
  }

  private async session(scope: string, settings: Settings): Promise<Session> {
    const target = this.target(settings)
    const scopeKey = hash(`${settings.environment}\n${scope}`)
    await sqliteClient.run("INSERT OR IGNORE INTO langfuse_sessions(target,scope_key,conversation_scope,session_id,trace_id,root_span_id) VALUES(?,?,?,?,?,?)", [target, scopeKey, hash(scope.slice(scope.indexOf("\n") + 1)), randomUUID(), randomBytes(16).toString("hex"), randomBytes(8).toString("hex")])
    const row = await sqliteClient.get<Session>("SELECT * FROM langfuse_sessions WHERE target=? AND scope_key=?", [target, scopeKey])
    if (!row) throw new Error("Missing Langfuse session")
    const cached = this.sessions.get(row.trace_id)
    if (cached) return cached
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value!)
    this.sessions.set(row.trace_id, row)
    return row
  }

  async begin(options: Row): Promise<Call | null> {
    try {
      const settings = this.settings()
      if (!this.ready(settings) || this.stopped) return null
      if (/model-test|channel-test/.test(`${text(options.purpose)} ${text(options.taskName)}`) || options.source === "management") return null
      this.start()
      const active = this.context.getStore()
      const localTrace = record(options.trace)
      const scope = active?.scope || `background:${text(localTrace.id) || randomUUID()}`
      const session = await this.serial(async () => {
        if (active) return active.session ||= this.session(scope, settings)
        return { session_id: randomUUID(), trace_id: randomBytes(16).toString("hex"), root_span_id: "", root_queued: 0 }
      })
      const rate = active ? Number(settings.sampleRate) : Number(settings.backgroundSampleRate)
      const fraction = parseInt(hash(session.session_id).slice(0, 8), 16) / 0x100000000
      if (!(fraction < rate)) { this.skipped++; return null }
      const input = settings.captureContent ? contentString(options.input, settings) : undefined
      return { id: randomBytes(8).toString("hex"), started: this.now(), session, scope, target: this.target(settings), settings,
        options: { ...options, input: undefined, trace: { id: localTrace.id || active?.turnId }, source: options.source || active?.source }, input }
    } catch { this.fault(); return null /* 观测故障不阻断模型。 */ }
  }

  complete(call: Call | null, result: unknown, error?: unknown): void {
    if (!call || call.finished) return
    call.finished = true
    try {
      const options = call.options, channel = record(options.channel), response = record(result), usage = record(response.usage)
      const operation = text(options.operation), model = text(channel.model), provider = text(record(channel.provider).name || channel.apiProvider)
      const attrs = [
        attribute("langfuse.observation.type", operation === "embedding" ? "embedding" : operation === "rerank" ? "retriever" : "generation"),
        attribute("langfuse.trace.name", "yui-chat.session"), attribute("langfuse.session.id", call.session.session_id),
        attribute("langfuse.user.id", hash(call.scope)), attribute("langfuse.environment", call.settings.environment),
        attribute("langfuse.observation.model.name", model), attribute("langfuse.observation.metadata.provider", provider),
        attribute("langfuse.observation.metadata.protocol", text(channel.type)), attribute("langfuse.observation.metadata.source", text(options.source)),
        attribute("langfuse.observation.metadata.purpose", text(options.purpose)), attribute("langfuse.observation.metadata.task", text(options.taskName)),
        attribute("langfuse.observation.metadata.run_id", text(record(options.trace).id)),
        attribute("langfuse.observation.metadata.stop_reason", text(response.stopReason)),
        attribute("langfuse.observation.metadata.tool_call_count", Array.isArray(response.toolCalls) ? response.toolCalls.length : 0),
        attribute("langfuse.observation.metadata.input_count", Number(options.inputCount || 0)),
        attribute("langfuse.observation.metadata.usage_source", text(usage.source || "unknown")),
      ]
      const usageDetails: Row = {}
      for (const [from, to] of [["input", "input"], ["output", "output"], ["total", "total"]]) {
        if (typeof usage[from] === "number" && (usage[`${from}Known`] === true || (usage.source === "reported" && usage[`${from}Known`] !== false))) usageDetails[to] = usage[from]
      }
      if (Object.keys(usageDetails).length) attrs.push(attribute("langfuse.observation.usage_details", JSON.stringify(usageDetails)))
      if (typeof usage.cached === "number") attrs.push(attribute("langfuse.observation.metadata.cached_tokens", usage.cached))
      if (typeof usage.reasoning === "number") attrs.push(attribute("langfuse.observation.metadata.reasoning_tokens", usage.reasoning))
      if (call.input !== undefined) attrs.push(attribute("langfuse.observation.input", call.input))
      if (call.settings.captureContent && options.tools) attrs.push(attribute("langfuse.observation.metadata.tools", contentString(options.tools, call.settings)))
      const summary = operation === "embedding" ? { dimensions: response.dimensions, count: options.inputCount }
        : operation === "image-generation" ? { imageCount: Array.isArray(response.images) ? response.images.length : 0 }
          : operation === "rerank" ? { results: response.results }
            : operation === "chat" ? [{ role: "assistant", content: response.text, tool_calls: (Array.isArray(response.toolCalls) ? response.toolCalls : []).map(value => {
              const tool = record(value)
              return { id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }
            }) }] : { answers: response.answers }
      if (call.settings.captureContent || ["embedding", "image-generation", "rerank"].includes(operation)) attrs.push(attribute("langfuse.observation.output", contentString(summary, call.settings)))
      if (error) attrs.push(attribute("langfuse.observation.level", "ERROR"), attribute("langfuse.observation.status_message", "模型调用失败；详细原因见本地日志。"))
      const span: Row = { traceId: call.session.trace_id, spanId: call.id, name: `yui-chat.${operation}`, kind: 3,
        ...(call.id !== call.session.root_span_id ? { parentSpanId: call.session.root_span_id } : {}),
        startTimeUnixNano: (BigInt(call.started) * 1000000n).toString(), endTimeUnixNano: (BigInt(this.now()) * 1000000n).toString(),
        attributes: attrs, status: { code: error ? 2 : 1 } }
      if (this.pending.length >= MEMORY_LIMIT) { this.skipped++; this.lastError = "Langfuse 待写缓冲已满，新增记录已跳过。"; return }
      this.pending.push({ id: call.id, target: call.target, scope: call.scope, session: call.session, span, settings: call.settings })
      void this.serial(() => this.persist()).catch(() => this.fault())
    } catch { this.fault() /* 序列化失败只报告观测故障，不改变模型返回值。 */ }
  }

  private async persist(): Promise<void> {
    while (this.pending.length) {
      const item = this.pending[0], month = new Date(this.now()).toISOString().slice(0, 7)
      // 首个完成的真实模型调用充当根 observation，避免额外 session wrapper。
      const root = !item.session.root_queued
      if (root) delete item.span.parentSpanId
      else item.span.parentSpanId = item.session.root_span_id
      const payload = JSON.stringify(item.span)
      const units = root ? 2 : 1 // 保守预留 Trace + Observation。
      try {
        const results = await sqliteClient.transaction([
          { sql: "INSERT OR IGNORE INTO langfuse_budget_monthly(target,month) VALUES(?,?)", params: [item.target, month] },
          { sql: `INSERT OR IGNORE INTO langfuse_outbox(id,target,payload_json,created_at,budget_month,units)
            SELECT ?,?,?,?,?,? WHERE (SELECT reserved_units FROM langfuse_budget_monthly WHERE target=? AND month=?) + ? <= ?
            AND (SELECT COUNT(*) FROM langfuse_outbox) < ? AND (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) FROM langfuse_outbox) + ? <= ?`,
            params: [item.id, item.target, payload, this.now(), month, units, item.target, month, units, item.settings.monthlyUnitLimit, QUEUE_LIMIT, Buffer.byteLength(payload), QUEUE_BYTES] },
          { sql: "UPDATE langfuse_budget_monthly SET reserved_units=reserved_units+? WHERE target=? AND month=? AND changes()>0", params: [units, item.target, month] },
          { sql: "UPDATE langfuse_sessions SET root_queued=1,root_span_id=? WHERE target=? AND trace_id=? AND EXISTS(SELECT 1 FROM langfuse_outbox WHERE id=?)", params: [root ? item.id : item.session.root_span_id, item.target, item.session.trace_id, item.id] },
        ])
        if (!Number(record(results[1]).changes)) { this.skipped++; this.lastError = "Langfuse 月度额度或待发队列达到上限，新增记录已跳过。" }
        else { item.session.root_queued = 1; if (root) item.session.root_span_id = item.id }
        this.pending.shift()
      } catch { this.writeFailures++; this.fault(); throw new Error("Langfuse outbox write failed") }
    }
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.flushOnce().finally(() => { this.flushing = null })
    return this.flushing
  }
  private async flushOnce(): Promise<void> {
    await this.serial(() => this.persist())
    const settings = this.settings()
    if (!this.ready(settings)) return
    const target = this.target(settings)
    const rows = await this.serial(async () => {
      const candidates = await sqliteClient.all<Row>("SELECT * FROM langfuse_outbox WHERE target=? AND next_attempt_at<=? ORDER BY created_at,id LIMIT 20", [target, this.now()])
      const month = new Date(this.now()).toISOString().slice(0, 7)
      const ready: Row[] = []
      for (const row of candidates) {
        if (row.budget_month !== month) {
          // 跨月积压也要占用投递当月预算，不能借上月额度绕过上限。
          const changes = await sqliteClient.transaction([
            { sql: "INSERT OR IGNORE INTO langfuse_budget_monthly(target,month) VALUES(?,?)", params: [target, month] },
            { sql: "UPDATE langfuse_budget_monthly SET reserved_units=reserved_units+? WHERE target=? AND month=? AND reserved_units+?<=?", params: [row.units, target, month, row.units, settings.monthlyUnitLimit] },
            { sql: "UPDATE langfuse_outbox SET budget_month=? WHERE id=? AND changes()>0", params: [month, row.id] },
          ])
          if (!Number(record(changes[2]).changes)) continue
        }
        ready.push(row)
      }
      return ready
    })
    if (!rows.length) return
    try {
      await this.send(settings, rows.map(row => record(JSON.parse(text(row.payload_json)))))
      await sqliteClient.transaction(rows.map(row => ({ sql: "DELETE FROM langfuse_outbox WHERE id=?", params: [row.id] })))
      this.sent += rows.length
      this.lastError = ""
    } catch {
      this.fault()
      await sqliteClient.transaction(rows.map(row => ({ sql: "UPDATE langfuse_outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?", params: [this.now() + Math.min(300000, 5000 * 2 ** Math.min(6, Number(row.attempts))), row.id] })))
    }
  }

  async resetScopes(scopes?: string[]): Promise<void> {
    await this.serial(async () => {
      if (!scopes) await sqliteClient.run("DELETE FROM langfuse_sessions", [])
      else for (const scope of scopes) await sqliteClient.run("DELETE FROM langfuse_sessions WHERE conversation_scope=?", [hash(scope)])
    })
  }

  async stats(): Promise<Row> {
    const settings = this.settings()
    if (!sqliteClient.status.available) return { enabled: !!settings?.enabled, available: false, lastError: this.lastError }
    const month = new Date(this.now()).toISOString().slice(0, 7)
    const budget = this.ready(settings) ? await sqliteClient.get<Row>("SELECT reserved_units FROM langfuse_budget_monthly WHERE target=? AND month=?", [this.target(settings), month]) : null
    const outbox = await sqliteClient.get<Row>("SELECT COUNT(*) AS pending,COALESCE(SUM(attempts>0),0) AS retrying FROM langfuse_outbox", [])
    return { enabled: !!settings?.enabled, configured: this.ready(settings), month, monthlyUnitLimit: settings?.monthlyUnitLimit,
      reservedUnits: Number(budget?.reserved_units || 0), ...outbox, buffered: this.pending.length, sent: this.sent,
      skipped: this.skipped, writeFailures: this.writeFailures, lastError: this.lastError }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // 网络发送自身有总计 5 秒超时；等它完成后再允许宿主关闭 SQLite。
    try { await this.flush() }
    catch { this.fault() /* SQLite outbox 保留，重启继续投递。 */ }
  }
}

export const langfuseReporter = new LangfuseReporter()
