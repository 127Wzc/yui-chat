import { asRecord, asRecords } from "../../shared/data.js"

export interface ModelToolPolicyConfig {
  mode?: "inherit" | "allowlist" | "denylist"
  allow?: string[]
  deny?: string[]
  routes?: {
    web_search?: { source?: "auto" | "hosted" | "local" | "disabled"; strategy?: "preferred" | "fallback" | "parallel" }
    tool_search?: { source?: "auto" | "hosted" | "local" | "disabled" }
  }
}

export interface ModelToolPolicyOption {
  value: string
  label: string
  description: string
  meta: string
}

const SEARCH_CAPABILITY_OPTIONS: ModelToolPolicyOption[] = [
  { value: "web_search", label: "Web Search", description: "实时网络搜索能力；具体使用 OpenAI 托管还是本地渠道由搜索策略决定。", meta: "能力 · 托管 / 本地" },
  { value: "file_search", label: "File Search", description: "在已配置的 Vector Store 中检索文件。", meta: "能力 · OpenAI 托管" },
  { value: "tool_search", label: "Tool Search", description: "查找延迟加载的可用工具；Responses 优先使用上游托管实现。", meta: "能力 · 托管 / 本地" },
]

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))]
}

export function buildModelToolPolicyOptions(toolsState: unknown, configState: unknown, configured: unknown[] = []): ModelToolPolicyOption[] {
  const options = new Map<string, ModelToolPolicyOption>()
  const known = new Set<string>()
  const toolsConfig = asRecord(asRecord(configState).tools)
  const hostedOpenai = asRecord(asRecord(toolsConfig.hosted).openai)
  const hostedGloballyEnabled = toolsConfig.enabled !== false && hostedOpenai.enabled !== false
  const enabledCapabilities = new Set(Array.isArray(toolsConfig.enabledTools) ? toolsConfig.enabledTools.map(String) : [])
  const hostedFeatureEnabled = (value: string) => {
    const feature = value === "web_search" ? "webSearch" : value === "file_search" ? "fileSearch" : "toolSearch"
    return hostedGloballyEnabled && enabledCapabilities.has(value) && asRecord(hostedOpenai[feature]).enabled !== false
  }
  for (const option of SEARCH_CAPABILITY_OPTIONS) {
    known.add(option.value)
    if (hostedFeatureEnabled(option.value)) options.set(option.value, option)
  }
  for (const tool of asRecords(asRecord(toolsState).tools)) {
    const name = String(tool.name || "").trim()
    if (!name) continue
    known.add(name)
    known.add(`local:${name}`)
    if (toolsConfig.enabled === false || tool.enabled === false) continue
    const builtin = asRecord(toolsConfig.builtin)
    const webSearchSources = asRecord(builtin.webSearch).enabledSources
    const noLocalImplementation = (name === "web_search" && Array.isArray(webSearchSources) && !webSearchSources.length)
      || (name === "tool_search" && asRecord(builtin.toolSearch).localEnabled === false)
    if (noLocalImplementation && !options.has(name)) continue
    const common = asRecord(tool.common)
    const displayName = String(common.displayNameZh || name).trim()
    const source = String(common.source || "local").trim()
    const sourceLabel = source === "builtin" ? "本地内置" : source === "custom" ? "Custom" : source === "mcp" ? "MCP" : source
    const existing = options.get(name)
    options.set(name, {
      value: name,
      label: existing?.label || (displayName === name ? name : `${displayName} · ${name}`),
      description: String(common.descriptionZh || common.description || "").trim(),
      meta: existing ? `${existing.meta} / ${sourceLabel}` : sourceLabel,
    })
  }
  for (const entry of configured) {
    const value = String(entry || "").trim()
    if (value && !known.has(value) && !options.has(value)) options.set(value, { value, label: value, description: "", meta: "配置中保留 · 当前工具目录未发现" })
  }
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"))
}

export const TOOL_POLICY_MODE_OPTIONS = [
  { value: "inherit", label: "继承全部可用工具" },
  { value: "allowlist", label: "仅允许白名单" },
  { value: "denylist", label: "继承并排除黑名单" },
]

export const TOOL_SOURCE_OPTIONS = [
  { value: "auto", label: "自动选择" },
  { value: "hosted", label: "OpenAI 原生" },
  { value: "local", label: "本地工具" },
  { value: "disabled", label: "禁用此能力" },
]

export const WEB_SEARCH_STRATEGY_OPTIONS = [
  { value: "", label: "继承工具管理默认值" },
  { value: "preferred", label: "只用首选渠道" },
  { value: "fallback", label: "首选失败后换源" },
  { value: "parallel", label: "多渠道并行聚合" },
]

export function modelToolPolicyDraft(policy: ModelToolPolicyConfig = {}) {
  return {
    toolPolicyMode: policy.mode || "inherit",
    toolPolicyAllow: uniqueStrings(policy.allow),
    toolPolicyDeny: uniqueStrings(policy.deny),
    webSearchSource: policy.routes?.web_search?.source || "auto",
    toolSearchSource: policy.routes?.tool_search?.source || "auto",
    webSearchStrategy: policy.routes?.web_search?.strategy || "",
  }
}

export function modelToolPolicyPatch(draft: ReturnType<typeof modelToolPolicyDraft>) {
  const webSearch = {
    source: draft.webSearchSource || "auto",
    ...(draft.webSearchStrategy ? { strategy: draft.webSearchStrategy } : {}),
  }
  return {
    mode: draft.toolPolicyMode || "inherit",
    allow: uniqueStrings(draft.toolPolicyAllow),
    deny: uniqueStrings(draft.toolPolicyDeny),
    routes: {
      web_search: webSearch,
      tool_search: { source: draft.toolSearchSource || "auto" },
    },
  }
}

export const MODEL_TOOL_POLICY_EDITOR_TEMPLATE = `
  <Collapse v-if="draft.toolUse !== 'false'" title="模型工具与搜索策略" hint="统一管理模型可见工具、搜索来源与启停" nested>
    <div class="form-grid dense">
      <Field label="工具范围" type="select" :options="TOOL_POLICY_MODE_OPTIONS" v-model="draft.toolPolicyMode" tip="模型策略只能收窄工具管理处已经允许的范围，不能恢复全局或角色已禁用的工具。" />
      <Field label="Web Search" type="select" :options="TOOL_SOURCE_OPTIONS" v-model="draft.webSearchSource" tip="自动时 Responses 优先 OpenAI 原生，其他协议使用本地渠道；工具库停用始终优先。" />
      <Field v-if="draft.webSearchSource !== 'disabled'" label="搜索方式" type="select" :options="WEB_SEARCH_STRATEGY_OPTIONS" v-model="draft.webSearchStrategy" tip="只有 OpenAI 渠道可用时直接采用 Responses 的最终回复；本地渠道参与失败换源或并行时，经聚合门面收集证据，再由主模型统一汇总一次。" />
      <Field label="Tool Search" type="select" :options="TOOL_SOURCE_OPTIONS" v-model="draft.toolSearchSource" tip="自动时 Responses 优先原生 tool_search，其他协议使用本地工具发现。" />
    </div>
    <Collapse v-if="draft.chatProtocol === 'responses'" title="File Search" hint="需要 Vector Store 时再启用" nested>
      <div class="form-grid dense">
        <Field label="启用 File Search" type="select" :options="BOOL_OFF_OPTIONS" v-model="draft.responsesFileSearch" tip="由 OpenAI 在 Vector Store 中检索文件；只有配置 ID 后才能启用。" />
        <Field v-if="draft.responsesFileSearch === 'true'" label="Vector Store IDs" v-model="draft.responsesVectorStoreIds" placeholder="vs_..." tip="逗号或换行分隔。" />
        <Field v-if="draft.responsesFileSearch === 'true'" label="最大结果" type="number" v-model="draft.responsesFileSearchMaxResults" />
      </div>
    </Collapse>
    <SearchMultiSelect v-if="draft.toolPolicyMode === 'allowlist'" label="工具白名单" :options="toolPolicyOptions" v-model="draft.toolPolicyAllow" placeholder="搜索能力或工具名称" tip="只允许选中的能力或工具；同一能力的托管和本地实现不再重复列出。" />
    <SearchMultiSelect v-if="draft.toolPolicyMode === 'denylist'" label="工具黑名单" :options="toolPolicyOptions" v-model="draft.toolPolicyDeny" placeholder="搜索名称、工具 ID、来源或说明" tip="从当前模型可用工具中排除选中项；全局停用和角色权限仍优先。" />
    <div class="hint-banner"><Icon name="info" :size="14" /><span>最终可用集合 = 全局启用与角色权限 ∩ 当前模型策略 ∩ 协议支持。工具管理处的停用优先级最高；明确选择“OpenAI 原生”但协议不支持时不会静默改用本地工具。</span></div>
  </Collapse>
`
