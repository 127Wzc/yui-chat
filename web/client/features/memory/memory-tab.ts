import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue"
import { confirmAction, openSystemSettings, request as rawRequest, setDirtyScope, store, toast } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage } from "../../shared/data.js"
import { splitTokens } from "../../shared/format.js"
import { MemoryCaptureDrawers } from "./memory-capture-drawers.js"
import { MemoryExtractionWorkspace } from "./memory-extraction-workspace.js"
import { MemoryManageWorkspace } from "./memory-manage-workspace.js"

const PAGE_SIZE = 20
const RAW_PAGE_SIZE = 50
const WINDOW_PAGE_SIZE = 20
const CALENDAR_SILENT_REFRESH_MS = 5000
const POLICY_OVERRIDE_FIELDS = ["retentionDays", "tokenLimit", "modelName", "promptTemplate", "maxTokens", "minConfidence", "retrievalResultLimit"] as const
type PolicyOverrideField = typeof POLICY_OVERRIDE_FIELDS[number]
type MemoryRecord = Record<string, any>

function record(value: unknown): MemoryRecord {
  return asRecord(value) as MemoryRecord
}

function records(value: unknown): MemoryRecord[] {
  return asRecords(value) as MemoryRecord[]
}

// API 层只暴露 unknown-compatible record；记忆页在这里完成一次领域边界收敛。
const request = async (path: string, options: RequestInit = {}): Promise<MemoryRecord> => rawRequest(path, options)

function timeLabel(value: unknown): string {
  if (!value) return "暂无更新时间"
  const time = new Date(typeof value === "number" ? value : String(value))
  if (Number.isNaN(time.getTime())) return "暂无更新时间"
  return time.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function dateTimeInput(value: unknown): string {
  const time = new Date(Number(value) || Date.now())
  if (Number.isNaN(time.getTime())) return ""
  const local = new Date(time.getTime() - time.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function rangeLabel(start: unknown, end: unknown): string {
  const from = new Date(Number(start) || 0)
  const to = new Date(Number(end) || 0)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "暂无范围"
  const day = (value: Date): string => value.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
  const clock = (value: Date): string => value.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
  return day(from) === day(to) ? `${day(from)} ${clock(from)}—${clock(to)}` : `${day(from)} ${clock(from)}—${day(to)} ${clock(to)}`
}

function pageUrl(base: string, params: MemoryRecord = {}): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") query.set(key, String(value))
  }
  const suffix = query.toString()
  return suffix ? `${base}?${suffix}` : base
}

function debounce(fn: (...args: any[]) => void, delay = 300): (...args: any[]) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, delay)
  }
}

function scopeLabel(target: MemoryRecord = {}): string {
  if (target.scopeType === "group") return "群公共记忆 · 仅在当前群生效"
  if (target.scopeType === "user_group") return "用户群内记忆 · 仅在当前群生效"
  return "用户全局记忆 · 所有对话可用"
}

function extractionScopeLabel(scopeType = ""): string {
  if (scopeType === "group") return "群记忆"
  if (scopeType === "user") return "个人全局记忆"
  return "个人群记忆"
}

function extractionResultLabel(result: MemoryRecord = {}): string {
  const scopeType = String(result.scopeType || "")
  const generic = extractionScopeLabel(scopeType)
  if (scopeType === "group") return generic
  const targetName = String(result.targetName || "").trim()
  const ownerId = String(result.ownerId || result.subjectId || "").trim()
  const target = targetName || (ownerId ? `QQ ${ownerId}` : "该用户")
  return `${target}${generic}`
}

function dayKeyFromDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value))
  if (Number.isNaN(date.getTime())) return ""
  const pad = (number: number): string => String(number).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDayKey(value: unknown): Date | null {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
  return Number.isNaN(date.getTime()) ? null : date
}

function shiftDayKey(value: unknown, amount = 0): string {
  const date = parseDayKey(value) || new Date()
  date.setDate(date.getDate() + Number(amount || 0))
  return dayKeyFromDate(date)
}

function localDayKey(value: unknown = Date.now()): string {
  return dayKeyFromDate(value)
}

function dayNumber(value: unknown): number | string {
  const date = parseDayKey(value)
  return date ? date.getDate() : ""
}

function monthLabel(value: unknown): string {
  const date = parseDayKey(value)
  return date ? `${date.getMonth() + 1}月` : ""
}

function calendarRangeBounds(range = "year"): { fromDay: string; toDay: string; todayDay: string } {
  const today = localDayKey()
  const days = range === "30d" ? 30 : (range === "90d" ? 90 : 365)
  return { fromDay: shiftDayKey(today, -(days - 1)), toDay: today, todayDay: today }
}

const CALENDAR_STATUS_LABELS: Record<string, string> = {
  memory: "已形成记忆",
  no_result: "已提炼无结果",
  unprocessed: "尚未提炼",
  failed: "处理失败",
  empty: "无消息",
}

function meaningfulResultCount(item: MemoryRecord = {}): number {
  if (Number.isFinite(Number(item.memoryResultCount))) return Math.max(0, Number(item.memoryResultCount))
  return Array.isArray(item.result)
    ? item.result.filter((result: MemoryRecord) => String(result?.action || "added") !== "ignored").length
    : 0
}

function calendarStatus(item: MemoryRecord = {}): MemoryRecord {
  const explicit = String(item.calendarStatus || item.status || "")
  if (["memory", "no_result", "unprocessed", "failed", "empty"].includes(explicit)) {
    return { key: explicit, label: CALENDAR_STATUS_LABELS[explicit], tone: `is-${explicit.replaceAll("_", "-")}` }
  }
  const messageCount = Number(item.messageCount ?? item.sourceMessageCount ?? 0)
  if (!messageCount) return { key: "empty", label: CALENDAR_STATUS_LABELS.empty, tone: "is-empty" }
  if (explicit === "failed") return { key: "failed", label: CALENDAR_STATUS_LABELS.failed, tone: "is-failed" }
  if (explicit === "completed") {
    const resultCount = meaningfulResultCount(item)
    return resultCount
      ? { key: "memory", label: CALENDAR_STATUS_LABELS.memory, tone: "is-memory" }
      : { key: "no_result", label: CALENDAR_STATUS_LABELS.no_result, tone: "is-no-result" }
  }
  return { key: "unprocessed", label: CALENDAR_STATUS_LABELS.unprocessed, tone: "is-unprocessed" }
}

function calendarMetricValue(item: MemoryRecord = {}, metric = "tokens"): number {
  if (metric === "messages") return Math.max(0, Number(item.messageCount ?? item.sourceMessageCount ?? 0))
  if (metric === "memories") return meaningfulResultCount(item)
  return Math.max(0, Number(item.estimatedInputTokens || 0))
}

export const MemoryTab = {
  name: "MemoryTab",
  setup() {
    const activeWorkspace = ref("manage")
    const extractionPane = ref("timeline")
    const busy = ref(false)
    const captureBusy = ref(false)
    const captureAction = ref("")
    const showGroupPicker = ref(false)
    const groupPickerQuery = ref("")
    const selectedGroupId = ref("")
    const groupWorkspace = ref<MemoryRecord | null>(null)
    const groupMemoryQuery = ref("")
    const groupMemoryPage = ref(1)
    const duplicatePlan = ref<MemoryRecord | null>(null)
    const duplicatePlanBusy = ref(false)
    const memberQuery = ref("")
    const selectedMember = ref<MemoryRecord | null>(null)
    const memberWorkspace = ref<MemoryRecord | null>(null)
    const memberScope = ref("user_group")
    const memberMemoryQuery = ref("")
    const memberMemoryPage = ref(1)
    const showMemoryDrawer = ref(false)
    const showProfileDrawer = ref(false)
    const showCaptureSettings = ref(false)
    const showReextractDialog = ref(false)
    const selectedCapture = ref<MemoryRecord | null>(null)
    const captureMessages = ref<MemoryRecord>({ items: [], total: 0, page: 1, pageSize: RAW_PAGE_SIZE })
    const captureWindows = ref<MemoryRecord[]>([])
    const captureWindowPage = ref<MemoryRecord>({ total: 0, page: 1, pageSize: WINDOW_PAGE_SIZE })
    const windowDetails = reactive<MemoryRecord>({})
    const windowDetailLoading = reactive<MemoryRecord>({})
    const windowDetailRequests: Record<string, Promise<MemoryRecord | null> | undefined> = {}
    const captureMessageQuery = ref("")
    const captureMessagePage = ref(1)
    const captureMessagePageJump = ref(1)
    const captureMessageOrder = ref("desc")
    const selectedTimelineWindow = ref<MemoryRecord | null>(null)
    const timelineWindowDetail = ref<MemoryRecord | null>(null)
    const timelineDetailLoading = ref(false)
    const timelineDetailError = ref("")
    const reextractStart = ref("")
    const reextractEnd = ref("")
    const reextractPlan = ref<MemoryRecord | null>(null)
    const reextractBusy = ref(false)
    const calendarDays = ref<MemoryRecord[]>([])
    const calendarMeta = ref<MemoryRecord>({ fromDay: "", toDay: "", todayDay: localDayKey(), timeZone: "" })
    const calendarRange = ref("year")
    const calendarMetric = ref("tokens")
    const calendarBusy = ref(false)
    const calendarWeeksElement = ref<HTMLElement | null>(null)
    const windowSelectionMode = ref(false)
    const selectedWindows = ref<Record<string, MemoryRecord>>({})
    // 每个字段可继承系统默认，也可以变成单群覆盖。新群的初始值始终取当前系统默认。
    const captureDraft = reactive<MemoryRecord>({
      scopeId: "", enabled: true,
      useDefault: { retentionDays: true, tokenLimit: true, modelName: true, promptTemplate: true, maxTokens: true, minConfidence: true, retrievalResultLimit: true },
      retentionDays: 30, tokenLimit: 30000, modelName: "", promptTemplate: "", maxTokens: 4096, minConfidence: 0.7, retrievalResultLimit: 3,
    })
    // 从既有配置进入为编辑模式，锁定群号；新增模式下命中已有群号时阻止保存以免覆盖。
    const captureDraftEditing = ref(false)
    const historyBackfillLimit = ref(100)
    // 可选补录起点：填消息 ID 则从该消息向前拉取；配合“继续向前补录”实现大批量递进补录。
    const historyBackfillFrom = ref("")
    const draft = reactive<MemoryRecord>({
      scopeType: "group", ownerId: "", groupId: "", memoryId: "", memoryText: "", memoryTags: "",
      profileName: "", profilePronouns: "", profileInterests: "", profilePreferences: "", profileDislikes: "", profileStyle: "", profileNotes: "",
    })

    const capture = computed<MemoryRecord>(() => record(store.memory).capture || { policies: [], windows: {} })
    const capturePolicies = computed<MemoryRecord[]>(() => records(capture.value.policies))
    const captureDefaults = computed<MemoryRecord>(() => {
      const memoryConfig = record(record(store.config).memory)
      const groupCapture = record(memoryConfig.groupCapture)
      const consolidation = record(groupCapture.consolidation)
      const retrieval = record(memoryConfig.retrieval)
      return capture.value.defaultPolicy || {
        retentionDays: Number(groupCapture.defaultRetentionDays) || 30,
        tokenLimit: Number(groupCapture.defaultTokenLimit) || 30000,
        promptTemplate: String(groupCapture.promptTemplate || "").trim() || capture.value.defaultPromptTemplate || "",
        modelName: String(consolidation.modelName || ""),
        maxTokens: Number(consolidation.maxTokens) || 4096,
        minConfidence: Number(consolidation.minConfidence ?? 0.7),
        retrievalResultLimit: Number(retrieval.resultLimit) || 3,
      }
    })
    const backfillLimitMax = computed(() => Number(capture.value.historyBackfillMaxMessages || 500))
    const defaultReplyModelName = computed(() => String(record(store.config).modelTasks?.replyer?.modelList?.[0] || records(record(store.config).models).find((model: MemoryRecord) => model.capabilities?.chat !== false)?.name || "").trim())
    const extractionModelOptions = computed(() => [
      { value: "", label: defaultReplyModelName.value ? `跟随默认对话模型 · ${defaultReplyModelName.value}` : "跟随默认对话模型" },
      ...records(record(store.config).models)
        .filter((model: MemoryRecord) => model.name && model.capabilities?.chat !== false)
        .map((model: MemoryRecord) => ({ value: model.name, label: model.modelIdentifier && model.modelIdentifier !== model.name ? `${model.name} · ${model.modelIdentifier}` : model.name })),
    ])
    const selectedPolicy = computed(() => capturePolicies.value.find(policy => policy.scopeId === selectedGroupId.value) || null)
    const captureDraftPolicy = computed(() => capturePolicies.value.find(policy => policy.scopeId === captureDraft.scopeId.trim()) || null)
    const captureDraftDirty = computed(() => {
      const policy = captureDraftPolicy.value
      if (!policy) return true
      if (Boolean(policy.enabled) !== Boolean(captureDraft.enabled)) return true
      return POLICY_OVERRIDE_FIELDS.some(field => {
        const overridden = captureDraft.useDefault[field] !== true
        if (Boolean(policy.overrides?.[field]) !== overridden) return true
        if (!overridden) return false
        return String(policy[field] ?? "") !== String(captureDraft[field] ?? "")
      })
    })
    const filteredPolicies = computed(() => {
      const needle = groupPickerQuery.value.trim().toLowerCase()
      if (!needle) return capturePolicies.value
      return capturePolicies.value.filter(policy => policy.scopeId.toLowerCase().includes(needle))
    })
    const groupMemory = computed(() => groupWorkspace.value?.groupMemory || { items: [], total: 0, page: 1, pageSize: PAGE_SIZE })
    const members = computed(() => groupWorkspace.value?.members || [])
    const currentMemberMemory = computed(() => {
      if (!memberWorkspace.value) return { items: [], total: 0, page: 1, pageSize: PAGE_SIZE }
      return memberScope.value === "user" ? memberWorkspace.value.globalMemory : memberWorkspace.value.groupMemory
    })
    const selectedMemberName = computed(() => memberWorkspace.value?.profile?.name || selectedMember.value?.name || selectedMember.value?.userId || "成员")
    const timelineWindows = computed(() => calendarDays.value.length ? calendarDays.value : (reextractPlan.value?.windows || []))
    const calendarWeeks = computed(() => {
      const source = calendarDays.value
      if (!source.length) return []
      const map = new Map(source.map(item => [String(item.day || localDayKey(item.windowStart)), item]))
      const firstItem = source[0] || {}
      const lastItem = source.at(-1) || {}
      const firstDay = String(calendarMeta.value.fromDay || firstItem.day || localDayKey(firstItem.windowStart))
      const lastDay = String(calendarMeta.value.toDay || lastItem.day || localDayKey(lastItem.windowStart))
      const first = parseDayKey(firstDay)
      const last = parseDayKey(lastDay)
      if (!first || !last) return []
      first.setDate(first.getDate() - first.getDay())
      last.setDate(last.getDate() + (6 - last.getDay()))
      const weeks = []
      for (let cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 7)) {
        const start = dayKeyFromDate(cursor)
        const days = Array.from({ length: 7 }, (_, index) => {
          const day = shiftDayKey(start, index)
          return map.get(day) || {
            day,
            outOfRange: true,
            windowStart: parseDayKey(day)?.getTime() || 0,
            windowEnd: parseDayKey(shiftDayKey(day, 1))?.getTime() || 0,
            status: "empty",
            calendarStatus: "empty",
            messageCount: 0,
            estimatedInputTokens: 0,
            modelCallCount: 0,
            memoryResultCount: 0,
            ignoredResultCount: 0,
            rawAvailable: false,
            canReextract: false,
          }
        })
        const monthDay = days.find(item => dayNumber(item.day) === 1)
        weeks.push({ start, days, label: monthDay ? monthLabel(monthDay.day) : (weeks.length ? "" : monthLabel(days[0].day)) })
      }
      return weeks
    })
    const calendarMetricLabel = computed(() => ({ messages: "消息", tokens: "Token", memories: "记忆" })[calendarMetric.value] || "Token")
    const calendarMaxMetric = computed(() => Math.max(1, ...calendarDays.value.map(item => calendarMetricValue(item, calendarMetric.value))))
    const calendarSummary = computed(() => calendarDays.value.reduce((summary, item) => {
      const status = calendarStatus(item).key
      return {
        ...summary,
        days: summary.days + (Number(item.messageCount || item.sourceMessageCount || 0) > 0 ? 1 : 0),
        messages: summary.messages + Number(item.messageCount || item.sourceMessageCount || 0),
        memories: summary.memories + meaningfulResultCount(item),
        [status]: Number(summary[status] || 0) + 1,
      }
    }, { days: 0, messages: 0, memories: 0, memory: 0, no_result: 0, unprocessed: 0, failed: 0, empty: 0 }))
    const selectedWindowStarts = computed(() => Object.keys(selectedWindows.value).map(Number).filter(Number.isFinite))
    const selectedWindowItems = computed(() => Object.values(selectedWindows.value))
    const selectedWindowSummary = computed(() => selectedWindowItems.value.reduce((summary, item) => ({
      messages: summary.messages + Number(item.sourceMessageCount || item.messageCount || 0),
      tokens: summary.tokens + Number(item.estimatedInputTokens || 0),
      calls: summary.calls + Number(item.modelCallCount || item.chunkCount || 0),
    }), { messages: 0, tokens: 0, calls: 0 }))
    const captureMessagePageCount = computed(() => Math.max(1, Math.ceil(Number(captureMessages.value.total || 0) / Number(captureMessages.value.pageSize || RAW_PAGE_SIZE))))
    const selectedWindowMessages = computed(() => timelineWindowDetail.value?.messages || [])
    const extractionCounts = computed(() => ({
      messages: Number(selectedPolicy.value?.messageCount || 0),
      windows: Number(captureWindowPage.value.total || 0),
      pending: Number(selectedPolicy.value?.windowProgress?.pending || 0) + Number(selectedPolicy.value?.windowProgress?.running || 0),
    }))
    const runRecordWindows = computed(() => captureWindows.value)
    let capturePollTimer: ReturnType<typeof setInterval> | null = null
    let calendarRevealTimer: ReturnType<typeof setTimeout> | null = null
    let calendarPinnedToLatest = true
    let calendarScrollLeft = 0
    let calendarLoadedAt = 0
    // 轮询代次：进行中的 poll 结束后据此判断是否已被停止，避免卸载后复活。
    let capturePollEpoch = 0
    // 各数据面的请求序号：只应用最新一次请求的响应，防止乱序响应覆盖新状态。
    const loadSeq: Record<string, number> = { group: 0, member: 0, captureMessages: 0, preview: 0, calendar: 0, timelineDetail: 0 }

    function policyTitle(policy: MemoryRecord): string {
      return `群 ${policy.scopeId}`
    }

    function promptSummary(value: unknown = ""): string {
      const prompt = String(value || "").trim()
      if (!prompt || prompt === capture.value.defaultPromptTemplate) return "内置默认提示词"
      return `自定义提示词（${prompt.length} 字）`
    }

    function captureDefaultLabel(field: PolicyOverrideField): string {
      const defaults = captureDefaults.value
      if (field === "retentionDays") return defaults.retentionDays ? `${defaults.retentionDays} 天` : "永久保留"
      if (field === "tokenLimit") return `${compactNumber(defaults.tokenLimit)} Token`
      if (field === "modelName") return defaults.modelName || (defaultReplyModelName.value ? `默认对话模型 · ${defaultReplyModelName.value}` : "默认对话模型")
      if (field === "promptTemplate") return promptSummary(defaults.promptTemplate)
      if (field === "maxTokens") return `${compactNumber(defaults.maxTokens)} Token`
      if (field === "minConfidence") return String(defaults.minConfidence)
      if (field === "retrievalResultLimit") return `${defaults.retrievalResultLimit} 条`
      return ""
    }

    function captureFieldHint(field: PolicyOverrideField): string {
      const label = captureDefaultLabel(field)
      const suffix = field === "tokenLimit" ? "；范围 3,000–60,000，仅估算群聊消息 Token，不含记忆提炼系统提示词" : ""
      return (captureDraft.useDefault[field]
        ? `跟随系统默认：${label}。直接编辑会自动变为本群自定义。`
        : `当前为本群自定义；系统默认：${label}`) + suffix
    }

    function captureFieldSource(field: PolicyOverrideField): string {
      const label = captureDefaultLabel(field)
      return captureDraft.useDefault[field] ? `跟随系统默认 · ${label}` : `本群自定义 · 系统为 ${label}`
    }

    function policyOverrideSummary(policy: MemoryRecord = {}): string {
      const count = POLICY_OVERRIDE_FIELDS.filter(field => policy.overrides?.[field]).length
      return count ? `单群覆盖 ${count} 项` : "继承系统默认"
    }

    function resetCaptureDraft(policy: MemoryRecord | null = null): void {
      const defaults = captureDefaults.value
      captureDraft.scopeId = policy?.scopeId || ""
      captureDraft.enabled = policy ? Boolean(policy.enabled) : true
      for (const field of POLICY_OVERRIDE_FIELDS) {
        captureDraft.useDefault[field] = !policy?.overrides?.[field]
        // 提示词覆盖回显原始覆盖文本而不是解析后的完整提示词，避免保存时把内置默认词物化成本群快照。
        if (field === "promptTemplate" && policy?.overrides?.promptTemplate) captureDraft[field] = policy.promptTemplateOverride ?? ""
        else captureDraft[field] = policy?.[field] ?? defaults[field]
      }
    }

    function updateCaptureField(field: PolicyOverrideField, value: unknown): void {
      // 不让用户先操作“继承”开关：第一次直接编辑就是明确的单群覆盖。
      if (captureDraft.useDefault[field]) captureDraft.useDefault[field] = false
      captureDraft[field] = value
    }

    function resetCaptureField(field: PolicyOverrideField): void {
      captureDraft.useDefault[field] = true
      captureDraft[field] = captureDefaults.value[field]
    }

    function memberTitle(member: MemoryRecord): string {
      return member?.name ? `${member.name} · QQ ${member.userId}` : `QQ ${member?.userId || ""}`
    }

    function applyWindowPage(value: MemoryRecord | MemoryRecord[]): void {
      const page = Array.isArray(value)
        ? { items: value, total: value.length, page: 1, pageSize: Math.max(value.length, WINDOW_PAGE_SIZE) }
        : (value || { items: [], total: 0, page: 1, pageSize: WINDOW_PAGE_SIZE })
      captureWindows.value = page.items || []
      captureWindowPage.value = {
        total: Number(page.total || 0),
        page: Number(page.page || 1),
        pageSize: Number(page.pageSize || WINDOW_PAGE_SIZE),
      }
    }

    function applyMessagePage(value: MemoryRecord | undefined): void {
      const page = value || { items: [], total: 0, page: 1, pageSize: RAW_PAGE_SIZE, order: captureMessageOrder.value }
      captureMessages.value = {
        items: Array.isArray(page.items) ? page.items : [],
        total: Number(page.total || 0),
        page: Number(page.page || 1),
        pageSize: Number(page.pageSize || RAW_PAGE_SIZE),
        order: page.order === "asc" ? "asc" : "desc",
      }
      captureMessagePage.value = captureMessages.value.page
      captureMessagePageJump.value = captureMessages.value.page
      captureMessageOrder.value = captureMessages.value.order
    }

    function applyCaptureSummary(next: MemoryRecord, { light = false }: { light?: boolean } = {}): void {
      if (!light) {
        store.memory = { ...store.memory, capture: next }
        return
      }
      const previous = capture.value
      const previousPolicies = new Map(records(previous.policies).map((policy: MemoryRecord) => [policy.scopeId, policy]))
      const policies = records(next.policies).map((policy: MemoryRecord) => ({ ...(previousPolicies.get(policy.scopeId) || {}), ...policy }))
      store.memory = { ...store.memory, capture: { ...previous, ...next, policies } }
    }

    async function refreshCapture(options: { light?: boolean } = {}): Promise<MemoryRecord> {
      const light = options.light === true
      const result = await request(light ? "/api/memory/captures?light=1" : "/api/memory/captures")
      applyCaptureSummary(result.capture, { light })
      return result.capture
    }

    function revealLatestCalendarDays() {
      if (calendarRevealTimer) clearTimeout(calendarRevealTimer)
      calendarRevealTimer = setTimeout(async () => {
        calendarRevealTimer = null
        await nextTick()
        const element = calendarWeeksElement.value
        if (element) {
          calendarPinnedToLatest = true
          calendarScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
          element.scrollLeft = calendarScrollLeft
        }
      }, 0)
    }

    function restoreCalendarViewport() {
      if (calendarRevealTimer) clearTimeout(calendarRevealTimer)
      calendarRevealTimer = setTimeout(async () => {
        calendarRevealTimer = null
        await nextTick()
        const element = calendarWeeksElement.value
        if (!element) return
        const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
        const target = calendarPinnedToLatest ? maxScrollLeft : Math.min(Math.max(0, calendarScrollLeft), maxScrollLeft)
        element.scrollLeft = target
        calendarScrollLeft = element.scrollLeft
      }, 0)
    }

    function handleCalendarScroll(event: Event): void {
      const element = event.currentTarget as HTMLElement | null
      if (!element) return
      calendarScrollLeft = Math.max(0, element.scrollLeft)
      calendarPinnedToLatest = element.scrollWidth - element.clientWidth - element.scrollLeft <= 4
    }

    function handleCalendarViewportResize() {
      if (calendarPinnedToLatest) revealLatestCalendarDays()
    }

    async function loadCalendar(options: { revealLatest?: boolean; silent?: boolean; force?: boolean } = {}): Promise<MemoryRecord | null> {
      const policy = selectedPolicy.value
      if (!policy) {
        calendarDays.value = []
        return null
      }
      const revealLatest = options.revealLatest === true || !calendarDays.value.length || options.silent !== true
      if (options.silent && !options.force && calendarDays.value.length && Date.now() - calendarLoadedAt < CALENDAR_SILENT_REFRESH_MS) return null
      const scopeId = policy.scopeId
      const seq = ++loadSeq.calendar
      const bounds = calendarRangeBounds(calendarRange.value)
      if (!options.silent) calendarBusy.value = true
      try {
        const result = await request(pageUrl(`/api/memory/captures/group/${encodeURIComponent(scopeId)}/calendar`, {
          days: calendarRange.value === "30d" ? 30 : (calendarRange.value === "90d" ? 90 : 365),
        }))
        if (seq !== loadSeq.calendar || selectedPolicy.value?.scopeId !== scopeId) return null
        const calendar = result.calendar || result
        const items = calendar.items || calendar.days || []
        calendarMeta.value = {
          fromDay: calendar.fromDay || bounds.fromDay,
          toDay: calendar.toDay || bounds.toDay,
          todayDay: calendar.todayDay || bounds.todayDay,
          timeZone: calendar.timeZone || "",
        }
        calendarDays.value = items.map(normalizeCalendarItem)
        const selectedDay = selectedTimelineWindow.value?.day || localDayKey(selectedTimelineWindow.value?.windowStart)
        if (selectedDay) {
          const replacement = calendarDays.value.find(item => item.day === selectedDay)
          if (replacement) {
            const previous = selectedTimelineWindow.value || {}
            const detailWindow = timelineWindowDetail.value?.window || null
            const previousId = String(previous.windowId || previous.id || detailWindow?.id || "")
            const replacementId = String(replacement.windowId || replacement.id || "")
            const previousTaskStatus = String(detailWindow?.status || previous.windowStatus || previous.status || "")
            const replacementTaskStatus = String(replacement.windowStatus || replacement.status || "")
            const sameWindow = previousId === replacementId
            const detailStale = !sameWindow || (
              (previousTaskStatus && replacementTaskStatus && previousTaskStatus !== replacementTaskStatus)
              || Number(previous.messageCount || previous.sourceMessageCount || 0) !== Number(replacement.messageCount || replacement.sourceMessageCount || 0)
              || Number(previous.memoryResultCount || 0) !== Number(replacement.memoryResultCount || 0)
              || Number(previous.ignoredResultCount || 0) !== Number(replacement.ignoredResultCount || 0)
              || Number(previous.updatedAt || detailWindow?.updatedAt || 0) !== Number(replacement.updatedAt || 0)
              || Boolean(previous.needsReextract) !== Boolean(replacement.needsReextract)
            )
            selectedTimelineWindow.value = { ...previous, ...replacement }
            if (!detailStale && detailWindow?.result) selectedTimelineWindow.value.result = detailWindow.result
            else if (!detailStale && Array.isArray(previous.result)) selectedTimelineWindow.value.result = previous.result
            if (detailStale) {
              if (previousId) delete windowDetails[windowDetailKey(scopeId, previousId)]
              if (replacementId) delete windowDetails[windowDetailKey(scopeId, replacementId)]
              timelineWindowDetail.value = null
              selectTimelineWindow(replacement).catch(() => {})
            }
          }
          else {
            selectedTimelineWindow.value = null
            timelineWindowDetail.value = null
          }
        }
        calendarLoadedAt = Date.now()
        if (revealLatest) revealLatestCalendarDays()
        return calendar
      } catch (err) {
        if (!options.silent && seq === loadSeq.calendar) toast(errorMessage(err))
        throw err
      } finally {
        if (!options.silent && seq === loadSeq.calendar) calendarBusy.value = false
      }
    }

    function stopCapturePolling() {
      capturePollEpoch += 1
      if (capturePollTimer) clearTimeout(capturePollTimer)
      capturePollTimer = null
    }

    function startCapturePolling(attempts = 40): void {
      stopCapturePolling()
      const epoch = capturePollEpoch
      const poll = async (remaining: number): Promise<void> => {
        if (epoch !== capturePollEpoch) return
        try { await refreshCapture({ light: true }) } catch { /* 请求动作本身会展示错误；轮询失败无需额外打断抽屉。 */ }
        if (epoch !== capturePollEpoch) return
        const policy = captureDraftPolicy.value || selectedPolicy.value
        const progress = policy?.windowProgress || {}
        const active = policy?.backfill?.status === "running" || Number(progress.pending || 0) > 0 || Number(progress.running || 0) > 0
        if (activeWorkspace.value === "extract" && selectedPolicy.value) {
          try {
            const scope = `group/${encodeURIComponent(selectedPolicy.value.scopeId)}`
            const result = await request(pageUrl(`/api/memory/captures/${scope}/windows`, {
              page: captureWindowPage.value.page,
              pageSize: captureWindowPage.value.pageSize,
            }))
            if (epoch !== capturePollEpoch) return
            applyWindowPage(result.windows)
            await loadCalendar({ silent: true })
          } catch { /* 页面仍可手动刷新；轮询失败不打断当前操作。 */ }
        }
        if (epoch !== capturePollEpoch) return
        if (active && remaining > 0) capturePollTimer = setTimeout(() => poll(remaining - 1), 1500)
        else capturePollTimer = null
      }
      capturePollTimer = setTimeout(() => poll(attempts), 500)
    }

    function backfillStatusLabel(status = "") {
      return ({ running: "补录中", completed: "最近补录完成", failed: "补录失败" })[status] || "尚未补录"
    }

    function windowStatusLabel(status = "") {
      return ({ unprocessed: "尚未提炼", empty: "无消息", pending: "等待处理", running: "正在提炼", completed: "已完成", failed: "提炼失败" })[status] || status || "未知"
    }

    function normalizeCalendarItem(item: MemoryRecord = {}): MemoryRecord {
      const day = String(item.day || localDayKey(item.windowStart))
      const parsed = parseDayKey(day)
      const windowStart = Number(item.windowStart || item.window_start || parsed?.getTime() || 0)
      const windowEnd = Number(item.windowEnd || item.window_end || parseDayKey(shiftDayKey(day, 1))?.getTime() || 0)
      const result = Array.isArray(item.result) ? item.result : []
      const status = item.status || item.calendarStatus || ""
      return {
        ...item,
        day,
        id: item.id || item.windowId || item.window_id || "",
        windowId: item.windowId || item.id || item.window_id || "",
        windowStart,
        windowEnd,
        messageCount: Number(item.messageCount ?? item.sourceMessageCount ?? 0),
        sourceMessageCount: Number(item.sourceMessageCount ?? item.messageCount ?? 0),
        estimatedInputTokens: Number(item.estimatedInputTokens || 0),
        modelCallCount: Number(item.modelCallCount || item.chunkCount || 0),
        memoryResultCount: Number.isFinite(Number(item.memoryResultCount)) ? Number(item.memoryResultCount) : result.filter(row => row?.action !== "ignored").length,
        ignoredResultCount: Number(item.ignoredResultCount || result.filter(row => row?.action === "ignored").length),
        updatedAt: Number(item.updatedAt || item.updated_at || 0),
        truncated: Boolean(item.truncated),
        omittedItemCount: Number(item.omittedItemCount || 0),
        result,
        status,
        calendarStatus: item.calendarStatus || (CALENDAR_STATUS_LABELS[status] ? status : undefined),
      }
    }

    function calendarLevel(item: MemoryRecord = {}): number {
      const value = calendarMetricValue(item, calendarMetric.value)
      if (!value) return 0
      const ratio = value / Math.max(1, calendarMaxMetric.value)
      if (ratio <= 0.15) return 1
      if (ratio <= 0.35) return 2
      if (ratio <= 0.65) return 3
      return 4
    }

    function calendarDayClass(item: MemoryRecord = {}): (string | Record<string, boolean>)[] {
      const status = calendarStatus(item)
      const windowStatus = String(item.windowStatus || item.status || "")
      return [
        "calendar-day",
        status.tone,
        `level-${calendarLevel(item)}`,
        { "is-processing": ["pending", "running"].includes(windowStatus), "is-needs-reextract": Boolean(item.needsReextract), "is-today": item.day === calendarMeta.value.todayDay, "is-selected": isWindowSelected(item) },
      ]
    }

    function calendarDayTitle(item: MemoryRecord = {}): string {
      const status = calendarStatus(item)
      const messageCount = Number(item.messageCount || item.sourceMessageCount || 0)
      const tokens = compactNumber(item.estimatedInputTokens)
      const memoryCount = meaningfulResultCount(item)
      const suffix = item.needsReextract ? " · 有新补录，需重提炼" : ""
      const raw = item.rawAvailable === false && item.windowId ? " · 原始消息已过期，仅可查看结果" : ""
      return `${item.day || "未知日期"} · ${status.label} · ${messageCount} 条消息 · ${tokens} Token · ${memoryCount} 条记忆${suffix}${raw}`
    }

    function calendarDayAriaLabel(item: MemoryRecord = {}): string {
      const status = calendarStatus(item)
      const windowStatus = String(item.windowStatus || "")
      const processing = windowStatus === "pending" ? "，正在等待处理" : windowStatus === "running" ? "，正在提炼" : ""
      const needs = item.needsReextract ? "，有新消息待重提炼" : ""
      const expired = item.rawAvailable === false && item.windowId ? "，原始消息已过期" : ""
      return `${item.day || "未知日期"}，${status.label}，${Number(item.messageCount || item.sourceMessageCount || 0)} 条消息，${compactNumber(item.estimatedInputTokens)} Token，${meaningfulResultCount(item)} 条记忆${processing}${needs}${expired}`
    }

    function timelineStatus(item: MemoryRecord = {}): MemoryRecord {
      return calendarStatus(item)
    }

    function segmentSummary(item: MemoryRecord = {}): string[] {
      const labels: Record<string, string> = { text: "文本", at: "@", reply: "回复", image: "图片", face: "表情", record: "语音", video: "视频", file: "文件", unknown: "未知" }
      const counts: Record<string, number> = item.segmentCounts || records(item.segments).reduce<Record<string, number>>((all, segment: MemoryRecord) => ({ ...all, [segment.type || "unknown"]: Number(all[segment.type || "unknown"] || 0) + 1 }), {})
      return Object.entries(counts).filter(([, count]) => count).map(([type, count]) => `${labels[type] || type} ${count}`)
    }

    function normalizationView(item: MemoryRecord = {}): MemoryRecord {
      const status = item.normalization?.status || "normalized"
      return { label: item.normalization?.label || "已规范", tone: status === "warning" ? "risk-medium" : (status === "non_text" ? "muted" : "on") }
    }

    function compactNumber(value: unknown = 0): string {
      const number = Math.max(0, Number(value) || 0)
      return number >= 10000 ? `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)} 万` : number.toLocaleString("zh-CN")
    }

    function windowWorkload(item: MemoryRecord = {}): MemoryRecord {
      const messages = Number(item.sourceMessageCount || 0)
      const chars = Number(item.sourceTextChars || 0)
      const members = Number(item.sourceMemberCount || 0)
      const calls = Number(item.modelCallCount || item.chunkCount || 0)
      return { messages, chars, members, calls, tokens: Number(item.estimatedInputTokens || 0), callLabel: item.modelCallCount ? "实际模型调用" : "预计子窗口" }
    }

    function memoryLifecycle(item: MemoryRecord = {}): MemoryRecord {
      const status = item?.lifecycle?.status || item.status || "active"
      const detail = item?.lifecycle || item
      const label = ({
        active: "生效中",
        warm: "待巩固",
        cold: "低活跃",
        expired: "已过期",
        archived: item.source === "superseded" ? "已被修正" : "已归档",
        deleted: "已删除",
      } as Record<string, string>)[status] || "生效中"
      const confirmed = detail.lastConfirmedAt || item.lastSeenAt
      const expires = detail.expiresAt || item.expiresAt
      const notes = ["生命周期：" + label]
      if (confirmed) notes.push("最近确认 " + timeLabel(confirmed))
      if (expires) notes.push("有效至 " + timeLabel(expires))
      else if (["active", "warm", "cold"].includes(status)) notes.push("无固定到期时间")
      return { label, tone: `is-${status}`, title: notes.join(" · ") }
    }

    function resultAction(result: MemoryRecord = {}): MemoryRecord {
      const action = String(result.action || "added")
      return ({
        added: { label: "新增", tone: "on" },
        updated: { label: "已修改", tone: "risk-medium" },
        reinforced: { label: "已强化", tone: "accent" },
        retracted: { label: "已撤回", tone: "risk-medium" },
        ignored: { label: "已忽略", tone: "muted" },
      })[action] || { label: "已处理", tone: "muted" }
    }

    function taskResultSummary(results: MemoryRecord[] = [], fallback = 0): string {
      if (!Array.isArray(results) || !results.length) return `覆盖 ${fallback} 条可分析消息`
      const counts = results.reduce((all, item) => ({ ...all, [item.action || "added"]: Number(all[item.action || "added"] || 0) + 1 }), {})
      const labels = [["added", "新增"], ["updated", "修改"], ["reinforced", "强化"], ["ignored", "忽略"]]
        .filter(([key]) => counts[key])
        .map(([key, label]) => `${label} ${counts[key]}`)
      const merged = results.reduce((sum, item) => sum + Number(item.duplicateCount || 0), 0)
      if (merged) labels.push(`合并重复 ${merged}`)
      return labels.join(" · ") || `覆盖 ${fallback} 条可分析消息`
    }

    function runningWindowProgress(item: MemoryRecord = {}): string {
      const attempt = Math.max(1, Number(item.attemptCount || 1))
      const total = Math.max(Number(item.processingChunkTotal || 0), Number(item.chunkCount || 0))
      const current = Math.max(1, Math.min(total || 1, Number(item.processingChunk || 1)))
      return total
        ? `正在提炼 · 第 ${attempt} 次尝试 · 当前 Token 子窗口 ${current} / ${total}`
        : `正在提炼 · 第 ${attempt} 次尝试 · 正在准备消息`
    }

    function taskListSummary(item: MemoryRecord = {}): string {
      if (item.status === "running") return runningWindowProgress(item)
      if (item.errorMessage) return item.errorMessage
      if (item.needsReextract) return "有新补录消息，待确认重提炼"
      return taskResultSummary(item.result, item.sourceMessageCount)
    }

    function windowStartValue(item: MemoryRecord = {}): number {
      const value = Number(item.windowStart || 0) || Number(parseDayKey(item.day)?.getTime() || 0)
      return Number.isFinite(value) && value > 0 ? value : 0
    }

    function isWindowSelectable(item: MemoryRecord = {}): boolean {
      if (!windowStartValue(item) || !Number(item.sourceMessageCount || item.messageCount || 0)) return false
      if (item.canReextract === false || item.rawAvailable === false) return false
      return !["pending", "running"].includes(String(item.windowStatus || item.status || ""))
    }

    function isWindowSelected(item: MemoryRecord = {}): boolean {
      return Boolean(selectedWindows.value[String(windowStartValue(item))])
    }

    function clearWindowSelection() {
      selectedWindows.value = {}
    }

    function toggleWindowSelectionMode() {
      windowSelectionMode.value = !windowSelectionMode.value
      if (!windowSelectionMode.value) clearWindowSelection()
    }

    function toggleWindowSelection(item: MemoryRecord = {}): void {
      const start = windowStartValue(item)
      if (!start || !Number(item.sourceMessageCount || item.messageCount || 0)) return toast("这个窗口没有可提炼的原始消息")
      if (item.rawAvailable === false) return toast("这一天的原始消息已过期，不能重新提炼")
      if (item.canReextract === false && item.windowEnd > Date.now()) return toast("今天的消息窗尚未关闭，暂不能重新提炼")
      if (item.canReextract === false && !selectedPolicy.value?.enabled) return toast("请先开启这个群的消息采集")
      if (["pending", "running"].includes(String(item.windowStatus || item.status || ""))) return toast("这个窗口已经在等待或提炼中")
      const key = String(start)
      const next = { ...selectedWindows.value }
      if (next[key]) delete next[key]
      else {
        if (Object.keys(next).length >= 100) return toast("一次最多选择 100 个窗口")
        next[key] = item
      }
      selectedWindows.value = next
    }

    function openRunWindow(item: MemoryRecord = {}): unknown {
      if (windowSelectionMode.value) return toggleWindowSelection(item)
      extractionPane.value = "timeline"
      return selectTimelineWindow(item)
    }

    function extractionWindowAction(item: MemoryRecord = {}): string {
      if (item.status === "failed") return "失败重试"
      if (item.status === "pending") return "立即执行"
      if (item.status === "completed" && item.needsReextract) return "重提炼"
      return ""
    }

    async function runExtractionWindow(item: MemoryRecord = {}): Promise<void> {
      const policy = selectedPolicy.value
      const action = extractionWindowAction(item)
      if (!policy?.enabled) return toast("请先开启这个群的消息采集")
      if (!action || !item.id) return
      const retry = item.status === "failed" || (item.status === "completed" && Boolean(item.needsReextract))
      captureAction.value = retry ? "retry-window" : "run-window"
      try {
        const response = await request(`/api/memory/captures/group/${encodeURIComponent(policy.scopeId)}/windows/${encodeURIComponent(item.id)}/run`, {
          method: "POST",
          body: JSON.stringify({ retry }),
        })
        applyCaptureSummary(response.capture)
        await changeCaptureWindowPage(captureWindowPage.value.page)
        await loadCalendar({ silent: true, force: true })
        startCapturePolling()
        toast(retry ? "已提交重试，正在后台处理" : "已开始执行，正在后台处理", "success")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        captureAction.value = ""
      }
    }

    function selectVisibleWindows(mode = "all"): void {
      const source = extractionPane.value === "tasks" ? runRecordWindows.value : timelineWindows.value
      const candidates = source.filter((item: MemoryRecord) => {
        if (!isWindowSelectable(item)) return false
        if (mode === "failed") return item.status === "failed"
        if (mode === "needs") return Boolean(item.needsReextract)
        if (mode === "unprocessed") return calendarStatus(item).key === "unprocessed"
        return true
      })
      if (!candidates.length) return toast(mode === "failed" ? "当前视图没有失败窗口" : mode === "needs" ? "当前视图没有需重提炼窗口" : mode === "unprocessed" ? "当前视图没有尚未提炼的窗口" : "当前视图没有可选窗口")
      const next = { ...selectedWindows.value }
      let limited = false
      for (const item of candidates) {
        const key = String(windowStartValue(item))
        if (next[key]) continue
        if (Object.keys(next).length >= 100) {
          limited = true
          break
        }
        next[key] = item
      }
      selectedWindows.value = next
      windowSelectionMode.value = true
      if (limited) toast("已达到单次 100 个窗口上限")
    }

    async function confirmSelectedWindows(items: MemoryRecord[] = selectedWindowItems.value): Promise<void> {
      if (!selectedPolicy.value?.enabled) return toast("请先开启这个群的消息采集")
      const unique = new Map()
      for (const item of Array.isArray(items) ? items : []) {
        const start = windowStartValue(item)
        if (start && isWindowSelectable(item)) unique.set(start, item)
      }
      const windows = [...unique.values()]
      if (!windows.length) return toast("请先选择可提炼的窗口")
      if (windows.length > 100) return toast("一次最多选择 100 个窗口")
      const summary = windows.reduce((all, item) => ({
        messages: all.messages + Number(item.sourceMessageCount || item.messageCount || 0),
        tokens: all.tokens + Number(item.estimatedInputTokens || 0),
        calls: all.calls + Number(item.modelCallCount || item.chunkCount || 0),
      }), { messages: 0, tokens: 0, calls: 0 })
      const accepted = await confirmAction({
        title: `提炼选中的 ${windows.length} 个日窗口？`,
        message: `覆盖 ${compactNumber(summary.messages)} 条原始消息，预计 ${compactNumber(summary.tokens)} Token、${compactNumber(summary.calls)} 次模型调用。`,
        detail: "已完成或失败的窗口会按当前原文重新计算并入队；正在等待或运行的窗口会自动跳过。原始消息不会被删除。",
        confirmText: "确认提炼", tone: "warn", icon: "sparkles",
      })
      if (!accepted || !selectedPolicy.value) return
      captureAction.value = "reextract-selection"
      try {
        const response = await request(`/api/memory/captures/group/${encodeURIComponent(selectedPolicy.value.scopeId)}/reextract`, {
          method: "POST",
          body: JSON.stringify({ windowStarts: windows.map(windowStartValue) }),
        })
        applyCaptureSummary(response.capture)
        const result = response.result || {}
        const keep = new Set((result.skippedEmptyWindowStarts || []).map((value: unknown) => String(Number(value))))
        selectedWindows.value = Object.fromEntries(Object.entries(selectedWindows.value).filter(([key]) => keep.has(key)))
        windowSelectionMode.value = Boolean(Object.keys(selectedWindows.value).length)
        await changeCaptureWindowPage(captureWindowPage.value.page)
        await loadCalendar({ silent: true })
        if (result.queued) startCapturePolling()
        toast(`已入队 ${result.queued || 0} 个窗口${result.alreadyQueued ? `，${result.alreadyQueued} 个已在队列中` : ""}${result.skippedEmpty ? `，${result.skippedEmpty} 个已无原始消息` : ""}`, "success")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        captureAction.value = ""
      }
    }

    function batchProgressLabel(item: MemoryRecord = {}): string {
      const batch = item.batch || {}
      if (Number(batch.windowCount || 1) <= 1) return ""
      return `历史小时窗口合并批次 · 本窗口 ${batch.windowIndex}/${batch.windowCount}`
    }

    async function refreshWorkspace(): Promise<void> {
      busy.value = true
      try {
        await refreshCapture()
        const first = capturePolicies.value.find((policy: MemoryRecord) => policy.enabled) || capturePolicies.value[0]
        if (!selectedGroupId.value || !capturePolicies.value.some((policy: MemoryRecord) => policy.scopeId === selectedGroupId.value)) {
          selectedGroupId.value = first?.scopeId || ""
        }
        if (selectedGroupId.value) await loadGroupWorkspace()
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        busy.value = false
      }
    }

    async function reviewDuplicateMemories() {
      if (!selectedGroupId.value) return
      duplicatePlanBusy.value = true
      try {
        const result = await request(`/api/memory/captures/group/${encodeURIComponent(selectedGroupId.value)}/memories/duplicates`)
        const plan = record(result.plan || { entries: [], archiveCount: 0 })
        duplicatePlan.value = plan
        if (!plan.archiveCount) return toast("没有发现可自动合并的重复记忆", "success")
        const detail = records(plan.entries).slice(0, 4).map((item: MemoryRecord) => `保留：${record(item.keep).text}\n归档：${records(item.archive).map((row: MemoryRecord) => row.text).join('；')}`).join("\n\n")
        const accepted = await confirmAction({
          title: `整理 ${plan.archiveCount} 条重复记忆？`,
          message: "只会归档同一事实键和值的自动提炼结果，不会删除原始记录，也不会调用模型。",
          detail: records(plan.entries).length > 4 ? `${detail}\n\n其余 ${records(plan.entries).length - 4} 组重复项未展开。` : detail,
          confirmText: "确认整理", tone: "warn", icon: "database",
        })
        if (!accepted) return
        const ids = records(plan.entries).flatMap((item: MemoryRecord) => records(item.archive).map((row: MemoryRecord) => row.id))
        const merged = await request(`/api/memory/captures/group/${encodeURIComponent(selectedGroupId.value)}/memories/duplicates/merge`, { method: "POST", body: JSON.stringify({ ids }) })
        store.memory = { ...store.memory, stats: merged.stats }
        await loadGroupWorkspace()
        if (selectedMember.value) await loadMemberWorkspace({ silent: true })
        toast(`已归档 ${merged.result?.archived || 0} 条重复记忆`, "success")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        duplicatePlanBusy.value = false
      }
    }

    async function loadGroupWorkspace(options: { silent?: boolean } = {}): Promise<void> {
      const groupId = selectedGroupId.value
      if (!groupId) {
        groupWorkspace.value = null
        return
      }
      const seq = ++loadSeq.group
      if (!options.silent) busy.value = true
      try {
        const result = await request(pageUrl(`/api/memory/groups/${encodeURIComponent(groupId)}/workspace`, {
          groupQuery: groupMemoryQuery.value,
          groupPage: groupMemoryPage.value,
          memberQuery: memberQuery.value,
          memberLimit: 100,
          pageSize: PAGE_SIZE,
        }))
        if (seq === loadSeq.group && groupId === selectedGroupId.value) groupWorkspace.value = result.workspace
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        if (!options.silent) busy.value = false
      }
    }

    async function selectGroup(policy: MemoryRecord): Promise<void> {
      selectedGroupId.value = policy.scopeId
      windowSelectionMode.value = false
      clearWindowSelection()
      selectedTimelineWindow.value = null
      timelineWindowDetail.value = null
      timelineDetailLoading.value = false
      timelineDetailError.value = ""
      calendarDays.value = []
      calendarPinnedToLatest = true
      calendarScrollLeft = 0
      calendarLoadedAt = 0
      loadSeq.timelineDetail += 1
      showGroupPicker.value = false
      groupPickerQuery.value = ""
      groupMemoryQuery.value = ""
      groupMemoryPage.value = 1
      captureWindowPage.value = { total: 0, page: 1, pageSize: WINDOW_PAGE_SIZE }
      captureMessagePage.value = 1
      captureMessagePageJump.value = 1
      memberQuery.value = ""
      selectedMember.value = null
      memberWorkspace.value = null
      await loadGroupWorkspace()
      if (activeWorkspace.value === "extract") await loadExtractionWorkspace({ resetRange: true })
    }

    async function switchWorkspace(value: string): Promise<void> {
      activeWorkspace.value = value
      showGroupPicker.value = false
      if (value !== "extract") {
        loadSeq.timelineDetail += 1
        timelineDetailLoading.value = false
        timelineDetailError.value = ""
      }
      if (value === "extract") await loadExtractionWorkspace({ resetRange: !reextractPlan.value })
    }

    async function selectMember(member: MemoryRecord): Promise<void> {
      selectedMember.value = member
      memberScope.value = "user_group"
      memberMemoryQuery.value = ""
      memberMemoryPage.value = 1
      await loadMemberWorkspace()
    }

    async function loadMemberWorkspace(options: { silent?: boolean } = {}): Promise<void> {
      const groupId = selectedGroupId.value
      const userId = selectedMember.value?.userId
      if (!groupId || !userId) {
        memberWorkspace.value = null
        return
      }
      const seq = ++loadSeq.member
      if (!options.silent) busy.value = true
      try {
        const query = memberMemoryQuery.value
        const result = await request(pageUrl(`/api/memory/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
          groupQuery: memberScope.value === "user_group" ? query : "",
          groupPage: memberScope.value === "user_group" ? memberMemoryPage.value : 1,
          globalQuery: memberScope.value === "user" ? query : "",
          globalPage: memberScope.value === "user" ? memberMemoryPage.value : 1,
          pageSize: PAGE_SIZE,
        }))
        if (seq === loadSeq.member && selectedGroupId.value === groupId && selectedMember.value?.userId === userId) memberWorkspace.value = result.workspace
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        if (!options.silent) busy.value = false
      }
    }

    function openCaptureSettings(policy: MemoryRecord | null = null): void {
      showGroupPicker.value = false
      captureDraftEditing.value = Boolean(policy)
      resetCaptureDraft(policy)
      showCaptureSettings.value = true
    }

    async function saveCapturePolicy() {
      const scopeId = captureDraft.scopeId.trim()
      if (!scopeId) return toast("请输入要采集的群号")
      if (!captureDraftEditing.value && capturePolicies.value.some(policy => policy.scopeId === scopeId)) {
        return toast("这个群已有采集配置，请从群列表进入编辑，避免覆盖已有设置")
      }
      captureBusy.value = true
      try {
        const result = await request(`/api/memory/captures/group/${encodeURIComponent(scopeId)}`, {
          method: "PUT",
          body: JSON.stringify({
            enabled: captureDraft.enabled,
            overrides: Object.fromEntries(POLICY_OVERRIDE_FIELDS.map(field => [field, captureDraft.useDefault[field] !== true])),
            retentionDays: captureDraft.retentionDays,
            tokenLimit: captureDraft.tokenLimit,
            modelName: captureDraft.modelName,
            promptTemplate: captureDraft.promptTemplate,
            maxTokens: captureDraft.maxTokens,
            minConfidence: captureDraft.minConfidence,
            retrievalResultLimit: captureDraft.retrievalResultLimit,
          }),
        })
        store.memory = { ...store.memory, capture: result.capture }
        captureDraftEditing.value = true
        const groupChanged = selectedGroupId.value !== scopeId
        selectedGroupId.value = scopeId
        await loadGroupWorkspace({ silent: true })
        if (activeWorkspace.value === "extract") await loadExtractionWorkspace({ resetRange: groupChanged })
        toast(captureDraft.enabled ? "群采集配置已保存并开启" : "群采集配置已保存为暂停")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        captureBusy.value = false
      }
    }

    // 从原始消息列表直接选定补录起点：回填输入框便于核对，并立即按当前条数向前补录。
    function backfillFromMessage(message: MemoryRecord): unknown {
      const messageId = String(message?.messageId || "").trim()
      if (!messageId) return toast("这条消息没有可用的消息 ID")
      historyBackfillFrom.value = messageId
      return backfillHistory()
    }

    async function backfillHistory(options: { continueFromOldest?: boolean } = {}): Promise<void> {
      const policy = selectedPolicy.value
      if (!policy) return toast("请先选择要补录的采集群")
      if (!policy.enabled) return toast("请先开启这个群的消息采集")
      captureAction.value = "backfill"
      startCapturePolling()
      try {
        const body: MemoryRecord = { limit: Math.min(Math.max(1, Number(historyBackfillLimit.value) || 100), backfillLimitMax.value) }
        if (options.continueFromOldest === true) body.continueFromOldest = true
        else if (String(historyBackfillFrom.value || "").trim()) body.beforeMessageId = String(historyBackfillFrom.value).trim()
        const result = await request(`/api/memory/captures/group/${encodeURIComponent(policy.scopeId)}/history`, {
          method: "POST",
          body: JSON.stringify(body),
        })
        store.memory = { ...store.memory, capture: result.capture }
        await loadExtractionWorkspace()
        const more = result.result?.hasMore ? "；还有更早历史，可点“继续向前补录”" : ""
        toast(`已补录 ${result.result?.saved || 0} 条原始记录（宿主返回 ${result.result?.received || 0} 条）${result.result?.windowsQueued ? `，已排入 ${result.result.windowsQueued} 个历史日提炼任务` : ""}${more}`)
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        captureAction.value = ""
        startCapturePolling()
      }
    }

    async function queueExtraction() {
      const policy = selectedPolicy.value
      if (!policy) return toast("请先选择要提炼的采集群")
      if (!policy.enabled) return toast("请先开启这个群的消息采集")
      captureAction.value = "extract"
      startCapturePolling()
      try {
        const result = await request(`/api/memory/captures/group/${encodeURIComponent(policy.scopeId)}/extract`, { method: "POST", body: "{}" })
        store.memory = { ...store.memory, capture: result.capture }
        await loadExtractionWorkspace()
        const historical = Number(result.queued?.historicalDays || 0)
        toast(historical ? `已排入 ${historical} 个历史日提炼任务，正在后台处理` : "昨天没有可提炼的已关闭消息")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        captureAction.value = ""
        startCapturePolling()
      }
    }

    async function loadCaptureDetails({ messagesOnly = false }: { messagesOnly?: boolean } = {}): Promise<void> {
      const policy = selectedCapture.value
      if (!policy) return
      const seq = ++loadSeq.captureMessages
      captureBusy.value = true
      try {
        const scope = `group/${encodeURIComponent(policy.scopeId)}`
        const [messages, windows] = await Promise.all([
          request(pageUrl(`/api/memory/captures/${scope}/messages`, {
            q: captureMessageQuery.value,
            page: captureMessagePage.value,
            pageSize: RAW_PAGE_SIZE,
            order: captureMessageOrder.value,
          })),
          messagesOnly ? Promise.resolve(null) : request(pageUrl(`/api/memory/captures/${scope}/windows`, {
            page: captureWindowPage.value.page,
            pageSize: captureWindowPage.value.pageSize,
          })),
        ])
        if (seq !== loadSeq.captureMessages) return
        applyMessagePage(messages.messages)
        if (windows) applyWindowPage(windows.windows)
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        captureBusy.value = false
      }
    }

    async function loadExtractionWorkspace({ resetRange = false }: { resetRange?: boolean } = {}): Promise<void> {
      const policy = selectedPolicy.value
      if (!policy) {
        captureMessages.value = { items: [], total: 0, page: 1, pageSize: RAW_PAGE_SIZE }
        captureWindows.value = []
        captureWindowPage.value = { total: 0, page: 1, pageSize: WINDOW_PAGE_SIZE }
        calendarDays.value = []
        reextractPlan.value = null
        return
      }
      selectedCapture.value = policy
      const seq = ++loadSeq.captureMessages
      captureBusy.value = true
      try {
        const scope = `group/${encodeURIComponent(policy.scopeId)}`
        const [messages, windows] = await Promise.all([
          request(pageUrl(`/api/memory/captures/${scope}/messages`, { q: captureMessageQuery.value, page: captureMessagePage.value, pageSize: RAW_PAGE_SIZE, order: captureMessageOrder.value })),
          request(pageUrl(`/api/memory/captures/${scope}/windows`, {
            page: captureWindowPage.value.page,
            pageSize: captureWindowPage.value.pageSize,
          })),
        ])
        if (seq !== loadSeq.captureMessages) return
        applyMessagePage(messages.messages)
        applyWindowPage(windows.windows)
        const progress = policy.windowProgress || {}
        if (Number(progress.pending || 0) || Number(progress.running || 0)) startCapturePolling()
        if (resetRange || !reextractStart.value) reextractStart.value = dateTimeInput(policy.oldestMessageAt || Date.now() - 14 * 86400000)
        if (resetRange || !reextractEnd.value) reextractEnd.value = dateTimeInput(policy.newestMessageAt || Date.now())
        await loadCalendar({ silent: true, force: true })
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        captureBusy.value = false
      }
    }

    async function previewReextraction({ silent = false }: { silent?: boolean } = {}): Promise<void> {
      const policy = selectedPolicy.value
      if (!policy) return
      const seq = ++loadSeq.preview
      if (!silent) reextractBusy.value = true
      try {
        const result = await request(pageUrl(`/api/memory/captures/group/${encodeURIComponent(policy.scopeId)}/reextract-preview`, { startAt: reextractStart.value, endAt: reextractEnd.value }))
        if (seq === loadSeq.preview) reextractPlan.value = result.plan || null
      } catch (err) {
        if (!silent) toast(errorMessage(err))
      } finally {
        if (!silent) reextractBusy.value = false
      }
    }

    async function openReextractDialog() {
      if (!selectedPolicy.value) return toast("请先选择采集群")
      if (!selectedPolicy.value.enabled) return toast("请先开启这个群的消息采集")
      if (!reextractStart.value) reextractStart.value = dateTimeInput(selectedPolicy.value.oldestMessageAt || Date.now() - 14 * 86400000)
      if (!reextractEnd.value) reextractEnd.value = dateTimeInput(selectedPolicy.value.newestMessageAt || Date.now())
      await previewReextraction()
      showReextractDialog.value = true
    }

    async function confirmReextraction() {
      const policy = selectedPolicy.value
      if (!policy || !reextractPlan.value?.selectedMessageCount) return toast("所选范围没有可提炼的文本消息")
      const accepted = await confirmAction({
        title: `创建 ${reextractPlan.value.dayCount} 个按日重提炼任务？`,
        message: `将按自然日拆分，覆盖 ${compactNumber(reextractPlan.value.selectedMessageCount)} 条消息，预计 ${compactNumber(reextractPlan.value.estimatedInputTokens)} Token。`,
        detail: "已存在的事实会按事实键新增、强化或修改；不会删除原始消息，也不会简单重复新增记忆。",
        confirmText: "确认创建任务", tone: "warn", icon: "sparkles",
      })
      if (!accepted) return
      reextractBusy.value = true
      try {
        const result = await request(`/api/memory/captures/group/${encodeURIComponent(policy.scopeId)}/reextract`, { method: "POST", body: JSON.stringify({ startAt: reextractStart.value, endAt: reextractEnd.value }) })
        store.memory = { ...store.memory, capture: result.capture }
        applyWindowPage(result.windowPage || result.windows)
        showReextractDialog.value = false
        startCapturePolling()
        toast(`已创建 ${result.result?.queued || 0} 个按日重提炼任务${result.result?.alreadyQueued ? `，${result.result.alreadyQueued} 个已在队列中` : ""}`, "success")
        await loadCalendar({ silent: true, force: true })
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        reextractBusy.value = false
      }
    }

    async function reextractSingleDay(item: MemoryRecord): Promise<unknown> {
      return confirmSelectedWindows([item])
    }

    async function selectTimelineWindow(item: MemoryRecord): Promise<void> {
      const seq = ++loadSeq.timelineDetail
      const normalized = normalizeCalendarItem(item)
      selectedTimelineWindow.value = normalized
      timelineWindowDetail.value = null
      timelineDetailLoading.value = true
      timelineDetailError.value = ""
      if (normalized?.id) {
        try {
          await loadWindowDetail(normalized)
          if (seq !== loadSeq.timelineDetail) return
          const detailKey = windowDetailKey(selectedPolicy.value?.scopeId, normalized.id)
          const detail = windowDetails[detailKey] || null
          timelineWindowDetail.value = detail
          if (detail?.window) selectedTimelineWindow.value = { ...normalized, ...detail.window, day: normalized.day }
        } catch (err) {
          if (seq === loadSeq.timelineDetail) timelineDetailError.value = errorMessage(err) || "无法加载这一天的详情"
        } finally {
          if (seq === loadSeq.timelineDetail) timelineDetailLoading.value = false
        }
        return
      }
      if (!selectedPolicy.value) {
        timelineDetailLoading.value = false
        return
      }
      try {
        const result = await request(pageUrl(`/api/memory/captures/group/${encodeURIComponent(selectedPolicy.value.scopeId)}/messages`, {
          from: normalized.windowStart, to: normalized.windowEnd, page: 1, pageSize: 100,
        }))
        if (seq !== loadSeq.timelineDetail) return
        timelineWindowDetail.value = { window: normalized, messages: result.messages?.items || [], totalMessages: result.messages?.total || 0, truncated: Number(result.messages?.total || 0) > 100 }
      } catch (err) {
        if (seq === loadSeq.timelineDetail) {
          timelineDetailError.value = errorMessage(err) || "无法加载这一天的原始消息"
          toast(errorMessage(err))
        }
      } finally {
        if (seq === loadSeq.timelineDetail) timelineDetailLoading.value = false
      }
    }

    function changeCaptureMessagePage(page: number): void {
      const nextPage = Math.max(1, Math.min(captureMessagePageCount.value, Math.trunc(Number(page) || 1)))
      captureMessagePage.value = nextPage
      captureMessagePageJump.value = nextPage
      loadCaptureDetails({ messagesOnly: true })
    }

    function jumpCaptureMessagePage(): void {
      changeCaptureMessagePage(Number(captureMessagePageJump.value) || 1)
    }

    function changeCaptureMessageOrder(order: string): void {
      const nextOrder = order === "asc" ? "asc" : "desc"
      if (captureMessageOrder.value === nextOrder) return
      captureMessageOrder.value = nextOrder
      captureMessagePage.value = 1
      captureMessagePageJump.value = 1
      loadCaptureDetails({ messagesOnly: true })
    }

    async function changeCaptureWindowPage(page: number): Promise<void> {
      const policy = selectedPolicy.value
      if (!policy) return
      captureBusy.value = true
      try {
        const result = await request(pageUrl(`/api/memory/captures/group/${encodeURIComponent(policy.scopeId)}/windows`, {
          page,
          pageSize: captureWindowPage.value.pageSize,
        }))
        applyWindowPage(result.windows)
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        captureBusy.value = false
      }
    }

    async function loadWindowDetail(item: MemoryRecord): Promise<MemoryRecord | null> {
      const policy = selectedCapture.value
      if (!policy?.scopeId || !item?.id) return null
      const detailKey = windowDetailKey(policy.scopeId, item.id)
      const cached = windowDetails[detailKey]
      if (cached && (!Number(item.updatedAt) || Number(cached.window?.updatedAt || 0) >= Number(item.updatedAt))) return cached
      if (cached) delete windowDetails[detailKey]
      if (windowDetailRequests[detailKey]) return windowDetailRequests[detailKey]
      windowDetailLoading[detailKey] = true
      const pending = (async () => {
        try {
          const result = await request(`/api/memory/captures/group/${encodeURIComponent(policy.scopeId)}/windows/${encodeURIComponent(item.id)}`)
          windowDetails[detailKey] = result.detail || null
          return windowDetails[detailKey]
        } catch (err) {
          toast(errorMessage(err))
          throw err
        } finally {
          windowDetailLoading[detailKey] = false
          delete windowDetailRequests[detailKey]
        }
      })()
      windowDetailRequests[detailKey] = pending
      return pending
    }

    function windowDetailKey(scopeId: unknown, windowId: unknown): string {
      return `${String(scopeId || "").trim()}:${String(windowId || "").trim()}`
    }

    function targetForGroup(): MemoryRecord {
      const groupId = selectedGroupId.value
      return { scopeType: "group", ownerId: groupId, groupId }
    }

    function targetForMember(): MemoryRecord {
      const userId = selectedMember.value?.userId || ""
      return { scopeType: memberScope.value, ownerId: userId, groupId: selectedGroupId.value }
    }

    function openMemoryEditor(item: MemoryRecord | null = null, target: MemoryRecord = targetForGroup()): void {
      if (!target.ownerId || !target.groupId) return toast("请先选择一个采集群和成员")
      draft.scopeType = target.scopeType
      draft.ownerId = target.ownerId
      draft.groupId = target.groupId
      draft.memoryId = item?.id || ""
      draft.memoryText = item?.text || ""
      draft.memoryTags = (item?.tags || []).join(", ")
      showMemoryDrawer.value = true
    }

    async function saveMemory() {
      if (!draft.memoryText.trim()) return toast("请输入记忆内容")
      busy.value = true
      try {
        let result
        // 后端返回的 workspace 是无过滤的第一页，直接覆盖会和当前搜索词、页码错位；改为按当前条件重新加载。
        if (draft.scopeType === "group") {
          result = await request(`/api/memory/groups/${encodeURIComponent(draft.groupId)}/facts`, {
            method: "POST",
            body: JSON.stringify({ id: draft.memoryId || undefined, text: draft.memoryText.trim(), tags: splitTokens(draft.memoryTags) }),
          })
          await loadGroupWorkspace({ silent: true })
        } else {
          result = await request(`/api/memory/groups/${encodeURIComponent(draft.groupId)}/members/${encodeURIComponent(draft.ownerId)}/facts`, {
            method: "POST",
            body: JSON.stringify({ scopeType: draft.scopeType, id: draft.memoryId || undefined, text: draft.memoryText.trim(), tags: splitTokens(draft.memoryTags) }),
          })
          await loadMemberWorkspace({ silent: true })
        }
        store.memory = { ...store.memory, stats: result.stats }
        showMemoryDrawer.value = false
        toast(draft.memoryId ? "记忆内容已更新" : "记忆已添加")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        busy.value = false
      }
    }

    function openProfileEditor() {
      const profile = memberWorkspace.value?.profile || {}
      draft.profileName = profile.name || ""
      draft.profilePronouns = profile.pronouns || ""
      draft.profileInterests = (profile.interests || []).join(", ")
      draft.profilePreferences = (profile.preferences || []).join(", ")
      draft.profileDislikes = (profile.dislikes || []).join(", ")
      draft.profileStyle = profile.communicationStyle || ""
      draft.profileNotes = profile.notes || ""
      showProfileDrawer.value = true
    }

    async function saveProfile() {
      const userId = selectedMember.value?.userId
      if (!userId) return toast("请先选择一位群成员")
      busy.value = true
      try {
        const result = await request("/api/memory/profile", {
          method: "POST",
          body: JSON.stringify({
            userId,
            replace: true,
            profile: {
              name: draft.profileName,
              pronouns: draft.profilePronouns,
              interests: splitTokens(draft.profileInterests),
              preferences: splitTokens(draft.profilePreferences),
              dislikes: splitTokens(draft.profileDislikes),
              communicationStyle: draft.profileStyle,
              notes: draft.profileNotes,
            },
          }),
        })
        if (memberWorkspace.value) memberWorkspace.value = { ...memberWorkspace.value, profile: result.result?.profile || {} }
        showProfileDrawer.value = false
        toast("用户画像已保存")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        busy.value = false
      }
    }

    async function deleteMemory(item: MemoryRecord, target: MemoryRecord): Promise<void> {
      const accepted = await confirmAction({
        title: "删除这条记忆？",
        message: target.scopeType === "user" ? "删除后，该用户的全局对话不会再使用这条记忆。" : "删除后，这条信息不会再注入当前群的后续对话。",
        detail: item.text || item.id,
        confirmText: "确认删除记忆",
        tone: "danger",
        icon: "trash",
      })
      if (!accepted) return
      busy.value = true
      try {
        let result
        if (target.scopeType === "group") {
          result = await request(`/api/memory/groups/${encodeURIComponent(target.groupId)}/facts/${encodeURIComponent(item.id)}`, { method: "DELETE" })
          // 删除可能清空当前页；退回上一页后按当前搜索条件重载，避免列表和搜索框错位。
          await loadGroupWorkspace({ silent: true })
          if (!groupMemory.value.items.length && groupMemoryPage.value > 1) {
            groupMemoryPage.value -= 1
            await loadGroupWorkspace({ silent: true })
          }
        } else {
          result = await request(pageUrl(`/api/memory/groups/${encodeURIComponent(target.groupId)}/members/${encodeURIComponent(target.ownerId)}/facts/${encodeURIComponent(item.id)}`, { scopeType: target.scopeType }), { method: "DELETE" })
          await loadMemberWorkspace({ silent: true })
          if (!currentMemberMemory.value.items.length && memberMemoryPage.value > 1) {
            memberMemoryPage.value -= 1
            await loadMemberWorkspace({ silent: true })
          }
        }
        store.memory = { ...store.memory, stats: result.stats }
        toast("记忆已删除")
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        busy.value = false
      }
    }

    function changeGroupPage(page: number): void {
      groupMemoryPage.value = page
      loadGroupWorkspace()
    }

    function changeMemberPage(page: number): void {
      memberMemoryPage.value = page
      loadMemberWorkspace()
    }

    // 搜索输入防抖后再请求；响应侧另有序号守卫，双保险避免乱序覆盖。
    const debouncedGroupSearch = debounce(() => { if (selectedGroupId.value) loadGroupWorkspace({ silent: true }) })
    const debouncedMemberSearch = debounce(() => { if (selectedMember.value) loadMemberWorkspace({ silent: true }) })
    const debouncedCaptureMessageSearch = debounce(() => { if (selectedCapture.value) loadCaptureDetails({ messagesOnly: true }) })
    watch(groupMemoryQuery, () => {
      groupMemoryPage.value = 1
      debouncedGroupSearch()
    })
    watch(memberQuery, debouncedGroupSearch)
    watch(memberScope, () => {
      memberMemoryQuery.value = ""
      memberMemoryPage.value = 1
      if (selectedMember.value) loadMemberWorkspace({ silent: true })
    })
    watch(memberMemoryQuery, () => {
      memberMemoryPage.value = 1
      debouncedMemberSearch()
    })
    watch(captureMessageQuery, () => {
      captureMessagePage.value = 1
      captureMessagePageJump.value = 1
      // 只刷新消息列表；全量重建 extraction 工作区会重置时间线选择并放大请求。
      debouncedCaptureMessageSearch()
    })
    watch(calendarRange, () => {
      if (!selectedPolicy.value || activeWorkspace.value !== "extract") return
      clearWindowSelection()
      loadSeq.timelineDetail += 1
      selectedTimelineWindow.value = null
      timelineWindowDetail.value = null
      timelineDetailLoading.value = false
      timelineDetailError.value = ""
      calendarPinnedToLatest = true
      calendarScrollLeft = 0
      loadCalendar().catch(() => {})
    })
    watch(extractionPane, pane => {
      if (pane === "timeline" && activeWorkspace.value === "extract") restoreCalendarViewport()
    })
    watch([calendarBusy, captureBusy], ([calendarLoading, captureLoading]) => {
      if (!calendarLoading && !captureLoading && extractionPane.value === "timeline" && activeWorkspace.value === "extract") {
        restoreCalendarViewport()
      }
    })
    const captureDraftGuard = computed(() => showCaptureSettings.value && Boolean(captureDraft.scopeId.trim()) && captureDraftDirty.value)
    watch(captureDraftGuard, dirty => setDirtyScope("memory:capture-draft", dirty), { immediate: true })
    onMounted(() => {
      window.addEventListener("resize", handleCalendarViewportResize)
      refreshWorkspace()
    })
    onUnmounted(() => {
      stopCapturePolling()
      if (calendarRevealTimer) clearTimeout(calendarRevealTimer)
      window.removeEventListener("resize", handleCalendarViewportResize)
      setDirtyScope("memory:capture-draft", false)
    })

    function setCalendarWeeksElement(element: HTMLElement | null): void {
      calendarWeeksElement.value = element
    }

    // 子工作区只接收这个响应式视图对象，所有 API 请求、确认和刷新仍由父组件统一编排。
    const memoryView = reactive({
      activeWorkspace, extractionPane, busy, captureBusy, captureAction, showGroupPicker, groupPickerQuery, selectedGroupId, selectedPolicy, capturePolicies, filteredPolicies, captureDefaults, captureDraftPolicy, captureDraftDirty, captureDraftEditing, historyBackfillLimit, historyBackfillFrom, backfillLimitMax, extractionModelOptions, groupWorkspace, groupMemory, groupMemoryQuery, groupMemoryPage, duplicatePlan, duplicatePlanBusy,
      members, memberQuery, selectedMember, selectedMemberName, memberWorkspace, memberScope, memberMemoryQuery, memberMemoryPage, currentMemberMemory,
      showMemoryDrawer, showProfileDrawer, showCaptureSettings, showReextractDialog, selectedCapture, captureMessages, captureWindows, captureWindowPage, captureMessageQuery, captureMessagePage, captureMessagePageJump, captureMessageOrder, captureMessagePageCount, captureDraft, draft, windowDetails, windowDetailLoading,
      selectedTimelineWindow, timelineWindowDetail, selectedWindowMessages, timelineWindows, reextractStart, reextractEnd, reextractPlan, reextractBusy, extractionCounts, runRecordWindows,
      calendarDays, calendarMeta, calendarRange, calendarMetric, calendarBusy, calendarWeeks, calendarMetricLabel, calendarSummary, calendarWeeksElement, timelineDetailLoading, timelineDetailError,
      windowSelectionMode, selectedWindowStarts, selectedWindowItems, selectedWindowSummary,
      policyTitle, policyOverrideSummary, memberTitle, timeLabel, rangeLabel, scopeLabel, extractionScopeLabel, extractionResultLabel, backfillStatusLabel, windowStatusLabel, timelineStatus, calendarStatus, calendarDayClass, calendarDayTitle, calendarDayAriaLabel, dayNumber, segmentSummary, normalizationView, compactNumber, windowWorkload, memoryLifecycle, resultAction, taskResultSummary, runningWindowProgress, taskListSummary, batchProgressLabel, captureDefaultLabel, captureFieldHint, captureFieldSource, updateCaptureField, resetCaptureField, selectGroup, selectMember, switchWorkspace, refreshWorkspace, reviewDuplicateMemories, openCaptureSettings, saveCapturePolicy, openSystemSettings, backfillHistory, backfillFromMessage, queueExtraction,
      isWindowSelected, toggleWindowSelectionMode, toggleWindowSelection, openRunWindow, extractionWindowAction, runExtractionWindow, clearWindowSelection, selectVisibleWindows, confirmSelectedWindows, handleCalendarScroll,
      loadCaptureDetails, loadExtractionWorkspace, loadCalendar, previewReextraction, openReextractDialog, confirmReextraction, reextractSingleDay, selectTimelineWindow, changeCaptureMessagePage, jumpCaptureMessagePage, changeCaptureMessageOrder, changeCaptureWindowPage, targetForGroup, targetForMember, openMemoryEditor, saveMemory, deleteMemory, openProfileEditor, saveProfile, changeGroupPage, changeMemberPage,
      setCalendarWeeksElement,
    })

    return {
      memoryView,
      activeWorkspace, extractionPane, busy, captureBusy, captureAction, showGroupPicker, groupPickerQuery, selectedGroupId, selectedPolicy, capturePolicies, filteredPolicies, captureDefaults, captureDraftPolicy, captureDraftDirty, captureDraftEditing, historyBackfillLimit, historyBackfillFrom, backfillLimitMax, defaultReplyModelName, extractionModelOptions, groupWorkspace, groupMemory, groupMemoryQuery, groupMemoryPage, duplicatePlan, duplicatePlanBusy,
      members, memberQuery, selectedMember, selectedMemberName, memberWorkspace, memberScope, memberMemoryQuery, memberMemoryPage, currentMemberMemory,
      showMemoryDrawer, showProfileDrawer, showCaptureSettings, showReextractDialog, selectedCapture, captureMessages, captureWindows, captureWindowPage, captureMessageQuery, captureMessagePage, captureMessagePageJump, captureMessageOrder, captureMessagePageCount, captureDraft, draft, windowDetails, windowDetailLoading,
      selectedTimelineWindow, timelineWindowDetail, selectedWindowMessages, timelineWindows, reextractStart, reextractEnd, reextractPlan, reextractBusy, extractionCounts, runRecordWindows,
      calendarDays, calendarMeta, calendarRange, calendarMetric, calendarBusy, calendarWeeks, calendarMetricLabel, calendarSummary, calendarWeeksElement, timelineDetailLoading, timelineDetailError,
      windowSelectionMode, selectedWindowStarts, selectedWindowItems, selectedWindowSummary,
      policyTitle, policyOverrideSummary, memberTitle, timeLabel, rangeLabel, scopeLabel, extractionScopeLabel, extractionResultLabel, backfillStatusLabel, windowStatusLabel, timelineStatus, calendarStatus, calendarDayClass, calendarDayTitle, calendarDayAriaLabel, dayNumber, segmentSummary, normalizationView, compactNumber, windowWorkload, memoryLifecycle, resultAction, taskResultSummary, runningWindowProgress, taskListSummary, batchProgressLabel, captureDefaultLabel, captureFieldHint, captureFieldSource, updateCaptureField, resetCaptureField, selectGroup, selectMember, switchWorkspace, refreshWorkspace, reviewDuplicateMemories, openCaptureSettings, saveCapturePolicy, openSystemSettings, backfillHistory, backfillFromMessage, queueExtraction,
      isWindowSelected, toggleWindowSelectionMode, toggleWindowSelection, openRunWindow, extractionWindowAction, runExtractionWindow, clearWindowSelection, selectVisibleWindows, confirmSelectedWindows, handleCalendarScroll,
      loadCaptureDetails, loadExtractionWorkspace, loadCalendar, previewReextraction, openReextractDialog, confirmReextraction, reextractSingleDay, selectTimelineWindow, changeCaptureMessagePage, jumpCaptureMessagePage, changeCaptureMessageOrder, changeCaptureWindowPage, targetForGroup, targetForMember, openMemoryEditor, saveMemory, deleteMemory, openProfileEditor, saveProfile, changeGroupPage, changeMemberPage,
    }
  },
  components: { MemoryCaptureDrawers, MemoryExtractionWorkspace, MemoryManageWorkspace },
  template: `
    <MemoryCaptureDrawers :view="memoryView" />

    <Panel flush class="memory-hub-workspace">
      <header class="memory-hub-tabs">
        <div class="memory-workspace-switch" role="tablist" aria-label="记忆工作区">
          <button type="button" :class="{ active: activeWorkspace === 'manage' }" @click="switchWorkspace('manage')"><Icon name="database" :size="15" /><span><b>记忆管理</b><small>维护记忆块与用户画像</small></span></button>
          <button type="button" :class="{ active: activeWorkspace === 'extract' }" @click="switchWorkspace('extract')"><Icon name="sparkles" :size="15" /><span><b>记忆提炼</b><small>核对原始消息与时间窗</small></span></button>
        </div>
        <div class="row memory-settings-actions">
          <button class="btn small outline" type="button" @click="openCaptureSettings(selectedPolicy)"><Icon name="settings" :size="14" />采集设置</button>
        </div>
      </header>
      <MemoryManageWorkspace :view="memoryView" />
      <MemoryExtractionWorkspace :view="memoryView" />
    </Panel>
  `,
}
