import { computed, onUnmounted, reactive, ref } from "vue"
import { confirmAction, store, request, toast, saveConfigPatch, refreshTab } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { splitTokens, percent, shortId, groupBy } from "../../shared/format.js"
import { KnowledgeBaseWorkspace } from "./knowledge-base-workspace.js"
import { KnowledgeCommandMaintenance } from "./knowledge-command-maintenance.js"

const BOOL_OPTIONS = [{ value: "true", label: "开启" }, { value: "false", label: "关闭" }]
const BOOL_OFF_OPTIONS = [{ value: "false", label: "关闭" }, { value: "true", label: "开启" }]

/** 管理台知识库的 API 结构会随索引能力扩展；这里将边界收敛成页面内部模型。 */
type KnowledgeRecord = Record<string, any>

interface KnowledgeConfig extends KnowledgeRecord {
  enabled?: boolean
  dynamicCapture?: boolean
  commandPrefixes?: string[]
  captureGroups?: boolean
  capturePrivate?: boolean
  maxEvents?: number
  excludedPlugins?: string[]
  excludedCommands?: string[]
}

interface KnowledgeItem extends KnowledgeRecord {
  id: string
  manual?: boolean
  dynamic?: boolean
  pluginKey?: string
  source_type?: string
  metadata?: KnowledgeRecord
}

interface KnowledgeBase extends KnowledgeRecord {
  id: string
  name?: string
  description?: string
  protected?: boolean
  auto_retrieve?: boolean
  updated_at?: number
  stats?: KnowledgeRecord
  config?: KnowledgeRecord
  index?: KnowledgeRecord
}

interface KnowledgeDocument extends KnowledgeItem {
  title?: string
  content?: string
  preview?: string
}

interface KnowledgeGrant extends KnowledgeRecord {
  id: string
  principal_type?: string
  principal_id?: string
}

interface IndexJob extends KnowledgeRecord {
  id: string
  status?: string
  progress?: KnowledgeRecord
}

interface IndexPagination {
  page: number
  pageSize: number
  total: number
}

interface KnowledgeDigest extends KnowledgeRecord {
  stats?: KnowledgeRecord
  observer?: KnowledgeRecord
  capture?: KnowledgeRecord
  distributions?: KnowledgeRecord
}

interface KnowledgeQuality extends KnowledgeRecord {
  summary?: KnowledgeRecord
  weakCommands?: KnowledgeItem[]
  recommendations?: KnowledgeItem[]
}

interface KnowledgeSlice extends KnowledgeRecord {
  stats?: KnowledgeRecord
  digest?: KnowledgeDigest
  quality?: KnowledgeQuality
  recommendation?: KnowledgeRecord
}

interface KnowledgeModel extends KnowledgeRecord {
  name: string
  capabilities?: KnowledgeRecord
  embedding?: KnowledgeRecord
}

interface RecommendationItem extends KnowledgeRecord {
  sectionRank?: number
  sectionLabel?: string
}

interface KnowledgeApiResponse extends KnowledgeRecord {
  result?: KnowledgeRecord
  base?: KnowledgeBase
  bases?: KnowledgeBase[]
  documents?: KnowledgeDocument[]
  grants?: KnowledgeGrant[]
  jobs?: IndexJob[]
  pagination?: IndexPagination
  results?: KnowledgeItem[]
  document?: KnowledgeDocument
  command?: KnowledgeItem
  sync?: KnowledgeRecord
  stats?: KnowledgeRecord
  digest?: KnowledgeDigest
  quality?: KnowledgeQuality
  index?: KnowledgeRecord
}

interface KnowledgeDraft extends KnowledgeRecord {
  query: string
  enabled: string
  dynamicCapture: string
  commandPrefixes: string
  captureGroups: string
  capturePrivate: string
  maxEvents: number
  excludedPlugins: string
  excludedCommands: string
  manualId: string
  manualSourceCommandId: string
  manualSourceRuleKey: string
  manualSourceOrigin: unknown
  manualPluginName: string
  manualCommand: string
  manualDescription: string
  manualBody: string
  manualExamples: string
  manualParameters: string
  manualNotes: string
  baseName: string
  baseDescription: string
  baseEmbeddingModel: string
  baseDimensions: number
  commandEmbeddingModel: string
  commandEmbeddingDimensions: number
  baseId: string
  baseAutoRetrieve: string
  baseTriggerWords: string
  sourceBaseId: string
  sourceName: string
  sourceContent: string
  documentId: string
  retrievalQuery: string
  grantPrincipalType: string
  grantPrincipalId: string
  grantGroupId: string
  grantAccess: string
}

function records<T extends KnowledgeRecord = KnowledgeRecord>(value: unknown): T[] {
  return asRecords(value) as T[]
}

function record<T extends KnowledgeRecord = KnowledgeRecord>(value: unknown): T {
  return asRecord(value) as T
}

function canDelete(item: KnowledgeItem = { id: "" }) {
  return Boolean(item.manual || item.dynamic || item.pluginKey === "manual" || item.pluginKey === "observed")
}

function documentOrigin(item: KnowledgeItem = { id: "" }) {
  const origin = item?.metadata?.origin || {}
  const type = origin.type || (item.source_type === "command" ? "runtime-plugin-rule" : "")
  if (!type) return null
  const labels: Record<string, string> = {
    "runtime-plugin-rule": "Yunzai 插件规则",
    manual: "管理台手动补充",
    observed: "动态观察",
  }
  const unavailable = type === "runtime-plugin-rule" ? "重新扫描后补全" : "不适用"
  return {
    label: origin.label || labels[type] || "知识来源",
    plugin: origin.pluginName || origin.pluginKey || unavailable,
    file: origin.file || unavailable,
    fileRole: origin.fileRole || (type === "runtime-plugin-rule" ? unavailable : "不适用"),
    method: origin.method || unavailable,
  }
}

export const KnowledgeTab = {
  name: "KnowledgeTab",
  components: { KnowledgeBaseWorkspace, KnowledgeCommandMaintenance },
  setup() {
    const cfg = computed<KnowledgeConfig>(() => record<KnowledgeRecord>(store.config).knowledge as KnowledgeConfig || {})
    const knowledge = computed<KnowledgeSlice>(() => record<KnowledgeSlice>(store.knowledge))
    const digest = computed<KnowledgeDigest>(() => knowledge.value.digest || {})
    const quality = computed<KnowledgeQuality>(() => knowledge.value.quality || {})
    const recommendation = computed<KnowledgeRecord | null>(() => knowledge.value.recommendation || null)
    const showManualDrawer = ref(false)
    const showCaptureDrawer = ref(false)
    const showExclusionDrawer = ref(false)
    const showBaseDrawer = ref(false)
    const showDocumentDrawer = ref(false)
    const showGrantDrawer = ref(false)
    const showCommandMaintenanceDrawer = ref(false)
    const bases = ref<KnowledgeBase[]>([])
    const selectedBaseId = ref("")
    const baseQuery = ref("")
    const activeBasePane = ref("documents")
    const documents = ref<KnowledgeDocument[]>([])
    const grants = ref<KnowledgeGrant[]>([])
    const indexJobs = ref<IndexJob[]>([])
    const indexJobPage = ref(1)
    const indexJobPagination = ref<IndexPagination>({ page: 1, pageSize: 10, total: 0 })
    let indexPollTimer: ReturnType<typeof setInterval> | null = null
    let indexPollBusy = false
    const retrievalResults = ref<KnowledgeItem[]>([])
    const documentQuery = ref("")
    const baseBusy = ref(false)
    const activeMaintenancePane = ref("commands")
    const maintenancePaneItems = [
      { value: "commands", label: "指令与示例", icon: "book" },
      { value: "overview", label: "采集概览", icon: "sparkles" },
      { value: "quality", label: "收录质量", icon: "activity" },
    ]

    const draft = reactive<KnowledgeDraft>({
      query: "怎么查体力",
      enabled: String(Boolean(cfg.value.enabled)),
      dynamicCapture: String(Boolean(cfg.value.dynamicCapture)),
      commandPrefixes: (cfg.value.commandPrefixes || ["#", "/", "*"]).join(","),
      captureGroups: String(Boolean(cfg.value.captureGroups)),
      capturePrivate: String(Boolean(cfg.value.capturePrivate)),
      maxEvents: cfg.value.maxEvents || 1000,
      excludedPlugins: (cfg.value.excludedPlugins || []).join(", "),
      excludedCommands: (cfg.value.excludedCommands || []).join("\n"),
      manualId: "",
      manualSourceCommandId: "",
      manualSourceRuleKey: "",
      manualSourceOrigin: null,
      manualPluginName: "手动知识",
      manualCommand: "#体力",
      manualDescription: "查询体力或每日状态",
      manualBody: "",
      manualExamples: "#体力,#体力 @用户",
      manualParameters: "内容,@用户",
      manualNotes: "",
      baseName: "",
      baseDescription: "",
      baseEmbeddingModel: "",
      baseDimensions: 0,
      commandEmbeddingModel: "",
      commandEmbeddingDimensions: 1024,
      baseId: "",
      baseAutoRetrieve: "false",
      baseTriggerWords: "",
      sourceBaseId: "",
      sourceName: "",
      sourceContent: "",
      documentId: "",
      retrievalQuery: "",
      grantPrincipalType: "role",
      grantPrincipalId: "user",
      grantGroupId: "",
      grantAccess: "allow",
    })

    const selectedBase = computed(() => bases.value.find(base => base.id === selectedBaseId.value) || null)
    const filteredBases = computed(() => {
      const query = baseQuery.value.trim().toLowerCase()
      const matched = query ? bases.value.filter(base => [base.name, base.description, base.id].some(value => String(value || "").toLowerCase().includes(query))) : [...bases.value]
      const rank: Record<string, number> = { bad: 0, warn: 1, on: 2, off: 3 }
      return matched.sort((a, b) => (rank[baseHealth(a).state] ?? 4) - (rank[baseHealth(b).state] ?? 4) || Number(b.updated_at || 0) - Number(a.updated_at || 0))
    })
    const embeddingModelOptions = computed(() => [
      { value: "", label: "仅全文检索（无需模型）" },
      ...records<KnowledgeModel>(record(store.config).models).filter((model: KnowledgeModel) => model?.capabilities?.embedding).map((model: KnowledgeModel) => ({
        value: model.name,
        label: `${model.name}${model.embedding?.defaultDimensions ? ` · ${model.embedding.defaultDimensions} 维` : ""}`,
      })),
    ])
    const activeIndexJob = computed(() => indexJobs.value.find(item => ["queued", "running", "retrying", "canceling"].includes(item.status || "")) || null)
    const latestIndexJob = computed(() => indexJobs.value[0] || null)
    const visibleIndexJob = computed(() => {
      if (activeIndexJob.value) return activeIndexJob.value
      return ["completed", "failed", "paused_budget", "paused_no_model"].includes(latestIndexJob.value?.status || "")
        ? latestIndexJob.value
        : null
    })
    const basePaneItems = computed(() => [
      { value: "documents", label: "内容", description: "查看和修正原文", icon: "file", badge: selectedBase.value?.stats?.documents || 0 },
      { value: "retrieval", label: "召回测试", description: "验证能否检索到", icon: "search" },
      { value: "grants", label: "授权", description: "按角色、用户和群控制", icon: "key", badge: grants.value.length },
      { value: "index", label: "索引", description: "检查异常和重建", icon: "activity", badge: indexJobs.value.length },
    ])

    function baseHealth(base: KnowledgeBase = { id: "" }) {
      const status = base.index?.status || "fts_ready"
      if (["failed", "paused_budget", "paused_no_model"].includes(status)) return { state: "bad", label: status === "failed" ? "索引异常" : "索引暂停" }
      if (!Number(base.stats?.documents || 0)) return { state: "warn", label: "暂无内容" }
      if (base.config?.embeddingModel && !["completed", "ready"].includes(status)) return { state: "warn", label: "待构建" }
      return { state: "on", label: base.config?.embeddingModel ? "可检索" : "全文可用" }
    }

    function jobLabel(status = "") {
      return ({ queued: "等待中", running: "构建中", canceling: "取消中", retrying: "等待重试", completed: "已完成", failed: "失败", paused_budget: "预算暂停", paused_no_model: "缺少模型", canceled: "已取消", superseded: "已替代" })[status] || status || "未知"
    }

    function jobProgress(item: IndexJob = { id: "" }) {
      if (item.status === "completed" || item.progress?.phase === "completed") return 100
      const percentValue = Number(item.progress?.percent)
      if (Number.isFinite(percentValue)) return Math.max(0, Math.min(100, Math.round(percentValue)))
      const processed = Number(item.progress?.processed || 0)
      const total = Number(item.progress?.total || 0)
      return total > 0 ? Math.max(0, Math.min(100, Math.round((processed / total) * 100))) : (item.status === "running" ? 5 : 0)
    }

    function jobProgressLabel(item: IndexJob = { id: "" }) {
      return item.progress?.message || jobLabel(item.status)
    }

    function jobProgressTone(item: IndexJob = { id: "" }) {
      if (["failed", "paused_budget", "paused_no_model"].includes(item.status || "")) return "bad"
      if (item.status === "completed") return "done"
      return "active"
    }

    function stopIndexPolling() {
      if (indexPollTimer) clearInterval(indexPollTimer)
      indexPollTimer = null
    }

    async function refreshIndexJobsOnly({ silent = true } = {}) {
      const baseId = selectedBaseId.value
      if (!baseId || indexPollBusy) return
      indexPollBusy = true
      try {
        const wasActive = Boolean(activeIndexJob.value)
        const result = await request(`/api/knowledge/index-jobs?baseId=${encodeURIComponent(baseId)}&page=${indexJobPage.value}&pageSize=10`) as KnowledgeApiResponse
        if (selectedBaseId.value !== baseId) return
        indexJobs.value = result.jobs || []
        indexJobPagination.value = result.pagination || { page: indexJobPage.value, pageSize: 10, total: indexJobs.value.length }
        if (!activeIndexJob.value) {
          stopIndexPolling()
          if (wasActive) await loadBases()
        }
      } catch (err) {
        if (!silent) toast(errorMessage(err))
      } finally {
        indexPollBusy = false
      }
    }

    function syncIndexPolling() {
      if (!activeIndexJob.value) {
        stopIndexPolling()
        return
      }
      if (!indexPollTimer) indexPollTimer = setInterval(() => refreshIndexJobsOnly(), 1000)
    }

    const digestMetrics = computed(() => {
      const stats = digest.value.stats || {}
      return [
        { label: "指令", value: stats.commands || 0, icon: "book", tone: "blue" },
        { label: "插件", value: stats.plugins || 0, icon: "cpu", tone: "purple" },
        { label: "动态指令", value: stats.dynamicCommands || stats.observedCommands || 0, icon: "activity", tone: "green" },
        { label: "示例覆盖", value: percent(stats.exampleCoverageRatio || 0), icon: "check", tone: "cyan" },
      ]
    })
    const digestPills = computed(() => {
      const observer = digest.value.observer || {}
      const capture = digest.value.capture || {}
      return [
        { label: "观察器", active: observer.patched },
        { label: "前缀 " + ((observer.commandPrefixes || []).join(" ") || "-"), tone: "accent" },
        { label: "事件 " + (capture.total || 0) },
        { label: "观察 " + (capture.observed || 0) },
      ]
    })
    const pluginPills = computed(() => records<KnowledgeRecord>(digest.value.distributions?.plugins).map((item: KnowledgeRecord) => ({ label: `${item.key} ${item.count}` })))

    const qualityMetrics = computed(() => {
      const s = quality.value.summary || {}
      return [
        { label: "无明显问题", value: s.okCommands || 0, max: s.commands || undefined, icon: "check", tone: "green" },
        { label: "问题指令", value: s.issueCommands || 0, icon: "alert", tone: s.issueCommands ? "orange" : "green" },
        { label: "平均质量", value: s.averageQualityScore ?? 0, max: 100, icon: "activity", tone: "blue" },
        { label: "动态指令", value: (s.issues || {})["dynamic-observed"] || 0, icon: "search", tone: "cyan" },
      ]
    })
    const weakCommands = computed(() => quality.value.weakCommands || [])
    const recommendations = computed(() => quality.value.recommendations || [])
    const recommendationSections = computed(() => {
      const rows = records<RecommendationItem>(recommendation.value?.results).map((item: RecommendationItem, index: number) => ({ ...item, _order: index + 1 }))
      const grouped = groupBy(rows, (item: RecommendationItem) => `${item.sectionRank ?? 99}:${item.sectionLabel || "其他功能"}`)
      return Object.entries(grouped).map(([key, items]) => {
        const [, title] = key.split(":")
        return { key, title, items }
      })
    })

    const knowledgeSummary = computed(() => {
      const stats = digest.value.stats || {}
      if (draft.enabled !== "true") return { tone: "off", title: "指令知识库尚未开启", detail: "开启后，助手才能根据普通中文问题推荐机器人指令。" }
      if (!Number(stats.commands || 0)) return { tone: "warn", title: "知识库已开启，等待首次扫描", detail: "执行一次扫描后，助手会整理当前机器人中可用的指令和示例。" }
      return { tone: "ready", title: `助手已经认识 ${stats.commands || 0} 条指令`, detail: `来自 ${stats.plugins || 0} 个插件；用户可以直接描述需求，不必先记住准确命令。` }
    })

    async function search() {
      try {
        const result = await request(`/api/knowledge?q=${encodeURIComponent(draft.query || "")}`) as KnowledgeApiResponse
        store.knowledge = result
        toast("检索完成")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function loadBases() {
      try {
        bases.value = ((await request("/api/knowledge/bases")) as KnowledgeApiResponse).bases || []
        if (!bases.value.some(base => base.id === selectedBaseId.value)) selectedBaseId.value = bases.value[0]?.id || ""
        draft.sourceBaseId = selectedBaseId.value
        const builtin = bases.value.find(base => base.id === "builtin-commands")
        draft.commandEmbeddingModel = builtin?.config?.embeddingModel || ""
        draft.commandEmbeddingDimensions = Number(builtin?.config?.dimensions || 1024)
        await loadBaseDetails()
      } catch (err) { toast(errorMessage(err)) }
    }

    async function loadBaseDetails() {
      const baseId = selectedBaseId.value
      if (!baseId) {
        documents.value = []
        grants.value = []
        indexJobs.value = []
        indexJobPagination.value = { page: 1, pageSize: 10, total: 0 }
        stopIndexPolling()
        return
      }
      try {
        const encoded = encodeURIComponent(baseId)
        const [documentResultRaw, grantResultRaw, jobResultRaw] = await Promise.all([
          request(`/api/knowledge/bases/${encoded}/documents?q=${encodeURIComponent(documentQuery.value)}`),
          request(`/api/knowledge/bases/${encoded}/grants`),
          request(`/api/knowledge/index-jobs?baseId=${encoded}&page=${indexJobPage.value}&pageSize=10`),
        ])
        const documentResult = documentResultRaw as KnowledgeApiResponse
        const grantResult = grantResultRaw as KnowledgeApiResponse
        const jobResult = jobResultRaw as KnowledgeApiResponse
        if (selectedBaseId.value !== baseId) return
        documents.value = documentResult.documents || []
        grants.value = grantResult.grants || []
        indexJobs.value = jobResult.jobs || []
        indexJobPagination.value = jobResult.pagination || { page: indexJobPage.value, pageSize: 10, total: indexJobs.value.length }
        syncIndexPolling()
      } catch (err) { toast(errorMessage(err)) }
    }

    async function selectBase(baseId: string): Promise<void> {
      selectedBaseId.value = baseId
      indexJobPage.value = 1
      draft.sourceBaseId = baseId
      retrievalResults.value = []
      await loadBaseDetails()
    }

    function openBaseEditor(base: KnowledgeBase | null = null): void {
      draft.baseId = base?.id || ""
      draft.baseName = base?.name || ""
      draft.baseDescription = base?.description || ""
      draft.baseEmbeddingModel = base?.config?.embeddingModel || ""
      draft.baseDimensions = Number(base?.config?.dimensions || 0)
      draft.baseAutoRetrieve = String(Boolean(base?.auto_retrieve))
      draft.baseTriggerWords = (base?.config?.triggerWords || []).join(", ")
      showBaseDrawer.value = true
    }

    async function saveBase() {
      try {
        if (!draft.baseName.trim()) throw new Error("请输入知识库名称")
        const payload = {
          name: draft.baseName.trim(),
          description: draft.baseDescription,
          autoRetrieve: draft.baseAutoRetrieve === "true",
          triggerWords: splitTokens(draft.baseTriggerWords),
          config: { embeddingModel: draft.baseEmbeddingModel, dimensions: Number(draft.baseDimensions || 0) },
        }
        const editing = Boolean(draft.baseId)
        const result = await request(editing ? `/api/knowledge/bases/${encodeURIComponent(draft.baseId)}` : "/api/knowledge/bases", {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        })
        selectedBaseId.value = (result as KnowledgeApiResponse).base?.id || selectedBaseId.value
        showBaseDrawer.value = false
        await loadBases()
        toast(editing ? "知识库设置已保存" : "知识库已创建，默认仅主人可访问")
      } catch (err) { toast(errorMessage(err)) }
    }

    async function createBase() { openBaseEditor() }

    async function openDocumentEditor(item: KnowledgeDocument | null = null): Promise<void> {
      if (selectedBase.value?.protected) return
      draft.documentId = item?.id || ""
      draft.sourceName = item?.title || ""
      draft.sourceContent = ""
      if (item?.id) {
        try {
          const result = await request(`/api/knowledge/bases/${encodeURIComponent(selectedBaseId.value)}/documents/${encodeURIComponent(item.id)}`) as KnowledgeApiResponse
          draft.sourceName = result.document?.title || item.title || ""
          draft.sourceContent = result.document?.content || ""
        } catch (err) { return toast(errorMessage(err)) }
      }
      showDocumentDrawer.value = true
    }

    async function ingestSource() {
      try {
        const baseId = selectedBaseId.value || draft.sourceBaseId
        if (!baseId || !draft.sourceContent.trim()) throw new Error("请选择知识库并输入内容")
        const editing = Boolean(draft.documentId)
        const url = editing
          ? `/api/knowledge/bases/${encodeURIComponent(baseId)}/documents/${encodeURIComponent(draft.documentId)}`
          : `/api/knowledge/bases/${encodeURIComponent(baseId)}/sources/text`
        await request(url, { method: editing ? "PATCH" : "POST", body: JSON.stringify({ title: draft.sourceName.trim() || "直接文本", name: draft.sourceName.trim() || "直接文本", content: draft.sourceContent }) })
        draft.sourceName = ""
        draft.sourceContent = ""
        draft.documentId = ""
        showDocumentDrawer.value = false
        await loadBases()
        toast(editing ? "知识内容已更新并重新分块" : "知识内容已导入，可立即全文检索")
      } catch (err) { toast(errorMessage(err)) }
    }

    async function deleteDocument(item: KnowledgeDocument): Promise<void> {
      const accepted = await confirmAction({ title: `删除内容“${item.title}”？`, message: "会同步移除全文检索和向量索引中的对应分块。", detail: item.preview || item.id, confirmText: "确认删除内容" })
      if (!accepted) return
      try {
        await request(`/api/knowledge/bases/${encodeURIComponent(selectedBaseId.value)}/documents/${encodeURIComponent(item.id)}`, { method: "DELETE" })
        await loadBases()
        toast("知识内容已删除")
      } catch (err) { toast(errorMessage(err)) }
    }

    async function testRetrieval() {
      try {
        if (!selectedBaseId.value || !draft.retrievalQuery.trim()) throw new Error("请输入要测试的问题")
        baseBusy.value = true
        const result = await request(`/api/knowledge/bases/${encodeURIComponent(selectedBaseId.value)}/search`, { method: "POST", body: JSON.stringify({ query: draft.retrievalQuery.trim(), limit: 8, useVector: true }) }) as KnowledgeApiResponse
        retrievalResults.value = result.results || []
        toast(retrievalResults.value.length ? `召回 ${retrievalResults.value.length} 条内容` : "没有召回内容，请检查原文或索引状态")
      } catch (err) { toast(errorMessage(err)) } finally { baseBusy.value = false }
    }

    async function rebuildBase() {
      try {
        if (!selectedBaseId.value) return
        baseBusy.value = true
        const result = await request(`/api/knowledge/bases/${encodeURIComponent(selectedBaseId.value)}/rebuild`, { method: "POST", body: JSON.stringify({ immediate: false, start: true }) }) as KnowledgeApiResponse
        indexJobPage.value = 1
        await loadBases()
        toast(result.result?.status === "fts_ready" ? "当前使用全文检索，无需构建向量" : "索引已开始构建，页面会显示实时进度")
      } catch (err) { toast(errorMessage(err)) } finally { baseBusy.value = false }
    }

    function openGrantEditor() {
      draft.grantPrincipalType = "role"
      draft.grantPrincipalId = "user"
      draft.grantGroupId = ""
      draft.grantAccess = "allow"
      showGrantDrawer.value = true
    }

    async function saveGrant() {
      try {
        if (!draft.grantPrincipalId.trim()) throw new Error("请输入授权主体")
        const result = await request(`/api/knowledge/bases/${encodeURIComponent(selectedBaseId.value)}/grants`, { method: "POST", body: JSON.stringify({
          principalType: draft.grantPrincipalType,
          principalId: draft.grantPrincipalId.trim(),
          groupId: draft.grantGroupId.trim(),
          access: draft.grantAccess,
        }) }) as KnowledgeApiResponse
        grants.value = result.grants || []
        showGrantDrawer.value = false
        toast("授权规则已保存；拒绝规则优先于允许规则")
      } catch (err) { toast(errorMessage(err)) }
    }

    async function deleteGrant(item: KnowledgeGrant): Promise<void> {
      const accepted = await confirmAction({ title: "删除这条授权规则？", message: "删除后将重新按其他匹配规则判断访问权限。", detail: `${item.principal_type}:${item.principal_id}`, confirmText: "确认删除规则" })
      if (!accepted) return
      try {
        const result = await request(`/api/knowledge/bases/${encodeURIComponent(selectedBaseId.value)}/grants/${encodeURIComponent(item.id)}`, { method: "DELETE" }) as KnowledgeApiResponse
        grants.value = result.grants || []
        toast("授权规则已删除")
      } catch (err) { toast(errorMessage(err)) }
    }

    async function retryJob(item: IndexJob): Promise<void> {
      try {
        await request(`/api/knowledge/index-jobs/${encodeURIComponent(item.id)}/retry`, { method: "POST", body: "{}" })
        await loadBaseDetails()
        toast("索引任务已重新排队")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function cancelIndexJob(item: IndexJob): Promise<void> {
      const accepted = await confirmAction({ title: "取消这条索引任务？", message: "当前构建会停止继续执行，已生效的旧索引不会受影响。", detail: shortId(item.id), confirmText: "确认取消任务" })
      if (!accepted) return
      try {
        await request(`/api/knowledge/index-jobs/${encodeURIComponent(item.id)}/cancel`, { method: "POST", body: "{}" })
        await refreshIndexJobsOnly({ silent: false })
        await loadBases()
        toast("索引任务已取消")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function deleteIndexJob(item: IndexJob): Promise<void> {
      const accepted = await confirmAction({ title: "删除这条索引任务记录？", message: "只删除任务历史记录及其未发布的过渡向量数据，不会影响当前生效的向量索引。", detail: shortId(item.id), confirmText: "确认删除任务" })
      if (!accepted) return
      try {
        await request(`/api/knowledge/index-jobs/${encodeURIComponent(item.id)}`, { method: "DELETE" })
        if (indexJobs.value.length === 1 && indexJobPage.value > 1) indexJobPage.value--
        await refreshIndexJobsOnly({ silent: false })
        toast("索引任务记录已删除")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function changeIndexJobPage(page: number): Promise<void> {
      const totalPages = Math.max(1, Math.ceil(Number(indexJobPagination.value.total || 0) / 10))
      indexJobPage.value = Math.max(1, Math.min(totalPages, Number(page) || 1))
      await refreshIndexJobsOnly({ silent: false })
    }
    async function deleteBase(base: KnowledgeBase): Promise<void> {
      const accepted = await confirmAction({ title: `删除知识库“${base.name}”？`, message: "会删除该库的文档、索引和授权，内置指令库不可删除。", detail: base.id, confirmText: "确认删除知识库" })
      if (!accepted) return
      try {
        await request(`/api/knowledge/bases/${encodeURIComponent(base.id)}`, { method: "DELETE" })
        if (selectedBaseId.value === base.id) selectedBaseId.value = ""
        await loadBases()
        toast("知识库已删除")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function rescan() {
      try {
        const result = await request("/api/knowledge/rescan", { method: "POST", body: "{}" }) as KnowledgeApiResponse
        await refreshTab("knowledge")
        await loadBases()
        const comparison = result.sync?.comparison || {}
        const changed = Number(comparison.added || 0) + Number(comparison.updated || 0) + Number(comparison.deleted || 0)
        const manualNote = Number(comparison.preservedManual || 0) ? `；保留 ${comparison.preservedManual} 条人工修订` : ""
        if (!result.sync?.changed) toast(`扫描完成，共 ${result.commands || 0} 条；未发现插件侧变更，未重建向量${manualNote}`)
        else if (result.sync?.index) toast(`扫描完成：检测到 ${changed} 处插件变更，已开始重建向量${manualNote}`)
        else toast(`扫描完成：检测到 ${changed} 处插件变更，已更新全文检索；未配置向量模型${manualNote}`)
      } catch (err) { toast(errorMessage(err)) }
    }

    async function saveCommandRetrieval() {
      try {
        const result = await request("/api/knowledge/bases/builtin-commands/retrieval", {
          method: "PATCH",
          body: JSON.stringify({
            embeddingModel: draft.commandEmbeddingModel,
            dimensions: Number(draft.commandEmbeddingDimensions || 1024),
          }),
        }) as KnowledgeApiResponse
        await loadBases()
        toast(result.index?.status === "queued" ? "已保存，语义索引已排队" : (draft.commandEmbeddingModel ? "已保存向量模型，等待构建索引" : "已切回全文检索"))
      } catch (err) { toast(errorMessage(err)) }
    }

    function openCommandMaintenance(base: KnowledgeBase | null = null): void {
      if (base?.id !== "builtin-commands") return
      if (selectedBaseId.value !== base.id) selectBase(base.id)
      draft.commandEmbeddingModel = base.config?.embeddingModel || ""
      draft.commandEmbeddingDimensions = Number(base.config?.dimensions || 1024)
      activeMaintenancePane.value = "commands"
      showCommandMaintenanceDrawer.value = true
    }
    async function saveCapture() {
      try {
        await saveConfigPatch({
          "knowledge.enabled": draft.enabled === "true",
          "knowledge.dynamicCapture": draft.dynamicCapture === "true",
          "knowledge.commandPrefixes": splitTokens(draft.commandPrefixes || "#,/,*"),
          "knowledge.captureGroups": draft.captureGroups === "true",
          "knowledge.capturePrivate": draft.capturePrivate === "true",
          "knowledge.maxEvents": Number(draft.maxEvents || 1000),
        })
      } catch (err) { toast(errorMessage(err)) }
    }
    async function saveExclusions() {
      try {
        await saveConfigPatch({
          "knowledge.excludedPlugins": splitTokens(draft.excludedPlugins),
          "knowledge.excludedCommands": String(draft.excludedCommands || "").split(/[\n,，]+/).map(item => item.trim()).filter(Boolean),
        }, "knowledge-exclusions")
        showExclusionDrawer.value = false
        await rescan()
      } catch (err) { toast(errorMessage(err)) }
    }
    function canEditBuiltinCommand(item: KnowledgeItem = { id: "" }): boolean {
      return selectedBase.value?.id === "builtin-commands" && Boolean(item?.metadata?.commandId)
    }
    async function openBuiltinCommandEditor(item: KnowledgeItem): Promise<void> {
      if (!canEditBuiltinCommand(item)) return
      try {
        baseBusy.value = true
        const commandId = String(item.metadata?.commandId || "")
        const baseId = encodeURIComponent(selectedBaseId.value)
        const [commandResultRaw, documentResultRaw] = await Promise.all([
          request(`/api/knowledge/commands/${encodeURIComponent(commandId)}`),
          request(`/api/knowledge/bases/${baseId}/documents/${encodeURIComponent(item.id)}`),
        ])
        const commandResult = commandResultRaw as KnowledgeApiResponse
        const documentResult = documentResultRaw as KnowledgeApiResponse
        const command = (commandResult.command || { id: commandId }) as KnowledgeItem
        openManualEditor(command, {
          sourceCommandId: command.overridesCommandId || commandId,
          sourceRuleKey: command.overridesSourceRuleKey || command.sourceRuleKey || "",
          sourceOrigin: command.origin || null,
          body: command.body || documentResult.document?.content || "",
        })
      } catch (err) { toast(errorMessage(err)) } finally { baseBusy.value = false }
    }
    function openManualEditor(item: KnowledgeItem | null = null, options: KnowledgeRecord = {}): void {
      draft.manualId = item?.manual ? (item.id || "") : ""
      draft.manualSourceCommandId = options.sourceCommandId ?? (item && !item.manual ? item.id || "" : item?.overridesCommandId || "")
      draft.manualSourceRuleKey = options.sourceRuleKey ?? (item && !item.manual ? item.sourceRuleKey || "" : item?.overridesSourceRuleKey || "")
      draft.manualSourceOrigin = options.sourceOrigin ?? (draft.manualSourceCommandId ? item?.origin || null : null)
      draft.manualPluginName = item?.pluginName || item?.pluginKey || "手动知识"
      draft.manualCommand = item?.suggestedCommand || item?.example || "#体力"
      draft.manualDescription = item?.description || item?.summary || ""
      draft.manualBody = options.body ?? item?.body ?? ""
      draft.manualExamples = (item?.examples || []).join(", ")
      draft.manualParameters = (item?.parameterHints || []).map((value: unknown) => typeof value === "string" ? value : record(value).name).filter(Boolean).join(", ")
      draft.manualNotes = ""
      showManualDrawer.value = true
    }
    async function saveManual() {
      try {
        if (!draft.manualCommand.trim()) throw new Error("请输入推荐指令")
        const result = await request("/api/knowledge/manual-command", {
          method: "POST",
          body: JSON.stringify({
            id: draft.manualId || undefined,
            sourceCommandId: draft.manualSourceCommandId || undefined,
            sourceRuleKey: draft.manualSourceRuleKey || undefined,
            sourceOrigin: draft.manualSourceOrigin || undefined,
            pluginName: draft.manualPluginName.trim() || "手动知识",
            suggestedCommand: draft.manualCommand.trim(),
            description: draft.manualDescription,
            body: draft.manualBody,
            examples: splitTokens(draft.manualExamples),
            parameterHints: splitTokens(draft.manualParameters),
            notes: draft.manualNotes,
          }),
        }) as KnowledgeApiResponse
        store.knowledge = { ...asRecord(store.knowledge), stats: result.stats, digest: result.digest, quality: result.quality }
        showManualDrawer.value = false
        await loadBases()
        toast(result.sync?.index ? "已保存，正文已重新分块并开始重建向量" : "已保存，正文已重新分块；当前使用全文检索")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function requestDeleteCommand(item: KnowledgeItem): Promise<void> {
      const candidate = { id: item.id, label: item.suggestedCommand || item.example || item.id }
      const accepted = await confirmAction({
        title: `删除知识条目“${candidate.label}”？`,
        message: "只会移除本插件中的手动或动态知识条目，不会删除其他插件的实际命令。",
        detail: candidate.id,
        confirmText: "确认删除条目",
      })
      if (!accepted) return
      try {
        const result = await request(`/api/knowledge/commands/${encodeURIComponent(candidate.id)}`, { method: "DELETE" }) as KnowledgeApiResponse
        store.knowledge = { ...asRecord(store.knowledge), stats: result.stats, digest: result.digest, quality: result.quality }
        toast(`已删除知识条目：${candidate.label}`)
      } catch (err) { toast(errorMessage(err)) }
    }
    onUnmounted(stopIndexPolling)
    loadBases()

    function recConfidenceTone(confidence: string): string {
      return confidence === "high" ? "" : confidence === "low" ? "risk-medium" : ""
    }
    return {
      cfg, knowledge, digest, quality, recommendation, draft,
      showManualDrawer, showCaptureDrawer, showExclusionDrawer, showBaseDrawer, showDocumentDrawer, showGrantDrawer, showCommandMaintenanceDrawer,
      activeMaintenancePane, maintenancePaneItems, bases, selectedBaseId, selectedBase, baseQuery, filteredBases, activeBasePane, basePaneItems,
      documents, grants, indexJobs, indexJobPagination, retrievalResults, documentQuery, baseBusy, embeddingModelOptions, activeIndexJob, latestIndexJob, visibleIndexJob,
      knowledgeSummary,
      digestMetrics, digestPills, pluginPills, qualityMetrics, weakCommands, recommendations,
      recommendationSections,
      canDelete, documentOrigin, canEditBuiltinCommand, shortId, recConfidenceTone, baseHealth, jobLabel, jobProgress, jobProgressLabel, jobProgressTone,
      BOOL_OPTIONS, BOOL_OFF_OPTIONS,
      search, rescan, openCommandMaintenance, loadBases, loadBaseDetails, selectBase, createBase, openBaseEditor, saveBase, openDocumentEditor, ingestSource, deleteDocument,
      testRetrieval, rebuildBase, openGrantEditor, saveGrant, deleteGrant, retryJob, cancelIndexJob, deleteIndexJob, changeIndexJobPage, deleteBase, saveCapture, saveExclusions, openManualEditor, openBuiltinCommandEditor, saveManual, requestDeleteCommand, saveCommandRetrieval,
    }
  },
  template: `
    <div class="stack">
      <SideDrawer
        :open="showBaseDrawer"
        :title="draft.baseId ? '编辑知识库' : '新建知识库'"
        subtitle="先建立清晰的库边界，再添加内容和授权。"
        icon="database"
        width="560px"
        @close="showBaseDrawer = false"
      >
        <div class="form-grid">
          <Field label="名称" v-model="draft.baseName" placeholder="例如：产品帮助中心" />
          <Field label="检索方式" type="select" :options="embeddingModelOptions" v-model="draft.baseEmbeddingModel" tip="不选模型也可使用全文检索；选择 embedding 模型后可进行语义召回。" />
          <Field label="向量维度" type="number" v-model="draft.baseDimensions" placeholder="0 表示采用模型默认值" />
          <Field label="自动召回" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.baseAutoRetrieve" />
        </div>
        <Field label="描述" type="textarea" rows="4" v-model="draft.baseDescription" placeholder="说明收录范围、维护人和适用场景" />
        <Field label="自动召回触发词" hint="逗号或换行" v-model="draft.baseTriggerWords" placeholder="例如：售后, 保修, 退换货" />
        <div class="hint-banner ok"><Icon name="info" :size="14" /><span>新库默认只允许主人访问；可在“授权”页签中逐步开放给角色、用户或群。</span></div>
        <template #actions>
          <button class="btn outline" type="button" @click="showBaseDrawer = false"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary" type="button" @click="saveBase"><Icon name="save" :size="14" />{{ draft.baseId ? '保存设置' : '创建知识库' }}</button>
        </template>
      </SideDrawer>

      <SideDrawer
        :open="showDocumentDrawer"
        :title="draft.documentId ? '修正知识内容' : '添加知识内容'"
        subtitle="保存后会立即重建全文分块，并为已配置的语义索引排队。"
        icon="file"
        width="720px"
        @close="showDocumentDrawer = false"
      >
        <Field label="内容标题" v-model="draft.sourceName" placeholder="给维护者看的清晰标题" />
        <Field label="原始内容" type="textarea" rows="18" v-model="draft.sourceContent" placeholder="粘贴文本或 Markdown；这里展示并保存完整原文" />
        <div class="hint-banner" :class="draft.sourceContent.trim() ? 'ok' : 'warn'"><Icon :name="draft.sourceContent.trim() ? 'check' : 'alert'" :size="14" /><span>{{ draft.sourceContent.trim() ? '保存后可立即全文检索。' : '内容不能为空。' }}</span></div>
        <template #actions>
          <button class="btn outline" type="button" @click="showDocumentDrawer = false"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary" type="button" @click="ingestSource"><Icon name="save" :size="14" />{{ draft.documentId ? '保存并重新分块' : '添加并建立索引' }}</button>
        </template>
      </SideDrawer>

      <SideDrawer
        :open="showGrantDrawer"
        title="添加授权规则"
        subtitle="可以按角色、单个用户、群或群内用户控制访问。"
        icon="key"
        width="540px"
        @close="showGrantDrawer = false"
      >
        <div class="form-grid">
          <Field label="主体类型" type="select" :options="[
            { value: 'role', label: '角色' }, { value: 'user', label: '单个用户' },
            { value: 'group', label: '群' }, { value: 'user_group', label: '群内用户' }
          ]" v-model="draft.grantPrincipalType" />
          <Field label="主体 ID" v-model="draft.grantPrincipalId" placeholder="角色可填 user / groupAdmin / master" />
          <Field label="限定群号" v-model="draft.grantGroupId" placeholder="留空表示不限定群" />
          <Field label="规则效果" type="select" :options="[{ value: 'allow', label: '允许访问' }, { value: 'deny', label: '拒绝访问（优先）' }]" v-model="draft.grantAccess" />
        </div>
        <div class="hint-banner warn"><Icon name="alert" :size="14" /><span>只要同一用户命中一条拒绝规则，该知识库就不会对其开放。</span></div>
        <template #actions>
          <button class="btn outline" type="button" @click="showGrantDrawer = false"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary" type="button" @click="saveGrant"><Icon name="save" :size="14" />保存规则</button>
        </template>
      </SideDrawer>

      <SideDrawer
        :open="showManualDrawer"
        :title="draft.manualSourceCommandId ? '编辑内置指令说明' : '补充指令说明'"
        :subtitle="draft.manualSourceCommandId ? '保存为人工覆盖层：后续重扫会更新其他指令，但不会覆盖这里的指令与正文。' : '补齐扫描不到或描述较弱的指令；手动说明会保留，不会被后续运行态扫描覆盖。'"
        :icon="draft.manualSourceCommandId ? 'pencil' : 'plus'"
        width="520px"
        @close="showManualDrawer = false"
      >
        <div class="form-grid">
          <Field label="所属插件" v-model="draft.manualPluginName" tip="同一插件下，同一条推荐指令只保留一份；再次保存会覆盖旧说明，并优先于运行态扫描。" />
          <Field label="推荐指令" v-model="draft.manualCommand" />
          <Field label="用途摘要" v-model="draft.manualDescription" />
          <Field label="示例" hint="逗号或换行" v-model="draft.manualExamples" />
          <Field label="参数提示" v-model="draft.manualParameters" />
        </div>
        <Field label="正文" type="textarea" rows="8" v-model="draft.manualBody" placeholder="填写给 AI 检索和理解的完整说明" />
        <Field label="备注" type="textarea" v-model="draft.manualNotes" placeholder="补充别名、限制或使用场景" />
        <div v-if="draft.manualSourceCommandId" class="hint-banner ok"><Icon name="info" :size="14" /><span>这只修改内置指令知识库，不会改动插件源码或实际触发规则；保存后会重新分块，并在已配置向量模型时自动重建索引。</span></div>
        <template #actions>
          <button class="btn outline" type="button" @click="showManualDrawer = false"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary" type="button" @click="saveManual"><Icon name="save" :size="14" />保存并更新索引</button>
        </template>
      </SideDrawer>

      <SideDrawer
        :open="showExclusionDrawer"
        title="检索排除规则"
        subtitle="被排除的插件或指令仍可正常运行，只是不再进入 AI 指令检索。"
        icon="filter"
        width="620px"
        @close="showExclusionDrawer = false"
      >
        <div class="hint-banner ok"><Icon name="info" :size="14" /><span>适合隐藏管理命令、实验插件或不希望 AI 主动推荐的危险指令。</span></div>
        <Field label="排除整个插件" hint="逗号或换行分隔" type="textarea" rows="5" v-model="draft.excludedPlugins" placeholder="例如：群管理插件, 调试工具" />
        <Field label="只排除某条指令" hint="每行：插件名::指令" type="textarea" rows="7" v-model="draft.excludedCommands" placeholder="例如：群管理插件::#批量禁言" />
        <template #actions>
          <button class="btn outline" type="button" @click="showExclusionDrawer = false"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary small" type="button" @click="saveExclusions"><Icon name="save" :size="14" />保存并重建检索</button>
        </template>
      </SideDrawer>

      <SideDrawer
        :open="showCaptureDrawer"
        title="采集策略"
        subtitle="配置指令知识库的动态捕获和采集范围。"
        icon="filter"
        width="560px"
        @close="showCaptureDrawer = false"
      >
        <div class="form-grid">
          <Field label="启用知识库" type="select" :options="BOOL_OPTIONS" v-model="draft.enabled" />
          <Field label="动态捕获指令" type="select" :options="BOOL_OPTIONS" v-model="draft.dynamicCapture" tip="自动观察聊天中出现的新指令" />
          <Field label="指令前缀" v-model="draft.commandPrefixes" />
          <Field label="采集群聊指令" type="select" :options="BOOL_OPTIONS" v-model="draft.captureGroups" />
          <Field label="采集私聊指令" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.capturePrivate" />
          <Field label="最多动态事件" type="number" v-model="draft.maxEvents" />
        </div>
        <template #actions>
          <button class="btn outline" type="button" @click="showCaptureDrawer = false"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary small" type="button" @click="saveCapture"><Icon name="save" :size="14" />保存采集策略</button>
        </template>
      </SideDrawer>

      <KnowledgeCommandMaintenance
        :open="showCommandMaintenanceDrawer"
        :active-pane="activeMaintenancePane"
        :pane-items="maintenancePaneItems"
        :draft="draft"
        :digest-metrics="digestMetrics"
        :digest-pills="digestPills"
        :plugin-pills="pluginPills"
        :recommendation-sections="recommendationSections"
        :knowledge-summary="knowledgeSummary"
        :embedding-model-options="embeddingModelOptions"
        :active-index-job="activeIndexJob"
        :visible-index-job="visibleIndexJob"
        :quality-metrics="qualityMetrics"
        :recommendations="recommendations"
        :weak-commands="weakCommands"
        :job-progress-tone="jobProgressTone"
        :job-progress-label="jobProgressLabel"
        :job-progress="jobProgress"
        :job-label="jobLabel"
        :rec-confidence-tone="recConfidenceTone"
        :can-delete="canDelete"
        @close="showCommandMaintenanceDrawer = false"
        @set-pane="activeMaintenancePane = $event"
        @open-exclusion="showExclusionDrawer = true"
        @open-manual="openManualEditor"
        @open-manual-item="openManualEditor"
        @search="search"
        @rescan="rescan"
        @open-capture="showCaptureDrawer = true"
        @save-command-retrieval="saveCommandRetrieval"
        @request-delete-command="requestDeleteCommand"
      />

      <KnowledgeBaseWorkspace
        :filtered-bases="filteredBases"
        :bases="bases"
        :selected-base-id="selectedBaseId"
        :selected-base="selectedBase"
        :base-query="baseQuery"
        :base-pane-items="basePaneItems"
        :active-base-pane="activeBasePane"
        :documents="documents"
        :grants="grants"
        :index-jobs="indexJobs"
        :index-job-pagination="indexJobPagination"
        :retrieval-results="retrievalResults"
        :document-query="documentQuery"
        :draft="draft"
        :base-busy="baseBusy"
        :active-index-job="activeIndexJob"
        :base-health="baseHealth"
        :document-origin="documentOrigin"
        :can-edit-builtin-command="canEditBuiltinCommand"
        :job-label="jobLabel"
        :job-progress="jobProgress"
        :job-progress-tone="jobProgressTone"
        :job-progress-label="jobProgressLabel"
        :short-id="shortId"
        @refresh-bases="loadBases"
        @create-base="createBase"
        @select-base="selectBase"
        @open-command-maintenance="openCommandMaintenance"
        @open-base-editor="openBaseEditor"
        @rebuild-base="rebuildBase"
        @delete-base="deleteBase"
        @set-base-pane="activeBasePane = $event"
        @update-base-query="baseQuery = $event"
        @load-base-details="loadBaseDetails"
        @update-document-query="documentQuery = $event"
        @open-document-editor="openDocumentEditor"
        @open-builtin-command="openBuiltinCommandEditor"
        @delete-document="deleteDocument"
        @test-retrieval="testRetrieval"
        @open-grant-editor="openGrantEditor"
        @delete-grant="deleteGrant"
        @retry-job="retryJob"
        @cancel-job="cancelIndexJob"
        @delete-job="deleteIndexJob"
        @change-job-page="changeIndexJobPage"
      />
    </div>
  `,
}
