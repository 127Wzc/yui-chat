import { computed, onUnmounted, reactive, ref, watch } from "vue"
import { confirmAction, store, request, toast, saveConfigPatch, refreshTab, setDirtyScope } from "../../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { splitTokens, shortId } from "../../shared/format.js"
import { KnowledgeBaseWorkspace } from "./knowledge-base-workspace.js"
import { KnowledgeCommandMaintenance } from "./knowledge-command-maintenance.js"
import { KnowledgeCommandEditor } from "./knowledge-command-editor.js"

const BOOL_OFF_OPTIONS = [{ value: "false", label: "关闭" }, { value: "true", label: "开启" }]

/** 管理台知识库的 API 结构会随索引能力扩展；这里将边界收敛成页面内部模型。 */
type KnowledgeRecord = Record<string, any>

interface KnowledgeConfig extends KnowledgeRecord {
  enabled?: boolean
  commandPrefixes?: string[]
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

interface KnowledgeApiResponse extends KnowledgeRecord {
  trace?: KnowledgeRecord
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
  commandPrefixes: string
  baseName: string
  baseDescription: string
  baseFieldDescription: string
  baseEmbeddingModel: string
  baseDimensions: number
  retrievalMinRelevance: number | string
  retrievalRerankEnabled: string
  retrievalRerankModel: string
  retrievalRerankResultLimit: number
  retrievalRerankMinScore: number | string
  commandEmbeddingModel: string
  commandRetrievalMode: string
  commandFieldDescription: string
  commandDescription: string
  commandEmbeddingDimensions: number
  baseId: string
  baseAutoRetrieve: string
  baseTriggerWords: string
  sourceBaseId: string
  sourceName: string
  sourceContent: string
  documentId: string
  retrievalQuery: string
  retrievalResultLimit: number
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

function documentOrigin(item: KnowledgeItem = { id: "" }) {
  const origin = item?.metadata?.origin || {}
  const command = item?.metadata?.command || {}
  const type = origin.type || (item.source_type === "command" ? "runtime-plugin-rule" : "")
  if (!type) return null
  const labels: Record<string, string> = {
    "runtime-plugin-rule": "Yunzai 插件规则",
    "loaded-plugin-rule": "已加载插件规则",
    manual: "管理台手动补充",
    observed: "动态观察",
  }
  return {
    label: origin.label || labels[type] || "知识来源",
    plugin: command.pluginName || origin.pluginName || origin.pluginKey || command.pluginKey || "未提供插件",
    fileLabel: origin.file ? "文件" : "注册来源",
    file: origin.file || origin.registrationKey || command.registrationKey || command.origin?.registrationKey || "未提供来源",
    method: origin.method || command.fnc || "未提供方法",
  }
}

export const KnowledgeTab = {
  name: "KnowledgeTab",
  components: { KnowledgeBaseWorkspace, KnowledgeCommandMaintenance, KnowledgeCommandEditor },
  setup() {
    const cfg = computed<KnowledgeConfig>(() => record<KnowledgeRecord>(store.config).knowledge as KnowledgeConfig || {})
    const knowledge = computed<KnowledgeSlice>(() => record<KnowledgeSlice>(store.knowledge))
    const digest = computed<KnowledgeDigest>(() => knowledge.value.digest || {})
    const quality = computed<KnowledgeQuality>(() => knowledge.value.quality || {})
    const recommendation = computed<KnowledgeRecord | null>(() => knowledge.value.recommendation || null)
    const showManualDrawer = ref(false)
    const currentCommand = ref<KnowledgeRecord>({})
    const commandRevision = ref(0)
    const showBaseDrawer = ref(false)
    const showDocumentDrawer = ref(false)
    const showGrantDrawer = ref(false)
    const showCommandMaintenanceDrawer = ref(false)
    const bases = ref<KnowledgeBase[]>([])
    let contentRevision = 0
    let detailRevision = 0
    const selectedBaseId = ref("")
    const baseQuery = ref("")
    const activeBasePane = ref("documents")
    const documents = ref<KnowledgeDocument[]>([])
    const grants = ref<KnowledgeGrant[]>([])
    const indexJobs = ref<IndexJob[]>([])
    const indexInspection = ref<KnowledgeRecord | null>(null)
    const indexJobPage = ref(1)
    const indexJobPagination = ref<IndexPagination>({ page: 1, pageSize: 10, total: 0 })
    let indexPollTimer: ReturnType<typeof setInterval> | null = null
    let indexPollBusy = false
    const retrievalResults = ref<KnowledgeItem[]>([])
    const retrievalDiagnostics = ref<KnowledgeRecord | null>(null)
    const retrievalTrace = ref<KnowledgeRecord | null>(null)
    let retrievalRevision = 0
    watch(selectedBaseId, () => {
      retrievalRevision++
      retrievalResults.value = []
      retrievalDiagnostics.value = null
      retrievalTrace.value = null
    }, { flush: "sync" })
    const documentQuery = ref("")
    const documentSort = ref("updated")
    const baseBusy = ref(false)
    const activeMaintenancePane = ref("commands")
    const globalSettingsOpen = ref(false)
    const globalSettingsBusy = ref(false)
    const maintenancePaneItems = [
      { value: "commands", label: "指令管理", icon: "book" },
      { value: "settings", label: "设置", icon: "sliders" },
    ]

    const draft = reactive<KnowledgeDraft>({
      query: "怎么查体力",
      enabled: String(Boolean(cfg.value.enabled)),
      commandPrefixes: (cfg.value.commandPrefixes || ["#", "/", "*"]).join(","),
      baseName: "",
      baseDescription: "",
      baseFieldDescription: "",
      baseEmbeddingModel: "",
      baseDimensions: 0,
      retrievalMinRelevance: cfg.value.retrieval?.minRelevance ?? 0.55,
      retrievalRerankEnabled: String(cfg.value.retrieval?.rerankEnabled === true),
      retrievalRerankModel: cfg.value.retrieval?.rerankModel || "",
      retrievalRerankResultLimit: cfg.value.retrieval?.rerankResultLimit ?? 5,
      retrievalRerankMinScore: (cfg.value.retrieval?.rerankMinScore ?? "") as number | string,
      commandEmbeddingModel: "",
      commandRetrievalMode: "hybrid",
      commandFieldDescription: "",
      commandDescription: "",
      commandEmbeddingDimensions: 0,
      baseId: "",
      baseAutoRetrieve: "false",
      baseTriggerWords: "",
      sourceBaseId: "",
      sourceName: "",
      sourceContent: "",
      documentId: "",
      retrievalQuery: "",
      retrievalResultLimit: cfg.value.retrieval?.resultLimit ?? 5,
      grantPrincipalType: "role",
      grantPrincipalId: "user",
      grantGroupId: "",
      grantAccess: "allow",
    })

    const selectedBase = computed(() => bases.value.find(base => base.id === selectedBaseId.value) || null)
    const globalResultLimit = computed(() => cfg.value.retrieval?.resultLimit ?? 5)
    function globalSettingsSignature(): string {
      return JSON.stringify([Number(draft.retrievalResultLimit), Number(draft.retrievalMinRelevance), draft.retrievalRerankEnabled === "true", draft.retrievalRerankModel, draft.retrievalRerankMinScore === "" ? null : Number(draft.retrievalRerankMinScore), Number(draft.retrievalRerankResultLimit)])
    }
    const savedGlobalSettings = computed(() => JSON.stringify([globalResultLimit.value, cfg.value.retrieval?.minRelevance ?? 0.55, cfg.value.retrieval?.rerankEnabled === true, cfg.value.retrieval?.rerankModel || "", cfg.value.retrieval?.rerankMinScore ?? null, cfg.value.retrieval?.rerankResultLimit ?? 5]))
    const globalSettingsDirty = computed(() => globalSettingsSignature() !== savedGlobalSettings.value)
    watch(globalSettingsDirty, dirty => setDirtyScope("knowledge-global-settings", dirty))
    watch(savedGlobalSettings, (_value, previous) => {
      if (globalSettingsSignature() === previous) resetGlobalSettings()
    })
    async function saveGlobalSettings(): Promise<void> {
      if (globalSettingsBusy.value) return
      const limit = Number(draft.retrievalResultLimit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) { toast("召回数量请填写 1–20 的整数"); return }
      const rerankLimit = Number(draft.retrievalRerankResultLimit)
      if (!Number.isInteger(rerankLimit) || rerankLimit < 1 || rerankLimit > 20) { toast("重排返回数量请填写 1–20 的整数"); return }
      const relevance = Number(draft.retrievalMinRelevance)
      if (draft.retrievalMinRelevance === "" || !Number.isFinite(relevance) || relevance < 0 || relevance > 1) { toast("相关性阈值请填写 0–1 的数值"); return }
      const rerankScore = draft.retrievalRerankMinScore === "" ? null : Number(draft.retrievalRerankMinScore)
      if (rerankScore !== null && !Number.isFinite(rerankScore)) { toast("重排最低分请填写有限数值，或留空不截断"); return }
      try {
        globalSettingsBusy.value = true
        await saveConfigPatch({
          "knowledge.retrieval.resultLimit": limit,
          "knowledge.retrieval.minRelevance": relevance,
          "knowledge.retrieval.rerankEnabled": draft.retrievalRerankEnabled === "true",
          "knowledge.retrieval.rerankModel": draft.retrievalRerankModel,
          "knowledge.retrieval.rerankMinScore": rerankScore,
          "knowledge.retrieval.rerankResultLimit": rerankLimit,
        })
        globalSettingsOpen.value = false
        toast("全局检索设置已保存，所有知识库立即生效")
      } catch (err) { toast(errorMessage(err)) } finally { globalSettingsBusy.value = false }
    }
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
    const rerankModelOptions = computed(() => {
      const providers = records<KnowledgeRecord>(record(store.config).apiProviders)
      return records<KnowledgeModel>(record(store.config).models).filter(model => {
        const provider = providers.find(item => item.name === model.apiProvider)
        const adapter = model.adapter || provider?.type || "mock"
        const purpose = model.purpose || (adapter === "systemone" ? "decision" : ["openai-images", "openai-chat-completions", "gemini-images"].includes(adapter) ? "image" : model.capabilities?.chat === false && model.capabilities?.embedding ? "embedding" : "chat")
        return adapter !== "mock" && (purpose === "rerank" || model.name === cfg.value.retrieval?.rerankModel && purpose === "chat")
      }).map(model => ({ value: model.name, label: `${model.apiProvider || "未分配渠道"} / ${model.name}${model.purpose === "rerank" ? "" : "（现有对话模型重排）"}` }))
    })
    function resetGlobalSettings(): void {
      draft.retrievalResultLimit = globalResultLimit.value
      draft.retrievalMinRelevance = cfg.value.retrieval?.minRelevance ?? 0.55
      draft.retrievalRerankEnabled = String(cfg.value.retrieval?.rerankEnabled === true)
      draft.retrievalRerankModel = cfg.value.retrieval?.rerankModel || ""
      draft.retrievalRerankMinScore = cfg.value.retrieval?.rerankMinScore ?? ""
      draft.retrievalRerankResultLimit = cfg.value.retrieval?.rerankResultLimit ?? 5
    }
    function openGlobalSettings(): void {
      if (!globalSettingsDirty.value) resetGlobalSettings()
      globalSettingsOpen.value = true
    }
    async function closeGlobalSettings(): Promise<void> {
      if (globalSettingsBusy.value) return
      if (globalSettingsDirty.value && !await confirmAction({ title: "放弃未保存的全局配置？", message: "关闭后将放弃本次检索与重排设置的修改。", confirmText: "放弃修改" })) return
      resetGlobalSettings()
      globalSettingsOpen.value = false
    }
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
      if (base.config?.embeddingModel && (!base.active_vector_space_id || !["completed", "ready"].includes(status))) return { state: "warn", label: "待构建" }
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

    const builtinBase = computed(() => bases.value.find(base => base.id === "builtin-commands"))
    const commandModelDimensions = computed(() => Number(records<KnowledgeModel>(record(store.config).models).find(model => model.name === draft.commandEmbeddingModel)?.embedding?.defaultDimensions || 0))
    const currentCommandDimensions = computed(() => Number(builtinBase.value?.config?.dimensions || 0))
    function selectCommandEmbeddingModel(name: string): void {
      draft.commandEmbeddingModel = name
      draft.commandEmbeddingDimensions = name ? commandModelDimensions.value : 0
    }
    function syncCommandDimensions(): void {
      if (!commandModelDimensions.value || activeIndexJob.value) return
      draft.commandEmbeddingDimensions = commandModelDimensions.value
    }
    const digestMetrics = computed(() => {
      const stats = builtinBase.value?.stats || {}
      return [
        { label: "已收录指令", value: stats.documents || 0 },
        { label: "可检索指令", value: stats.searchableDocuments || 0 },
        { label: "总分块", value: stats.chunks || 0 },
        { label: "向量更新", value: stats.pendingVectors || 0 },
      ]
    })
    async function search() {
      try {
        const result = await request(`/api/knowledge?q=${encodeURIComponent(draft.query || "")}`) as KnowledgeApiResponse
        store.knowledge = result
        toast("检索完成")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function refreshKnowledgeContent(): Promise<void> {
      const revision = ++contentRevision
      try {
        const result = await request("/api/knowledge/bases") as KnowledgeApiResponse
        if (revision !== contentRevision) return
        bases.value = result.bases || []
        await loadBaseDetails()
      } catch (err) { toast(errorMessage(err)) }
    }
    async function loadBases() {
      const revision = ++contentRevision
      try {
        const result = await request("/api/knowledge/bases") as KnowledgeApiResponse
        if (revision !== contentRevision) return
        bases.value = result.bases || []
        if (!bases.value.some(base => base.id === selectedBaseId.value)) selectedBaseId.value = bases.value[0]?.id || ""
        draft.sourceBaseId = selectedBaseId.value
        const builtin = bases.value.find(base => base.id === "builtin-commands")
        draft.commandRetrievalMode = builtin?.retrievalMode || "hybrid"
        draft.commandFieldDescription = builtin?.config?.fieldDescription || ""
        draft.commandDescription = builtin?.description || ""
        draft.commandEmbeddingModel = builtin?.config?.embeddingModel || ""
        draft.commandEmbeddingDimensions = Number(builtin?.config?.dimensions || 0)
        retrievalBaseline.value = retrievalSignature()
        await loadBaseDetails()
      } catch (err) { toast(errorMessage(err)) }
    }

    async function loadBaseDetails() {
      const revision = ++detailRevision
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
          request(`/api/knowledge/bases/${encoded}/documents?q=${encodeURIComponent(documentQuery.value)}&sort=${encodeURIComponent(documentSort.value)}`),
          request(`/api/knowledge/bases/${encoded}/grants`),
          request(`/api/knowledge/index-jobs?baseId=${encoded}&page=${indexJobPage.value}&pageSize=10`),
        ])
        const documentResult = documentResultRaw as KnowledgeApiResponse
        const grantResult = grantResultRaw as KnowledgeApiResponse
        const jobResult = jobResultRaw as KnowledgeApiResponse
        if (selectedBaseId.value !== baseId || revision !== detailRevision) return
        documents.value = documentResult.documents || []
        grants.value = grantResult.grants || []
        indexJobs.value = jobResult.jobs || []
        indexJobPagination.value = jobResult.pagination || { page: indexJobPage.value, pageSize: 10, total: indexJobs.value.length }
        syncIndexPolling()
      } catch (err) { toast(errorMessage(err)) }
    }

    async function selectBase(baseId: string): Promise<void> {
      selectedBaseId.value = baseId
      documentSort.value = "updated"
      indexInspection.value = null
      indexJobPage.value = 1
      draft.sourceBaseId = baseId
      await loadBaseDetails()
    }

    function openBaseEditor(base: KnowledgeBase | null = null): void {
      draft.baseId = base?.id || ""
      draft.baseName = base?.name || ""
      draft.baseDescription = base?.description || ""
      draft.baseFieldDescription = base?.config?.fieldDescription || ""
      draft.baseEmbeddingModel = base?.config?.embeddingModel || ""
      draft.baseDimensions = Number(base?.config?.dimensions || 0)
      draft.baseAutoRetrieve = String(Boolean(base?.auto_retrieve))
      draft.baseTriggerWords = (base?.config?.triggerWords || []).join(", ")
      baseBaseline.value = baseSignature()
      showBaseDrawer.value = true
    }

    function baseSignature(): string {
      return JSON.stringify([draft.baseName, draft.baseDescription, draft.baseFieldDescription, draft.baseEmbeddingModel, draft.baseDimensions, draft.baseAutoRetrieve, draft.baseTriggerWords])
    }
    const baseBaseline = ref(baseSignature())
    watch(() => [showBaseDrawer.value, baseSignature()], () => {
      setDirtyScope("knowledge-base-editor", showBaseDrawer.value && baseSignature() !== baseBaseline.value)
    })
    async function closeBaseEditor(): Promise<void> {
      if (baseSignature() !== baseBaseline.value && !await confirmAction({ title: "放弃未保存的知识库设置？", message: "关闭后将丢弃本次修改。", confirmText: "放弃修改" })) return
      showBaseDrawer.value = false
    }

    async function saveBase() {
      try {
        if (!draft.baseName.trim()) throw new Error("请输入知识库名称")
        const payload = {
          name: draft.baseName.trim(),
          description: draft.baseDescription,
          autoRetrieve: draft.baseAutoRetrieve === "true",
          triggerWords: splitTokens(draft.baseTriggerWords),
          config: { embeddingModel: draft.baseEmbeddingModel, dimensions: Number(draft.baseDimensions || 0), fieldDescription: draft.baseFieldDescription },
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

    const documentSignature = () => JSON.stringify([draft.sourceName, draft.sourceContent])
    const documentBaseline = ref(documentSignature())
    watch(() => showDocumentDrawer.value && documentSignature() !== documentBaseline.value,
      dirty => setDirtyScope("knowledge-document-editor", dirty))
    async function closeDocumentEditor(): Promise<void> {
      if (documentSignature() !== documentBaseline.value && !await confirmAction({ title: "放弃未保存的知识内容？", message: "关闭后将丢弃本次修改。", confirmText: "放弃修改" })) return
      showDocumentDrawer.value = false
    }

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
      documentBaseline.value = documentSignature()
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
      if (baseBusy.value) return
      const baseId = selectedBaseId.value
      const revision = ++retrievalRevision
      try {
        if (!baseId || !draft.retrievalQuery.trim()) throw new Error("请输入要测试的问题")
        baseBusy.value = true
        const result = await request(`/api/knowledge/bases/${encodeURIComponent(baseId)}/search`, { method: "POST", body: JSON.stringify({ query: draft.retrievalQuery.trim(), compare: true }) }) as KnowledgeApiResponse
        if (revision !== retrievalRevision || selectedBaseId.value !== baseId) return
        retrievalResults.value = result.results || []
        retrievalDiagnostics.value = result.retrieval || null
        retrievalTrace.value = result.trace || null
        toast(`召回 ${result.trace?.candidates?.length || 0} 条候选，最终返回 ${retrievalResults.value.length} 条内容`)
      } catch (err) { toast(errorMessage(err)) } finally { baseBusy.value = false }
    }

    async function checkIndexStatus(repair = false) {
      const baseId = selectedBaseId.value
      if (!baseId) return
      try {
        baseBusy.value = true
        const encoded = encodeURIComponent(baseId)
        const response = await request(`/api/knowledge/bases/${encoded}/${repair ? "repair-index" : "index-status"}`, repair ? { method: "POST", body: JSON.stringify({ start: true }) } : {}) as KnowledgeApiResponse
        if (selectedBaseId.value !== baseId) return
        indexInspection.value = repair ? response.result?.inspection || null : response.inspection || null
        if (repair) {
          indexJobPage.value = 1
          await loadBases()
          toast(response.result?.status === "ready" ? "索引完整，无需补齐" : response.result?.status === "fts_ready" ? "当前使用全文检索，无需向量索引" : "缺失分块补齐已排队，已有向量会复用")
        } else toast("索引检查完成，未调用模型")
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

    const grantSignature = () => JSON.stringify([draft.grantPrincipalType, draft.grantPrincipalId, draft.grantGroupId, draft.grantAccess])
    const grantBaseline = ref(grantSignature())
    watch(() => showGrantDrawer.value && grantSignature() !== grantBaseline.value,
      dirty => setDirtyScope("knowledge-grant-editor", dirty))
    async function closeGrantEditor(): Promise<void> {
      if (grantSignature() !== grantBaseline.value && !await confirmAction({ title: "放弃未保存的授权规则？", message: "关闭后将丢弃本次修改。", confirmText: "放弃修改" })) return
      showGrantDrawer.value = false
    }

    function openGrantEditor() {
      draft.grantPrincipalType = "role"
      draft.grantPrincipalId = "user"
      draft.grantGroupId = ""
      draft.grantAccess = "allow"
      grantBaseline.value = grantSignature()
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

    async function saveCommandRetrieval() {
      try {
        if (draft.commandEmbeddingModel && !Number(draft.commandEmbeddingDimensions)) throw new Error("所选模型未声明默认维度，请先到模型页完善")
        const result = await request("/api/knowledge/bases/builtin-commands/retrieval", {
          method: "PATCH",
          body: JSON.stringify({
            mode: draft.commandRetrievalMode,
            fieldDescription: draft.commandFieldDescription,
            description: draft.commandDescription,
            embeddingModel: draft.commandEmbeddingModel,
            dimensions: Number(draft.commandEmbeddingDimensions || 0),
          }),
        }) as KnowledgeApiResponse
        await refreshTab()
        await loadBases()
        toast(result.index?.status === "queued" ? "已保存检索设置，语义索引已排队" : "检索设置已保存，所有入口立即生效")
      } catch (err) { toast(errorMessage(err)) }
    }

    function openCommandMaintenance(base: KnowledgeBase | null = null): void {
      if (base?.id !== "builtin-commands") return
      if (selectedBaseId.value !== base.id) selectBase(base.id)
      draft.commandEmbeddingModel = base.config?.embeddingModel || ""
      draft.commandRetrievalMode = base.retrievalMode || "hybrid"
      draft.commandFieldDescription = base.config?.fieldDescription || ""
      draft.commandDescription = base.description || ""
      draft.commandEmbeddingDimensions = Number(base.config?.dimensions || 0)
      retrievalBaseline.value = retrievalSignature()
      activeMaintenancePane.value = "commands"
      showCommandMaintenanceDrawer.value = true
    }
    function canEditBuiltinCommand(item: KnowledgeItem = { id: "" }): boolean {
      return selectedBase.value?.id === "builtin-commands" && Boolean(item?.metadata?.commandId)
    }
    async function openBuiltinCommandEditor(item: KnowledgeItem): Promise<void> {
      if (!canEditBuiltinCommand(item)) return
      try {
        baseBusy.value = true
        const commandId = String(item.metadata?.commandId || "")
        await openManualEditor({ id: commandId })
      } catch (err) { toast(errorMessage(err)) } finally { baseBusy.value = false }
    }
    async function openManualEditor(item: KnowledgeItem | null = null): Promise<void> {
      if (!item?.id) return
      currentCommand.value = item
      showManualDrawer.value = true
    }
    function commandAvailabilityChanged(result:KnowledgeRecord):void {
      const builtin=bases.value.find(base=>base.id==="builtin-commands")
      if(builtin)builtin.stats=result.stats
      const states=new Map<string,KnowledgeRecord>((result.availability || []).map((row:KnowledgeRecord)=>[row.id,row]))
      documents.value=documents.value.map(row=>{const state=states.get(String(row.metadata?.commandId || ""));return state?{...row,searchable:state.enabled,exclusionReasons:state.enabled?[]:["知识推荐已停用"]}:row})
      retrievalResults.value=retrievalResults.value.filter(row=>states.get(String(row.commandId || row.metadata?.commandId || ""))?.enabled !== false)
      retrievalTrace.value = null
      retrievalDiagnostics.value = null
      retrievalRevision++
    }
    async function commandDescriptionChanged(): Promise<void> {
      commandRevision.value++
      await refreshKnowledgeContent()
    }
    function retrievalSignature(): string {
      return JSON.stringify([draft.commandRetrievalMode, draft.commandDescription, draft.commandFieldDescription, draft.commandEmbeddingModel, draft.commandEmbeddingDimensions])
    }
    const retrievalBaseline = ref(retrievalSignature())
    watch(() => [showCommandMaintenanceDrawer.value, retrievalSignature()], () => {
      setDirtyScope("knowledge-command-retrieval", showCommandMaintenanceDrawer.value && retrievalSignature() !== retrievalBaseline.value)
    })
    async function closeCommandMaintenance(): Promise<void> {
      if ((retrievalSignature() !== retrievalBaseline.value || store.dirtyScopes["knowledge-command-workbench"]) && !await confirmAction({ title: "放弃未保存的维护设置？", message: "检索设置或导入内容有未提交的修改。", confirmText: "放弃修改" })) return
      showCommandMaintenanceDrawer.value = false
    }
    async function requestDeleteCommand(item: KnowledgeItem): Promise<void> {
      const candidate = { id: item.id, label: item.suggestedCommand || item.example || item.id }
      const accepted = await confirmAction({
        title: `删除知识条目“${candidate.label}”？`,
        message: "删除当前知识条目及索引，保留最多 3 个版本供恢复；不会删除其他插件的实际命令。",
        detail: candidate.id,
        confirmText: "确认删除条目",
      })
      if (!accepted) return
      try {
        const current = await request(`/api/knowledge/commands/${encodeURIComponent(candidate.id)}/history`) as KnowledgeRecord
        const result = await request(`/api/knowledge/commands/${encodeURIComponent(candidate.id)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: current.revision }) }) as KnowledgeApiResponse
        store.knowledge = { ...asRecord(store.knowledge), stats: result.stats, digest: result.digest, quality: result.quality }
        commandRevision.value++
        await refreshKnowledgeContent()
        toast(`已删除知识条目：${candidate.label}`)
      } catch (err) { toast(errorMessage(err)) }
    }
    onUnmounted(() => { stopIndexPolling(); setDirtyScope("knowledge-global-settings", false); setDirtyScope("knowledge-base-editor", false); setDirtyScope("knowledge-document-editor", false); setDirtyScope("knowledge-grant-editor", false); setDirtyScope("knowledge-command-editor", false); setDirtyScope("knowledge-command-retrieval", false); setDirtyScope("knowledge-command-capture", false) })
    loadBases()

    function recConfidenceTone(confidence: string): string {
      return confidence === "high" ? "" : confidence === "low" ? "risk-medium" : ""
    }
    return {
      cfg, knowledge, digest, quality, recommendation, draft, rerankModelOptions,
      globalSettingsOpen, globalSettingsBusy, globalSettingsDirty, globalResultLimit, saveGlobalSettings, openGlobalSettings, closeGlobalSettings,
      showManualDrawer, currentCommand, commandRevision, commandDescriptionChanged, commandAvailabilityChanged, showBaseDrawer, showDocumentDrawer, showGrantDrawer, showCommandMaintenanceDrawer,
      activeMaintenancePane, maintenancePaneItems, bases, selectedBaseId, selectedBase, baseQuery, filteredBases, activeBasePane, basePaneItems,
      documents, grants, indexJobs, indexJobPagination, retrievalResults, retrievalDiagnostics, retrievalTrace, documentQuery, documentSort, baseBusy, embeddingModelOptions, activeIndexJob, latestIndexJob, visibleIndexJob,
      digestMetrics, commandModelDimensions, currentCommandDimensions, selectCommandEmbeddingModel, syncCommandDimensions, refreshKnowledgeContent,
      documentOrigin, canEditBuiltinCommand, shortId, recConfidenceTone, baseHealth, jobLabel, jobProgress, jobProgressLabel, jobProgressTone,
      BOOL_OFF_OPTIONS,
      search, openCommandMaintenance, loadBases, loadBaseDetails, selectBase, createBase, openBaseEditor, closeBaseEditor, closeDocumentEditor, closeGrantEditor, saveBase, openDocumentEditor, ingestSource, deleteDocument,
      testRetrieval, rebuildBase, checkIndexStatus, indexInspection, openGrantEditor, saveGrant, deleteGrant, retryJob, cancelIndexJob, deleteIndexJob, changeIndexJobPage, deleteBase, openManualEditor, openBuiltinCommandEditor, requestDeleteCommand, saveCommandRetrieval, closeCommandMaintenance,
    }
  },
  template: `
    <div class="stack">
      <SideDrawer
        :open="showBaseDrawer"
        variant="dialog"
        :title="draft.baseId ? '编辑知识库' : '新建知识库'"
        subtitle="先建立清晰的库边界，再添加内容和授权。"
        icon="database"
        width="560px"
        @close="closeBaseEditor"
      >
        <div class="form-grid">
          <Field label="名称" v-model="draft.baseName" placeholder="例如：产品帮助中心" />
          <Field label="检索方式" type="select" :options="embeddingModelOptions" v-model="draft.baseEmbeddingModel" tip="不选模型也可使用全文检索；选择 embedding 模型后可进行语义召回。" />
          <Field label="向量维度" type="number" v-model="draft.baseDimensions" placeholder="0 表示采用模型默认值" />
          <Field label="自动召回" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.baseAutoRetrieve" />
        </div>
        <Field label="用途与适用场景" type="textarea" rows="3" v-model="draft.baseDescription" placeholder="说明收录范围，以及什么问题应该查询这个库" tip="工具目录提供简要用途，帮助模型选库；选中知识库后可查看完整说明。" />
        <Field label="字段说明" type="textarea" rows="4" v-model="draft.baseFieldDescription" placeholder="可选，说明正文中专用字段的含义" tip="最多 2000 字符。按知识库提供一次，供重排和回答参考；不写入分块，修改无需重建向量。" />
        <Field label="自动召回触发词" hint="逗号或换行" v-model="draft.baseTriggerWords" placeholder="例如：售后, 保修, 退换货" />
        <div class="hint-banner ok"><Icon name="info" :size="14" /><span>新库默认只允许主人访问；可在“授权”页签中逐步开放给角色、用户或群。</span></div>
        <template #actions>
          <button class="btn outline" type="button" @click="closeBaseEditor"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary" type="button" @click="saveBase"><Icon name="save" :size="14" />{{ draft.baseId ? '保存设置' : '创建知识库' }}</button>
        </template>
      </SideDrawer>

      <SideDrawer
        :open="showDocumentDrawer"
        :title="draft.documentId ? '修正知识内容' : '添加知识内容'"
        subtitle="保存后会立即重建全文分块，并为已配置的语义索引排队。"
        icon="file"
        width="720px"
        @close="closeDocumentEditor"
      >
        <Field label="内容标题" v-model="draft.sourceName" placeholder="给维护者看的清晰标题" />
        <Field label="原始内容" type="textarea" rows="18" v-model="draft.sourceContent" placeholder="粘贴文本或 Markdown；这里展示并保存完整原文" />
        <div class="hint-banner" :class="draft.sourceContent.trim() ? 'ok' : 'warn'"><Icon :name="draft.sourceContent.trim() ? 'check' : 'alert'" :size="14" /><span>{{ draft.sourceContent.trim() ? '保存后可立即全文检索。' : '内容不能为空。' }}</span></div>
        <template #actions>
          <button class="btn outline" type="button" @click="closeDocumentEditor"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary" type="button" @click="ingestSource"><Icon name="save" :size="14" />{{ draft.documentId ? '保存并重新分块' : '添加并建立索引' }}</button>
        </template>
      </SideDrawer>

      <SideDrawer
        :open="showGrantDrawer"
        variant="dialog"
        title="添加授权规则"
        subtitle="可以按角色、单个用户、群或群内用户控制访问。"
        icon="key"
        width="540px"
        @close="closeGrantEditor"
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
          <button class="btn outline" type="button" @click="closeGrantEditor"><Icon name="x" :size="14" />取消</button>
          <button class="btn primary" type="button" @click="saveGrant"><Icon name="save" :size="14" />保存规则</button>
        </template>
      </SideDrawer>

      <KnowledgeCommandEditor
        :open="showManualDrawer"
        :command="currentCommand"
        @close="showManualDrawer = false"
        @changed="commandDescriptionChanged"
      />



      <KnowledgeCommandMaintenance
        :open="showCommandMaintenanceDrawer"
        :active-pane="activeMaintenancePane"
        :refresh-token="commandRevision"
        :pane-items="maintenancePaneItems"
        :draft="draft"
        :digest-metrics="digestMetrics"
        :embedding-model-options="embeddingModelOptions"
        :model-dimensions="commandModelDimensions"
        :current-dimensions="currentCommandDimensions"
        :active-index-job="activeIndexJob"
        :visible-index-job="visibleIndexJob"
        :job-progress-tone="jobProgressTone"
        :job-progress-label="jobProgressLabel"
        :job-progress="jobProgress"
        :job-label="jobLabel"
        @close="closeCommandMaintenance"
        @set-pane="activeMaintenancePane = $event"
        @open-manual-item="openManualEditor"
        @refresh="refreshKnowledgeContent"
        @availability-changed="commandAvailabilityChanged"
        @save-command-retrieval="saveCommandRetrieval"
        @select-embedding-model="selectCommandEmbeddingModel"
        @sync-dimensions="syncCommandDimensions"
      />

      <KnowledgeBaseWorkspace
        :rerank-model-options="rerankModelOptions"
        :global-settings-open="globalSettingsOpen"
        :global-settings-busy="globalSettingsBusy"
        :global-settings-dirty="globalSettingsDirty"
        :global-result-limit="globalResultLimit"
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
        :index-inspection="indexInspection"
        :index-job-pagination="indexJobPagination"
        :retrieval-results="retrievalResults"
        :retrieval-diagnostics="retrievalDiagnostics"
        :retrieval-trace="retrievalTrace"
        :document-query="documentQuery"
        :document-sort="documentSort"
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
        @open-global-settings="openGlobalSettings"
        @close-global-settings="closeGlobalSettings"
        @save-global-settings="saveGlobalSettings"
        @create-base="createBase"
        @select-base="selectBase"
        @open-command-maintenance="openCommandMaintenance"
        @open-base-editor="openBaseEditor"
        @rebuild-base="rebuildBase"
        @check-index="checkIndexStatus()"
        @repair-index="checkIndexStatus(true)"
        @delete-base="deleteBase"
        @set-base-pane="activeBasePane = $event"
        @update-base-query="baseQuery = $event"
        @load-base-details="loadBaseDetails"
        @update-document-query="documentQuery = $event"
        @update-document-sort="documentSort = $event; loadBaseDetails()"
        @open-document-editor="openDocumentEditor"
        @open-builtin-command="openBuiltinCommandEditor"
        @delete-document="deleteDocument"
        @delete-builtin-command="requestDeleteCommand"
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
