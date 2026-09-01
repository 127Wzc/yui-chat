import { reactive } from "vue"
import { createApiClient } from "./api.js"

export type UnknownRecord = Record<string, unknown>
export type DataSlice = UnknownRecord | null

const validTabs = ["overview", "chat", "logs", "providers", "persona", "tools", "filters", "tool-permissions", "knowledge", "memory", "advanced"] as const
type TabName = typeof validTabs[number]
type SliceName = "config" | "health" | "providers" | "tools" | "filters" | "skills" | "output" | "mcp" | "diagnostics" | "conversations" | "subAgentRuns" | "capabilities" | "setupGuide" | "logsSummary" | "memory" | "render" | "knowledge"

interface ClientStore {
  token: string
  authenticated: boolean
  theme: "light" | "dark"
  developerMode: boolean
  activeTab: TabName
  ready: boolean
  bootError: string
  sliceErrors: Record<string, string>
  sliceLoading: Record<string, boolean>
  dirtyScopes: Record<string, boolean>
  pendingTab: string
  systemSettingsSection: string
  config: DataSlice
  schema: DataSlice
  schemaManifest: DataSlice
  configMeta: DataSlice
  configBackups: UnknownRecord[]
  health: DataSlice
  providers: DataSlice
  tools: DataSlice
  filters: DataSlice
  skills: DataSlice
  mcp: DataSlice
  output: DataSlice
  knowledge: DataSlice
  memory: DataSlice
  render: DataSlice
  diagnostics: DataSlice
  conversations: DataSlice
  subAgentRuns: DataSlice
  capabilities: DataSlice
  setupGuide: DataSlice
  logsSummary: DataSlice
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 单一数据源：组件只读 store、只调下面的 actions。
const hashTab = (location.hash || "").replace(/^#/, "")
const initialTab: TabName = (validTabs as readonly string[]).includes(hashTab) ? hashTab as TabName : "overview"

export const store = reactive<ClientStore>({
  // UI 状态
  token: "",
  authenticated: false,
  theme: localStorage.getItem("yui-chat-theme") === "dark" ? "dark" : "light",
  developerMode: localStorage.getItem("yui-chat-developer-mode") === "true",
  activeTab: initialTab,
  ready: false,
  bootError: "",
  sliceErrors: {},
  sliceLoading: {},
  dirtyScopes: {},
  pendingTab: "",
  systemSettingsSection: "",
  // 数据切片（与后端 /api/* 一一对应）
  config: null,
  schema: null,
  schemaManifest: null,
  configMeta: null,
  configBackups: [],
  health: null,
  providers: null,
  tools: null,
  filters: null,
  skills: null,
  mcp: null,
  output: null,
  knowledge: null,
  memory: null,
  render: null,
  diagnostics: null,
  conversations: null,
  subAgentRuns: null,
  capabilities: null,
  setupGuide: null,
  logsSummary: null,
})

const client = createApiClient({ getToken: () => store.token })
export const request = client.request
export const apiUrl = client.api

// ---- Toast ----
export const toastState = reactive({ message: "", tone: "info", icon: "info", show: false })
let toastTimer: ReturnType<typeof setTimeout> | undefined
function inferToastTone(message: string = "", requested: string = ""): string {
  if (["success", "warn", "danger", "info"].includes(requested)) return requested
  const text = String(message).toLowerCase()
  if (/失败|错误|异常|无效|不存在|拒绝|缺少|无法|未能|not found|error/.test(text)) return "danger"
  if (/已删除|已清理|已退出|停用|覆盖|风险|请先|注意/.test(text)) return "warn"
  if (/成功|已保存|已启用|完成|通过|已生成|已刷新|已导入|已载入|已安装|已更新/.test(text)) return "success"
  return "info"
}
export function toast(message: unknown, tone: string = ""): void {
  toastState.message = String(message ?? "")
  toastState.tone = inferToastTone(toastState.message, tone)
  toastState.icon = toastState.tone === "success" ? "check" : toastState.tone === "info" ? "info" : "alert"
  toastState.show = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastState.show = false }, 2600)
}

// ---- 全局二次确认 ----
export interface ConfirmOptions {
  title?: unknown
  message?: unknown
  detail?: unknown
  confirmText?: unknown
  cancelText?: unknown
  tone?: unknown
  icon?: unknown
}

export const confirmState = reactive({
  open: false,
  title: "请确认操作",
  message: "",
  detail: "",
  confirmText: "确认",
  cancelText: "取消",
  tone: "danger",
  icon: "alert",
})
let confirmResolver: ((accepted: boolean) => void) | null = null

export function confirmAction(options: ConfirmOptions = {}): Promise<boolean> {
  if (confirmResolver) confirmResolver(false)
  Object.assign(confirmState, {
    open: true,
    title: String(options.title || "请确认操作"),
    message: String(options.message || "此操作会立即生效。"),
    detail: String(options.detail || ""),
    confirmText: String(options.confirmText || "确认"),
    cancelText: String(options.cancelText || "取消"),
    tone: options.tone === "warn" ? "warn" : "danger",
    icon: String(options.icon || (options.tone === "warn" ? "restore" : "alert")),
  })
  return new Promise(resolve => { confirmResolver = resolve })
}

export function settleConfirm(accepted = false): void {
  confirmState.open = false
  const resolve = confirmResolver
  confirmResolver = null
  resolve?.(Boolean(accepted))
}

// ---- 切片刷新 ----
const refreshers: Record<SliceName, () => Promise<void>> = {
  config: async () => {
    const cfg = await request("/api/config")
    store.config = record(cfg.config)
    store.schema = record(cfg.schema)
    store.schemaManifest = record(cfg.schemaManifest)
    store.configMeta = record(cfg.meta)
    store.configBackups = Array.isArray(cfg.backups) ? cfg.backups.map(record) : []
  },
  health: async () => { store.health = await request("/api/health") },
  providers: async () => { store.providers = await request("/api/providers") },
  tools: async () => { store.tools = await request("/api/tools") },
  filters: async () => {
    const filtering = await request("/api/message-filters")
    const custom = await request("/api/custom-filters").catch(() => null)
    store.filters = custom ? { ...filtering, custom: custom.custom, customImplementations: custom.implementations || [] } : filtering
  },
  skills: async () => { store.skills = await request("/api/skills") },
  output: async () => { store.output = await request("/api/output") },
  mcp: async () => { store.mcp = await request("/api/mcp") },
  diagnostics: async () => { store.diagnostics = record((await request("/api/diagnostics")).diagnostics) },
  conversations: async () => { store.conversations = await request("/api/conversations") },
  subAgentRuns: async () => { try { store.subAgentRuns = await request("/api/subagent/runs") } catch { store.subAgentRuns = { runs: [] } } },
  capabilities: async () => { store.capabilities = record((await request("/api/capabilities")).registry) },
  setupGuide: async () => { store.setupGuide = record((await request("/api/setup-guide")).guide) },
  logsSummary: async () => {
    const to = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const from = new Date(Date.now() + 8 * 60 * 60 * 1000 - 6 * 86400000).toISOString().slice(0, 10)
    store.logsSummary = record((await request(`/api/logs/summary?from=${from}&to=${to}`)).summary)
  },
  memory: async () => { store.memory = await request("/api/memory") },
  render: async () => { store.render = await request("/api/render/templates") },
  knowledge: async () => { store.knowledge = await request("/api/knowledge") },
}

// 每个页面真正依赖的切片；保存后只刷新这些，不再 loadAll 全量。
export const tabSlices: Record<TabName, SliceName[]> = {
  overview: ["config", "diagnostics", "conversations", "setupGuide", "logsSummary"],
  chat: ["config", "providers", "conversations", "setupGuide"],
  logs: ["config"],
  providers: ["config", "providers", "diagnostics", "subAgentRuns"],
  persona: ["config", "output", "diagnostics"],
  tools: ["config", "tools", "skills", "mcp", "render", "diagnostics"],
  filters: ["filters", "config"],
  "tool-permissions": ["config", "tools", "skills", "mcp", "render", "diagnostics"],
  knowledge: ["config", "knowledge", "diagnostics"],
  memory: ["config", "memory", "diagnostics"],
  advanced: ["config", "memory", "diagnostics", "output"],
}

async function refreshSlice(key: SliceName): Promise<void> {
  store.sliceLoading[key] = true
  try {
    await refreshers[key]()
    delete store.sliceErrors[key]
  } catch (error) {
    store.sliceErrors[key] = errorMessage(error)
    throw error
  } finally {
    store.sliceLoading[key] = false
  }
}

export async function refreshSlices(keys: string[] = []): Promise<void> {
  const unique = [...new Set(keys)].filter((key): key is SliceName => Object.hasOwn(refreshers, key))
  await Promise.all(unique.map(refreshSlice))
}

export async function refreshTab(tab: string = store.activeTab): Promise<void> {
  const selected = Object.hasOwn(tabSlices, tab) ? tab as TabName : "overview"
  await refreshSlices(tabSlices[selected] || tabSlices.overview)
}

export async function loadAll() {
  await Promise.all((Object.keys(refreshers) as SliceName[]).map(refreshSlice))
  store.ready = true
}

// 首屏只加载当前页面需要的数据。非鉴权错误按切片隔离，避免一个低频模块拖垮整个控制台。
export async function loadInitial(tab: string = store.activeTab): Promise<{ loaded: number; failed: number }> {
  const selected = Object.hasOwn(tabSlices, tab) ? tab as TabName : "overview"
  const keys = [...new Set(tabSlices[selected] || tabSlices.overview)].filter(key => refreshers[key])
  const results = await Promise.allSettled(keys.map(refreshSlice))
  const errors = results.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason)
  const authError = errors.find(error => /unauthorized|token|登录|令牌|401/i.test(errorMessage(error)))
  if (authError) {
    store.authenticated = false
    throw authError
  }
  if (errors.length === results.length && errors[0]) throw errors[0]
  store.authenticated = true
  store.ready = true
  return { loaded: results.length - errors.length, failed: errors.length }
}

// ---- 通用 actions ----
export async function saveConfigPatch(patch: UnknownRecord, _source = ""): Promise<UnknownRecord> {
  const saved = await request("/api/config", {
    method: "PATCH",
    body: JSON.stringify({ patch }),
  })
  store.config = record(saved.config)
  store.configMeta = record(saved.meta) || store.configMeta
  store.configBackups = Array.isArray(saved.backups) ? saved.backups.map(record) : store.configBackups
  const changedPaths = Array.isArray(saved.changedPaths) ? saved.changedPaths : []
  toast(`配置已保存${changedPaths.length ? `：${changedPaths.length} 项` : ""}`)
  await refreshTab()
  return saved
}

export function setDirtyScope(scope: unknown, dirty = true): void {
  const key = String(scope || "").trim()
  if (!key) return
  if (dirty) store.dirtyScopes[key] = true
  else delete store.dirtyScopes[key]
}

export function hasUnsavedChanges(): boolean {
  return Object.values(store.dirtyScopes).some(Boolean)
}

export function cancelPendingNavigation() {
  store.pendingTab = ""
}

export function discardPendingNavigation() {
  const target = store.pendingTab
  if (!target) return
  setDirtyScope(`tab:${store.activeTab}`, false)
  store.pendingTab = ""
  setTab(target)
}

export function setTab(tab: string): boolean | undefined {
  if (!(validTabs as readonly string[]).includes(tab)) return
  const changed = store.activeTab !== tab
  if (changed && hasUnsavedChanges()) {
    store.pendingTab = tab
    if (location.hash !== `#${store.activeTab}`) {
      history.replaceState(null, "", `${location.pathname}${location.search}#${store.activeTab}`)
    }
    return false
  }
  store.activeTab = tab as TabName
  if (location.hash !== `#${tab}`) {
    history.replaceState(null, "", `${location.pathname}${location.search}#${tab}`)
  }
  if (changed && store.ready) refreshTab(tab).catch(error => toast(errorMessage(error) || "页面数据加载失败"))
  return true
}

export function openSystemSettings(section: unknown = "status"): boolean | undefined {
  store.systemSettingsSection = String(section || "status")
  return setTab("advanced")
}

/** 消费由主人 #yui面板 命令签发的一次性码；页面本身不提供签发入口。 */
export async function consumeQuickLogin(): Promise<boolean> {
  const params = new URLSearchParams(location.search)
  const code = params.get("quick")
  if (!code) return false
  params.delete("quick")
  const query = params.toString()
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash || ""}`)
  await request("/api/auth/quick-login", {
    method: "POST",
    body: JSON.stringify({ code }),
  })
  store.authenticated = true
  return true
}

export function syncToken(value: unknown): void {
  store.token = String(value ?? "")
}

// ---- 主题（light 默认 / dark 切换）----
const THEME_KEY = "yui-chat-theme"
export function applyTheme(theme: unknown): void {
  const next = theme === "light" ? "light" : "dark"
  store.theme = next
  if (typeof document !== "undefined") document.documentElement.dataset.theme = next
  try { localStorage.setItem(THEME_KEY, next) } catch { /* best-effort：失败不影响主流程。 */ }
}
export function toggleTheme() {
  applyTheme(store.theme === "dark" ? "light" : "dark")
}

export function setDeveloperMode(enabled: unknown): void {
  store.developerMode = Boolean(enabled)
  try { localStorage.setItem("yui-chat-developer-mode", store.developerMode ? "true" : "false") } catch { /* best-effort：失败不影响主流程。 */ }
}

export function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws"
  let ws
  try {
    ws = new WebSocket(`${proto}://${location.host}${location.pathname.replace(/\/$/, "")}/ws`)
  } catch {
    return
  }
  ws.onmessage = event => {
    try {
      const data = JSON.parse(event.data)
      if (data.type === "status" || data.type === "hello") refreshTab().catch(() => {})
    } catch { /* best-effort：失败不影响主流程。 */ }
  }
  const timer = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }))
  }, 15000)
  ws.onclose = () => clearInterval(timer)
}
