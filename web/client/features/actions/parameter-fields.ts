import { asRecord, type UnknownRecord } from "../../shared/data.js"

const labels: Record<string, string> = {
  count: "数量", aspectRatio: "画面比例", imageSize: "图片尺寸", size: "分辨率", quality: "画质", background: "背景",
  startMessage: "开始提示", query: "查询内容", text: "文字", prompt: "提示词", referenceImages: "参考图片", prefix: "前缀",
  source: "来源渠道", searchMode: "搜索模式", maxResults: "结果数量上限", topic: "搜索主题", searchDepth: "搜索深度",
  timeRange: "时间范围", days: "新闻回溯天数", site: "限定网站", startDate: "开始日期", endDate: "结束日期",
}
export const parameterLabel = (key: string, schema: unknown = {}) => String(asRecord(schema).title || labels[key] || key)

const searchHints: Record<string, string> = {
  query: "搜索关键词或完整问题，由默认要求和指令后的补充文字组成。",
  source: "auto 从已启用的渠道中选择；指定渠道时，该渠道也必须先启用。",
  searchMode: "auto 跟随工具策略；fast 使用首选渠道，balanced 失败后换源，deep 并行搜索多个渠道。",
  maxResults: "最多返回多少条结果，留空使用工具中配置的数量。",
  topic: "Tavily 可选择普通网页或新闻。", searchDepth: "Tavily 的基础或深入搜索。",
  timeRange: "只搜索最近一天、一周、一月、半年或一年的内容；各渠道支持的范围不同。",
  days: "Tavily 新闻搜索向前查询的天数。", site: "仅百度 AI 搜索使用；多个域名用逗号或竖线分隔。",
  startDate: "Tavily 搜索起始日期，格式为 YYYY-MM-DD。", endDate: "Tavily 搜索结束日期，格式为 YYYY-MM-DD。",
}
const searchChoices: Record<string, string> = { auto:"自动", "baidu-ai":"百度 AI 搜索", tavily:"Tavily", fast:"首选渠道", balanced:"失败换源", deep:"多渠道并行", general:"普通网页", news:"新闻", basic:"基础", advanced:"深入", day:"最近一天", week:"最近一周", month:"最近一月", halfyear:"最近半年", year:"最近一年" }

export function actionParameterFields(schema: unknown, excluded: string[] = [], toolName = "") {
  const definition = asRecord(schema)
  const required = Array.isArray(definition.required) ? definition.required : []
  return Object.entries(asRecord(definition.properties)).filter(([key]) => !excluded.includes(key)).map(([key, value]) => {
    const field = asRecord(value)
    const kind = String(field.type || "")
    const choices = Array.isArray(field.enum) ? field.enum : kind === "boolean" ? [true, false] : []
    const complex = !choices.length && !["string", "number", "integer", "boolean"].includes(kind)
    const hints = [toolName === "web_search" ? searchHints[key] || String(field.description || "") : String(field.description || ""),
      Object.hasOwn(field, "default") ? `工具默认：${JSON.stringify(field.default)}` : "留空时不传入此参数。",
      field.minimum !== undefined ? `最小值 ${field.minimum}` : "", field.maximum !== undefined ? `最大值 ${field.maximum}` : "",
      complex ? `使用 JSON 填写${kind === "array" ? "数组" : kind === "object" ? "对象" : "参数值"}。` : "",
    ].filter(Boolean)
    return { key, label: parameterLabel(key, field), required: required.includes(key), complex,
      type: choices.length ? "select" : complex ? "textarea" : ["number", "integer"].includes(kind) ? "number" : "text",
      hint: hints.join(" "), placeholder: kind === "array" ? '例如：["值1", "值2"]' : kind === "object" ? '例如：{"名称":"值"}' : "留空跟随工具",
      options: [{ value: "", label: "跟随工具默认" }, ...choices.map(value => ({ value: JSON.stringify(value), label: value === true ? "是" : value === false ? "否" : typeof value === "string" ? (toolName === "web_search" && searchChoices[value] ? `${searchChoices[value]} · ${value}` : value) : JSON.stringify(value) }))],
    }
  })
}

export function parameterInputValue(schema: unknown, value: unknown): string | number {
  if (value === undefined) return ""
  const field = asRecord(schema)
  if (field.enum || field.type === "boolean" || typeof value === "object") return JSON.stringify(value)
  return typeof value === "number" ? value : String(value)
}

/** 空输入表示继承；枚举保留原始 JSON 类型，复杂输入保持为数组或对象。 */
export function parseParameterInput(schema: unknown, input: unknown): unknown {
  if (input === "") return undefined
  const field = asRecord(schema)
  const type = String(field.type || "")
  let value = input
  if (Array.isArray(field.enum) || type === "boolean" || !["string", "number", "integer"].includes(type)) value = JSON.parse(String(input))
  else if (type === "number" || type === "integer") value = Number(input)
  if (type === "array" && !Array.isArray(value)) throw new Error("请填写 JSON 数组，例如 [\"值1\", \"值2\"]")
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("请填写 JSON 对象，例如 {\"名称\":\"值\"}")
  if (type === "boolean" && typeof value !== "boolean") throw new Error("请选择是或否")
  if (["integer", "number"].includes(type) && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("请填写有效数字")
  if (type === "integer" && !Number.isInteger(value)) throw new Error("请填写整数")
  if (typeof value === "number" && field.minimum !== undefined && value < Number(field.minimum)) throw new Error(`不能小于 ${field.minimum}`)
  if (typeof value === "number" && field.maximum !== undefined && value > Number(field.maximum)) throw new Error(`不能大于 ${field.maximum}`)
  if (Array.isArray(field.enum) && !field.enum.some(choice => JSON.stringify(choice) === JSON.stringify(value))) throw new Error("请选择允许的值")
  return value
}

export function updateParameterValue(args: UnknownRecord, key: string, value: unknown): UnknownRecord {
  if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("不支持此参数名")
  const next = { ...args }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}
