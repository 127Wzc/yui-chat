export const BOOL_OPTIONS = [{ value: "true", label: "开启" }, { value: "false", label: "关闭" }]
export const BOOL_OFF_OPTIONS = [{ value: "false", label: "关闭" }, { value: "true", label: "开启" }]
export const MCP_RISK_OPTIONS = [
  { value: "low", label: "低风险" },
  { value: "medium", label: "中风险" },
  { value: "external", label: "外网访问" },
  { value: "high", label: "高风险" },
]

export type UnknownRecord = Record<string, unknown>

export interface ToolRecord extends UnknownRecord {
  name: string
  enabled?: boolean
  modelTokenEstimate?: number
}

export interface ToolGroupMeta {
  title: string
  description: string
  icon: string
  order: number
}

export interface ToolGroup extends ToolGroupMeta {
  name: string
  names: string[]
  tools: ToolRecord[]
  unavailable: ToolRecord[]
  disabled: ToolRecord[]
  enabled: ToolRecord[]
  highRisk: ToolRecord[]
  external: ToolRecord[]
  ready: boolean
}

export interface ToolsSlice extends UnknownRecord {
  tools?: ToolRecord[]
  custom?: { catalog?: ToolRecord[] }
  skills?: { catalog?: ToolRecord[] }
  mcp?: { servers?: ToolRecord[]; config?: { servers?: Record<string, ToolRecord> } }
}

export interface ToolsConfig extends UnknownRecord {
  enabled?: boolean
  policy?: { allowExternalNetwork?: boolean; allowCustomTools?: boolean; allowMcpTools?: boolean }
  hosted?: { openai?: { enabled?: boolean; webSearch?: { enabled?: boolean }; fileSearch?: { enabled?: boolean }; toolSearch?: { enabled?: boolean } } }
  promptSelection?: { enabled?: boolean; maxTools?: number; maxDefinitionTokens?: number }
  builtin?: UnknownRecord
}

export interface ChatConfig extends UnknownRecord {
  maxToolRounds?: number
  execution?: UnknownRecord
}

export interface ToolConfigRoot extends UnknownRecord {
  tools?: ToolsConfig
  chat?: ChatConfig
  subAgent?: { enabled?: boolean }
}

// 能力列表按工具真实 category 展示；preset 只负责批量启用，不再承担页面分类职责。
export const BUILTIN_CATEGORY_META: Record<string, ToolGroupMeta> = {
  command: { title: "指令与知识", description: "查询指令、转交宿主命令等基础能力。", icon: "list", order: 0 },
  memory: { title: "记忆与画像", description: "读取、记录和管理长期记忆。", icon: "database", order: 1 },
  network: { title: "联网检索", description: "天气、网页、GitHub 和图片等实时检索。", icon: "search", order: 2 },
  media: { title: "媒体操作", description: "识别、发送和转交图片、音视频等媒体。", icon: "eye", order: 3 },
  social: { title: "社交互动", description: "发送消息、@ 用户和其他会话互动。", icon: "message", order: 4 },
  schedule: { title: "定时任务", description: "创建、查询和取消提醒任务。", icon: "clock", order: 5 },
  entertainment: { title: "群聊娱乐", description: "骰子、猜拳、点赞和戳一戳等轻量互动。", icon: "sparkles", order: 6 },
  admin: { title: "群管理", description: "禁言、踢人和消息处理等受限管理动作。", icon: "key", order: 7 },
  agent: { title: "子代理", description: "将复杂任务分派给受限的子代理执行。", icon: "cpu", order: 8 },
}

export function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

export interface ToolPolicy extends UnknownRecord {
  highRisk?: boolean
  externalNetwork?: boolean
  requiresMaster?: boolean
  requiresGroup?: boolean
  requiresGroupAdmin?: boolean
}

export interface ToolCommon extends UnknownRecord {
  source?: string
  category?: string
  categoryLabel?: string
  displayNameZh?: string
  descriptionZh?: string
  description?: string
  risk?: string
  tags?: string[]
  policy?: ToolPolicy
  provenance?: UnknownRecord
  configSchema?: { properties?: Record<string, UnknownRecord> }
  requiresFinalReply?: boolean
  delivery?: string
  execution?: UnknownRecord
  executionByAction?: UnknownRecord
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}

export interface RuntimeFieldRow extends UnknownRecord {
  name: string
  kind: "secret" | "select" | "number" | "textarea" | "text"
  label: string
  placeholder?: string
  tip?: string
  options?: Array<{ value: string; label: string }>
}

export function toolCommon(tool: unknown = {}): ToolCommon {
  const source = record(tool)
  return Boolean(source.common) && typeof source.common === "object" && !Array.isArray(source.common) ? source.common as ToolCommon : source as ToolCommon
}

export function toolSource(tool: unknown = {}): string {
  return String(toolCommon(tool).source || "")
}

export function toolProvenance(tool: unknown = {}): UnknownRecord {
  const provenance = toolCommon(tool).provenance
  return Boolean(provenance) && typeof provenance === "object" && !Array.isArray(provenance) ? provenance as UnknownRecord : {}
}

const TOOL_DELIVERY_LABELS = {
  silent: "统一回复",
  "current-chat": "当前会话即时发送",
  "target-chat": "跨目标即时发送",
  media: "媒体即时发送",
}

export function toolDeliveryLabel(tool: unknown = {}): string {
  const delivery = String(toolCommon(tool).delivery || "")
  return TOOL_DELIVERY_LABELS[delivery as keyof typeof TOOL_DELIVERY_LABELS] || "统一回复"
}

export function toolFinalReplyLabel(tool: unknown = {}): string {
  return toolCommon(tool).requiresFinalReply === false ? "可无回复执行" : "需要最终回复"
}

export function toolRepeatabilityLabel(tool: unknown = {}): string {
  const common = toolCommon(tool)
  const execution = record(common.execution)
  const actionPolicies = record(common.executionByAction)
  if (Object.keys(actionPolicies).length) {
    return "按动作决定重复策略"
  }
  if (["dedupe", "explicit_only"].includes(String(execution.repeatPolicy))) return "同一请求重复调用会跳过"
  if (execution.repeatPolicy === "bounded") return "允许有限重复调用"
  return "允许重复调用"
}

export function toolHasRepeatProtection(tool: unknown = {}): boolean {
  const common = toolCommon(tool)
  const execution = record(common.execution)
  if (["dedupe", "explicit_only"].includes(String(execution.repeatPolicy))) return true
  return Object.values(record(common.executionByAction)).some(policy => ["dedupe", "explicit_only"].includes(String(record(policy).repeatPolicy)))
}

export function sourceLabel(source: unknown = ""): string {
  const raw = String(source || "")
  return ({ builtin: "内置", custom: "自定义", skill: "Skill", mcp: "MCP" } as Record<string, string>)[raw] || raw || "unknown"
}

export function sourceTechLabel(source: unknown = ""): string {
  const raw = String(source || "").trim()
  const label = sourceLabel(raw)
  if (!raw || raw === label) return ""
  return raw
}

export function isFoldedRenderTool(tool: unknown = {}): boolean {
  const source = record(tool)
  return toolCommon(tool).category === "render" && source.name !== "render_image"
}

export function policyBadges(policy: unknown = {}): string[] {
  const source = record(policy)
  const badges: string[] = []
  if (source.requiresMaster) badges.push("仅主人")
  if (source.requiresGroup) badges.push("群聊")
  if (source.requiresGroupAdmin) badges.push("群管")
  if (source.highRisk) badges.push("高风险")
  if (source.externalNetwork) badges.push("外网")
  return badges
}

export function riskBadgeClass(risk: unknown): string {
  const value = String(risk || "")
  return value === "high" ? "risk-high" : ((value === "medium" || value === "external") ? "risk-medium" : "")
}

export function riskLabel(tool: unknown = {}): string {
  const common = toolCommon(tool)
  const policy = record(common.policy)
  if (policy.highRisk || common.risk === "high") return "高风险"
  if (policy.externalNetwork || common.risk === "external") return "外网访问"
  if (common.risk === "medium") return "中风险"
  return "低风险"
}

export function toolDisplayName(tool: unknown = {}): string {
  return String(toolCommon(tool).displayNameZh || record(tool).name || "").trim()
}

export function toolEnglishName(tool: unknown = {}): string {
  const zh = String(toolCommon(tool).displayNameZh || "").trim()
  const raw = String(record(tool).name || "").trim()
  if (!raw || !zh || zh === raw) return ""
  return raw
}

export function toolMatchesFilter(tool: unknown, filter: unknown): boolean {
  const source = record(tool)
  const filterSource = record(filter)
  const common = toolCommon(tool)
  const policy = record(common.policy)
  const query = String(filterSource.query || "").trim().toLowerCase()
  const status = String(filterSource.status || "all")
  if (status === "enabled" && source.enabled !== true) return false
  if (status === "disabled" && source.enabled === true) return false
  if (status === "high-risk" && !(common.risk === "high" || policy.highRisk || policy.requiresMaster)) return false
  if (status === "external" && !policy.externalNetwork) return false
  if (!query) return true
  return [common.displayNameZh, source.name, common.descriptionZh, common.description, common.source, common.category, common.categoryLabel, common.risk, common.riskLabel, ... (Array.isArray(common.tags) ? common.tags : [])]
    .join(" ").toLowerCase().includes(query)
}

export function toolDescription(tool: unknown = {}): string {
  const common = toolCommon(tool)
  return String(common.descriptionZh || common.description || "").trim()
}

export function toolDescriptionExtra(tool: unknown = {}): string {
  const common = toolCommon(tool)
  const zh = String(common.descriptionZh || "").trim()
  const raw = String(common.description || "").trim()
  if (!zh || !raw || zh === raw) return ""
  return raw
}

function jsonText(value: unknown): string {
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)
}

// 运行变量草稿：按 configSchema 字段生成字符串输入值，保存时再按类型转换。
export function runtimeDraftValues(configSchema: unknown = {}, runtimeConfig: unknown = {}): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const [name, fieldValue] of Object.entries(record(record(configSchema).properties))) {
    const field = record(fieldValue)
    const value = record(runtimeConfig)[name]
    if (value === undefined) draft[name] = ""
    else if (field?.type === "object" || field?.type === "array") draft[name] = jsonText(value)
    else draft[name] = String(value)
  }
  return draft
}

export function runtimeFieldRow(name: string, fieldValue: unknown = {}, hasValue = false): RuntimeFieldRow {
  const field = record(fieldValue)
  const label = String(field.title || name)
  const defaultText = field?.default === undefined ? "" : jsonText(field.default)
  const tips = []
  if (field?.description) tips.push(field.description)
  if (field?.secret === true) {
    tips.push(hasValue ? "已设置：保持 ******** 不变即保留，清空后保存即删除。" : "密钥只保存在服务端配置，保存后以 ******** 回显。")
    return { name, kind: "secret", label, placeholder: hasValue ? "" : "未设置", tip: tips.join(" ") }
  }
  if (defaultText) tips.push(`留空使用默认值 ${defaultText}`)
  if (field?.type === "boolean") {
    const defaultLabel = field.default === undefined ? "默认" : `默认（${field.default ? "开启" : "关闭"}）`
    return { name, kind: "select", label, options: [{ value: "", label: defaultLabel }, { value: "true", label: "开启" }, { value: "false", label: "关闭" }], tip: tips.join(" ") }
  }
  if (Array.isArray(field?.enum)) {
    return { name, kind: "select", label, options: [{ value: "", label: defaultText ? `默认（${defaultText}）` : "默认" }, ...field.enum.map(item => ({ value: String(item), label: String(item) }))], tip: tips.join(" ") }
  }
  if (field?.type === "number" || field?.type === "integer") return { name, kind: "number", label, placeholder: defaultText ? `默认 ${defaultText}` : "", tip: tips.join(" ") }
  if (field?.type === "object" || field?.type === "array") return { name, kind: "textarea", label, placeholder: defaultText, tip: tips.join(" ") }
  return { name, kind: "text", label, placeholder: defaultText ? `默认 ${defaultText}` : "", tip: tips.join(" ") }
}

// 收集草稿：空值跳过（= 清除/使用默认），JSON 字段解析失败抛错由调用方提示。
export function collectRuntimeValues(configSchema: unknown = {}, draft: unknown = {}): UnknownRecord {
  const value: UnknownRecord = {}
  const draftSource = record(draft)
  for (const [name, fieldValue] of Object.entries(record(record(configSchema).properties))) {
    const field = record(fieldValue)
    const raw = draftSource[name]
    if (raw === "" || raw === undefined || raw === null) continue
    if (field?.type === "boolean") value[name] = raw === true || raw === "true"
    else if (field?.type === "number" || field?.type === "integer") value[name] = Number(raw)
    else if (field?.type === "object" || field?.type === "array") {
      try {
        value[name] = JSON.parse(String(raw))
      } catch {
        throw new Error(`${field?.title || name} 不是合法 JSON`)
      }
    } else value[name] = String(raw)
  }
  return value
}
