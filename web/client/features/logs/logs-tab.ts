import { computed, onMounted, onUnmounted, reactive, ref } from "vue"
import { confirmAction, request, saveConfigPatch, store, toast } from "../../app/store/store.js"
import { asRecord, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { compactMediaDataForDisplay, modelMessageImageCount, modelMessagesImageCount } from "./log-media-display.js"

interface ModelRef extends UnknownRecord {
  id?: string
  name?: string
  model?: string
  provider?: string
}

interface LogModelCall extends UnknownRecord {
  id?: string
  sequence?: number
  status?: string
  purpose?: string
  metadata?: UnknownRecord
  metadata_json?: string
  available_tool_count?: number
  context_message_count?: number
  response_tool_call_count?: number
  available_models?: ModelRef[]
  actual_model?: ModelRef
  model_name?: string
  model_identifier?: string
  provider_name?: string
  route?: { availableModels?: ModelRef[]; actualModel?: ModelRef }
  parent_tool_id?: string
  response_text?: string
  stop_reason?: string
  total_tokens?: number
  duration_ms?: number
  started_at?: number
  input_text?: string
  error_message?: string
}

interface LogToolCall extends UnknownRecord {
  id?: string
  status?: string
  category?: string
  source?: string
  delivery?: string
  round?: number
  call_index?: number
  duration_ms?: number
  started_at?: number
  model_call_id?: string
  parent_tool_id?: string
  tool_name?: string
  result_chars?: number
  result_text?: string
  error_message?: string
  requires_final_reply?: boolean
  dispatched?: boolean
  retryAllowed?: boolean
  decision?: string
  remainingCount?: number
  deduplicated?: boolean
  usage_source?: string
  executedCount?: number
  completedCount?: number
  operationId?: string
  guardCode?: string
  attempt?: number
  arguments?: unknown
}

interface LogRun extends UnknownRecord {
  id: string
  started_at?: number
  status?: string
  source?: string
  purpose?: string
  conversation_key?: string
  prompt_text?: string
  model_calls?: number
  tool_calls?: number
  failed_tools?: number
  total_tokens?: number
  duration_ms?: number
  response_text?: string
  metadata?: UnknownRecord
}

interface LogDetail extends UnknownRecord {
  run: LogRun
  modelCalls?: LogModelCall[]
  toolCalls?: LogToolCall[]
  childRuns?: LogRun[]
}

interface ModelCallSnapshot extends UnknownRecord {
  model_call_id?: string
  run_id?: string
  sequence?: number
  operation?: string
  messages?: unknown[]
  tools?: unknown[]
  request?: UnknownRecord
  message_count?: number
  tool_count?: number
  context_chars?: number
  tool_chars?: number
  truncated?: boolean
  redaction_version?: string
  captured_at?: number
}

interface ContextItem extends UnknownRecord {
  index?: number
  role?: string
  source?: string
  label?: string
  chars?: number
  tokenEstimate?: number
  toolCallIds?: string[]
}

interface ContextSection extends UnknownRecord {
  source?: string
  label?: string
  messageIndexes?: number[]
  count?: number
  chars?: number
  tokenEstimate?: number
  content?: string
}

interface ContextMetadata extends UnknownRecord {
  phase?: string
  total?: { messageCount?: number; chars?: number; tokenEstimate?: number }
  items?: ContextItem[]
  sections?: ContextSection[]
}

interface ModelCallDetail extends UnknownRecord {
  modelCall?: LogModelCall
  snapshot?: ModelCallSnapshot | null
  available?: boolean
  persistence?: boolean
}

interface ConversationItem extends UnknownRecord {
  id?: string
  source?: string
  purpose?: string
  status?: string
  started_at?: number
  ended_at?: number
  duration_ms?: number
  prompt_text?: string
  response_text?: string
  model_calls?: number
  tool_calls?: number
  failed_tools?: number
  total_tokens?: number
  prompt_chars?: number
  response_chars?: number
  model_call_ids?: string[]
}

interface ConversationDetail extends UnknownRecord {
  runId?: string
  conversationKey?: string
  session?: {
    key?: string
    scope_type?: string
    user_id?: string
    group_id?: string
    source?: string
    purpose?: string
    started_at?: number
    ended_at?: number
    turn_count?: number
  }
  available?: boolean
  persistence?: boolean
  items?: ConversationItem[]
}

interface LogSummary extends UnknownRecord {
  totals?: { total?: number; calls?: number; failures?: number; cost?: number; currency?: string; toolSuccessRate?: number; toolFailures?: number }
  models?: Array<{ name?: string }>
  persistence?: { available?: boolean; queued?: number; droppedEvents?: number; lastFlushAt?: string; lastError?: string }
}

interface LogState {
  summary: LogSummary | null
  runs: LogRun[]
  nextCursor: string
  loading: boolean
  error: string
  detail: LogDetail | null
  settings: { detailRetentionDays: number; aggregateRetentionDays: number }
  filters: { from: string; to: string; status: string; model: string; purpose: string; query: string }
}

interface CleanupResult extends UnknownRecord { modelCalls?: number; toolCalls?: number }

const contextSourceLabels: Record<string, string> = {
  "system-context": "系统上下文",
  "step-instruction": "步骤指令",
  workflow: "前序步骤",
  history: "会话历史",
  current: "当前提问",
  "model-decision": "模型工具决策",
  "tool-result": "工具返回结果",
  "runtime-instruction": "运行时收束指令",
  "persona-runtime": "系统运行规则",
  "runtime-time": "当前时间",
  persona: "角色设定",
  "persona-extra": "额外系统提示",
  "command-knowledge": "内置指令知识",
  skill: "Skill 指令",
  media: "媒体与消息附加内容",
  memory: "记忆召回",
  knowledge: "知识库召回",
  recent: "最近消息上下文",
  other: "其他上下文",
}

function contextMessageText(value: unknown): string {
  const content = asRecord(value).content
  if (typeof content === "string") return content
  if (content !== undefined) {
    try { return JSON.stringify(content, null, 2) || "" } catch { return String(content) }
  }
  return ""
}

function snapshotContext(snapshot: ModelCallSnapshot | null | undefined): ContextMetadata {
  const request = asRecord(snapshot?.request)
  const metadata = asRecord(request.metadata)
  return asRecord<ContextMetadata>(metadata.context)
}

function contextItemFor(snapshot: ModelCallSnapshot | null | undefined, index: number): ContextItem {
  const message = snapshot?.messages?.[index]
  const metadata = snapshotContext(snapshot)
  const listed = (metadata.items || []).find(item => Number(item.index) === index) || {}
  const chars = Number(listed.chars ?? contextMessageText(message).length)
  const tokenEstimate = Number(listed.tokenEstimate ?? Math.ceil(chars / 4))
  return {
    ...listed,
    index,
    role: String(listed.role || asRecord(message).role || "unknown"),
    chars,
    tokenEstimate,
  }
}

function contextSectionsFor(snapshot: ModelCallSnapshot | null | undefined): ContextSection[] {
  const metadata = snapshotContext(snapshot)
  if (metadata.sections?.length) return metadata.sections
  const grouped = new Map<string, ContextSection>()
  for (let index = 0; index < (snapshot?.messages || []).length; index += 1) {
    const item = contextItemFor(snapshot, index)
    const source = String(item.source || "other")
    const current = grouped.get(source) || {
      source,
      label: contextSourceLabels[source] || String(item.label || source),
      messageIndexes: [],
      count: 0,
      chars: 0,
      tokenEstimate: 0,
    }
    current.messageIndexes = [...(current.messageIndexes || []), index]
    current.count = Number(current.count || 0) + 1
    current.chars = Number(current.chars || 0) + Number(item.chars || 0)
    current.tokenEstimate = Number(current.tokenEstimate || 0) + Number(item.tokenEstimate || 0)
    grouped.set(source, current)
  }
  return [...grouped.values()]
}

function contextSourceLabel(value: unknown): string {
  const source = asRecord(value)
  const key = String(source.source || (typeof value === "string" ? value : ""))
  return contextSourceLabels[key] || String(source.label || key || "其他上下文")
}

function promptPreview(value: unknown): string {
  const content = String(value || "").replace(/\s+/g, " ").trim()
  if (!content) return "没有保存提问正文"
  return content.length > 58 ? `${content.slice(0, 58)}…` : content
}

function conversationScope(detail: ConversationDetail | null | undefined): string {
  const session = detail?.session || {}
  if (session.scope_type === "system") return "系统任务"
  if (session.group_id) return `群 ${session.group_id}`
  if (session.user_id) return `用户 ${session.user_id}`
  const first = detail?.items?.[0]
  if (first?.source) return sourceLabel(first.source)
  return "未标记范围"
}

function conversationTitle(detail: ConversationDetail | null | undefined): string {
  const session = detail?.session || {}
  const first = detail?.items?.[0]
  const purpose = purposeLabel(session.purpose || first?.purpose)
  const source = sourceLabel(session.source || first?.source)
  const activity = source !== "-" ? source : purpose !== "-" ? purpose : "会话"
  return `${conversationScope(detail)} · ${activity}`
}

function dateValue(offset = 0) {
  const date = new Date(Date.now() + (8 * 60 * 60 * 1000) + offset * 86400000)
  return date.toISOString().slice(0, 10)
}

function number(value: unknown): string {
  return Number(value || 0).toLocaleString("zh-CN")
}

function time(value: unknown): string {
  if (!value) return "-"
  return new Date(Number(value)).toLocaleString("zh-CN", { hour12: false })
}

function statusLabel(value: unknown): string {
  const labels: Record<string, string> = { running: "进行中", queued: "排队中", accepted: "已接收", ok: "成功", error: "失败", failed: "失败", ambiguous: "结果不确定", denied: "拒绝", blocked: "拦截", skipped: "已跳过", partial: "部分完成", silent: "静默", canceled: "取消", interrupted: "中断" }
  const key = String(value || "")
  return labels[key] || key || "未知"
}

function modelStopLabel(value: unknown): string {
  const labels: Record<string, string> = {
    tool_calls: "请求工具",
    end_turn: "正常结束",
    max_tokens: "达到输出上限",
    pause_turn: "模型暂停",
    refusal: "模型拒绝",
    error: "模型错误",
    unknown: "终止原因未知",
  }
  const key = String(value || "unknown")
  return labels[key] || key
}

function duration(value: unknown): string {
  const ms = Math.max(0, Number(value) || 0)
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s`
}

function categoryLabel(value: unknown = ""): string {
  const labels: Record<string, string> = { command: "指令", memory: "记忆", network: "网络", media: "媒体", output: "输出", render: "渲染", social: "社交", admin: "群管", entertainment: "娱乐", custom: "自定义", skill: "Skill", mcp: "MCP" }
  const key = String(value || "")
  return labels[key] || key || "未分类"
}

function deliveryLabel(value: unknown = ""): string {
  const labels: Record<string, string> = { silent: "交给模型", "current-chat": "当前会话发送", "target-chat": "目标会话发送", media: "媒体发送" }
  const key = String(value || "")
  return labels[key] || key || "未标记"
}

function modelMetadata(item: LogModelCall = {}): UnknownRecord {
  if (item.metadata) return asRecord(item.metadata)
  try {
    const parsed = JSON.parse(item.metadata_json || "{}")
    return asRecord(parsed)
  } catch { return {} }
}

function availableTools(item: LogModelCall): number {
  return Number(item.available_tool_count ?? modelMetadata(item).toolCount) || 0
}

function responseToolCalls(item: LogModelCall): number {
  return Number(item.response_tool_call_count ?? modelMetadata(item).toolCalls) || 0
}

function modelLabel(model: ModelRef = {}): string {
  const name = model.id || model.name || model.model || "-"
  const provider = model.provider ? `/${model.provider}` : ""
  return `${name}${provider}`
}

function modelRouteDetail(item: LogModelCall): string {
  const metadata = modelMetadata(item)
  const route = item.route || asRecord<{ availableModels?: ModelRef[]; actualModel?: ModelRef }>(metadata.route)
  const available = (item.available_models || route.availableModels || []).map(modelLabel).filter(Boolean)
  const actual = item.actual_model || route.actualModel || { id: item.model_name, model: item.model_identifier, provider: item.provider_name }
  return `可用模型 ${available.join("、") || "-"} · 实际调用 ${modelLabel(actual)}`
}

function scopeLabel(row: LogRun = { id: "" }): string {
  if (row.scope_type === "system") return "系统任务"
  if (row.group_id) return `群 ${row.group_id}`
  return `用户 ${row.user_id || "-"}`
}

function sourceLabel(value: unknown = ""): string {
  const labels: Record<string, string> = {
    "knowledge-index-rebuild": "向量重建",
    embedding: "向量调用",
    "group-memory-consolidation": "群聊记忆提炼",
    firstPerson: "第一人称对话",
    management: "管理任务",
    "memory-recall": "记忆召回",
    "memory-vector-index": "记忆向量",
    "knowledge-vector-index": "知识库向量",
  }
  const key = String(value || "")
  return labels[key] || key || "-"
}

function purposeLabel(value: unknown = ""): string {
  const labels: Record<string, string> = {
    embedding_knowledge: "知识库向量",
    embedding_memory: "记忆向量",
    embedding: "向量调用",
    chat: "对话",
    "memory-consolidation": "记忆提炼",
  }
  const key = String(value || "")
  return labels[key] || key || "-"
}

function lineageLabel(value: unknown = ""): string {
  const id = String(value || "")
  return id ? `父工具 ${id.slice(0, 8)}` : ""
}

export const LogsTab = {
  name: "LogsTab",
  setup() {
    const state = reactive<LogState>({
      summary: null,
      runs: [],
      nextCursor: "",
      loading: false,
      error: "",
      detail: null,
      settings: { detailRetentionDays: 7, aggregateRetentionDays: 90 },
      filters: { from: dateValue(-6), to: dateValue(), status: "", model: "", purpose: "", query: "" },
    })
    const drawerOpen = ref(false)
    const timelineFilter = ref("all")
    const settingsDrawerOpen = ref(false)
    const modelDetailOpen = ref(false)
    const modelDetailLoading = ref(false)
    const modelDetailError = ref("")
    const modelDetail = ref<ModelCallDetail | null>(null)
    const modelDetailTab = ref("context")
    const conversationOpen = ref(false)
    const conversationLoading = ref(false)
    const conversationError = ref("")
    const conversationDetail = ref<ConversationDetail | null>(null)
    const conversationTurnId = ref("")
    const conversationTurnLoading = ref(false)
    const conversationTurnError = ref("")
    const conversationTurnDetail = ref<LogDetail | null>(null)
    let modelDetailRequest = 0
    let conversationRequest = 0
    let conversationTurnRequest = 0
    const conversationTurnCache = new Map<string, LogDetail>()
    let refreshTimer: ReturnType<typeof setInterval> | null = null
    let visibilityHandler: (() => void) | null = null

    function syncSettings() {
      const config = asRecord<{ logging?: { history?: UnknownRecord } }>(store.config)
      const history = asRecord(config.logging?.history)
      state.settings.detailRetentionDays = Number(history.detailRetentionDays || 7)
      state.settings.aggregateRetentionDays = Number(history.aggregateRetentionDays || 90)
    }

    function queryParams(includeCursor = true) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(state.filters)) if (value !== "" && value !== null && value !== undefined) params.set(key, value)
      if (!includeCursor) params.delete("cursor")
      return params.toString()
    }

    async function refresh({ append = false } = {}) {
      if (state.loading) return
      state.loading = true
      state.error = ""
      try {
        const summaryQuery = new URLSearchParams(queryParams(false))
        const runsQuery = new URLSearchParams(queryParams(false))
        if (append && state.nextCursor) runsQuery.set("cursor", state.nextCursor)
        const [summaryResponse, runsResponse] = await Promise.all([
          request(`/api/logs/summary?${summaryQuery}`),
          request(`/api/logs/runs?${runsQuery}`),
        ])
        const summary = asRecord<{ summary?: LogSummary }>(summaryResponse)
        const runs = asRecord<{ items?: LogRun[]; nextCursor?: string }>(runsResponse)
        state.summary = summary.summary || null
        const items = Array.isArray(runs.items) ? runs.items : []
        state.runs = append ? [...state.runs, ...items] : items
        state.nextCursor = String(runs.nextCursor || "")
        syncSettings()
      } catch (error) {
        state.error = errorMessage(error)
      } finally {
        state.loading = false
      }
    }

    function resetAndRefresh() {
      state.nextCursor = ""
      return refresh()
    }

    function resetFilters() {
      state.filters = { from: dateValue(-6), to: dateValue(), status: "", model: "", purpose: "", query: "" }
      return resetAndRefresh()
    }

    async function applyFilters() {
      await resetAndRefresh()
    }

    async function openRun(row: LogRun) {
      try {
        const result = await request(`/api/logs/runs/${encodeURIComponent(row.id)}`)
        state.detail = asRecord<LogDetail>(result)
        timelineFilter.value = "all"
        drawerOpen.value = true
      } catch (error) { toast(errorMessage(error)) }
    }

    async function openModelDetailById(id: unknown) {
      const modelId = String(id || "")
      if (!modelId) return
      const requestId = ++modelDetailRequest
      modelDetailOpen.value = true
      modelDetailLoading.value = true
      modelDetailError.value = ""
      modelDetail.value = null
      modelDetailTab.value = "context"
      try {
        const result = await request(`/api/logs/model-calls/${encodeURIComponent(modelId)}/detail`)
        if (requestId !== modelDetailRequest) return
        modelDetail.value = asRecord<ModelCallDetail>(result)
      } catch (error) {
        if (requestId === modelDetailRequest) modelDetailError.value = errorMessage(error)
      } finally {
        if (requestId === modelDetailRequest) modelDetailLoading.value = false
      }
    }

    function openModelDetail(item: LogModelCall): Promise<void> {
      return openModelDetailById(item.id)
    }

    async function loadConversationTurn(item: ConversationItem | string) {
      const runId = typeof item === "string" ? item : String(item.id || "")
      if (!runId) return
      const requestId = ++conversationTurnRequest
      conversationTurnId.value = runId
      conversationTurnError.value = ""
      conversationTurnLoading.value = true
      conversationTurnDetail.value = null
      const cached = conversationTurnCache.get(runId)
      if (cached) {
        conversationTurnDetail.value = cached
        conversationTurnLoading.value = false
        return
      }
      try {
        const result = await request(`/api/logs/runs/${encodeURIComponent(runId)}`)
        if (requestId !== conversationTurnRequest) return
        const detail = asRecord<LogDetail>(result)
        conversationTurnCache.set(runId, detail)
        conversationTurnDetail.value = detail
      } catch (error) {
        if (requestId === conversationTurnRequest) conversationTurnError.value = errorMessage(error)
      } finally {
        if (requestId === conversationTurnRequest) conversationTurnLoading.value = false
      }
    }

    async function openConversation() {
      const runId = state.detail?.run?.id
      if (!runId) return
      const requestId = ++conversationRequest
      conversationOpen.value = true
      conversationLoading.value = true
      conversationError.value = ""
      conversationDetail.value = null
      conversationTurnRequest += 1
      conversationTurnId.value = ""
      conversationTurnError.value = ""
      conversationTurnDetail.value = null
      conversationTurnCache.clear()
      try {
        const result = await request(`/api/logs/runs/${encodeURIComponent(runId)}/conversation`)
        if (requestId !== conversationRequest) return
        const detail = asRecord<ConversationDetail>(result)
        conversationDetail.value = detail
        const first = detail.items?.find(item => Boolean(item.id))
        if (first) void loadConversationTurn(first)
      } catch (error) {
        if (requestId === conversationRequest) conversationError.value = errorMessage(error)
      } finally {
        if (requestId === conversationRequest) conversationLoading.value = false
      }
    }

    async function saveSettings() {
      try {
        await saveConfigPatch({
          "logging.history.detailRetentionDays": Number(state.settings.detailRetentionDays),
          "logging.history.aggregateRetentionDays": Number(state.settings.aggregateRetentionDays),
        })
        syncSettings()
        settingsDrawerOpen.value = false
      } catch (error) { toast(errorMessage(error)) }
    }

    async function cleanupLogs() {
      try {
        const body = { dryRun: true, before: new Date(`${state.filters.from}T00:00:00+08:00`).getTime() }
        const preview = await request("/api/logs/cleanup", { method: "POST", body: JSON.stringify(body) })
        const previewResult = asRecord<CleanupResult>(asRecord(preview).result)
        const accepted = await confirmAction({
          title: "清理日志详情？",
          message: `将删除 ${number(previewResult.modelCalls)} 条模型调用和 ${number(previewResult.toolCalls)} 条工具调用记录。`,
          detail: "只影响日志域，不会结束会话、删除记忆或修改知识库。",
          confirmText: "确认清理",
          tone: "warn",
          icon: "trash",
        })
        if (!accepted) return
        await request("/api/logs/cleanup", { method: "POST", body: JSON.stringify({ ...body, dryRun: false }) })
        toast("日志已清理", "success")
        await refresh()
      } catch (error) { toast(errorMessage(error)) }
    }

    async function cleanupAllLogs() {
      try {
        const preview = await request("/api/logs/cleanup", { method: "POST", body: JSON.stringify({ all: true, dryRun: true }) })
        const previewResult = asRecord<CleanupResult>(asRecord(preview).result)
        const accepted = await confirmAction({
          title: "清空全部日志？",
          message: `将删除 ${number(previewResult.modelCalls)} 条模型调用和 ${number(previewResult.toolCalls)} 条工具调用记录。`,
          detail: "只影响日志域，不会结束会话、删除记忆或知识库；此操作不可恢复。",
          confirmText: "确认清空日志",
          tone: "danger",
          icon: "trash",
        })
        if (!accepted) return
        await request("/api/logs/cleanup", { method: "POST", body: JSON.stringify({ all: true, dryRun: false }) })
        toast("全部日志已清空", "success")
        await refresh()
      } catch (error) { toast(errorMessage(error)) }
    }

    const totals = computed(() => state.summary?.totals || {})
    const metrics = computed(() => [
      { label: "Token 总量", value: number(totals.value.total), icon: "activity", tone: "blue", tip: "输入 + 输出 Token" },
      { label: "模型调用", value: number(totals.value.calls), icon: "cpu", tone: "purple" },
      { label: "模型失败率", value: `${totals.value.calls ? (((totals.value.failures || 0) / totals.value.calls) * 100).toFixed(1) : "0.0"}%`, icon: "alert", tone: totals.value.failures ? "orange" : "green" },
      { label: "估算费用", value: totals.value.cost ? `${Number(totals.value.cost).toFixed(4)} ${totals.value.currency || "CNY"}` : "-", icon: "wallet", tone: "blue", tip: "没有价格或 Token 时显示为 -" },
    ])
    const modelRows = computed(() => state.summary?.models || [])
    const modelResponses = computed(() => (state.detail?.modelCalls || []).filter(item => item.response_text))
    const availableToolCount = computed(() => (state.detail?.modelCalls || []).reduce((max, item) => Math.max(max, availableTools(item)), 0))
    const actualToolCount = computed(() => (state.detail?.toolCalls || []).length)
    const toolInvocationHint = computed(() => {
      if (availableToolCount.value > 0 && actualToolCount.value === 0) {
        return `本次向模型提供了 ${availableToolCount.value} 个工具，但模型没有发起工具调用；这不是链路丢失。`
      }
      if (availableToolCount.value === 0 && actualToolCount.value > 0) {
        return "已记录工具调用，但关联模型请求未声明可用工具；请检查模型接口记录。"
      }
      return ""
    })
    const timeline = computed(() => {
      const modelCalls = state.detail?.modelCalls || []
      const toolCalls = state.detail?.toolCalls || []
      const modelSequence = new Map(modelCalls.map(item => [item.id, Number(item.sequence || 0)]))
      const models = modelCalls.map(item => ({
        ...item,
        kind: "模型",
        kindKey: "model",
        label: item.model_name || "模型",
        detail: `${purposeLabel(item.purpose)} · ${statusLabel(item.status)} · ${modelStopLabel(item.stop_reason)} · 提供工具 ${availableTools(item)} · 返回调用 ${responseToolCalls(item)} · ${modelRouteDetail(item)}${item.parent_tool_id ? ` · ${lineageLabel(item.parent_tool_id)}` : ""}`,
        sortOrder: Number(item.sequence || 0),
      }))
      const tools = toolCalls.map(item => {
        const parentSequence = modelSequence.get(item.model_call_id) || Number(item.round || 0)
      return {
        ...item,
        kind: "工具",
        kindKey: "tool",
        label: item.tool_name || "未命名工具",
          detail: `第 ${item.round || "-"} 轮 · ${categoryLabel(item.category || item.source)} · ${duration(item.duration_ms)}${item.parent_tool_id ? ` · ${lineageLabel(item.parent_tool_id)}` : ""}`,
        sortOrder: parentSequence + 0.5 + (Number(item.call_index || 0) / 1000),
      }
      })
      const events = [...models, ...tools].sort((a, b) => a.sortOrder - b.sortOrder || Number(a.started_at || 0) - Number(b.started_at || 0))
      if (timelineFilter.value === "model") return events.filter(item => item.kindKey === "model")
      if (timelineFilter.value === "tool") return events.filter(item => item.kindKey === "tool")
      if (timelineFilter.value === "error") return events.filter(item => item.status !== "ok")
      return events
    })
    function toolGroupsForModel(modelId: unknown): Array<{ round: number; items: LogToolCall[] }> {
      const groups = new Map<number, LogToolCall[]>()
      for (const item of conversationTurnDetail.value?.toolCalls || []) {
        if (String(item.model_call_id || "") !== String(modelId || "")) continue
        const round = Number(item.round || 0)
        groups.set(round, [...(groups.get(round) || []), item])
      }
      return [...groups.entries()]
        .sort(([left], [right]) => left - right)
        .map(([round, items]) => ({ round, items: items.sort((left, right) => Number(left.call_index || 0) - Number(right.call_index || 0)) }))
    }
    function unlinkedConversationTools(): LogToolCall[] {
      const modelIds = new Set((conversationTurnDetail.value?.modelCalls || []).map(item => String(item.id || "")))
      return (conversationTurnDetail.value?.toolCalls || []).filter(item => !item.model_call_id || !modelIds.has(String(item.model_call_id)))
    }
    const modelOptions = computed(() => [{ value: "", label: "全部模型" }, ...modelRows.value.map(item => ({ value: item.name, label: item.name }))])

    onMounted(() => {
      syncSettings()
      refresh()
      visibilityHandler = () => {
        if (document.hidden) {
          if (refreshTimer) clearInterval(refreshTimer)
          refreshTimer = null
        } else if (!refreshTimer) {
          refresh()
          refreshTimer = setInterval(() => refresh(), 5000)
        }
      }
      document.addEventListener("visibilitychange", visibilityHandler)
      refreshTimer = setInterval(() => { if (!document.hidden) refresh() }, 5000)
    })
    onUnmounted(() => {
      if (refreshTimer) clearInterval(refreshTimer)
      if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler)
    })

    return {
      state, drawerOpen, settingsDrawerOpen, timelineFilter,
      modelDetailOpen, modelDetailLoading, modelDetailError, modelDetail, modelDetailTab,
      conversationOpen, conversationLoading, conversationError, conversationDetail, conversationTurnId, conversationTurnLoading, conversationTurnError, conversationTurnDetail,
      totals, metrics, timeline, modelResponses, modelOptions, availableToolCount, actualToolCount, toolInvocationHint,
      number, time, duration, categoryLabel, deliveryLabel, statusLabel, modelStopLabel, scopeLabel, sourceLabel, purposeLabel, lineageLabel, modelRouteDetail, availableTools, refresh, resetAndRefresh, resetFilters, applyFilters,
      conversationScope, conversationTitle, promptPreview, toolGroupsForModel, unlinkedConversationTools, contextSourceLabel, contextItemFor, contextSectionsFor,
      openRun, openModelDetail, openModelDetailById, openConversation, loadConversationTurn, saveSettings, cleanupLogs, cleanupAllLogs,
      modelContextCount: (item: LogModelCall) => Number(item.context_message_count ?? modelMetadata(item).messageCount) || 0,
      modelMessageImageCount,
      modelMessagesImageCount,
      pretty: (value: unknown) => {
        if (typeof value === "string") return value
        try { return JSON.stringify(value, null, 2) || "" } catch { return String(value ?? "") }
      },
      messageRole: (value: unknown) => String(asRecord(value).role || "unknown"),
      messageContent: (value: unknown) => {
        const source = asRecord(value)
        if (typeof source.content === "string") return source.content
        if (source.content !== undefined) {
          try { return JSON.stringify(compactMediaDataForDisplay(source.content), null, 2) || "" } catch { return String(source.content) }
        }
        return ""
      },
      toolFunction: (value: unknown) => asRecord(asRecord(value).function),
      toolName: (value: unknown) => String(asRecord(asRecord(value).function).name || asRecord(value).name || "未命名工具"),
      toolDescription: (value: unknown) => String(asRecord(asRecord(value).function).description || ""),
      toolParameters: (value: unknown) => asRecord(asRecord(asRecord(value).function).parameters),
    }
  },
  template: `
    <div class="stack logs-page">
      <section class="logs-summary-row" aria-label="日志统计总量">
        <div class="logs-inline-summary">
          <div v-for="item in metrics" :key="item.label" class="logs-inline-metric"><span>{{ item.label }}</span><b>{{ item.value }}</b></div>
        </div>
        <button class="btn small outline logs-settings-button" type="button" @click="settingsDrawerOpen = true"><Icon name="sliders" :size="13" />设置</button>
      </section>
      <div v-if="state.error" class="slice-error-banner"><Icon name="alert" :size="17" /><p>{{ state.error }}</p></div>

      <Panel title="运行链路日志" icon="list">
        <template #actions><span class="muted tiny">{{ state.runs.length }} 条当前结果</span></template>
        <div class="logs-filter-scroll">
          <div class="logs-filter-row">
            <Field class="logs-filter-field" v-model="state.filters.from" label="开始日期" type="date" />
            <Field class="logs-filter-field" v-model="state.filters.to" label="结束日期" type="date" />
            <Field class="logs-filter-field" v-model="state.filters.status" label="状态" type="select" :options="[{ value: '', label: '全部状态' }, { value: 'running', label: '进行中' }, { value: 'ok', label: '成功' }, { value: 'error', label: '失败' }, { value: 'ambiguous', label: '结果不确定' }, { value: 'denied', label: '拒绝' }, { value: 'blocked', label: '拦截' }, { value: 'skipped', label: '已跳过' }, { value: 'partial', label: '部分完成' }, { value: 'silent', label: '静默' }, { value: 'canceled', label: '取消' }]" />
            <Field class="logs-filter-field" v-model="state.filters.model" label="模型" type="select" :options="modelOptions" />
            <Field class="logs-filter-field" v-model="state.filters.purpose" label="用途标签" placeholder="chat / embedding" />
            <Field class="logs-filter-field logs-filter-query" v-model="state.filters.query" label="关键词" placeholder="用户、工具、结果、来源或提炼输入" @enter="applyFilters" />
            <button class="btn small outline" type="button" @click="resetFilters">重置</button>
            <button class="btn small primary" type="button" @click="applyFilters"><Icon name="filter" :size="13" />筛选</button>
          </div>
        </div>
        <div class="table-wrap logs-run-table"><table class="data-table"><thead><tr><th>开始时间</th><th>来源 / 用途</th><th>状态</th><th class="num">模型调用</th><th class="num">工具调用</th><th class="num">Token</th><th>用户 / 群</th><th class="col-actions">操作</th></tr></thead><tbody><tr v-for="row in state.runs" :key="row.id"><td class="muted tiny">{{ time(row.started_at) }}</td><td><div class="cell-title">{{ sourceLabel(row.source) }}</div><span class="muted tiny">{{ purposeLabel(row.purpose) }}</span></td><td><span class="badge" :class="row.status === 'ok' ? 'on' : (row.status === 'error' ? 'risk-high' : 'risk-medium')">{{ statusLabel(row.status) }}</span></td><td class="num">{{ number(row.model_calls) }}</td><td class="num">{{ number(row.tool_calls) }}<small v-if="row.failed_tools" class="table-subvalue">失败 {{ number(row.failed_tools) }}</small></td><td class="num">{{ number(row.total_tokens) }}</td><td class="muted tiny">{{ scopeLabel(row) }}</td><td class="col-actions"><button class="btn small outline" type="button" @click="openRun(row)">查看详情</button></td></tr></tbody></table><div v-if="!state.runs.length" class="logs-empty"><Icon name="activity" :size="22" /><b>没有匹配的日志</b><span>调整筛选条件后再试一次。</span></div></div>
        <div v-if="state.nextCursor" class="pager"><button class="btn small outline" type="button" @click="refresh({ append: true })">加载更多</button></div>
      </Panel>

      <SideDrawer :open="settingsDrawerOpen" title="日志设置" subtitle="管理持久化、保留周期和日志清理" icon="sliders" width="560px" @close="settingsDrawerOpen = false">
        <section class="logs-settings-section">
          <div class="logs-settings-heading"><span class="drawer-icon"><Icon name="database" :size="16" /></span><div><b>采集状态</b><p>大模型调用日志在后台异步写入，不影响模型主流程。</p></div></div>
          <div class="logs-health compact"><span><span class="dot" :class="state.summary?.persistence?.available ? 'on' : 'warn'"></span>{{ state.summary?.persistence?.available ? 'SQLite 持久化可用' : '内存环形缓冲' }}</span><span>队列 {{ number(state.summary?.persistence?.queued) }}</span><span>丢弃 {{ number(state.summary?.persistence?.droppedEvents) }}</span><span v-if="state.summary?.persistence?.lastFlushAt">最近刷新 {{ state.summary.persistence.lastFlushAt }}</span><span v-if="state.summary?.persistence?.lastError" class="text-danger">{{ state.summary.persistence.lastError }}</span></div>
        </section>
        <section class="logs-settings-section">
          <div class="logs-settings-heading"><span class="drawer-icon"><Icon name="clock" :size="16" /></span><div><b>保留策略</b><p>详情与长期汇总可以使用不同的保存周期。</p></div></div>
          <div class="form-grid"><Field v-model="state.settings.detailRetentionDays" label="详情保留天数" type="number" hint="默认 7 天" /><Field v-model="state.settings.aggregateRetentionDays" label="汇总保留天数" type="number" hint="默认 90 天" /><Field model-value="CNY" label="费用币种" disabled hint="统一使用 CNY" /></div>
          <button class="btn primary" type="button" @click="saveSettings"><Icon name="save" :size="14" />保存设置</button>
        </section>
        <section class="logs-settings-section danger-zone">
          <div class="logs-settings-heading"><span class="drawer-icon"><Icon name="trash" :size="16" /></span><div><b>清理日志</b><p>只影响日志域，不会结束会话，也不会删除记忆或知识库。</p></div></div>
          <div class="toolbar"><button class="btn outline" type="button" @click="cleanupLogs">清理 {{ state.filters.from }} 之前</button><button class="btn danger" type="button" @click="cleanupAllLogs">清空全部日志</button></div>
        </section>
      </SideDrawer>

      <SideDrawer :open="drawerOpen" title="运行链路详情" subtitle="按模型请求、工具轮次和结束状态展示完整链路" icon="activity" width="720px" @close="drawerOpen = false">
        <div v-if="state.detail" class="logs-detail">
          <div class="detail-summary"><div><span class="badge" :class="state.detail.run.status === 'ok' ? 'on' : 'risk-medium'">{{ statusLabel(state.detail.run.status) }}</span><span class="muted">{{ time(state.detail.run.started_at) }} · 总耗时 {{ duration(state.detail.run.duration_ms) }}</span></div><button v-if="state.detail.run.conversation_key" class="btn small outline" type="button" @click="openConversation"><Icon name="message" :size="13" />查看完整会话</button></div>
          <div class="logs-detail-stats"><span>模型请求 <b>{{ number(state.detail.run.model_calls) }}</b></span><span>可用工具 <b>{{ number(availableToolCount) }}</b></span><span>实际调用 <b>{{ number(actualToolCount) }}</b></span><span v-if="state.detail.run.failed_tools">失败 <b class="text-danger">{{ number(state.detail.run.failed_tools) }}</b></span><span>Token <b>{{ number(state.detail.run.total_tokens) }}</b></span></div>
          <details v-if="state.detail.run.response_text" class="logs-run-response"><summary>查看最终模型回复（{{ number(state.detail.run.response_text.length) }} 字符）</summary><pre>{{ state.detail.run.response_text }}</pre></details>
          <div v-if="state.detail.childRuns?.length" class="logs-detail-stats logs-child-runs"><span>子运行 <b>{{ number(state.detail.childRuns.length) }}</b></span><span v-for="child in state.detail.childRuns" :key="child.id" class="badge">{{ sourceLabel(child.source) }} · {{ statusLabel(child.status) }} · {{ String(child.id).slice(0, 8) }}</span></div>
          <nav class="logs-detail-filter" aria-label="链路筛选"><button type="button" :class="{ active: timelineFilter === 'all' }" @click="timelineFilter = 'all'">全部</button><button type="button" :class="{ active: timelineFilter === 'model' }" @click="timelineFilter = 'model'">模型请求 {{ number(state.detail.modelCalls?.length || 0) }}</button><button type="button" :class="{ active: timelineFilter === 'tool' }" @click="timelineFilter = 'tool'">工具调用 {{ number(state.detail.toolCalls?.length || 0) }}</button><button type="button" :class="{ active: timelineFilter === 'error' }" @click="timelineFilter = 'error'">异常</button></nav>
          <p v-if="toolInvocationHint" class="logs-silent-note warning">{{ toolInvocationHint }}</p>
          <p v-if="state.detail.run.status === 'silent' && state.detail.run.metadata?.requiresFinalReply === false" class="logs-silent-note">本次运行按工具回复策略结束，没有要求模型补充文本。</p>
          <p v-else-if="state.detail.run.status === 'silent'" class="logs-silent-note warning">本次运行没有形成最终文本；请检查工具结果、模型收束请求和失败节点。</p>
          <p v-if="!timeline.length" class="logs-empty compact"><Icon name="activity" :size="20" /><span>当前筛选下没有链路事件。</span></p>
          <section v-if="state.detail.modelCalls?.length" class="logs-model-index" aria-label="模型请求详情入口">
            <div class="logs-model-index-head"><b>模型请求详情</b><span class="muted tiny">每一轮的上下文和工具包单独加载</span></div>
            <div class="logs-model-index-list"><button v-for="item in state.detail.modelCalls" :key="'model-index-' + item.id" class="logs-model-index-item" type="button" @click="openModelDetail(item)"><span>第 {{ item.sequence || '-' }} 次</span><b>{{ modelStopLabel(item.stop_reason) }}</b><b>工具 {{ number(availableTools(item)) }}</b><b>上下文 {{ number(modelContextCount(item)) }} 条</b><Icon name="chevron-right" :size="13" /></button></div>
          </section>
          <div v-if="modelResponses.length" class="logs-model-responses"><details v-for="item in modelResponses" :key="'response-' + item.id" class="logs-model-response"><summary>第 {{ item.sequence || "-" }} 次模型回复（{{ number(item.response_text.length) }} 字符）</summary><pre>{{ item.response_text }}</pre></details></div><div class="timeline"><div v-for="(item, index) in timeline" :key="item.id || index" class="timeline-item" :class="{ 'timeline-tool-item': item.kindKey === 'tool' }"><span class="timeline-dot" :class="item.status === 'ok' ? 'on' : 'warn'"></span><div class="timeline-content"><div class="timeline-title"><b>{{ item.kind }} · {{ item.label }}</b><span class="badge" :class="item.status === 'ok' ? 'on' : 'risk-medium'">{{ statusLabel(item.status) }}</span><span v-if="item.kindKey === 'tool'" class="badge">{{ categoryLabel(item.category || item.source) }}</span><span v-if="item.kindKey === 'tool'" class="badge">{{ deliveryLabel(item.delivery) }}</span><span v-if="item.kindKey === 'tool'" class="badge" :class="item.requires_final_reply ? 'risk-medium' : 'on'">{{ item.requires_final_reply ? '需要最终回复' : '允许静默结束' }}</span><span v-if="item.kindKey === 'tool' && item.dispatched" class="badge risk-medium">已派发</span><span v-if="item.kindKey === 'tool' && item.retryAllowed === false" class="badge risk-medium">禁止重试</span><span v-if="item.kindKey === 'tool' && item.decision" class="badge">{{ item.decision }}</span><span v-if="item.kindKey === 'tool' && item.remainingCount > 0" class="badge risk-medium">剩余 {{ number(item.remainingCount) }}</span><span v-if="item.kindKey === 'tool' && item.deduplicated" class="badge risk-medium">重复调用已跳过</span><span v-if="item.usage_source && item.usage_source !== 'reported'" class="badge risk-medium">{{ item.usage_source === 'estimated' ? '估算' : '未知' }}</span></div><p class="muted tiny"><span v-if="item.kindKey === 'tool'">第 {{ item.round || '-' }} 轮 · 调用 {{ item.call_index || '-' }} · 执行 {{ number(item.executedCount || 0) }} · 完成 {{ number(item.completedCount || 0) }} · 返回 {{ number(item.result_chars || 0) }} 字符 · {{ duration(item.duration_ms) }}</span><span v-else>第 {{ item.sequence || '-' }} 次模型请求 · {{ item.detail }} · {{ number(item.total_tokens || 0) }} Token · {{ duration(item.duration_ms) }}</span></p><p v-if="item.kindKey === 'tool' && (item.operationId || item.guardCode)" class="muted tiny">操作 {{ item.operationId || '-' }}<span v-if="item.guardCode"> · {{ item.guardCode }}</span><span v-if="item.attempt"> · 第 {{ item.attempt }} 次尝试</span></p><JsonBlock v-if="item.kindKey === 'tool' && item.arguments" title="查看工具参数" :value="item.arguments" /><details v-if="item.kindKey === 'tool' && item.result_text" class="logs-tool-result"><summary>查看返回结果（{{ number(item.result_chars || 0) }} 字符）</summary><pre>{{ item.result_text }}</pre></details><p v-if="item.kindKey === 'tool' && item.error_message" class="logs-tool-error">{{ item.error_message }}</p><details v-if="item.input_text" class="logs-model-input"><summary>查看本次提炼输入（已脱敏）</summary><pre>{{ item.input_text }}</pre></details><JsonBlock v-if="item.kindKey === 'model' && item.metadata_json" title="查看模型调用详情" :value="{ metadata: item.metadata_json, error: item.error_message }" /></div></div></div>
        </div>
      </SideDrawer>

      <SideDrawer :open="modelDetailOpen" title="模型请求详情" subtitle="本次请求的上下文与注入工具按需加载；内容已脱敏，超出上限时会标记截断" icon="cpu" width="1080px" modal @close="modelDetailOpen = false">
        <div class="logs-detail-window">
          <div v-if="modelDetailLoading" class="drawer-loading"><span class="spinner"></span>正在加载模型请求详情…</div>
          <div v-else-if="modelDetailError" class="slice-error-banner"><Icon name="alert" :size="17" /><p>{{ modelDetailError }}</p></div>
          <template v-else-if="modelDetail?.modelCall">
            <div class="logs-detail-window-meta"><div><span class="badge" :class="modelDetail.modelCall.status === 'ok' ? 'on' : 'risk-medium'">{{ statusLabel(modelDetail.modelCall.status) }}</span><span class="muted">第 {{ modelDetail.modelCall.sequence || '-' }} 次 · {{ modelDetail.modelCall.model_name || '-' }} · {{ purposeLabel(modelDetail.modelCall.purpose) }}</span></div><span class="muted tiny">{{ time(modelDetail.modelCall.started_at) }} · {{ duration(modelDetail.modelCall.duration_ms) }}</span></div>
            <div v-if="modelDetail.snapshot" class="logs-detail-stats"><span>上下文 <b>{{ number(modelDetail.snapshot.message_count) }}</b> 条</span><span>图片 <b>{{ number(modelMessagesImageCount(modelDetail.snapshot.messages)) }}</b> 张</span><span>工具包 <b>{{ number(modelDetail.snapshot.tool_count) }}</b> 个</span><span>上下文数据 <b>{{ number(modelDetail.snapshot.context_chars) }}</b> 字符</span><span>工具定义 <b>{{ number(modelDetail.snapshot.tool_chars) }}</b> 字符</span><span v-if="modelDetail.snapshot.truncated" class="badge risk-medium">快照已截断</span></div>
            <p v-if="!modelDetail.snapshot" class="logs-silent-note warning">这条记录创建于详细快照功能启用前，当前只有精简的模型调用信息。</p>
            <nav class="logs-window-tabs" aria-label="模型请求详情分区"><button type="button" :class="{ active: modelDetailTab === 'context' }" @click="modelDetailTab = 'context'">实际上下文 {{ number(modelDetail.snapshot?.message_count || 0) }} · 图片 {{ number(modelMessagesImageCount(modelDetail.snapshot?.messages)) }}</button><button type="button" :class="{ active: modelDetailTab === 'tools' }" @click="modelDetailTab = 'tools'">注入工具 {{ number(modelDetail.snapshot?.tool_count || 0) }}</button><button type="button" :class="{ active: modelDetailTab === 'request' }" @click="modelDetailTab = 'request'">请求与回复</button></nav>
            <section v-if="modelDetailTab === 'context'" class="logs-window-section">
              <div v-if="contextSectionsFor(modelDetail.snapshot).length" class="logs-context-composition">
                <div class="logs-context-composition-head"><b>上下文构成</b><span class="muted tiny">按这次请求实际整理；展开分组可看具体来源</span></div>
                <div class="logs-context-section-list">
                  <article v-for="(section, sectionIndex) in contextSectionsFor(modelDetail.snapshot)" :key="'context-section-' + sectionIndex" class="logs-context-section">
                    <header><div><span class="badge">{{ contextSourceLabel(section) }}</span><b>{{ section.label || contextSourceLabel(section) }}</b></div><span class="muted tiny">{{ number(section.count) }} 条 · {{ number(section.chars) }} 字符 · {{ number(section.tokenEstimate) }} Token</span></header>
                    <pre v-if="section.content">{{ section.content }}</pre>
                  </article>
                </div>
              </div>
              <div v-if="modelDetail.snapshot?.messages?.length" class="logs-context-list">
                <article v-for="(item, index) in modelDetail.snapshot.messages" :key="'context-' + index" class="logs-context-item">
                  <header><div><span class="badge">{{ contextSourceLabel(contextItemFor(modelDetail.snapshot, index)) }}</span><b>{{ index + 1 }} · {{ messageRole(item) }}</b><span v-if="modelMessageImageCount(item)" class="badge on">图片 {{ number(modelMessageImageCount(item)) }} 张</span></div><span class="muted tiny">{{ number(contextItemFor(modelDetail.snapshot, index).chars) }} 字符 · {{ number(contextItemFor(modelDetail.snapshot, index).tokenEstimate) }} Token</span></header>
                  <pre>{{ messageContent(item) }}</pre>
                  <details v-if="item.tool_calls" class="logs-inline-json"><summary>查看工具调用结构</summary><pre>{{ pretty(item.tool_calls) }}</pre></details>
                </article>
              </div>
              <p v-if="!modelDetail.snapshot?.messages?.length" class="logs-empty compact"><Icon name="message" :size="20" /><span>本次调用没有消息上下文，可能是 embedding 请求。</span></p>
            </section>
            <section v-else-if="modelDetailTab === 'tools'" class="logs-window-section"><div v-if="modelDetail.snapshot?.tools?.length" class="logs-tool-catalog"><article v-for="(tool, index) in modelDetail.snapshot.tools" :key="'snapshot-tool-' + index" class="logs-snapshot-tool"><header><span class="logs-tool-number">#{{ index + 1 }}</span><b>{{ toolName(tool) }}</b><span v-if="tool.category" class="badge">{{ categoryLabel(tool.category) }}</span><span v-if="tool.source" class="badge">{{ tool.source }}</span><span v-if="tool.risk" class="badge risk-medium">{{ tool.risk }}</span></header><p v-if="toolDescription(tool)" class="muted">{{ toolDescription(tool) }}</p><details class="logs-inline-json"><summary>查看参数 Schema</summary><pre>{{ pretty(toolParameters(tool)) }}</pre></details></article></div><p v-else class="logs-empty compact"><Icon name="wrench" :size="20" /><span>本次调用没有向模型注入工具。</span></p></section>
            <section v-else class="logs-window-section logs-request-section"><JsonBlock title="请求元数据" :value="modelDetail.snapshot?.request || {}" :open="true" /><details v-if="modelDetail.modelCall.response_text" class="logs-run-response" open><summary>模型回复（{{ number(modelDetail.modelCall.response_text.length) }} 字符）</summary><pre>{{ modelDetail.modelCall.response_text }}</pre></details><JsonBlock title="模型调用元数据" :value="modelDetail.modelCall.metadata || {}" /><p v-if="modelDetail.modelCall.error_message" class="logs-tool-error">{{ modelDetail.modelCall.error_message }}</p></section>
          </template>
          <p v-else class="logs-empty compact"><Icon name="cpu" :size="20" /><span>没有可展示的模型请求详情。</span></p>
        </div>
      </SideDrawer>

      <SideDrawer :open="conversationOpen" title="会话工作台" subtitle="先按轮次定位，再查看这一轮的模型请求、工具轮次和实际上下文" icon="message" width="1080px" modal @close="conversationOpen = false">
        <div class="logs-detail-window">
          <div v-if="conversationLoading" class="drawer-loading"><span class="spinner"></span>正在加载会话索引…</div>
          <div v-else-if="conversationError" class="slice-error-banner"><Icon name="alert" :size="17" /><p>{{ conversationError }}</p></div>
          <template v-else-if="conversationDetail?.available">
            <div class="logs-session-meta logs-session-header">
              <div><b>{{ conversationTitle(conversationDetail) }}</b><span class="muted tiny">{{ number(conversationDetail.session?.turn_count || conversationDetail.items?.length || 0) }} 轮 · {{ sourceLabel(conversationDetail.session?.source) }} / {{ purposeLabel(conversationDetail.session?.purpose) }}</span></div>
              <details class="logs-session-id"><summary>查看内部会话 ID</summary><code>{{ conversationDetail.session?.key || conversationDetail.conversationKey }}</code></details>
            </div>
            <div v-if="conversationDetail.items?.length" class="logs-session-workbench">
              <nav class="logs-session-turn-list" aria-label="会话轮次">
                <div class="logs-session-turn-head"><b>会话轮次</b><span class="muted tiny">选择一轮查看完整链路</span></div>
                <button v-for="(item, index) in conversationDetail.items" :key="item.id || index" class="logs-session-turn" :class="{ active: conversationTurnId === item.id }" type="button" @click="loadConversationTurn(item)">
                  <span><span class="logs-turn-number">第 {{ index + 1 }} 轮</span><span class="badge" :class="item.status === 'ok' ? 'on' : 'risk-medium'">{{ statusLabel(item.status) }}</span></span>
                  <b>{{ promptPreview(item.prompt_text) }}</b>
                  <small>{{ time(item.started_at) }} · {{ sourceLabel(item.source) }} / {{ purposeLabel(item.purpose) }} · {{ number(item.model_calls) }} 次模型 · {{ number(item.tool_calls) }} 次工具</small>
                </button>
              </nav>
              <section class="logs-turn-workspace">
                <div v-if="conversationTurnLoading" class="drawer-loading"><span class="spinner"></span>正在加载这一轮的完整链路…</div>
                <div v-else-if="conversationTurnError" class="slice-error-banner"><Icon name="alert" :size="17" /><p>{{ conversationTurnError }}</p></div>
                <template v-else-if="conversationTurnDetail?.run">
                  <div class="logs-turn-head"><div><b>{{ promptPreview(conversationTurnDetail.run.prompt_text) }}</b><span class="muted tiny">{{ time(conversationTurnDetail.run.started_at) }} · {{ statusLabel(conversationTurnDetail.run.status) }}</span></div><span class="muted tiny">{{ number(conversationTurnDetail.run.total_tokens) }} Token · {{ number(conversationTurnDetail.run.tool_calls) }} 次工具</span></div>
                  <div class="logs-conversation-grid">
                    <section class="logs-message-card user"><b>用户提问</b><pre>{{ conversationTurnDetail.run.prompt_text || '这轮没有保存提问正文（可能是旧日志或非对话任务）。' }}</pre></section>
                    <section class="logs-message-card assistant"><b>模型回复</b><pre>{{ conversationTurnDetail.run.response_text || '这轮没有文本回复，可能以工具或静默结果结束。' }}</pre></section>
                  </div>
                  <div v-if="conversationTurnDetail.modelCalls?.length" class="logs-round-flow">
                    <article v-for="(model, modelIndex) in conversationTurnDetail.modelCalls" :key="model.id || modelIndex" class="logs-round-card">
                      <header><div><span class="logs-turn-number">模型请求 #{{ model.sequence || modelIndex + 1 }}</span><b>{{ model.model_name || model.model_identifier || '模型请求' }}</b><span class="badge" :class="model.status === 'ok' ? 'on' : 'risk-medium'">{{ statusLabel(model.status) }}</span><span class="badge">{{ modelStopLabel(model.stop_reason) }}</span></div><div class="logs-round-card-meta"><span class="muted tiny">上下文 {{ number(modelContextCount(model)) }} 条 · 注入 {{ number(availableTools(model)) }} 个工具 · {{ number(model.total_tokens) }} Token</span><button class="btn small outline" type="button" @click="openModelDetail(model)">查看本次上下文</button></div></header>
                      <div v-if="toolGroupsForModel(model.id).length" class="logs-round-tool-groups">
                        <section v-for="group in toolGroupsForModel(model.id)" :key="'tool-round-' + model.id + '-' + group.round" class="logs-round-tool-group">
                          <header><b>工具轮次 {{ group.round || '-' }}</b><span class="muted tiny">{{ number(group.items.length) }} 次实际调用</span></header>
                          <div class="logs-round-tool-list">
                            <article v-for="tool in group.items" :key="tool.id" class="logs-round-tool">
                              <div class="logs-round-tool-head"><div><b>{{ tool.tool_name || '未命名工具' }}</b><span class="badge" :class="tool.status === 'ok' ? 'on' : 'risk-medium'">{{ statusLabel(tool.status) }}</span><span class="badge">{{ categoryLabel(tool.category || tool.source) }}</span><span v-if="tool.delivery" class="badge">{{ deliveryLabel(tool.delivery) }}</span></div><span class="muted tiny">调用 {{ tool.call_index || '-' }} · {{ duration(tool.duration_ms) }}</span></div>
                              <p class="muted tiny">返回 {{ number(tool.result_chars) }} 字符<span v-if="tool.requires_final_reply"> · 需要最终回复</span><span v-if="tool.error_message"> · 执行失败</span></p>
                              <JsonBlock v-if="tool.arguments" title="查看工具参数" :value="tool.arguments" />
                              <details v-if="tool.result_text" class="logs-tool-result"><summary>查看返回结果（{{ number(tool.result_chars || 0) }} 字符）</summary><pre>{{ tool.result_text }}</pre></details>
                              <p v-if="tool.error_message" class="logs-tool-error">{{ tool.error_message }}</p>
                            </article>
                          </div>
                        </section>
                      </div>
                      <p v-else class="logs-round-empty muted tiny">这一轮没有关联到实际工具调用；注入工具数量仍可在“查看本次上下文”中核对。</p>
                    </article>
                  </div>
                  <article v-if="unlinkedConversationTools().length" class="logs-round-card logs-round-unlinked"><header><div><b>未关联模型请求的工具事件</b><span class="badge risk-medium">需要核对</span></div><span class="muted tiny">{{ number(unlinkedConversationTools().length) }} 次</span></header><div class="logs-round-tool-list"><article v-for="tool in unlinkedConversationTools()" :key="tool.id" class="logs-round-tool"><div class="logs-round-tool-head"><b>{{ tool.tool_name || '未命名工具' }}</b><span class="badge" :class="tool.status === 'ok' ? 'on' : 'risk-medium'">{{ statusLabel(tool.status) }}</span><span class="muted tiny">第 {{ tool.round || '-' }} 轮 · {{ duration(tool.duration_ms) }}</span></div><JsonBlock v-if="tool.arguments" title="查看工具参数" :value="tool.arguments" /></article></div></article>
                </template>
                <p v-else class="logs-empty compact"><Icon name="message" :size="20" /><span>请选择左侧一轮查看完整链路。</span></p>
              </section>
            </div>
            <p v-else class="logs-empty compact"><Icon name="message" :size="20" /><span>这个会话暂时没有可用的历史轮次。</span></p>
          </template>
          <p v-else class="logs-empty compact"><Icon name="message" :size="20" /><span>当前运行没有关联会话，或会话索引已过期。</span></p>
        </div>
      </SideDrawer>
    </div>
  `,
}
