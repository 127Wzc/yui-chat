import { cloneJsonValue } from "../shared/json-values.js"
import { escapeRegExp, pluginCommand, pluginCommandRule } from "../message/command-prefixes.js"
import { boundaryRoles, type BoundaryRole } from "../../tools/access/roles.js"

export type ActionRecord = Record<string, unknown>
export interface ActionReply { mode: "auto" | "text" | "json" | "image" | "message" | "silent"; path: string; template: string }
export interface ActionSource { frameworkResources: { target: string }; exportName: string; method: string; callStyle: "function" | "plugin" | "resource"; risk: "low" | "medium" | "high" | "external"; useInputAsMessage: boolean }
export interface ActionDefinition {
  kind: "tool" | "source"
  source: ActionSource | null
  reply: ActionReply
  id: string
  name: string
  description: string
  categoryId: string
  tags: string[]
  enabled: boolean
  command: string
  aliases: string[]
  stage: "rule" | "accept"
  priority: number
  minRole: BoundaryRole
  scope: "all" | "group" | "private"
  tool: string
  defaults: ActionRecord
  textParam: string
  textTemplate: string
  overridable: string[]
  input: { mode: "text" | "parameters"; images: "none" | "current-or-quote" | "current" | "quote"; imageParam: string; requireImage: boolean }
}
export interface ActionsConfig { enabled: boolean; categories: Array<{ id: string; name: string }>; items: Record<string, ActionDefinition> }

export function actionRecord(value: unknown): ActionRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ActionRecord : {}
}
function fail(message: string): never { throw new Error(message) }
function boundedText(value: unknown, label: string, max: number, fallback = ""): string {
  if (value !== undefined && typeof value !== "string") fail(`${label}必须是文字`)
  const text = String(value ?? fallback).trim()
  if (text.length > max) fail(`${label}不能超过 ${max} 个字符`)
  return text
}
function strings(value: unknown, label: string, max = 20): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) fail(`${label}必须是最多 ${max} 项的数组`)
  return [...new Set(value.map(item => boundedText(item, label, 64)).filter(Boolean))]
}
function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback
  if (!allowed.includes(value as T)) fail(`无效选项：${String(value).slice(0, 60)}`)
  return value as T
}
function flag(value: unknown, fallback: boolean): boolean {
  if (value !== undefined && typeof value !== "boolean") fail("开关必须是布尔值")
  return value === undefined ? fallback : value as boolean
}
const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/
const unsafeKeys = /^(?:__proto__|prototype|constructor|e|context|config|isMaster|sender|signal)$/i
const secretKeys = /(?:token|secret|password|credential|authorization|cookie|api[_-]?key)/i
export function validateActionValues(value: unknown, depth = 0): void {
  if (depth > 12) fail("参数嵌套过深")
  if (value === null || typeof value === "boolean" || typeof value === "string") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (Array.isArray(value)) { for (const item of value) validateActionValues(item, depth + 1); return }
  if (!value || typeof value !== "object") fail("参数必须是 JSON 数据")
  for (const [key, item] of Object.entries(value)) {
    if (unsafeKeys.test(key) || secretKeys.test(key)) fail(`参数 ${key} 不允许保存在动作中，请使用工具运行配置`)
    validateActionValues(item, depth + 1)
  }
}
function param(value: unknown, label: string, fallback = ""): string {
  const result = boundedText(value, label, 80, fallback)
  if (result && (!identifier.test(result) || unsafeKeys.test(result) || secretKeys.test(result))) fail(`${label}不是允许的参数名`)
  return result
}
// 固定入口保留其原有权限和行为；这里只保留后缀，前缀始终由中央模块派生。
const reserved = /^(?:chat|help|面板|登录|登陆|诊断|测试|工具|过滤器|渲染|截图|结束|新开|摧毁|毁灭|完结|文本模式|图片模式|语音模式|清理|第一人称|设置|打招呼|定时任务|我的定时任务|全部|所有|对话列表|闭嘴|张嘴|关机|开机|休眠|下班|上班|本群|全局|群\d+|查看|快捷指令|指令说明|动作中心)/i
function command(value: unknown): string {
  const result = boundedText(value, "指令", 40)
  if (!result || /[\s#/$@]/.test(result)) fail("指令请填写不带前缀和空格的名称")
  if (reserved.test(result)) fail(`“${result}”与系统保留指令冲突`)
  return result
}

export function parseAction(value: unknown, id?: string): ActionDefinition {
  const raw = actionRecord(value)
  const kind = choice(raw.kind, ["tool", "source"], "tool")
  const source = actionRecord(raw.source)
  const reference = boundedText(actionRecord(source.frameworkResources).target, "源码文件", 500)
  if (kind === "source" && (!/^(?:plugin:[^/\\]+\/|yunzai:)[^\\]+$/.test(reference) || reference.split("/").some(part => part === ".." || part.startsWith(".")) || /(?:^plugin:|\/)(?:chatgpt-plugin)(?:\/|$)/.test(reference))) fail("请选择允许的项目资源文件，不支持绝对路径或旧 chatgpt-plugin")
  const reply = actionRecord(raw.reply)
  const replyPath = boundedText(reply.path, "结果字段", 200)
  if (replyPath && (!/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+|\[\d+\])*$/.test(replyPath) || /(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|\[|$)/.test(replyPath))) fail("结果字段请使用 data.text 或 data.images[0].url 这样的路径")
  const key = boundedText(id ?? raw.id, "动作 ID", 64)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key) || unsafeKeys.test(key)) fail("动作 ID 无效")
  const name = boundedText(raw.name, "名称", 80)
  if (!name) fail("请填写动作名称")
  const defaults = raw.defaults === undefined ? {} : raw.defaults
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) fail("默认参数必须是 JSON 对象")
  if (JSON.stringify(defaults).length > 24000) fail("默认参数不能超过 24,000 个字符")
  validateActionValues(defaults)
  if (raw.input !== undefined && (!raw.input || typeof raw.input !== "object" || Array.isArray(raw.input))) fail("输入设置必须是对象")
  const input = actionRecord(raw.input)
  const priority = raw.priority ?? 1137
  if (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < -99999 || priority > 99999) fail("优先级必须是 -99999 至 99999 的整数")
  const textTemplate = boundedText(raw.textTemplate, "提示词模板", 8000)
  for (const match of textTemplate.matchAll(/\{\{([^{}]+)\}\}/g)) {
    if (!["text", "userName", "userId", "groupId"].includes(match[1].trim())) fail(`未知模板变量：${match[1]}`)
  }
  const result: ActionDefinition = {
    kind,
    source: kind === "source" ? { frameworkResources: { target: reference }, exportName: param(source.exportName, "导出名称", "default"), method: param(source.method, "方法名称"), callStyle: choice(source.callStyle, ["function", "plugin", "resource"], "function"), risk: choice(source.risk, ["low", "medium", "high", "external"], "medium"), useInputAsMessage: flag(source.useInputAsMessage, false) } : null,
    reply: { mode: choice(reply.mode, ["auto", "text", "json", "image", "message", "silent"], "auto"), path: replyPath, template: boundedText(reply.template, "回复模板", 4000) },
    id: key, name, description: boundedText(raw.description, "说明", 500),
    categoryId: boundedText(raw.categoryId, "分类", 64), tags: strings(raw.tags, "标签"),
    enabled: flag(raw.enabled, true), command: command(raw.command), aliases: strings(raw.aliases, "别名").map(command),
    stage: choice(raw.stage, ["rule", "accept"], "rule"), priority,
    minRole: choice(raw.minRole, boundaryRoles, "user"), scope: choice(raw.scope, ["all", "group", "private"], "all"),
    tool: param(raw.tool, "工具"), defaults: cloneJsonValue(defaults as ActionRecord),
    textParam: param(raw.textParam, "文字参数"), textTemplate,
    overridable: strings(raw.overridable, "可覆盖参数").map(name => param(name, "可覆盖参数")),
    input: {
      mode: choice(input.mode, ["text", "parameters"], "text"),
      images: choice(input.images, ["none", "current-or-quote", "current", "quote"], "none"),
      imageParam: param(input.imageParam, "图片参数", "referenceImages"), requireImage: flag(input.requireImage, false),
    },
  }
  if (kind === "tool" && !result.tool) fail("请选择关联工具")
  if (kind === "source") result.tool = `action_source_${key.replaceAll("-", "_")}`
  if (result.source?.callStyle === "plugin" && !result.source.method) fail("请填写插件方法名")
  if (result.textTemplate && !result.textParam) fail("使用提示词模板时必须指定文字参数")
  if (result.textTemplate && result.overridable.includes(result.textParam)) fail("模板绑定的文字参数不能同时开放覆盖")
  if (result.input.requireImage && result.input.images === "none") fail("必需图片时请选择图片来源")
  if (result.input.images !== "none" && !result.input.imageParam) fail("请选择图片参数")
  if (result.overridable.includes(result.input.imageParam) && result.input.images !== "none") fail("图片绑定参数不能由文字参数覆盖")
  return result
}

export function parseActions(value: unknown): ActionsConfig {
  const raw = actionRecord(value)
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) fail("动作配置必须是对象")
  const categories = raw.categories ?? []
  if (!Array.isArray(categories) || categories.length > 50) fail("分类最多 50 个")
  const ids = new Set<string>()
  const names = new Set<string>()
  const parsedCategories = categories.map(value => {
    const entry = actionRecord(value)
    const id = boundedText(entry.id, "分类 ID", 64)
    const name = boundedText(entry.name, "分类名称", 40)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !name || ids.has(id) || names.has(name)) fail("分类名称和 ID 必须非空且唯一")
    ids.add(id); names.add(name)
    return { id, name }
  })
  if (raw.items !== undefined && (!raw.items || typeof raw.items !== "object" || Array.isArray(raw.items))) fail("动作列表必须是对象")
  const entries = Object.entries(actionRecord(raw.items))
  if (entries.length > 200) fail("最多保存 200 个动作")
  const claims = new Set<string>()
  const items: Record<string, ActionDefinition> = {}
  for (const [id, value] of entries) {
    const item = parseAction(value, id)
    if (item.categoryId && !ids.has(item.categoryId)) fail(`动作“${item.name}”的分类不存在`)
    for (const alias of new Set([item.command, ...item.aliases])) {
      const key = `${item.stage}:${item.priority}:${alias}`
      if (item.enabled && claims.has(key)) fail(`指令“${alias}”存在相同阶段和优先级的动作`)
      if (item.enabled) claims.add(key)
    }
    items[id] = item
  }
  return { enabled: flag(raw.enabled, true), categories: parsedCategories, items }
}

export function actionRule(action: ActionDefinition): string {
  return pluginCommandRule(`(?:${[action.command, ...action.aliases].map(escapeRegExp).join("|")})(?:\\s+([\\s\\S]*))?`)
}
export function matchAction(action: ActionDefinition, message: unknown): string | null {
  const matched = String(message ?? "").trim().match(new RegExp(actionRule(action)))
  return matched ? String(matched[1] || "").trim() : null
}
export function actionCommand(action: ActionDefinition): string { return pluginCommand(action.command) }

export function figurineAction(id = "figurine"): ActionDefinition {
  return parseAction({ id, name: "手办化", description: "将图片中的主体制作成精致的收藏手办", command: "手办化", aliases: ["手办"],
    categoryId: "images", tool: "generate_image", defaults: { count: 1, aspectRatio: "1:1" }, textParam: "prompt",
    textTemplate: "将参考图中的主体制作成精致的收藏级手办，保留主体特征与服装，细腻材质，柔和棚拍光线，干净背景。\n补充要求：{{text}}",
    input: { images: "current-or-quote", requireImage: true },
  })
}

/** 示例只作为可复制草稿返回，保存前不注册指令，保存后也默认停用。 */
export function actionExamples(): ActionDefinition[] {
  return [
    { ...figurineAction(), enabled: false },
    parseAction({ id: "source-greeting", name: "源码问候", description: "调用项目函数，传入默认参数，从 JSON 中提取文字回复。", command: "源码问候", enabled: false,
      kind: "source", categoryId: "lookup", source: { frameworkResources: { target: "plugin:yui-chat/output/runtime/core/actions/example.js" }, exportName: "greet", callStyle: "function", risk: "low" },
      defaults: { prefix: "你好" }, textParam: "text", textTemplate: "{{userName}}",
      reply: { mode: "text", path: "data.text" },
    }),
  ]
}
