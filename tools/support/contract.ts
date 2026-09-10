import type { JsonValue } from "../../core/message-chain/types.js"
import type { ToolAutoDelivery, ToolCommon, ToolDefinition, ToolExecutionEffect, ToolExecutionPolicy, ToolSource } from "./tool-contract.js"

type UnknownRecord = Record<string, unknown>
type ToolExecutor = ToolDefinition["execute"]
export type NormalizedTool = ToolDefinition & { common: ToolCommon }

export const toolCategories = {
  command: "指令", discovery: "工具发现", memory: "记忆", network: "网络检索", media: "媒体",
  output: "输出处理", render: "渲染", social: "社交", admin: "群管", entertainment: "娱乐",
  custom: "自定义", skill: "Skill", mcp: "MCP", unknown: "未分类",
} as const

export const toolRiskLevels = { low: "低风险", medium: "中风险", high: "高风险", external: "外部服务" } as const
export const toolDeliveryModes = { silent: "统一回复", "current-chat": "当前会话即时发送", "target-chat": "跨目标即时发送", media: "媒体即时发送" } as const
export const toolExecutionEffects = { read: "read", idempotentWrite: "idempotent_write", nonIdempotent: "non_idempotent", destructive: "destructive", unknown: "unknown" } as const
export const toolRepeatPolicies = { allow: "allow", bounded: "bounded", dedupe: "dedupe", explicitOnly: "explicit_only" } as const
export const toolRetryPolicies = { safe: "safe", executor: "executor", noAmbiguousRetry: "no_ambiguous_retry", none: "none" } as const

const builtinToolDisplayNamesZh: Record<string, string> = {
  knowledge_manage: "知识库", memory_manage: "记忆与画像", voice_output: "语音输出", text_transform: "文本整理",
  keyword_filter: "关键词过滤", regex_replace: "正则替换", weather: "天气查询", website_fetch: "网页读取", github_api: "GitHub 查询",
  bilibili_media: "B站媒体", image_media: "图片媒体", web_search: "实时网络搜索", render_image: "图片渲染", render_url_screenshot: "网页截图", render_html_screenshot: "HTML 截图",
  message_send: "消息发送", generate_image: "图片生成", query_userinfo: "查询用户信息", block_user: "拉黑用户",
  schedule_task: "定时任务", send_dice: "发骰子", send_rps: "猜拳", mute_user: "禁言成员", kick_out: "踢出成员", edit_card: "修改群名片",
  set_title: "设置头衔", emoji_like: "贴表情", group_poke: "戳一戳", message_manage: "群消息管理", dispatch_subagent: "派发子代理",
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const source = record(value)
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(source)) {
    if (isJsonValue(item)) result[key] = item
  }
  return result
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function normalizedStringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).map(item => item.trim()).filter(Boolean))] : []
}

function asToolSource(value: unknown): ToolSource {
  return ["builtin", "custom", "mcp", "skill", "system"].includes(text(value)) ? text(value) as ToolSource : "custom"
}

function isToolEffect(value: unknown): value is ToolExecutionEffect {
  return Object.values(toolExecutionEffects).includes(text(value) as ToolExecutionEffect)
}

export function isToolRiskLevel(value: unknown): boolean { return Object.hasOwn(toolRiskLevels, text(value)) }
export function isToolDeliveryMode(value: unknown): boolean { return Object.hasOwn(toolDeliveryModes, text(value)) }
export function isToolExecutionEffect(value: unknown): boolean { return isToolEffect(value) }
export function isToolRepeatPolicy(value: unknown): boolean { return Object.values(toolRepeatPolicies).includes(text(value) as typeof toolRepeatPolicies[keyof typeof toolRepeatPolicies]) }
export function isToolRetryPolicy(value: unknown): boolean { return Object.values(toolRetryPolicies).includes(text(value) as typeof toolRetryPolicies[keyof typeof toolRetryPolicies]) }

export function resolveRequiresFinalReply(tool: unknown = {}, defaults: unknown = {}): boolean {
  const common = record(record(tool).common || tool)
  const fallback = record(record(defaults).common || defaults)
  const explicit = common.requiresFinalReply ?? fallback.requiresFinalReply
  return typeof explicit === "boolean" ? explicit : true
}

function normalizeAutoDelivery(value: unknown): ToolAutoDelivery | null {
  const input = record(value)
  if (text(input.via) !== "message_send") return null
  return {
    via: "message_send",
    batching: "merge",
    continueConversation: input.continueConversation === true,
  }
}

/** 读取公共属性；未归一化的 Custom/MCP 工具也只以未知记录返回。 */
export function getToolCommon(tool: unknown = {}): UnknownRecord {
  const source = record(tool)
  return record(source.common || tool)
}

function normalizePromptCount(value: unknown): ToolExecutionPolicy["promptCount"] {
  const source = record(value)
  if (!isRecord(value)) return null
  const units = normalizedStringList(source.units)
  return { keywords: normalizedStringList(source.keywords), units: units.length ? units : ["次", "下", "个"], maxClauses: Math.max(1, Math.min(20, Number(source.maxClauses) || 4)) }
}

/** 将工具执行约束归一化；未声明副作用的外部工具默认只允许显式一次执行。 */
export function normalizeExecutionPolicy(value: unknown = {}, fallback: unknown = {}): ToolExecutionPolicy {
  const input = record(value)
  const fallbackObject = record(fallback)
  const effect: ToolExecutionEffect = isToolEffect(input.effect) ? input.effect : isToolEffect(fallbackObject.effect) ? fallbackObject.effect : toolExecutionEffects.unknown
  const inferredRepeatPolicy = effect === toolExecutionEffects.read ? toolRepeatPolicies.bounded : effect === toolExecutionEffects.unknown ? toolRepeatPolicies.explicitOnly : toolRepeatPolicies.dedupe
  const inferredRetryPolicy = effect === toolExecutionEffects.read ? toolRetryPolicies.safe : toolRetryPolicies.noAmbiguousRetry
  const inferredMaxAttempts = effect === toolExecutionEffects.read ? 2 : 1
  const repeatPolicy = ["allow", "bounded", "dedupe", "explicit_only"].includes(text(input.repeatPolicy)) ? text(input.repeatPolicy) as ToolExecutionPolicy["repeatPolicy"] : ["allow", "bounded", "dedupe", "explicit_only"].includes(text(fallbackObject.repeatPolicy)) ? text(fallbackObject.repeatPolicy) as ToolExecutionPolicy["repeatPolicy"] : inferredRepeatPolicy
  const retryPolicy = ["safe", "executor", "no_ambiguous_retry", "none"].includes(text(input.retryPolicy)) ? text(input.retryPolicy) as ToolExecutionPolicy["retryPolicy"] : ["safe", "executor", "no_ambiguous_retry", "none"].includes(text(fallbackObject.retryPolicy)) ? text(fallbackObject.retryPolicy) as ToolExecutionPolicy["retryPolicy"] : inferredRetryPolicy
  const parallelSafe = input.parallelSafe !== undefined ? input.parallelSafe === true : fallbackObject.parallelSafe !== undefined ? fallbackObject.parallelSafe === true : effect === toolExecutionEffects.read
  const dispatchMarking = ["immediate", "deferred"].includes(text(input.dispatchMarking))
    ? text(input.dispatchMarking) as ToolExecutionPolicy["dispatchMarking"]
    : ["immediate", "deferred"].includes(text(fallbackObject.dispatchMarking))
      ? text(fallbackObject.dispatchMarking) as ToolExecutionPolicy["dispatchMarking"]
      : "immediate"
  return {
    effect, repeatPolicy, retryPolicy, dispatchMarking,
    supportsCount: Boolean(input.supportsCount ?? fallbackObject.supportsCount === true),
    countField: text(input.countField || fallbackObject.countField || "count").trim() || "count",
    maxCount: Math.max(1, Math.min(100, Number(input.maxCount ?? fallbackObject.maxCount ?? 1) || 1)),
    targetFields: normalizedStringList(input.targetFields ?? fallbackObject.targetFields),
    operationFields: normalizedStringList(input.operationFields ?? fallbackObject.operationFields ?? input.targetFields ?? fallbackObject.targetFields),
    promptCount: normalizePromptCount(input.promptCount ?? fallbackObject.promptCount),
    maxAttempts: Math.max(1, Math.min(5, Number(input.maxAttempts ?? fallbackObject.maxAttempts ?? inferredMaxAttempts) || 1)),
    timeoutMs: Math.max(1000, Math.min(600000, Number(input.timeoutMs ?? fallbackObject.timeoutMs ?? 60000) || 60000)),
    background: input.background === true || fallbackObject.background === true,
    parallelSafe,
    operationFamily: text(input.operationFamily || fallbackObject.operationFamily).trim(),
    polling: input.polling === true || fallbackObject.polling === true,
    maxPolls: Math.max(1, Math.min(20, Number(input.maxPolls ?? fallbackObject.maxPolls ?? 5) || 5)),
    minPollIntervalMs: Math.max(0, Math.min(60000, Number(input.minPollIntervalMs ?? fallbackObject.minPollIntervalMs ?? 0) || 0)),
  }
}

function normalizeExecutionByAction(value: unknown, base: ToolExecutionPolicy): Record<string, ToolExecutionPolicy> {
  return Object.fromEntries(Object.entries(record(value)).filter(([action]) => text(action).trim()).map(([action, execution]) => [action, normalizeExecutionPolicy(execution, base)]))
}

export function resolveToolExecutionPolicy(tool: unknown = {}, args: unknown = {}): { execution: ToolExecutionPolicy } {
  const common = getToolCommon(tool)
  const action = text(record(args).action).trim()
  const byAction = record(common.executionByAction)
  const execution = action && Object.hasOwn(byAction, action) ? byAction[action] : common.execution
  return { execution: normalizeExecutionPolicy(execution, { source: common.source }) }
}

export function toolSource(tool: unknown = {}): ToolSource { return asToolSource(getToolCommon(tool).source) }
export function toolProvenance(tool: unknown = {}): UnknownRecord { return record(getToolCommon(tool).provenance) }

export function normalizeParameters(parameters: unknown = {}): Record<string, JsonValue> {
  const source = record(parameters)
  return { ...jsonRecord(source), type: text(source.type) || "object", properties: jsonRecord(source.properties) }
}

function estimateSerializedTokens(value: string): number {
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length
  return Math.max(1, Math.ceil(cjk * 1.3 + Math.max(0, value.length - cjk) / 4))
}

export function isToolEnabledByConfig(config: unknown = {}, tool: unknown = {}): boolean {
  const root = record(config)
  const tools = record(root.tools)
  const common = getToolCommon(tool)
  const toolRecord = record(tool)
  if (text(common.source) === "mcp") {
    const provenance = record(common.provenance)
    const mcp = record(root.mcp)
    const servers = record(mcp.servers)
    const serverName = text(provenance.serverName || record(toolRecord.mcp).serverName || toolRecord.serverName).trim()
    const server = record(servers[serverName])
    return mcp.enabled === true && Boolean(serverName) && Object.keys(server).length > 0 && server.enabled !== false
  }
  const enabledTools = Array.isArray(tools.enabledTools) ? tools.enabledTools.map(text) : []
  return new Set(enabledTools).has(text(toolRecord.name))
}

export function modelToolDefinition(tool: unknown = {}): UnknownRecord {
  const toolRecord = record(tool)
  const common = getToolCommon(tool)
  return { type: "function", function: { name: text(toolRecord.name), description: modelToolDescription(tool), parameters: normalizeParameters(common.parameters) } }
}

function declaredEffects(common: UnknownRecord): string[] {
  const effects = [text(record(common.execution).effect)]
  for (const value of Object.values(record(common.executionByAction))) effects.push(text(record(value).effect))
  return [...new Set(effects.filter(Boolean))]
}

/**
 * 把工具自身的具体说明补成适合模型选择的稳定格式。
 * 具体能力与适用场景仍由工具声明；公共层只补齐“不该何时用”和副作用边界。
 */
export function modelToolDescription(tool: unknown = {}): string {
  const common = getToolCommon(tool)
  const base = text(common.description).trim() || text(common.descriptionZh).trim()
  const lower = base.toLowerCase()
  const effects = declaredEffects(common)
  const hasWrite = effects.some(effect => effect && effect !== toolExecutionEffects.read)
  const hasDestructive = effects.includes(toolExecutionEffects.destructive)
  const clauses: string[] = []
  if (!/\buse (?:this )?when\b/.test(lower)) {
    clauses.push(hasDestructive
      ? "Use only when the destructive change is explicitly requested."
      : hasWrite
        ? "Use when the requested action requires changing state."
        : "Use when this specific read capability is needed for the answer.")
  }
  if (!/\bdo not\b|\bdon't\b/.test(lower)) {
    clauses.push(hasWrite
      ? "Do not use it only for diagnosis, and do not repeat a side-effecting action without evidence that retrying is safe."
      : "Do not use it to make or imply changes.")
  }
  if (hasDestructive && !/irrevers|destruct|cannot be undone|难以恢复|不可恢复/.test(lower)) clauses.push("This operation can irreversibly modify data or state.")
  else if (hasWrite && !/side effect|modify|changes? (?:data|state)|interrupt|副作用|修改|中断/.test(lower)) clauses.push("This tool may modify data or external state.")
  else if (!hasWrite && !/read[ -]?only|只读/.test(lower)) clauses.push("This operation is read-only.")
  return [base, clauses.join(" ")].filter(Boolean).join("\n")
}

/** Responses API 原生 Function Calling 定义。 */
export function responsesToolDefinition(tool: unknown = {}): UnknownRecord {
  const toolRecord = record(tool)
  const common = getToolCommon(tool)
  return {
    type: "function",
    name: text(toolRecord.name),
    description: modelToolDescription(tool),
    parameters: normalizeParameters(common.parameters),
    ...(common.deferLoading === true ? { defer_loading: true } : {}),
  }
}

export function modelToolLoadingGuide(tool: unknown = {}): { definition: UnknownRecord; serialized: string; characters: number; estimatedTokens: number; note: string } {
  const definition = modelToolDefinition(tool)
  const serialized = JSON.stringify(definition, null, 2) || ""
  return { definition, serialized, characters: serialized.length, estimatedTokens: estimateSerializedTokens(serialized), note: "估算值仅用于规划；实际输入 token 由模型供应商的 tokenizer 和协议封装决定。" }
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === "null") return value === null
  if (type === "array") return Array.isArray(value)
  if (type === "object") return isRecord(value)
  if (type === "integer") return Number.isInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  if (type === "boolean") return typeof value === "boolean"
  if (type === "string") return typeof value === "string"
  return true
}

function validateSchemaValue(value: unknown, schemaValue: unknown, path: string, issues: string[]): void {
  const schema = record(schemaValue)
  if (!isRecord(schemaValue)) return
  const schemaType = text(schema.type)
  if (schemaType && !typeMatches(value, schemaType)) { issues.push(`${path} 类型应为 ${schemaType}`); return }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) issues.push(`${path} 不是允许的值`)
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < Number(schema.minLength)) issues.push(`${path} 长度不能少于 ${schema.minLength}`)
    if (schema.maxLength !== undefined && value.length > Number(schema.maxLength)) issues.push(`${path} 长度不能超过 ${schema.maxLength}`)
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < Number(schema.minimum)) issues.push(`${path} 不能小于 ${schema.minimum}`)
    if (schema.maximum !== undefined && value > Number(schema.maximum)) issues.push(`${path} 不能超过 ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < Number(schema.minItems)) issues.push(`${path} 至少需要 ${schema.minItems} 项`)
    if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) issues.push(`${path} 不能超过 ${schema.maxItems} 项`)
    if (schema.items !== undefined) value.forEach((item, index) => validateSchemaValue(item, schema.items, `${path}[${index}]`, issues))
  }
  if (isRecord(value)) {
    const properties = record(schema.properties)
    const required = Array.isArray(schema.required) ? schema.required.map(text) : []
    for (const key of required) if (value[key] === undefined || value[key] === null || value[key] === "") issues.push(`${path}.${key} 为必填项`)
    for (const [key, child] of Object.entries(properties)) if (value[key] !== undefined) validateSchemaValue(value[key], child, `${path}.${key}`, issues)
  }
}

export function validateToolArguments(tool: unknown = {}, args: unknown = {}): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  validateSchemaValue(isRecord(args) ? args : {}, getToolCommon(tool).parameters, "arguments", issues)
  return { ok: issues.length === 0, issues }
}

function containsCjk(value: unknown): boolean { return /[\u3400-\u9fff]/.test(text(value)) }

function inferDisplayNameZh(tool: UnknownRecord, defaults: UnknownRecord, source: string): string {
  const direct = [tool.displayNameZh, tool.nameZh, tool.titleZh, tool.labelZh, defaults.displayNameZh, defaults.nameZh, defaults.titleZh, defaults.labelZh].find(value => text(value).trim())
  if (direct) return text(direct).trim()
  if (source === "builtin" && builtinToolDisplayNamesZh[text(tool.name)]) return builtinToolDisplayNamesZh[text(tool.name)]
  const named = [tool.name, defaults.name, defaults.packageName, defaults.skillName].find(containsCjk)
  return named ? text(named).trim() : ""
}

function categoryForSource(source: string): string { return source === "mcp" ? "mcp" : source === "custom" ? "custom" : "unknown" }
function riskForCategory(category: string): string { return category === "admin" ? "high" : category === "mcp" || category === "network" ? "external" : ["media", "output", "social", "entertainment"].includes(category) ? "medium" : "low" }

/** 将内置、Custom、MCP 的动态工具收敛成同一个模型可见契约。 */
export function normalizeTool(tool: unknown, defaults: unknown = {}): NormalizedTool | null {
  const sourceTool = record(tool)
  const defaultRecord = record(defaults)
  const execute = sourceTool.execute
  if (!text(sourceTool.name) || typeof execute !== "function") return null
  const inputCommon = record(sourceTool.common || tool)
  const defaultCommon = record(defaultRecord.common || defaults)
  const source = asToolSource(inputCommon.source || defaultCommon.source || "custom")
  const category = text(inputCommon.category || defaultCommon.category || categoryForSource(source))
  const requestedRisk = text(inputCommon.risk || defaultCommon.risk || riskForCategory(category))
  const risk = isToolRiskLevel(requestedRisk) ? requestedRisk : riskForCategory(category)
  const policy: UnknownRecord = { ...record(defaultCommon.policy), ...record(inputCommon.policy) }
  const requestedDelivery = text(inputCommon.delivery || defaultCommon.delivery || "silent")
  const delivery = isToolDeliveryMode(requestedDelivery) ? requestedDelivery : "silent"
  const execution = normalizeExecutionPolicy(inputCommon.execution ?? defaultCommon.execution, { source, effect: source === "builtin" ? toolExecutionEffects.read : toolExecutionEffects.unknown })
  const executionByAction = normalizeExecutionByAction(inputCommon.executionByAction ?? defaultCommon.executionByAction, execution)
  if (["custom", "skill", "mcp"].includes(source) && risk === "high" && policy.requiresMaster !== true && policy.requiresGroupAdmin !== true) policy.requiresMaster = true
  const provenance: UnknownRecord = { ...record(defaultCommon.provenance), ...record(inputCommon.provenance) }
  for (const key of ["packageId", "packageName", "skillId", "serverName", "serverDescription"]) {
    if (defaultCommon[key] !== undefined) provenance[key] = defaultCommon[key]
    if (inputCommon[key] !== undefined) provenance[key] = inputCommon[key]
  }
  const sourceFields: UnknownRecord = { ...defaultRecord, ...sourceTool }
  for (const key of ["common", "displayNameZh", "nameZh", "titleZh", "labelZh", "description", "descriptionZh", "parameters", "configSchema", "source", "category", "categoryLabel", "risk", "riskLabel", "tags", "deferLoading", "delivery", "deliveryLabel", "autoDelivery", "requiresFinalReply", "requiresFinalReplyLabel", "replyPolicy", "replyPolicyLabel", "responsePolicy", "hiddenFromModel", "pipeline", "repeatable", "repeatableByAction", "idempotencyKeyFields", "idempotencyKeyFieldsByAction", "execution", "executionByAction", "policy", "packageId", "packageName", "skillId", "serverName", "serverDescription"]) delete sourceFields[key]
  const common: ToolCommon = {
    displayNameZh: inferDisplayNameZh({ ...sourceTool, ...inputCommon }, defaultCommon, source),
    description: text(inputCommon.description || defaultCommon.description),
    descriptionZh: text(inputCommon.descriptionZh || defaultCommon.descriptionZh),
    parameters: normalizeParameters(inputCommon.parameters || defaultCommon.parameters),
    configSchema: normalizeParameters(inputCommon.configSchema && isRecord(inputCommon.configSchema) ? inputCommon.configSchema : defaultCommon.configSchema || { type: "object", properties: {} }),
    source, category,
    categoryLabel: text(inputCommon.categoryLabel || defaultCommon.categoryLabel || toolCategories[category as keyof typeof toolCategories] || toolCategories.unknown),
    risk, tags: [...new Set([...normalizedStringList(defaultCommon.tags), ...normalizedStringList(inputCommon.tags)])],
    deferLoading: inputCommon.deferLoading === undefined
      ? (defaultCommon.deferLoading === undefined ? ["custom", "mcp"].includes(source) : defaultCommon.deferLoading === true)
      : inputCommon.deferLoading === true,
    delivery: delivery as ToolCommon["delivery"],
    autoDelivery: normalizeAutoDelivery(inputCommon.autoDelivery ?? defaultCommon.autoDelivery),
    requiresFinalReply: resolveRequiresFinalReply({ common: { ...inputCommon, delivery } }, { common: defaultCommon }),
    execution, executionByAction,
    hiddenFromModel: inputCommon.hiddenFromModel === true || defaultCommon.hiddenFromModel === true,
    pipeline: isRecord(inputCommon.pipeline) ? jsonRecord(inputCommon.pipeline) : isRecord(defaultCommon.pipeline) ? jsonRecord(defaultCommon.pipeline) : null,
    policy: jsonRecord(policy) as ToolCommon["policy"],
    provenance: jsonRecord(provenance),
  }
  return { ...sourceFields, name: text(sourceTool.name), execute: (execute as ToolExecutor).bind(tool), common }
}

export function annotateTool(tool: unknown, meta: unknown = {}): NormalizedTool | null { return normalizeTool(tool, meta) }
export function annotateTools(tools: unknown[] = [], meta: unknown = {}): NormalizedTool[] { return tools.map(tool => annotateTool(tool, meta)).filter((tool): tool is NormalizedTool => Boolean(tool)) }
