import { LangfusePanel } from "./langfuse-panel.js"
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue"
import { confirmAction, refreshSlices, request, saveConfigPatch, setDeveloperMode, setDirtyScope, setTab, store, toast } from "../../app/store/store.js"
import { toJson } from "../../shared/format.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"
import { SystemRenderStrategyPanel } from "../tools/system-render-strategy-panel.js"

interface ConfigMeta extends UnknownRecord {
  loaded?: boolean
  lastReloadedAt?: string
  lastLoadError?: { message?: string }
}
interface DiagnosticSummary { errorCount?: number; warnCount?: number }
interface DiagnosticIssue extends UnknownRecord {
  area?: string
  message?: string
  action?: string
  advice?: string
  target?: string
  section?: string
  patch?: UnknownRecord
}
interface DiagnosticsData extends UnknownRecord {
  summary?: DiagnosticSummary
  issues?: DiagnosticIssue[]
}
interface ManifestSection { id: string; title?: string; fieldCount?: number; advancedCount?: number }
interface SchemaManifest extends UnknownRecord {
  sections?: ManifestSection[]
  summary?: { tabs?: number; sections?: number; fields?: number; sensitiveFields?: number; advancedFields?: number }
}
interface ManifestTab { sections?: string[] }
interface ModelConfig { purpose?: string; adapter?: string; name?: string; modelIdentifier?: string; capabilities?: { chat?: boolean; embedding?: boolean } }
interface ConsolidationConfig { tokensPerDay?:number; relatedFactLimit?:number; modelName?: string; maxTokens?: number; minConfidence?: number; maxWindowsPerScan?: number; schedule?: { mode?: string; time?: string; cron?: string } }
interface GroupCaptureConfig {
  defaultRetentionDays?: number
  defaultTokenLimit?: number
  promptTemplate?: string
  consolidation?: ConsolidationConfig
}
interface AdvancedConfig extends UnknownRecord {
  web?: { publicBaseUrl?: string; mountPath?: string; port?: number }
  logging?: { level?: string; history?: UnknownRecord }
  system?: { backups?: { maxFiles?: number; maxAgeDays?: number } }
  security?: { linkSafety?: { allowPrivateHosts?: boolean; trustedPrivateDnsBypass?: boolean; screenshotAllowedHosts?: string[] } }
  memory?: { retention?:{expiredFactDays?:number}; retrieval?: { embeddingTokensPerDay?: number; resultLimit?: number; promptTokenBudget?: number; embeddingModel?: string; rerankEnabled?: boolean; rerankModel?: string; rerankMaxCandidates?: number; rerankInputTokenBudget?: number; rerankTimeoutMs?: number; rerankCacheTtlMs?: number; rerankMinScore?: number | null }; groupCapture?: GroupCaptureConfig }
  knowledge?: { indexing?: { globalEmbeddingTokensPerDay?: number } }
  modelTasks?: { replyer?: { modelList?: string[] } }
  models?: ModelConfig[]
}
interface CaptureDefaults {
  retentionDays: number
  tokenLimit: number
  promptTemplate: string
  modelName: string
  maxTokens: number
  minConfidence: number
  retrievalResultLimit: number
}
interface MemorySummary extends UnknownRecord {
  capture?: { defaultPolicy?: Partial<CaptureDefaults>; defaultPromptTemplate?: string }
}
interface SystemRenderStrategyPanelHandle {
  getPatch?: () => UnknownRecord
}

export const AdvancedTab = {
  name: "AdvancedTab",
  components: { SystemRenderStrategyPanel, LangfusePanel },
  setup() {
    const config = computed(() => asRecord<AdvancedConfig>(store.config))
    const draft = reactive({
      configJson: toJson(store.config),
      webAuthToken: "",
      webPublicBaseUrl: String(config.value.web?.publicBaseUrl || ""),
      loggingLevel: config.value.logging?.level || "info",
      backupMaxFiles: config.value.system?.backups?.maxFiles ?? 3,
      backupMaxAgeDays: config.value.system?.backups?.maxAgeDays ?? 30,
      linkAllowPrivateHosts: config.value.security?.linkSafety?.allowPrivateHosts === true,
      linkTrustedPrivateDnsBypass: config.value.security?.linkSafety?.trustedPrivateDnsBypass === true,
      linkScreenshotAllowedHosts: (config.value.security?.linkSafety?.screenshotAllowedHosts || []).join("\n"),
      memoryEmbeddingTokensPerDay: config.value.memory?.retrieval?.embeddingTokensPerDay ?? 200000,
      knowledgeEmbeddingTokensPerDay: config.value.knowledge?.indexing?.globalEmbeddingTokensPerDay ?? 2000000,
      captureRetentionDays: config.value.memory?.groupCapture?.defaultRetentionDays ?? 30,
      captureTokenLimit: config.value.memory?.groupCapture?.defaultTokenLimit ?? 200000,
      captureModelName: config.value.memory?.groupCapture?.consolidation?.modelName || "",
      captureUseBuiltInPrompt: !String(config.value.memory?.groupCapture?.promptTemplate || "").trim(),
      capturePromptTemplate: String(config.value.memory?.groupCapture?.promptTemplate || "").trim(),
      captureMaxTokens: config.value.memory?.groupCapture?.consolidation?.maxTokens ?? 100000,
      captureMinConfidence: config.value.memory?.groupCapture?.consolidation?.minConfidence ?? 0.7,
      captureMaxWindowsPerScan: config.value.memory?.groupCapture?.consolidation?.maxWindowsPerScan ?? 2,
      captureTokensPerDay: config.value.memory?.groupCapture?.consolidation?.tokensPerDay ?? 0,
      captureRelatedFactLimit: config.value.memory?.groupCapture?.consolidation?.relatedFactLimit ?? 8,
      captureExpiredFactDays: config.value.memory?.retention?.expiredFactDays ?? 0,
      captureScheduleMode: config.value.memory?.groupCapture?.consolidation?.schedule?.mode || "interval",
      captureScheduleTime: config.value.memory?.groupCapture?.consolidation?.schedule?.time || "03:00",
      captureScheduleCron: config.value.memory?.groupCapture?.consolidation?.schedule?.cron || "0 3 * * *",
      captureRetrievalResultLimit: config.value.memory?.retrieval?.resultLimit ?? 3,
      capturePromptTokenBudget: config.value.memory?.retrieval?.promptTokenBudget ?? 2000,
      captureEmbeddingModel: config.value.memory?.retrieval?.embeddingModel || "",
      memoryRerankEnabled: config.value.memory?.retrieval?.rerankEnabled === true,
      memoryRerankModel: config.value.memory?.retrieval?.rerankModel || "",
      memoryRerankCandidates: config.value.memory?.retrieval?.rerankMaxCandidates ?? 20,
      memoryRerankTokenBudget: config.value.memory?.retrieval?.rerankInputTokenBudget ?? 6000,
      memoryRerankTimeout: config.value.memory?.retrieval?.rerankTimeoutMs ?? 10000,
      memoryRerankCache: config.value.memory?.retrieval?.rerankCacheTtlMs ?? 300000,
      memoryRerankMinScore: config.value.memory?.retrieval?.rerankMinScore ?? "",
    })
    const activeSection = ref("status")
    const subsections: Record<string, Array<{ value: string; label: string; icon: string; description: string }>> = {
      status: [
        { value: "overview", label: "运行状态", icon: "activity", description: "查看配置状态、运行诊断与建议处理项。" },
        { value: "address", label: "访问地址", icon: "link", description: "设置服务器地址，预览管理台入口。" },
        { value: "credentials", label: "登录凭证", icon: "key", description: "查看和管理长期 Web 登录令牌。" },
      ],
      langfuse: [
        { value: "connection", label: "连接与凭证", icon: "key", description: "连接模型观测服务。" },
        { value: "sampling", label: "采样与额度", icon: "sliders", description: "控制模型调用采集范围。" },
        { value: "status", label: "上报状态", icon: "activity", description: "查看上报队列与额度。" },
      ],
      "link-safety": [
        { value: "network", label: "私网与可信资源", icon: "shield", description: "统一管理网页、媒体与工具的私网访问例外。" },
        { value: "screenshot", label: "截图域名", icon: "image", description: "限定 URL 截图允许访问的域名。" },
      ],
      backup: [
        { value: "manage", label: "备份管理", icon: "restore", description: "手动创建配置包，查看记录并按需回滚。" },
        { value: "retention", label: "保留策略", icon: "clock", description: "设置手动配置备份的保护天数与最少份数。" },
      ],
      "memory-capture": [
        { value: "retention", label: "采集与保留", icon: "database", description: "管理原始消息与到期记忆的保留时间。" },
        { value: "extraction", label: "提炼设置", icon: "bot", description: "设置提炼模型、提示词、输入输出预算与置信度。" },
        { value: "schedule", label: "调度与预算", icon: "clock", description: "安排后台提炼时间，控制扫描范围与每日用量。" },
        { value: "recall", label: "记忆召回", icon: "search", description: "设置日常对话注入的记忆条数、预算与向量模型。" },
        { value: "rerank", label: "重排设置", icon: "list", description: "配置记忆候选的相关性重排、超时与缓存。" },
      ],
      developer: [
        { value: "logs", label: "日志与预算", icon: "activity", description: "管理本地日志等级与 Embedding 每日预算。" },
        { value: "render", label: "渲染设置", icon: "image", description: "选择系统图片使用的渲染引擎。" },
        { value: "config", label: "完整配置", icon: "sliders", description: "查看并编辑完整配置 JSON。" },
        { value: "diagnostics", label: "结构与诊断", icon: "info", description: "查看配置结构、运行路径与原始诊断信息。" },
      ],
    }
    const selectedSubsections = reactive<Record<string, string>>(Object.fromEntries(Object.entries(subsections).map(([key, items]) => [key, items[0].value])))
    const activeSubsection = computed(() => selectedSubsections[activeSection.value])
    const subsection = computed(() => subsections[activeSection.value]?.find(item => item.value === activeSubsection.value) || subsections.status[0])
    function selectSection(value: string, child?: string): void {
      const [section, nested] = value.split("/")
      if (!subsections[section]) return
      activeSection.value = section
      const target = child || nested
      if (target && subsections[section].some(item => item.value === target)) selectedSubsections[section] = target
    }
    const showJsonDrawer = ref(false)
    const webTokenVisible = ref(false)
    const webTokenLoaded = ref(false)
    const webTokenBusy = ref(false)
    const systemRenderPanel = ref<SystemRenderStrategyPanelHandle | null>(null)
    const draftGroups = ["web-address", "web-token", "link-safety", "backup", "memory-capture", "developer", "config-json"]
    function groupForKey(key: string): string {
      if (key.startsWith("capture") || key.startsWith("memoryRerank")) return "memory-capture"
      if (key.startsWith("link")) return "link-safety"
      if (key.startsWith("backup")) return "backup"
      return ({ webPublicBaseUrl: "web-address", webAuthToken: "web-token", configJson: "config-json" } as Record<string, string>)[key] || "developer"
    }
    function draftState(group: string): string {
      const fields: UnknownRecord = Object.fromEntries(Object.entries(draft).filter(([key]) => groupForKey(key) === group))
      if (group === "developer") fields.render = systemRenderPanel.value?.getPatch?.() || {
        "response.render.system.engine": String(asRecord(asRecord(asRecord(config.value.response).render).system).engine || "html"),
      }
      return JSON.stringify(fields)
    }
    const baselines = reactive<Record<string, string>>(Object.fromEntries(draftGroups.map(group => [group, draftState(group)])))
    function markClean(group: string): void {
      baselines[group] = draftState(group)
      setDirtyScope(`system:${group}`, false)
    }
    const isDirty = (group: string): boolean => draftState(group) !== baselines[group]
    for (const group of draftGroups) watch(() => [draftState(group), baselines[group]], () => setDirtyScope(`system:${group}`, isDirty(group)), { flush: "sync", immediate: true })
    onBeforeUnmount(() => { for (const group of draftGroups) setDirtyScope(`system:${group}`, false) })
    function sectionDirty(section: string): boolean {
      const groups: Record<string, string[]> = { status: ["web-address", "web-token"], developer: ["developer", "config-json"] }
      return (groups[section] || [section]).some(group => store.dirtyScopes[`system:${group}`])
    }
    const configMeta = computed(() => asRecord<ConfigMeta>(store.configMeta))
    const backups = computed(() => store.configBackups)
    const manifest = computed(() => asRecord<SchemaManifest>(store.schemaManifest))
    const diagnostics = computed(() => asRecord<DiagnosticsData>(store.diagnostics))
    const diagSummary = computed(() => diagnostics.value.summary || {})
    const webAddressPreview = computed(() => {
      const base = String(draft.webPublicBaseUrl || "").trim() || `http://localhost:${Number(config.value.web?.port) || 2536}`
      try {
        const url = new URL(base)
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid")
        const basePath = url.pathname.replace(/\/+$/, "")
        const routePath = String(config.value.web?.mountPath || "/yui-chat").replace(/^\/+|\/+$/g, "")
        url.pathname = `${basePath}/${routePath}/`.replace(/\/{2,}/g, "/")
        url.search = "?quick=..."
        url.hash = ""
        return url.toString()
      } catch {
        return "请输入完整的 http:// 或 https:// 地址"
      }
    })
    const sectionsById = computed<Record<string, ManifestSection>>(() => Object.fromEntries((manifest.value.sections || []).map(s => [s.id, s])))
    const diagnosticRows = computed(() => (diagnostics.value.issues || []).map((issue, index) => {
      const message = String(issue.message || "")
      if (message.includes("管理地址允许在群聊发送")) return { ...issue, index, advice: "改为只在私聊发送管理地址，避免群内暴露入口。", action: "关闭群内发送", patch: { "web.loginInGroup": false } }
      if (message.includes("允许访问任意私网地址")) return { ...issue, index, advice: "关闭统一私网链接授权，降低服务端请求风险。", action: "关闭私网访问", patch: { "security.linkSafety.allowPrivateHosts": false } }
      if (issue.area === "persona") return { ...issue, index, advice: "补充目标群，或先关闭定时主动问候。", action: "去配置人设", target: "persona" }
      if (/provider|model|routing/i.test(String(issue.area || ""))) return { ...issue, index, advice: "检查供应商、默认模型和回复方案。", action: "去模型与回复", target: "providers" }
      if (/tool|mcp|skill|custom/i.test(String(issue.area || ""))) return { ...issue, index, advice: "到能力中心查看错误详情并启停对应能力。", action: "去能力中心", target: "tools" }
      if (issue.area === "web") return { ...issue, index, advice: "检查 Web 登录和访问策略。", action: "查看登录设置", target: "advanced", section: "status/credentials" }
      return { ...issue, index, advice: "根据问题描述检查对应配置；不确定时先保留现状。" }
    }))

    const systemState = computed(() => {
      if (configMeta.value.lastLoadError || Number(diagSummary.value.errorCount || 0) > 0) return "bad"
      if (Number(diagSummary.value.warnCount || 0) > 0) return "warn"
      return "good"
    })
    const systemTitle = computed(() => ({
      bad: "系统配置需要处理",
      warn: "系统可以使用，建议检查警告",
      good: "系统配置运行正常",
    })[systemState.value])
    const systemDescription = computed(() => {
      if (configMeta.value.lastLoadError) return `最近一次读取配置失败：${configMeta.value.lastLoadError.message || "未知错误"}`
      if (systemState.value === "bad") return `当前有 ${diagSummary.value.errorCount || 0} 个错误需要处理。`
      if (systemState.value === "warn") return `当前有 ${diagSummary.value.warnCount || 0} 个警告，不影响进入其他页面。`
      return "运行配置已载入，未发现阻断运行的问题。"
    })
    const systemMetrics = computed(() => [
      { label: "配置状态", value: configMeta.value.loaded ? "已载入" : "未载入", icon: "check", tone: configMeta.value.loaded ? "green" : "orange" },
      { label: "配置备份", value: backups.value.length, icon: "restore", tone: "blue" },
      { label: "错误", value: diagSummary.value.errorCount || 0, icon: "alert", tone: diagSummary.value.errorCount ? "red" : "green" },
      { label: "警告", value: diagSummary.value.warnCount || 0, icon: "info", tone: diagSummary.value.warnCount ? "orange" : "green" },
    ])
    const systemSectionItems = computed(() => [
      { value: "status", label: "运行与登录", description: "运行状态与 Web 登录", icon: "activity", badge: systemState.value === "good" ? "正常" : (systemState.value === "bad" ? "错误" : "警告"), tone: systemState.value === "good" ? "on" : (systemState.value === "bad" ? "bad" : "warn") },
      { value: "langfuse", label: "Langfuse 观测", description: "模型观测与额度", icon: "activity", badge: "Cloud" },
      { value: "link-safety", label: "链接安全", description: "私网、DNS 与截图", icon: "shield", badge: config.value.security?.linkSafety?.allowPrivateHosts ? "私网已开" : "默认拦截", tone: config.value.security?.linkSafety?.allowPrivateHosts ? "warn" : "on" },
      { value: "backup", label: "备份与恢复", description: "手动备份与恢复", icon: "restore", badge: backups.value.length || 0 },
      { value: "memory-capture", label: "群记忆默认", description: "采集、提炼与召回", icon: "database", badge: "默认" },
      { value: "developer", label: "开发者设置", description: "日志、预算与 JSON", icon: "sliders", badge: store.developerMode ? "已开启" : "已隐藏", tone: store.developerMode ? "warn" : "" },
    ])
    const captureSummary = computed(() => asRecord<MemorySummary>(store.memory).capture || {})
    const captureDefaults = computed<CaptureDefaults>(() => captureSummary.value.defaultPolicy ? {
      retentionDays: Number(captureSummary.value.defaultPolicy.retentionDays ?? 30),
      tokenLimit: Number(captureSummary.value.defaultPolicy.tokenLimit) || 200000,
      promptTemplate: String(captureSummary.value.defaultPolicy.promptTemplate || ""),
      modelName: String(captureSummary.value.defaultPolicy.modelName || ""),
      maxTokens: Number(captureSummary.value.defaultPolicy.maxTokens) || 100000,
      minConfidence: Number(captureSummary.value.defaultPolicy.minConfidence ?? 0.7),
      retrievalResultLimit: Number(captureSummary.value.defaultPolicy.retrievalResultLimit) || 3,
    } : {
      retentionDays: Number(config.value.memory?.groupCapture?.defaultRetentionDays ?? 30),
      tokenLimit: Number(config.value.memory?.groupCapture?.defaultTokenLimit) || 200000,
      promptTemplate: String(config.value.memory?.groupCapture?.promptTemplate || "").trim() || captureSummary.value.defaultPromptTemplate || "",
      modelName: String(config.value.memory?.groupCapture?.consolidation?.modelName || ""),
      maxTokens: Number(config.value.memory?.groupCapture?.consolidation?.maxTokens) || 100000,
      minConfidence: Number(config.value.memory?.groupCapture?.consolidation?.minConfidence ?? 0.7),
      retrievalResultLimit: Number(config.value.memory?.retrieval?.resultLimit) || 3,
    })
    const defaultReplyModelName = computed(() => String(config.value.modelTasks?.replyer?.modelList?.[0] || config.value.models?.find(model => model.capabilities?.chat !== false)?.name || "").trim())
    const captureModelOptions = computed(() => [
      { value: "", label: defaultReplyModelName.value ? `跟随默认对话模型 · ${defaultReplyModelName.value}` : "跟随默认对话模型" },
      ...(config.value.models || [])
        .filter(model => model.name && model.capabilities?.chat !== false)
        .map(model => ({ value: model.name, label: model.modelIdentifier && model.modelIdentifier !== model.name ? `${model.name} · ${model.modelIdentifier}` : model.name })),
    ])
    const memoryEmbeddingModelOptions = computed(() => [
      { value: "", label: "关闭向量召回 · 仅全文检索" },
      ...(config.value.models || [])
        .filter(model => model.name && model.capabilities?.embedding === true)
        .map(model => ({ value: model.name, label: model.modelIdentifier && model.modelIdentifier !== model.name ? `${model.name} · ${model.modelIdentifier}` : model.name })),
    ])

    const memoryRerankModelOptions = computed(() => [
      { value: "", label: "单独选择记忆重排模型" },
      ...(config.value.models || []).filter(model => model.name && (model.purpose === "rerank" || model.adapter === "rerank"))
        .map(model => ({ value: model.name, label: model.modelIdentifier && model.modelIdentifier !== model.name ? `${model.name} · ${model.modelIdentifier}` : model.name })),
    ])

    const manifestMetrics = computed(() => {
      const s = manifest.value.summary || {}
      return [
        { label: "配置页签", value: s.tabs || 0, icon: "list", tone: "blue" },
        { label: "配置分组", value: s.sections || 0, icon: "filter", tone: "purple" },
        { label: "字段", value: s.fields || 0, icon: "sliders", tone: "cyan" },
        { label: "敏感项", value: s.sensitiveFields || 0, icon: "key", tone: "orange" },
        { label: "进阶项", value: s.advancedFields || 0, icon: "gear", tone: "pink" },
      ]
    })

    async function syncDraft(forceGroup = "") {
      const groups = draftGroups.filter(group => forceGroup === "all" || group === forceGroup || !isDirty(group))
      const next = { ...draft }
      next.configJson = toJson(store.config)
      next.webPublicBaseUrl = String(config.value.web?.publicBaseUrl || "")
      next.loggingLevel = config.value.logging?.level || "info"
      next.backupMaxFiles = config.value.system?.backups?.maxFiles ?? 3
      next.backupMaxAgeDays = config.value.system?.backups?.maxAgeDays ?? 30
      next.linkAllowPrivateHosts = config.value.security?.linkSafety?.allowPrivateHosts === true
      next.linkTrustedPrivateDnsBypass = config.value.security?.linkSafety?.trustedPrivateDnsBypass === true
      next.linkScreenshotAllowedHosts = (config.value.security?.linkSafety?.screenshotAllowedHosts || []).join("\n")
      next.memoryEmbeddingTokensPerDay = config.value.memory?.retrieval?.embeddingTokensPerDay ?? 200000
      next.knowledgeEmbeddingTokensPerDay = config.value.knowledge?.indexing?.globalEmbeddingTokensPerDay ?? 2000000
      const capture = config.value.memory?.groupCapture || {}
      const consolidation = capture.consolidation || {}
      const configuredPrompt = String(capture.promptTemplate || "").trim()
      next.captureRetentionDays = Number(capture.defaultRetentionDays ?? 30)
      next.captureTokenLimit = Number(capture.defaultTokenLimit) || 200000
      next.captureModelName = consolidation.modelName || ""
      next.captureUseBuiltInPrompt = !configuredPrompt
      next.capturePromptTemplate = configuredPrompt || captureDefaults.value.promptTemplate || ""
      next.captureMaxTokens = Number(consolidation.maxTokens) || 100000
      const confidence = Number(consolidation.minConfidence)
      next.captureMinConfidence = Number.isFinite(confidence) ? confidence : 0.7
      next.captureMaxWindowsPerScan = Number(consolidation.maxWindowsPerScan) || 2
      next.captureTokensPerDay = Number(consolidation.tokensPerDay) || 0
      next.captureRelatedFactLimit = consolidation.relatedFactLimit ?? 8
      next.captureExpiredFactDays = config.value.memory?.retention?.expiredFactDays ?? 0
      next.captureScheduleMode = consolidation.schedule?.mode || "interval"
      next.captureScheduleTime = consolidation.schedule?.time || "03:00"
      next.captureScheduleCron = consolidation.schedule?.cron || "0 3 * * *"
      next.captureRetrievalResultLimit = Number(config.value.memory?.retrieval?.resultLimit) || 3
      next.capturePromptTokenBudget = Number(config.value.memory?.retrieval?.promptTokenBudget) || 2000
      next.captureEmbeddingModel = String(config.value.memory?.retrieval?.embeddingModel || "")
      next.memoryRerankEnabled = config.value.memory?.retrieval?.rerankEnabled === true
      next.memoryRerankModel = config.value.memory?.retrieval?.rerankModel || ""
      next.memoryRerankCandidates = config.value.memory?.retrieval?.rerankMaxCandidates ?? 20
      next.memoryRerankTokenBudget = config.value.memory?.retrieval?.rerankInputTokenBudget ?? 6000
      next.memoryRerankTimeout = config.value.memory?.retrieval?.rerankTimeoutMs ?? 10000
      next.memoryRerankCache = config.value.memory?.retrieval?.rerankCacheTtlMs ?? 300000
      next.memoryRerankMinScore = config.value.memory?.retrieval?.rerankMinScore ?? ""
      for (const [key, value] of Object.entries(next)) {
        if (groups.includes(groupForKey(key))) Object.assign(draft, { [key]: value })
      }
      for (const group of groups) markClean(group)
    }
    async function saveDeveloperSettings() {
      try {
        const memory = Number(draft.memoryEmbeddingTokensPerDay)
        const knowledge = Number(draft.knowledgeEmbeddingTokensPerDay)
        if (![memory, knowledge].every(value => Number.isInteger(value) && value >= 0 && value <= 100000000)) {
          throw new Error("Embedding 每日预算必须是 0 到 100000000 之间的整数")
        }
        await saveConfigPatch({
          "logging.level": draft.loggingLevel,
          "memory.retrieval.embeddingTokensPerDay": memory,
          "knowledge.indexing.globalEmbeddingTokensPerDay": knowledge,
          ...(systemRenderPanel.value?.getPatch?.() || {}),
        }, "developer-settings")
        await syncDraft("developer")
        toast("开发者设置已保存", "success")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function loadWebAuthToken(force = false) {
      if ((webTokenLoaded.value && !force) || webTokenBusy.value) return
      if (force && isDirty("web-token") && !await confirmAction({ title: "重新读取登录凭证？", message: "当前未保存的令牌输入会被替换。", confirmText: "重新读取", tone: "warn" })) return
      webTokenBusy.value = true
      try {
        const result = await request("/api/config/auth-token")
        draft.webAuthToken = String(result.authToken || "")
        markClean("web-token")
        webTokenLoaded.value = true
      } catch (err) { toast(errorMessage(err)) }
      finally { webTokenBusy.value = false }
    }
    async function saveWebAuthToken() {
      const authToken = String(draft.webAuthToken || "").trim()
      if (authToken && (authToken.length < 16 || authToken.length > 512)) {
        toast("Web 访问令牌留空表示禁用静态登录；启用时长度必须为 16–512 个字符。")
        return
      }
      const accepted = await confirmAction({
        title: authToken ? "更换 Web 访问令牌？" : "禁用静态 Token 登录？",
        message: authToken
          ? "新的长期令牌会立即保存；旧令牌和已有浏览器短会话会失效，当前浏览器会自动换发新会话。"
          : "静态登录令牌将被清除；以后仍可由主人发送 #yui面板 获取一次性快捷链接。当前浏览器会保留新换发的短会话。",
        confirmText: authToken ? "确认更换" : "确认禁用",
        tone: "warn",
        icon: "key",
      })
      if (!accepted) return
      webTokenBusy.value = true
      try {
        const result = await request("/api/config/auth-token", { method: "PUT", body: JSON.stringify({ authToken }) })
        draft.webAuthToken = String(result.authToken || authToken)
        markClean("web-token")
        webTokenLoaded.value = true
        toast(authToken ? "Web 静态访问令牌已更新" : "静态 Token 登录已禁用", "success")
        await refreshSlices(["config"])
      } catch (err) { toast(errorMessage(err)) }
      finally { webTokenBusy.value = false }
    }
    async function saveWebAddress() {
      const raw = String(draft.webPublicBaseUrl || "").trim()
      let normalized = ""
      if (raw) {
        try {
          const url = new URL(raw)
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid")
          normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`
        } catch {
          toast("服务器地址前缀必须是完整的 http/https 地址，不能包含账号密码、查询参数或锚点。")
          return
        }
      }
      try {
        await saveConfigPatch({ "web.publicBaseUrl": normalized }, "web-public-base-url")
        draft.webPublicBaseUrl = normalized
        markClean("web-address")
        await refreshSlices(["config"])
        toast(normalized ? "服务器地址前缀已保存" : "已恢复自动获取服务器地址", "success")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function saveLinkSafety() {
      const screenshotAllowedHosts = [...new Set(String(draft.linkScreenshotAllowedHosts || "")
        .split(/[\n,]+/u)
        .map(value => value.trim().toLowerCase())
        .filter(Boolean))]
      if (draft.linkAllowPrivateHosts || draft.linkTrustedPrivateDnsBypass) {
        const accepted = await confirmAction({
          title: "开启链接安全例外？",
          message: draft.linkAllowPrivateHosts
            ? "这会允许网页、媒体、图片缓存、消息发送和截图访问任意私网地址。仅应在受控网络中开启。"
            : "这只会允许集中登记的 QQ/Bilibili 可信资源接受私网 DNS 结果，其他用户链接仍会拦截私网。",
          confirmText: "确认保存",
          tone: "warn",
          icon: "shield",
        })
        if (!accepted) return
      }
      try {
        await saveConfigPatch({
          "security.linkSafety.allowPrivateHosts": draft.linkAllowPrivateHosts,
          "security.linkSafety.trustedPrivateDnsBypass": draft.linkTrustedPrivateDnsBypass,
          "security.linkSafety.screenshotAllowedHosts": screenshotAllowedHosts,
        }, "link-safety")
        await syncDraft("link-safety")
        await refreshSlices(["config", "render", "diagnostics"])
        toast("链接安全策略已保存", "success")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function copyWebAuthToken() {
      try {
        await navigator.clipboard.writeText(String(draft.webAuthToken || ""))
        toast("Web 访问令牌已复制")
      } catch (err) { toast(errorMessage(err, "复制失败")) }
    }
    async function saveBackupPolicy() {
      try {
        const maxFiles = Number(draft.backupMaxFiles)
        const maxAgeDays = Number(draft.backupMaxAgeDays)
        if (!Number.isInteger(maxFiles) || maxFiles < 3 || maxFiles > 1000) {
          throw new Error("备份文件上限必须是 3 到 1000 之间的整数")
        }
        if (!Number.isInteger(maxAgeDays) || maxAgeDays < 30 || maxAgeDays > 3650) {
          throw new Error("备份保留天数必须是 30 到 3650 之间的整数")
        }
        await saveConfigPatch({
          "system.backups.maxFiles": maxFiles,
          "system.backups.maxAgeDays": maxAgeDays,
        }, "backup-retention")
        await syncDraft("backup")
        await loadBackupDetails()
        toast("备份保留策略已保存并生效")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function createBackup() {
      try {
        const result = await request("/api/config/backups", { method: "POST", body: "{}" })
        store.configBackups = asRecords(result.backups)
        toast("配置包已创建", "success")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function loadBackupDetails() {
      try {
        const result = await request("/api/config/backups")
        store.configBackups = asRecords(result.backups)
      } catch (err) { toast(errorMessage(err)) }
    }
    async function saveCaptureDefaults() {
      try {
        const retentionDays = Math.round(Math.min(100000000, Math.max(0, Number(draft.captureRetentionDays) || 0)))
        const tokenLimit = Math.round(Math.min(1000000, Math.max(3000, Number(draft.captureTokenLimit) || 200000)))
        const maxTokens = Math.round(Math.min(100000, Math.max(256, Number(draft.captureMaxTokens) || 100000)))
        const confidence = Number(draft.captureMinConfidence)
        const minConfidence = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.7
        const maxWindowsPerScan = Math.round(Math.min(64, Math.max(1, Number(draft.captureMaxWindowsPerScan) || 2)))
        const retrievalResultLimit = Math.round(Math.min(20, Math.max(1, Number(draft.captureRetrievalResultLimit) || 3)))
        const promptTokenBudget = Math.round(Math.min(10000, Math.max(30, Number(draft.capturePromptTokenBudget) || 2000)))
        const promptTemplate = draft.captureUseBuiltInPrompt ? "" : String(draft.capturePromptTemplate || "").trim()
        if (!draft.captureUseBuiltInPrompt && !promptTemplate) throw new Error("请填写自定义提示词，或切换为内置默认提示词")
        const scheduleMode = ["interval", "time", "cron"].includes(String(draft.captureScheduleMode)) ? String(draft.captureScheduleMode) : "interval"
        const scheduleTime = String(draft.captureScheduleTime || "03:00").trim()
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) throw new Error("记忆提炼固定时间必须是 HH:mm（00:00–23:59）")
        const scheduleCron = String(draft.captureScheduleCron || "0 3 * * *").trim()
        if (scheduleMode === "cron" && scheduleCron.split(/\s+/).length !== 5) throw new Error("Cron 必须填写五段：分 时 日 月 周")
        await saveConfigPatch({
          "memory.groupCapture.defaultRetentionDays": retentionDays,
          "memory.groupCapture.defaultTokenLimit": tokenLimit,
          "memory.groupCapture.promptTemplate": promptTemplate,
          "memory.groupCapture.consolidation.modelName": draft.captureModelName || "",
          "memory.groupCapture.consolidation.maxTokens": maxTokens,
          "memory.groupCapture.consolidation.minConfidence": minConfidence,
          "memory.groupCapture.consolidation.maxWindowsPerScan": maxWindowsPerScan,
          "memory.groupCapture.consolidation.tokensPerDay": Math.max(0,Math.min(1000000000,Math.round(Number(draft.captureTokensPerDay)||0))),
          "memory.groupCapture.consolidation.relatedFactLimit": Math.max(0,Math.min(20,Math.round(Number(draft.captureRelatedFactLimit)||0))),
          "memory.retention.expiredFactDays": Math.max(0,Math.min(1000000,Math.round(Number(draft.captureExpiredFactDays)||0))),
          "memory.groupCapture.consolidation.schedule.mode": scheduleMode,
          "memory.groupCapture.consolidation.schedule.time": scheduleTime,
          "memory.groupCapture.consolidation.schedule.cron": scheduleCron,
          "memory.retrieval.resultLimit": retrievalResultLimit,
          "memory.retrieval.promptTokenBudget": promptTokenBudget,
          "memory.retrieval.embeddingModel": draft.captureEmbeddingModel || "",
          "memory.retrieval.rerankEnabled": draft.memoryRerankEnabled,
          "memory.retrieval.rerankModel": draft.memoryRerankModel,
          "memory.retrieval.rerankMaxCandidates": Number(draft.memoryRerankCandidates),
          "memory.retrieval.rerankInputTokenBudget": Number(draft.memoryRerankTokenBudget),
          "memory.retrieval.rerankTimeoutMs": Number(draft.memoryRerankTimeout),
          "memory.retrieval.rerankCacheTtlMs": Number(draft.memoryRerankCache),
          "memory.retrieval.rerankMinScore": draft.memoryRerankMinScore === "" ? null : Number(draft.memoryRerankMinScore),
        })
        await syncDraft("memory-capture")
        toast("群记忆系统默认已保存；继承默认的群会自动同步", "success")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function refreshSystem(forceGroup = "") {
      await refreshSlices(["config", "diagnostics", "output"])
      await syncDraft(forceGroup)
    }
    async function saveJson() {
      try {
        const accepted = await confirmAction({ title: "保存完整 JSON 配置？", message: "这会覆盖当前项目配置并立即重新载入；如需回滚，请先在备份页手动备份。", confirmText: "确认保存配置", tone: "warn", icon: "save" })
        if (!accepted) return
        const config = JSON.parse(draft.configJson)
        const saved = await request("/api/config", { method: "POST", body: JSON.stringify({ config }) })
        store.config = asRecord(saved.config)
        store.configMeta = asRecord(saved.meta)
        store.configBackups = asRecords(saved.backups)
        toast("JSON 配置已保存")
        draft.webAuthToken = ""
        webTokenLoaded.value = false
        await refreshSystem("all")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function applyDiagnosticAction(item: DiagnosticIssue) {
      try {
        if (item.patch) {
          const accepted = await confirmAction({
            title: `应用修复“${item.action || "建议配置"}”？`,
            message: "系统会修改相关配置并立即重新检查诊断结果。",
            detail: item.advice || item.message || "",
            confirmText: "应用修复",
            tone: "warn",
            icon: "wrench",
          })
          if (!accepted) return
          await saveConfigPatch(item.patch, "diagnostic-quick-fix")
          await refreshSystem()
          toast("建议配置已应用，诊断结果已重新检查")
          return
        }
        if (item.target === "advanced" && item.section) selectSection(item.section)
        else if (item.target) setTab(item.target)
      } catch (err) { toast(errorMessage(err)) }
    }
    async function requestRestore(fileName: unknown) {
      fileName = String(fileName || "")
      if (!fileName) return
      const accepted = await confirmAction({
        title: "回滚到这个配置备份？",
        message: "这会替换当前运行配置和备份中的配置项，并重新载入运行状态；如需保留当前配置，请先手动备份。",
        detail: fileName,
        confirmText: "确认回滚",
        tone: "warn",
        icon: "restore",
      })
      if (!accepted) return
      try {
        const result = await request("/api/config/restore", { method: "POST", body: JSON.stringify({ fileName }) })
        store.config = asRecord(result.config)
        store.configMeta = asRecord(result.meta)
        store.configBackups = asRecords(result.backups)
        toast("配置已回滚，运行配置已重新载入")
        draft.webAuthToken = ""
        webTokenLoaded.value = false
        await refreshSystem("all")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function requestDeleteBackup(fileName: unknown) {
      const target = String(fileName || "")
      if (!target) return
      const accepted = await confirmAction({
        title: "永久删除这个配置备份？",
        message: "删除后无法从管理台恢复，当前运行配置不会受到影响。",
        detail: target,
        confirmText: "永久删除",
        tone: "danger",
        icon: "trash",
      })
      if (!accepted) return
      try {
        const result = await request(`/api/config/backups/${encodeURIComponent(target)}`, { method: "DELETE" })
        store.configBackups = asRecords(result.backups)
        toast("配置备份已删除")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function closeJsonDrawer(): Promise<void> {
      if (isDirty("config-json")) {
        if (!await confirmAction({ title: "放弃未保存的 JSON 修改？", message: "关闭后恢复为当前已保存的配置。", confirmText: "放弃修改", tone: "warn" })) return
        await syncDraft("config-json")
      }
      showJsonDrawer.value = false
    }
    async function toggleDeveloperMode(value?: boolean) {
      const next = typeof value === "boolean" ? value : !store.developerMode
      if (!next && (isDirty("developer") || isDirty("config-json")) && !await confirmAction({ title: "关闭开发者模式？", message: "当前未保存的开发者设置和 JSON 修改会被放弃。", confirmText: "关闭并放弃修改", tone: "warn" })) return
      setDeveloperMode(next)
      if (!next) {
        showJsonDrawer.value = false
        await nextTick()
        await syncDraft("developer")
        await syncDraft("config-json")
      } else await syncDraft()
    }
    function sectionPills(tab: ManifestTab) {
      return (tab.sections || []).map(id => {
        const section = sectionsById.value[id] || {}
        return { label: `${section.title || id} ${section.fieldCount || 0}${section.advancedCount ? ` / 进阶 ${section.advancedCount}` : ""}` }
      })
    }
    function shortTime(value: unknown) {
      if (!value) return "尚无记录"
      const date = new Date(String(value))
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN")
    }
    function formatBytes(value: unknown) {
      const bytes = Math.max(0, Number(value) || 0)
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    }
    function backupContents(item: UnknownRecord) {
      if (item.kind === "quarantined") return "隔离的无效启动配置"
      if (item.kind === "unreadable") return "文件无法读取"
      const counts = asRecord(item.counts)
      const parts = [item.hasRuntimeConfig ? "运行配置" : "旧版配置"]
      if (item.sqliteAvailable === true) {
        parts.push(`能力规则 ${Number(counts.capabilityRules || 0)}`)
        parts.push(`知识库设置 ${Number(counts.knowledgeBases || 0)}`)
        parts.push(`知识库授权 ${Number(counts.knowledgeGrants || 0)}`)
      } else if (item.sqliteAvailable === false) parts.push("未包含 SQLite 配置")
      return parts.join(" · ")
    }
    watch(config, () => { void syncDraft() })
    watch(() => store.systemSettingsSection, section => {
      if (!section) return
      selectSection(section)
      store.systemSettingsSection = ""
    }, { immediate: true })
    watch(() => [activeSection.value, activeSubsection.value], ([section, child]) => {
      if (section === "status" && child === "credentials") void loadWebAuthToken()
      if (section === "backup" && child === "manage") void loadBackupDetails()
      void syncDraft()
    }, { immediate: true })

    return {
      draft, showJsonDrawer, webTokenVisible, webTokenLoaded, webTokenBusy, systemRenderPanel, webAddressPreview, configMeta, backups, manifest, activeSection, systemSectionItems, subsections, activeSubsection, subsection, selectSection, selectedSubsections, isDirty, sectionDirty,
      systemState, systemTitle, systemDescription, systemMetrics, diagnosticRows, manifestMetrics,
      captureDefaults, captureModelOptions, memoryEmbeddingModelOptions, memoryRerankModelOptions, defaultReplyModelName,
      sectionPills, saveJson, saveDeveloperSettings, loadWebAuthToken, saveWebAddress, saveWebAuthToken, copyWebAuthToken, saveLinkSafety, saveBackupPolicy, createBackup, loadBackupDetails, saveCaptureDefaults, requestRestore, requestDeleteBackup,
      toggleDeveloperMode, closeJsonDrawer, applyDiagnosticAction, shortTime, formatBytes, backupContents, store,
    }
  },
  template: `
    <div class="settings-workspace system-settings-workspace">
      <aside class="settings-rail" aria-label="系统设置导航">
        <div class="settings-rail-kicker">系统设置</div>
        <template v-for="item in systemSectionItems" :key="item.value">
          <button class="settings-rail-group" :class="{ active: activeSection === item.value }" type="button" :aria-current="activeSection === item.value ? 'page' : undefined" @click="selectSection(item.value)">
            <span class="settings-rail-icon"><Icon :name="item.icon" :size="16" /></span>
            <span class="settings-rail-copy"><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
            <span v-if="item.value !== 'langfuse' || sectionDirty(item.value)" class="settings-rail-badge" :class="sectionDirty(item.value) ? 'warn' : item.tone">{{ sectionDirty(item.value) ? '未保存' : item.badge }}</span>
          </button>
          <nav v-if="activeSection === item.value && (item.value !== 'developer' || store.developerMode)" class="settings-rail-subnav" :aria-label="item.label + '分区'">
            <button v-for="child in subsections[item.value]" :key="child.value" class="settings-rail-subitem" :class="{ active: activeSubsection === child.value }" type="button" :aria-current="activeSubsection === child.value ? 'page' : undefined" @click="selectSection(item.value, child.value)"><Icon :name="child.icon" :size="14" /><span>{{ child.label }}</span></button>
          </nav>
        </template>
      </aside>
      <div class="settings-content system-settings-content">
        <header v-if="activeSection !== 'langfuse'" class="settings-content-head">
          <div><div class="eyebrow">{{ systemSectionItems.find(item => item.value === activeSection)?.label }}</div><h2>{{ activeSection === 'developer' && !store.developerMode ? '开发者模式' : subsection.label }}</h2><p>{{ activeSection === 'developer' && !store.developerMode ? '开启后可管理日志、渲染与完整配置。' : subsection.description }}</p></div>
          <Field v-if="activeSection === 'developer'" class="system-developer-toggle" label="开发者模式" type="switch" :model-value="store.developerMode" :hint="store.developerMode ? '已开启' : '已关闭'" @update:model-value="toggleDeveloperMode" />
        </header>
        <LangfusePanel v-show="activeSection === 'langfuse'" :section="selectedSubsections.langfuse" />

        <div v-show="activeSection === 'status'" class="system-settings-pane">
          <div v-show="activeSubsection === 'overview'" class="settings-stack">
            <section class="system-hero" :class="systemState">
        <div class="system-hero-copy">
          <span class="eyebrow"><span class="dot" :class="systemState === 'good' ? 'on' : (systemState === 'bad' ? 'bad' : 'warn')"></span>系统状态</span>
          <h2>{{ systemTitle }}</h2>
          <p>{{ systemDescription }}</p>
          <span class="muted small">最近应用：{{ shortTime(configMeta.lastReloadedAt) }}</span>
        </div>
      </section>

      <MetricGrid :items="systemMetrics" compact />
      <Panel v-if="diagnosticRows.length" title="建议处理项" icon="alert">
        <PagedList :rows="diagnosticRows" :page-size="6" label="问题" empty="当前没有需要处理的问题。" v-slot="{ item }">
          <div class="diagnostic-action-card" :class="item.level">
            <span class="diagnostic-action-icon"><Icon :name="item.level === 'error' ? 'alert' : 'info'" :size="16" /></span>
            <div class="diagnostic-action-copy"><b>{{ item.message }}</b><p>{{ item.advice }}</p><span>{{ item.area }}</span></div>
            <button v-if="item.action" class="btn small" :class="item.patch ? 'primary' : 'outline'" type="button" @click="applyDiagnosticAction(item)">{{ item.action }}<Icon name="chevron-right" :size="13" /></button>
          </div>
        </PagedList>
      </Panel>


          </div>
          <div v-show="activeSubsection === 'address'" class="settings-stack">
            <Field label="服务器地址" type="text" v-model="draft.webPublicBaseUrl" placeholder="https://bot.example.com 或 https://bot.example.com/admin" description="留空时自动使用 Yunzai 已知地址，并保留 localhost 后备地址" />
            <div class="web-address-preview"><span>管理台入口预览</span><code>{{ webAddressPreview }}</code></div>
            <p class="muted small">主人通过 #yui面板 获取一次性快捷链接；这里设置链接使用的服务器地址。</p>
            <footer class="system-settings-save-bar"><span>{{ isDirty('web-address') ? '有未保存的更改' : '设置已同步' }}</span><button class="btn primary" type="button" @click="saveWebAddress"><Icon name="save" :size="14" />保存访问地址</button></footer>
          </div>
          <div v-show="activeSubsection === 'credentials'" class="settings-stack">
            <p class="muted small">长期令牌用于管理台首次登录与脚本请求头；一次性快捷登录仍由主人通过 #yui面板 发起。</p>
            <div class="action-bar"><button class="btn small outline" type="button" :disabled="webTokenBusy" @click="loadWebAuthToken(true)"><Icon name="refresh" :size="14" />重新读取</button></div>
            <Field label="长期登录令牌" :type="webTokenVisible ? 'text' : 'password'" v-model="draft.webAuthToken" :disabled="webTokenBusy" description="留空关闭静态登录；启用时填写 16–512 个字符" />
            <footer class="system-settings-save-bar">
              <div class="action-bar"><button class="btn outline" type="button" :disabled="!webTokenLoaded" @click="webTokenVisible = !webTokenVisible"><Icon :name="webTokenVisible ? 'eye-off' : 'eye'" :size="14" />{{ webTokenVisible ? '隐藏' : '显示' }}</button><button class="btn outline" type="button" :disabled="!webTokenLoaded" @click="copyWebAuthToken"><Icon name="copy" :size="14" />复制</button></div>
              <button class="btn primary" type="button" :disabled="webTokenBusy || !webTokenLoaded" @click="saveWebAuthToken"><Icon name="save" :size="14" />保存登录凭证</button>
            </footer>
          </div>
        </div>

        <div v-show="activeSection === 'link-safety'" class="system-settings-pane">
          <div v-show="activeSubsection === 'network'" class="settings-stack">
            <p class="muted small">网页读取、媒体缓存、消息发送和 URL 截图共用这里的网络访问策略。</p>
            <div class="settings-toggle-grid">
          <div class="settings-toggle-item"><div><strong>允许任意私网链接</strong><small>默认开启；关闭后网页、媒体、图片缓存、消息发送和截图统一拦截私网。</small></div><Switch :model-value="draft.linkAllowPrivateHosts" @update:model-value="draft.linkAllowPrivateHosts = $event" /></div>
          <div class="settings-toggle-item"><div><strong>可信资源私网 DNS 例外</strong><small>默认开启；关闭总私网授权后，仍可单独控制 QQ 媒体和 Bilibili CDN。</small></div><Switch :model-value="draft.linkTrustedPrivateDnsBypass" @update:model-value="draft.linkTrustedPrivateDnsBypass = $event" /></div>
        </div>

          </div>
          <div v-show="activeSubsection === 'screenshot'"><Field label="URL 截图允许域名" type="textarea" :rows="8" v-model="draft.linkScreenshotAllowedHosts" placeholder="*\nexample.com\n*.example.com" hint="* 允许全部域名；也可用精确域名或 *.example.com 子域通配，每行或逗号分隔。" /></div>
          <footer class="system-settings-save-bar"><span>{{ isDirty('link-safety') ? '有未保存的更改' : '设置已同步' }}</span><button class="btn primary" type="button" @click="saveLinkSafety"><Icon name="save" :size="14" />保存链接策略</button></footer>
        </div>

        <div v-show="activeSection === 'backup'" class="system-settings-pane">
          <div v-show="activeSubsection === 'manage'" class="settings-stack">
            <p class="muted small">备份只在点击按钮时创建。每份文件包含逻辑运行配置覆盖（含已配置的服务凭证），以及 SQLite 中的能力权限、知识库设置与授权；不包含运行日志、用量流水、聊天、记忆和知识正文。</p>
            <div class="backup-directory"><Icon name="folder" :size="14" /><span>保存目录</span><code>{{ configMeta.configBackupDir || 'data/yui-chat/backups/' }}</code></div>
            <div class="action-bar"><button class="btn primary" type="button" @click="createBackup"><Icon name="save" :size="14" />手动备份配置</button></div>
            <PagedList :rows="backups" :page-size="6" label="备份" list-class="backup-timeline" empty="暂无手动配置备份。" v-slot="{ item }">
          <div class="backup-row">
            <span class="backup-dot"></span>
            <div class="backup-copy">
              <b>{{ item.reason === "manual" ? "手动备份" : (item.reason || "配置备份") }}</b>
              <span>{{ shortTime(item.createdAt || item.modifiedAt) }} · {{ backupContents(item) }}</span>
              <small>{{ item.fileName || "" }}</small>
            </div>
            <span class="muted tiny">{{ formatBytes(item.size) }}</span>
            <div class="backup-actions">
              <button v-if="item.restorable !== false" class="btn small outline" type="button" @click="requestRestore(item.fileName)"><Icon name="restore" :size="14" />回滚</button>
              <button class="icon-btn sm danger" type="button" data-tip="永久删除备份" @click="requestDeleteBackup(item.fileName)"><Icon name="trash" :size="14" /></button>
            </div>
          </div>
        </PagedList>

          </div>
          <div v-show="activeSubsection === 'retention'" class="settings-stack">
            <p class="muted small">至少保留最新指定份数；只有更早的备份同时超过保留天数时，才会在创建手动备份时清理。</p>
            <div class="form-grid"><Field label="最少保留份数" type="number" v-model="draft.backupMaxFiles" hint="3–1000 个" /> <Field label="保护天数" type="number" v-model="draft.backupMaxAgeDays" hint="30–3650 天" /></div>
            <footer class="system-settings-save-bar"><span>{{ isDirty('backup') ? '有未保存的更改' : '设置已同步' }}</span><button class="btn primary" type="button" @click="saveBackupPolicy"><Icon name="save" :size="14" />保存保留策略</button></footer>
          </div>
        </div>

        <div v-show="activeSection === 'memory-capture'" class="system-settings-pane memory-capture-defaults">
          <p class="muted small">这些是系统默认值。单群可在“记忆管理 → 采集设置”覆盖，恢复继承后跟随系统默认。</p>
          <div v-show="activeSubsection === 'retention'" class="settings-stack"><div class="form-grid"><Field label="原始消息保留天数" type="number" v-model="draft.captureRetentionDays" description="0 表示永久保留；有限保留最少 1 天" /> <Field label="事实到期后删除天数" type="number" v-model="draft.captureExpiredFactDays" description="0 保留历史。短期记录与经历继续使用原有清理规则。" /></div></div>
          <div v-show="activeSubsection === 'extraction'" class="settings-stack">
            <Field label="提炼模型" type="select" :options="captureModelOptions" v-model="draft.captureModelName" :description="defaultReplyModelName ? '留空时使用默认对话模型：' + defaultReplyModelName : '留空时使用当前默认对话模型'" />
            <div class="form-grid"><Field label="输入 Token 上限（提炼与 AI 整理）" type="number" v-model="draft.captureTokenLimit" description="默认 200,000，可设 3,000–1,000,000。每日提炼按消息切分；AI 整理计入系统提示和完整资料，超限时停止。" /> <Field label="输出 Token 上限（提炼与 AI 整理）" type="number" v-model="draft.captureMaxTokens" description="默认 100,000，可设 256–100,000；思考 Token 也计入，实际受模型能力限制" /> <Field label="候选置信度阈值" type="number" v-model="draft.captureMinConfidence" description="0–1；低于此值的候选不会写入记忆" /></div>
            <label class="field"><span class="field-label">提炼提示词</span><span class="row"><Switch tip="使用内置提炼提示词" v-model="draft.captureUseBuiltInPrompt" /><small>{{ draft.captureUseBuiltInPrompt ? '使用内置默认提示词' : '使用下方自定义提示词' }}</small></span></label>
            <Field label="提示词内容" type="textarea" :rows="12" v-model="draft.capturePromptTemplate" :disabled="draft.captureUseBuiltInPrompt" :description="draft.captureUseBuiltInPrompt ? '当前展示的是内置默认提示词；关闭上方开关后可复制并修改。' : '自定义提示词会成为新群的默认值。'" />
          </div>
          <div v-show="activeSubsection === 'schedule'" class="settings-stack">
            <p class="muted small">全部群共用后台预算；这里仅控制自动提炼，手动“立即执行”不受触发计划限制。</p>
            <div class="form-grid"><Field label="每日提炼 Token 预算" type="number" v-model="draft.captureTokensPerDay" description="全部群共用，0 不限制。包含失败重试，额度不足次日继续；手动 AI 整理不计入此预算。" /> <Field label="相关旧事实条数" type="number" v-model="draft.captureRelatedFactLimit" description="默认 8，0–20；本地检索，不额外调用模型" /> <Field label="每轮扫描窗口数" type="number" v-model="draft.captureMaxWindowsPerScan" description="1–64；积压时可临时调高" /> <Field label="提炼触发方式" type="select" v-model="draft.captureScheduleMode" :options="[{ value: 'interval', label: '跟随扫描间隔（兼容默认）' }, { value: 'time', label: '每天固定时间' }, { value: 'cron', label: 'Cron 表达式' }]" /></div>
            <Field v-if="draft.captureScheduleMode === 'time'" label="每天触发时间" type="time" v-model="draft.captureScheduleTime" description="按服务器本地时区执行，例如 03:00。" /> <Field v-if="draft.captureScheduleMode === 'cron'" label="Cron（分 时 日 月 周）" v-model="draft.captureScheduleCron" placeholder="0 3 * * *" description="五段本地 Cron；例如 0 3 * * * = 每天 03:00，*/30 * * * * = 每 30 分钟。" />
          </div>
          <div v-show="activeSubsection === 'recall'" class="settings-stack">
            <div class="form-grid"><Field label="自动注入记忆条数" type="number" v-model="draft.captureRetrievalResultLimit" description="1–20；默认 3，单群可覆盖。" /> <Field label="记忆提示 Token 预算" type="number" v-model="draft.capturePromptTokenBudget" description="30–10,000；默认 2,000，仅限制日常自动注入。" /></div>
            <Field label="记忆向量模型" type="select" :options="memoryEmbeddingModelOptions" v-model="draft.captureEmbeddingModel" description="独立选择，与知识库向量模型互不联动；留空只进行本地全文检索。" />
            <p class="muted small">“查询我的全部记忆并总结”使用独立的本人记忆读取与分页，不受日常注入条数限制。</p>
          </div>
          <div v-show="activeSubsection === 'rerank'" class="settings-stack">
            <Field label="启用记忆重排" type="switch" v-model="draft.memoryRerankEnabled" description="对少量融合候选重新评估相关性；关闭、超时或失败时使用 RRF 融合排名。" /> <Field label="记忆重排模型" type="select" :options="memoryRerankModelOptions" v-model="draft.memoryRerankModel" :disabled="!draft.memoryRerankEnabled" description="单独选择专用重排模型，不继承知识库 RAG 或全局重排任务。" /> <details v-if="draft.memoryRerankEnabled" class="capture-default-prompt"><summary>重排候选、预算与缓存</summary><div class="form-grid" style="padding:12px">
              <Field label="重排候选上限" type="number" v-model="draft.memoryRerankCandidates" description="1–30；默认 20。" />
              <Field label="重排输入 Token 预算" type="number" v-model="draft.memoryRerankTokenBudget" description="200–30000；默认 6000。" />
              <Field label="重排超时（毫秒）" type="number" v-model="draft.memoryRerankTimeout" description="1000–60000；默认 10000。" />
              <Field label="重排缓存（毫秒）" type="number" v-model="draft.memoryRerankCache" description="0–86400000；默认 300000，0 为关闭。" />
              <Field label="重排最低分" type="number" v-model="draft.memoryRerankMinScore" description="留空不额外过滤；不同模型的分数含义可能不同。" />
            </div></details>

          </div>
          <footer class="system-settings-save-bar"><span>{{ isDirty('memory-capture') ? '有未保存的更改' : '设置已同步' }}</span><button class="btn primary" type="button" @click="saveCaptureDefaults"><Icon name="save" :size="14" />保存群记忆默认</button></footer>
        </div>

        <div v-show="activeSection === 'developer'" class="system-settings-pane">
          <div v-if="!store.developerMode" class="developer-gate"><span class="developer-gate-icon"><Icon name="sliders" :size="22" /></span><div><h3>高级配置已隐藏</h3><p>开启后可查看完整 JSON、Schema、运行路径和原始诊断。</p></div></div>
          <div v-else class="settings-stack">
            <div v-show="activeSubsection === 'logs'" class="settings-stack">
              <Field label="本地日志等级" type="select" v-model="draft.loggingLevel" :options="[{ value: 'off', label: '关闭' }, { value: 'error', label: '仅错误' }, { value: 'warn', label: '警告' }, { value: 'info', label: '常规' }, { value: 'debug', label: '调试' }]" description="控制模型、工具链和 Token 汇总日志。" />
              <div class="form-grid"><Field label="记忆 embedding Token / 天" type="number" v-model="draft.memoryEmbeddingTokensPerDay" hint="默认 200000" /> <Field label="知识库 embedding Token / 天" type="number" v-model="draft.knowledgeEmbeddingTokensPerDay" hint="默认 2000000" /></div>
            </div>
            <div v-show="activeSubsection === 'render'"><SystemRenderStrategyPanel ref="systemRenderPanel" :show-save="false" /></div>
            <div v-show="activeSubsection === 'config'" class="settings-stack">
              <div class="developer-warning"><Icon name="alert" :size="16" /><span>完整 JSON 适合批量修改配置。保存前仍会执行后端校验；需要回滚时请先手动备份。</span></div>
              <div class="action-bar"><button class="btn primary" type="button" @click="showJsonDrawer = true"><Icon name="pencil" :size="14" />编辑完整 JSON</button></div>
            </div>
            <div v-show="activeSubsection === 'diagnostics'" class="settings-stack">
              <JsonBlock title="配置运行态与路径" :value="configMeta" />
              <Collapse title="配置结构 Schema" hint="查看字段、敏感项和进阶项统计">
            <MetricGrid :items="manifestMetrics" compact />
            <PagedList :rows="manifest.tabs || []" :page-size="4" label="页签" list-class="config-schema-list" empty="暂无配置结构。" v-slot="{ item }">
              <div class="schema-card" :data-tip="item.description || ''">
                <div class="item-title truncate">{{ item.label || item.id }}</div>
                <PillList :items="sectionPills(item)" />
              </div>
            </PagedList>
          </Collapse>


              <JsonBlock title="原始调试数据 · Schema / 输出 / 诊断" :value="{ schema: store.schema, output: store.output, diagnostics: store.diagnostics }" />
            </div>
            <footer v-if="activeSubsection === 'logs' || activeSubsection === 'render'" class="system-settings-save-bar"><span>{{ isDirty('developer') ? '有未保存的更改' : '设置已同步' }}</span><button class="btn primary" type="button" @click="saveDeveloperSettings"><Icon name="save" :size="14" />保存开发者设置</button></footer>
          </div>
          <SideDrawer v-if="store.developerMode" :open="showJsonDrawer && activeSection === 'developer'" title="完整配置 JSON" subtitle="保存时执行完整配置校验；关闭未保存草稿前会提醒。" icon="sliders" width="760px" @close="closeJsonDrawer">
            <Field type="textarea" v-model="draft.configJson" :rows="22" />
            <template #actions><button class="btn primary small" type="button" @click="saveJson"><Icon name="save" :size="14" />保存 JSON</button></template>
          </SideDrawer>
        </div>
      </div>
    </div>
  `,
}
