import { computed, reactive, ref, watch } from "vue"
import { confirmAction, refreshSlices, request, saveConfigPatch, setDeveloperMode, setTab, store, toast } from "../../app/store/store.js"
import { toJson } from "../../shared/format.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../../shared/data.js"

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
interface ModelConfig { name?: string; modelIdentifier?: string; capabilities?: { chat?: boolean } }
interface ConsolidationConfig { modelName?: string; maxTokens?: number; minConfidence?: number; maxWindowsPerScan?: number }
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
  memory?: { retrieval?: { embeddingTokensPerDay?: number; resultLimit?: number }; groupCapture?: GroupCaptureConfig }
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

export const AdvancedTab = {
  name: "AdvancedTab",
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
      captureTokenLimit: config.value.memory?.groupCapture?.defaultTokenLimit ?? 30000,
      captureModelName: config.value.memory?.groupCapture?.consolidation?.modelName || "",
      captureUseBuiltInPrompt: !String(config.value.memory?.groupCapture?.promptTemplate || "").trim(),
      capturePromptTemplate: String(config.value.memory?.groupCapture?.promptTemplate || "").trim(),
      captureMaxTokens: config.value.memory?.groupCapture?.consolidation?.maxTokens ?? 4096,
      captureMinConfidence: config.value.memory?.groupCapture?.consolidation?.minConfidence ?? 0.7,
      captureMaxWindowsPerScan: config.value.memory?.groupCapture?.consolidation?.maxWindowsPerScan ?? 2,
      captureRetrievalResultLimit: config.value.memory?.retrieval?.resultLimit ?? 3,
    })
    const activeSection = ref(store.systemSettingsSection || "status")
    const showJsonDrawer = ref(false)
    const webTokenVisible = ref(false)
    const webTokenLoaded = ref(false)
    const webTokenBusy = ref(false)
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
      if (issue.area === "web") return { ...issue, index, advice: "检查 Web 登录和访问策略。", action: "查看开发设置", target: "advanced", section: "developer" }
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
      { value: "status", label: "运行与登录", description: "检查运行状态并管理 Web 凭证", icon: "activity", badge: systemState.value === "good" ? "正常" : (systemState.value === "bad" ? "错误" : "警告"), tone: systemState.value === "good" ? "on" : (systemState.value === "bad" ? "bad" : "warn") },
      { value: "link-safety", label: "链接安全", description: "集中管理私网、可信 DNS 与截图域名", icon: "shield", badge: config.value.security?.linkSafety?.allowPrivateHosts ? "私网已开" : "默认拦截", tone: config.value.security?.linkSafety?.allowPrivateHosts ? "warn" : "on" },
      { value: "backup", label: "备份与恢复", description: "仅在回滚配置时进入", icon: "restore", badge: backups.value.length || 0 },
      { value: "memory-capture", label: "群记忆默认", description: "新采集群继承的保留、提炼和召回参数", icon: "database", badge: "默认" },
      { value: "developer", label: "开发者设置", description: "JSON、Schema 和原始诊断", icon: "sliders", badge: store.developerMode ? "已开启" : "已隐藏", tone: store.developerMode ? "warn" : "" },
    ])
    const captureSummary = computed(() => asRecord<MemorySummary>(store.memory).capture || {})
    const captureDefaults = computed<CaptureDefaults>(() => captureSummary.value.defaultPolicy ? {
      retentionDays: Number(captureSummary.value.defaultPolicy.retentionDays) || 30,
      tokenLimit: Number(captureSummary.value.defaultPolicy.tokenLimit) || 30000,
      promptTemplate: String(captureSummary.value.defaultPolicy.promptTemplate || ""),
      modelName: String(captureSummary.value.defaultPolicy.modelName || ""),
      maxTokens: Number(captureSummary.value.defaultPolicy.maxTokens) || 4096,
      minConfidence: Number(captureSummary.value.defaultPolicy.minConfidence ?? 0.7),
      retrievalResultLimit: Number(captureSummary.value.defaultPolicy.retrievalResultLimit) || 3,
    } : {
      retentionDays: Number(config.value.memory?.groupCapture?.defaultRetentionDays) || 30,
      tokenLimit: Number(config.value.memory?.groupCapture?.defaultTokenLimit) || 30000,
      promptTemplate: String(config.value.memory?.groupCapture?.promptTemplate || "").trim() || captureSummary.value.defaultPromptTemplate || "",
      modelName: String(config.value.memory?.groupCapture?.consolidation?.modelName || ""),
      maxTokens: Number(config.value.memory?.groupCapture?.consolidation?.maxTokens) || 4096,
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

    async function syncDraft() {
      draft.configJson = toJson(store.config)
      draft.webPublicBaseUrl = String(config.value.web?.publicBaseUrl || "")
      draft.loggingLevel = config.value.logging?.level || "info"
      draft.backupMaxFiles = config.value.system?.backups?.maxFiles ?? 3
      draft.backupMaxAgeDays = config.value.system?.backups?.maxAgeDays ?? 30
      draft.linkAllowPrivateHosts = config.value.security?.linkSafety?.allowPrivateHosts === true
      draft.linkTrustedPrivateDnsBypass = config.value.security?.linkSafety?.trustedPrivateDnsBypass === true
      draft.linkScreenshotAllowedHosts = (config.value.security?.linkSafety?.screenshotAllowedHosts || []).join("\n")
      draft.memoryEmbeddingTokensPerDay = config.value.memory?.retrieval?.embeddingTokensPerDay ?? 200000
      draft.knowledgeEmbeddingTokensPerDay = config.value.knowledge?.indexing?.globalEmbeddingTokensPerDay ?? 2000000
      const capture = config.value.memory?.groupCapture || {}
      const consolidation = capture.consolidation || {}
      const configuredPrompt = String(capture.promptTemplate || "").trim()
      draft.captureRetentionDays = Number(capture.defaultRetentionDays) || 30
      draft.captureTokenLimit = Number(capture.defaultTokenLimit) || 30000
      draft.captureModelName = consolidation.modelName || ""
      draft.captureUseBuiltInPrompt = !configuredPrompt
      draft.capturePromptTemplate = configuredPrompt || captureDefaults.value.promptTemplate || ""
      draft.captureMaxTokens = Number(consolidation.maxTokens) || 4096
      const confidence = Number(consolidation.minConfidence)
      draft.captureMinConfidence = Number.isFinite(confidence) ? confidence : 0.7
      draft.captureMaxWindowsPerScan = Number(consolidation.maxWindowsPerScan) || 2
      draft.captureRetrievalResultLimit = Number(config.value.memory?.retrieval?.resultLimit) || 3
    }
    async function saveLoggingLevel() {
      try {
        await saveConfigPatch({ "logging.level": draft.loggingLevel }, "logging-level")
        toast("对话日志等级已保存")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function loadWebAuthToken(force = false) {
      if ((webTokenLoaded.value && !force) || webTokenBusy.value) return
      webTokenBusy.value = true
      try {
        const result = await request("/api/config/auth-token")
        draft.webAuthToken = String(result.authToken || "")
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
          ? "新的长期令牌会立即写入 config/config.json；旧令牌和已有浏览器短会话会失效，当前浏览器会自动换发新会话。"
          : "config.json 将不再保存静态登录令牌；以后仍可由主人发送 #yui面板 获取一次性快捷链接。当前浏览器会保留新换发的短会话。",
        confirmText: authToken ? "确认更换" : "确认禁用",
        tone: "warn",
        icon: "key",
      })
      if (!accepted) return
      webTokenBusy.value = true
      try {
        const result = await request("/api/config/auth-token", { method: "PUT", body: JSON.stringify({ authToken }) })
        draft.webAuthToken = String(result.authToken || authToken)
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
        await refreshSlices(["config"])
        toast(normalized ? "服务器地址前缀已保存并热应用" : "已恢复自动获取服务器地址", "success")
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
        await syncDraft()
        await refreshSlices(["config", "render", "diagnostics"])
        toast("链接安全策略已统一保存并热应用", "success")
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
        await syncDraft()
        await loadBackupDetails()
        toast("备份保留策略已保存并生效")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function createBackup() {
      try {
        const result = await request("/api/config/backups", { method: "POST", body: "{}" })
        store.configBackups = asRecords(result.backups)
        toast(result.sqliteAvailable ? "配置包已创建，已包含 JSON 与 SQLite 配置项" : "配置包已创建；SQLite 不可用，本次只包含 JSON 配置", "success")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function loadBackupDetails() {
      try {
        const result = await request("/api/config/backups")
        store.configBackups = asRecords(result.backups)
      } catch (err) { toast(errorMessage(err)) }
    }
    async function saveEmbeddingBudgets() {
      try {
        const memory = Number(draft.memoryEmbeddingTokensPerDay)
        const knowledge = Number(draft.knowledgeEmbeddingTokensPerDay)
        if (![memory, knowledge].every(value => Number.isInteger(value) && value >= 0 && value <= 100000000)) {
          throw new Error("Embedding 每日预算必须是 0 到 100000000 之间的整数")
        }
        await saveConfigPatch({
          "memory.retrieval.embeddingTokensPerDay": memory,
          "knowledge.indexing.globalEmbeddingTokensPerDay": knowledge,
        })
        await syncDraft()
        toast("Embedding 每日预算已保存")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function saveCaptureDefaults() {
      try {
        const retentionDays = Math.round(Math.min(100000000, Math.max(0, Number(draft.captureRetentionDays) || 0)))
        const tokenLimit = Math.round(Math.min(60000, Math.max(256, Number(draft.captureTokenLimit) || 30000)))
        const maxTokens = Math.round(Math.min(65536, Math.max(256, Number(draft.captureMaxTokens) || 4096)))
        const confidence = Number(draft.captureMinConfidence)
        const minConfidence = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.7
        const maxWindowsPerScan = Math.round(Math.min(64, Math.max(1, Number(draft.captureMaxWindowsPerScan) || 2)))
        const retrievalResultLimit = Math.round(Math.min(20, Math.max(1, Number(draft.captureRetrievalResultLimit) || 3)))
        const promptTemplate = draft.captureUseBuiltInPrompt ? "" : String(draft.capturePromptTemplate || "").trim()
        if (!draft.captureUseBuiltInPrompt && !promptTemplate) throw new Error("请填写自定义提示词，或切换为内置默认提示词")
        await saveConfigPatch({
          "memory.groupCapture.defaultRetentionDays": retentionDays,
          "memory.groupCapture.defaultTokenLimit": tokenLimit,
          "memory.groupCapture.promptTemplate": promptTemplate,
          "memory.groupCapture.consolidation.modelName": draft.captureModelName || "",
          "memory.groupCapture.consolidation.maxTokens": maxTokens,
          "memory.groupCapture.consolidation.minConfidence": minConfidence,
          "memory.groupCapture.consolidation.maxWindowsPerScan": maxWindowsPerScan,
          "memory.retrieval.resultLimit": retrievalResultLimit,
        })
        await syncDraft()
        toast("群记忆系统默认已保存；继承默认的群会自动同步", "success")
      } catch (err) { toast(errorMessage(err)) }
    }
    async function refreshSystem() {
      await refreshSlices(["config", "diagnostics", "output"])
      await syncDraft()
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
        await refreshSystem()
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
        if (item.target === "advanced" && item.section) activeSection.value = item.section
        else if (item.target) setTab(item.target)
      } catch (err) { toast(errorMessage(err)) }
    }
    async function requestRestore(fileName: unknown) {
      fileName = String(fileName || "")
      if (!fileName) return
      const accepted = await confirmAction({
        title: "回滚到这个配置备份？",
        message: "这会替换当前 JSON 配置和备份中的 SQLite 配置项，并重新载入运行状态；如需保留当前配置，请先手动备份。",
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
        await refreshSystem()
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
    function toggleDeveloperMode(value?: boolean) {
      const next = typeof value === "boolean" ? value : !store.developerMode
      setDeveloperMode(next)
      if (!next) showJsonDrawer.value = false
      else syncDraft()
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
    watch(() => store.systemSettingsSection, section => {
      if (!section) return
      activeSection.value = section
      store.systemSettingsSection = ""
    }, { immediate: true })
    watch(activeSection, section => {
      if (section === "memory-capture" || section === "link-safety") syncDraft()
      if (section === "status") loadWebAuthToken()
      if (section === "backup") loadBackupDetails()
    }, { immediate: true })

    return {
      draft, showJsonDrawer, webTokenVisible, webTokenLoaded, webTokenBusy, webAddressPreview, configMeta, backups, manifest, activeSection, systemSectionItems,
      systemState, systemTitle, systemDescription, systemMetrics, diagnosticRows, manifestMetrics,
      captureDefaults, captureModelOptions, defaultReplyModelName,
      sectionPills, saveJson, saveLoggingLevel, loadWebAuthToken, saveWebAddress, saveWebAuthToken, copyWebAuthToken, saveLinkSafety, saveBackupPolicy, createBackup, loadBackupDetails, saveEmbeddingBudgets, saveCaptureDefaults, requestRestore, requestDeleteBackup,
      toggleDeveloperMode, applyDiagnosticAction, shortTime, formatBytes, backupContents, store,
    }
  },
  template: `
    <div class="stack">
      <SectionNav v-model="activeSection" :items="systemSectionItems" label="系统与诊断分区" />

      <div v-if="activeSection === 'status'" class="section-stage">
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

      <Panel title="Web 访问与登录" icon="key">
        <p class="muted small">服务器地址前缀保存在 SQLite 运行配置中并热应用；静态入口只读取 <code>config/config.json</code> 中的 <code>web.authToken</code>。主人通过 <code>#yui面板</code> 获取的一次性快捷链接独立签发，页面不能主动生成。</p>
        <div class="form-section web-auth-settings">
          <div class="developer-section-head">
            <div><b>服务器地址前缀</b><span>可填写自定义域名、端口和反向代理路径；系统会在后面拼接 Web 路由与一次性快捷码。</span></div>
            <button class="btn primary small" type="button" @click="saveWebAddress"><Icon name="save" :size="14" />保存服务器地址</button>
          </div>
          <Field label="web.publicBaseUrl" type="text" v-model="draft.webPublicBaseUrl" placeholder="https://bot.example.com 或 https://bot.example.com/admin" hint="留空时自动使用 Yunzai 已知地址，并保留 localhost 后备地址" />
          <div class="web-address-preview"><span>快捷链接预览</span><code>{{ webAddressPreview }}</code></div>
        </div>
        <div class="form-section web-auth-settings">
          <div class="developer-section-head">
            <div><b>长期 Web 访问令牌</b><span>用于管理台首次登录、脚本请求头和建立浏览器短会话。</span></div>
            <button class="btn small outline" type="button" :disabled="webTokenBusy" @click="loadWebAuthToken(true)"><Icon name="refresh" :size="14" />重新读取</button>
          </div>
          <Field label="web.authToken" :type="webTokenVisible ? 'text' : 'password'" v-model="draft.webAuthToken" :disabled="webTokenBusy" hint="留空关闭静态登录；启用时填写 16–512 个字符" />
          <div class="action-bar">
            <button class="btn outline" type="button" :disabled="!webTokenLoaded" @click="webTokenVisible = !webTokenVisible"><Icon :name="webTokenVisible ? 'eye-off' : 'eye'" :size="14" />{{ webTokenVisible ? '隐藏' : '显示' }}</button>
            <button class="btn outline" type="button" :disabled="!webTokenLoaded" @click="copyWebAuthToken"><Icon name="copy" :size="14" />复制</button>
            <button class="btn primary" type="button" :disabled="webTokenBusy || !webTokenLoaded" @click="saveWebAuthToken"><Icon name="save" :size="14" />保存静态登录设置</button>
          </div>
        </div>
      </Panel>
      </div>

      <Panel v-if="activeSection === 'link-safety'" title="统一链接安全" icon="shield">
        <template #actions><button class="btn primary small" type="button" @click="saveLinkSafety"><Icon name="save" :size="14" />保存并热应用</button></template>
        <p class="muted small">网页读取、入站图片预处理、图片缓存、出站媒体和 URL 截图统一读取这里；各功能页不再保留重复的私网开关。</p>
        <div class="settings-toggle-grid">
          <div class="settings-toggle-item"><div><strong>允许任意私网链接</strong><small>默认开启；关闭后网页、媒体、图片缓存、消息发送和截图统一拦截私网。</small></div><Switch :model-value="draft.linkAllowPrivateHosts" @update:model-value="draft.linkAllowPrivateHosts = $event" /></div>
          <div class="settings-toggle-item"><div><strong>可信资源私网 DNS 例外</strong><small>默认开启；关闭总私网授权后，仍可单独控制 QQ 媒体和 Bilibili CDN。</small></div><Switch :model-value="draft.linkTrustedPrivateDnsBypass" @update:model-value="draft.linkTrustedPrivateDnsBypass = $event" /></div>
        </div>
        <Field label="URL 截图允许域名" type="textarea" rows="8" v-model="draft.linkScreenshotAllowedHosts" placeholder="*\nexample.com\n*.example.com" hint="* 允许全部域名；也可用精确域名或 *.example.com 子域通配，每行或逗号分隔。" />
      </Panel>

      <Panel v-if="activeSection === 'backup'" title="配置备份与恢复" icon="restore">
        <template #actions><button class="btn primary small" type="button" @click="createBackup"><Icon name="save" :size="14" />手动备份配置</button></template>
        <p class="muted small">备份只在点击按钮时创建。每份文件包含逻辑运行配置覆盖（含启动项和已配置的服务凭证），以及 SQLite 中的能力权限、知识库设置与授权；不包含运行日志、用量流水、聊天、记忆和知识正文。</p>
        <div class="backup-directory"><Icon name="folder" :size="14" /><span>保存目录</span><code>{{ configMeta.configBackupDir || 'data/yui-chat/backups/' }}</code></div>

        <div class="form-section">
          <div class="developer-section-head">
            <div><b>手动备份保留策略</b><span>至少保留最新指定份数；只有更早的备份同时超过保留天数时，才会在创建手动备份时清理。</span></div>
            <button class="btn primary small" type="button" @click="saveBackupPolicy"><Icon name="save" :size="14" />保存策略</button>
          </div>
          <div class="form-grid">
            <Field label="最少保留份数" type="number" v-model="draft.backupMaxFiles" hint="3–1000 个" />
            <Field label="保护天数" type="number" v-model="draft.backupMaxAgeDays" hint="30–3650 天" />
          </div>
        </div>

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
      </Panel>

      <Panel v-if="activeSection === 'memory-capture'" title="群记忆系统默认" icon="database">
        <template #actions><button class="btn primary small" type="button" @click="saveCaptureDefaults"><Icon name="save" :size="14" />保存系统默认</button></template>
        <p class="muted small">新采集群会继承这些值。单群可在“记忆管理 → 采集设置”中按字段覆盖，恢复继承后会立即重新跟随这里的默认值。</p>

        <div class="settings-stack">
          <div class="form-section">
            <div class="developer-section-head"><div><b>原始消息与输入切分</b><span>保留期更新后，继承默认的群会按消息发送时间重新计算到期时间。</span></div></div>
            <div class="form-grid capture-token-limits">
              <Field label="原始消息保留天数" type="number" v-model="draft.captureRetentionDays" hint="0 表示永久保留；有限保留最少 1 天" />
              <Field label="输入 Token 上限（单日子窗口）" type="number" v-model="draft.captureTokenLimit" hint="256–60,000；超限消息不会被截断" />
            </div>
          </div>

          <div class="form-section">
            <div class="developer-section-head"><div><b>提炼默认</b><span>留空模型时跟随当前默认对话模型；这些值可由单群覆盖。</span></div></div>
            <Field label="提炼模型" type="select" :options="captureModelOptions" v-model="draft.captureModelName" :hint="defaultReplyModelName ? '留空时使用默认对话模型：' + defaultReplyModelName : '留空时使用当前默认对话模型'" />
            <div class="form-grid capture-token-limits">
              <Field label="输出 Token 上限（单次提炼）" type="number" v-model="draft.captureMaxTokens" hint="256–65,536；推理型模型的思考 Token 也计入" />
              <Field label="候选置信度阈值" type="number" v-model="draft.captureMinConfidence" hint="0–1；低于此值的候选不会写入记忆" />
            </div>
            <label class="field"><span class="field-label">提炼提示词</span><span class="row"><Switch v-model="draft.captureUseBuiltInPrompt" /><small>{{ draft.captureUseBuiltInPrompt ? '使用内置默认提示词' : '使用下方自定义提示词' }}</small></span></label>
            <Field label="提示词内容" type="textarea" :rows="12" v-model="draft.capturePromptTemplate" :disabled="draft.captureUseBuiltInPrompt" :hint="draft.captureUseBuiltInPrompt ? '当前展示的是内置默认提示词；关闭上方开关后可复制并修改。' : '自定义提示词会成为新群的默认值。'" />
          </div>

          <div class="form-section">
            <div class="developer-section-head"><div><b>全局调度</b><span>这是全局吞吐上限，不提供单群覆盖，避免一个群占满提炼队列。</span></div></div>
            <Field label="每轮扫描窗口数" type="number" v-model="draft.captureMaxWindowsPerScan" hint="1–64；积压时可临时调高" />
          </div>

          <div class="form-section">
            <div class="developer-section-head"><div><b>对话记忆召回</b><span>全文命中少于此数量时，才会补一次向量召回；单群可单独覆盖。</span></div></div>
            <Field label="记忆召回条数（向量触发阈值）" type="number" v-model="draft.captureRetrievalResultLimit" hint="1–20；默认 3，同时决定自动注入的记忆条数" />
          </div>
        </div>
      </Panel>

      <Panel v-if="activeSection === 'developer'" title="开发者模式" icon="sliders">
        <template #actions>
          <label class="heading-switch" data-tip="开发者模式会显示完整 JSON、Schema 和原始诊断数据">
            <Switch :model-value="store.developerMode" @update:model-value="toggleDeveloperMode" />
            <span>{{ store.developerMode ? "开发者模式已开启" : "开启开发者模式" }}</span>
          </label>
        </template>

        <div v-if="!store.developerMode" class="developer-gate">
          <span class="developer-gate-icon"><Icon name="sliders" :size="22" /></span>
          <div>
            <h3>高级配置已隐藏</h3>
            <p>完整 JSON、Schema、运行路径和原始诊断适合熟悉配置结构的维护者。日常设置不需要开启。</p>
          </div>
        </div>

        <div v-else class="developer-stack">
          <div class="developer-warning"><Icon name="alert" :size="16" /><span>修改完整 JSON 可能导致模型、工具或权限无法启动。需要回滚时请先手动备份；后端校验仍会阻止无效配置。</span></div>

          <div class="developer-section-head">
            <div><b>对话日志等级</b><span>控制模型、工具链和 Token 汇总日志；不会输出密钥或完整工具结果</span></div>
            <div class="toolbar">
              <select class="input" v-model="draft.loggingLevel"><option value="off">关闭</option><option value="error">仅错误</option><option value="warn">警告</option><option value="info">常规</option><option value="debug">调试</option></select>
              <button class="btn small outline" type="button" @click="saveLoggingLevel"><Icon name="save" :size="14" />保存</button>
            </div>
          </div>

          <div class="developer-section-head">
            <div><b>Embedding 每日预算</b><span>本地预检通过后才占用；0 表示关闭本地上限</span></div>
            <button class="btn small outline" type="button" @click="saveEmbeddingBudgets"><Icon name="save" :size="14" />保存预算</button>
          </div>
          <div class="form-grid">
            <Field label="记忆 embedding Token / 天" type="number" v-model="draft.memoryEmbeddingTokensPerDay" hint="默认 200000" />
            <Field label="知识库 embedding Token / 天" type="number" v-model="draft.knowledgeEmbeddingTokensPerDay" hint="默认 2000000" />
          </div>

          <div class="developer-section-head">
            <div><b>完整配置 JSON</b><span>适合批量修改或排查底层字段</span></div>
            <button class="btn small outline" type="button" @click="showJsonDrawer = true"><Icon name="pencil" :size="14" />编辑 JSON</button>
          </div>

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

        <SideDrawer
          v-if="store.developerMode"
          :open="showJsonDrawer"
          title="完整配置 JSON"
          subtitle="由后端执行完整配置校验；需要回滚时请先手动备份。"
          icon="sliders"
          width="760px"
          @close="showJsonDrawer = false"
        >
          <Field type="textarea" v-model="draft.configJson" rows="22" />
          <template #actions>
            <button class="btn primary small" type="button" @click="saveJson"><Icon name="save" :size="14" />保存 JSON</button>
          </template>
        </SideDrawer>
      </Panel>
    </div>
  `,
}
