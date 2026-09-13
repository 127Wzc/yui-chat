import { asRecord } from "../../shared/data.js"

export interface ActionIssue { step: number; message: string }

/** 编辑器的即时提示；保存时仍以服务端权限与完整校验为准。 */
export function actionEditorIssues(value: unknown, defaultsText: string, schema: unknown, aliases: string[], overrides: string[]): ActionIssue[] {
  const action = asRecord(value), input = asRecord(action.input), source = asRecord(action.source), reply = asRecord(action.reply)
  const issues: ActionIssue[] = []
  const add = (step: number, message: string) => issues.push({step, message})
  if (!String(action.name || "").trim()) add(0, "请填写动作名称。")
  for (const name of [String(action.command || ""), ...aliases]) {
    if (!name.trim() || /[\s#/$@]/.test(name) || name.length > 40) add(0, "指令和别名应为 1–40 个字符，不带前缀、空格或 # / $ @。")
  }
  if (new Set([action.command, ...aliases]).size !== aliases.length + 1) add(0, "指令与别名不能重复。")
  if (!Number.isSafeInteger(action.priority) || Number(action.priority) < -99999 || Number(action.priority) > 99999) add(0, "优先级应为 -99999 至 99999 的整数。")
  if (action.kind === "tool" && !action.tool) add(1, "请选择一个工具。")
  if (action.kind === "source") {
    const target = String(asRecord(source.frameworkResources).target || "")
    if (!/^(?:plugin:[^/\\]+\/|yunzai:)[^\\]+$/.test(target) || target.split("/").some(part=>part === ".." || part.startsWith("."))) add(1, "请通过“选文件”选择项目资源，不支持绝对路径或上级目录。")
    if (source.callStyle !== "resource" && !/^[A-Za-z_$][\w$]*$/.test(String(source.exportName || ""))) add(1, "请填写有效导出名称，例如 default、greet 或 Handler。")
    if (source.callStyle === "plugin" && !String(source.method || "").trim()) add(1, "调用插件方法时必须填写方法名，例如 run。")
    if (source.method && !/^[A-Za-z_$][\w$]*$/.test(String(source.method))) add(1, "方法名应为代码中的单个方法名称，不能填写调用表达式。")
    if (source.callStyle !== "resource" && target && !/\.(?:js|mjs|cjs)$/i.test(target)) add(1, "函数调用需要选择编译后的 JS 模块；TS 文件请先构建，再选择对应运行文件。")
  }
  function template(text: string, allowed: string[], step: number) {
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) if (!allowed.includes(match[1].trim())) add(step, `不支持占位符 ${match[0]}；可用：${allowed.map(key=>`{{${key}}}`).join("、")}。`)
    if (/\{\{|\}\}/.test(text.replace(/\{\{[^{}]*\}\}/g,""))) add(step, "占位符的大括号未配对，请使用 {{变量名}}。")
  }
  template(String(action.textTemplate || ""), ["text","userName","userId","groupId"], 2)
  if (action.textTemplate && !action.textParam) add(2, "填写默认要求后，请选择“把指令后的文字填到”的参数。")
  if (input.requireImage && input.images === "none") add(2, "要求必须提供图片时，请选择图片来源。")
  if (input.images !== "none" && !input.imageParam) add(2, "请选择接收图片的参数。")
  if (action.textTemplate && overrides.includes(String(action.textParam))) add(2, "已绑定默认要求的文字参数，不能同时开放用户覆盖。")
  if (input.images !== "none" && overrides.includes(String(input.imageParam))) add(2, "已绑定图片的参数，不能同时开放用户覆盖。")
  const definition = asRecord(schema), properties = asRecord(definition.properties)
  let args: Record<string, unknown> = {}
  if (defaultsText.length > 24000) { add(2, "默认参数不能超过 24,000 个字符。"); return issues }
  try {
    const parsed: unknown = JSON.parse(defaultsText)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    args = asRecord(parsed)
  } catch { add(2, '默认参数必须是有效的 JSON 对象，例如 {"count":1}。') }
  function check(value: unknown, schema: unknown, path: string, depth = 0) {
    if (depth > 12) { add(2, "参数嵌套过深，请简化默认参数。"); return }
    const field = asRecord(schema), type = field.type
    if (type === "array" && !Array.isArray(value) || type === "object" && (!value || typeof value !== "object" || Array.isArray(value)) || ["string","boolean"].includes(String(type)) && typeof value !== type || ["number","integer"].includes(String(type)) && (typeof value !== "number" || !Number.isFinite(value))) { add(2, `${path} 类型不正确，应为 ${type}。`); return }
    if (type === "integer" && !Number.isInteger(value)) add(2, `${path} 必须是整数。`)
    if (Array.isArray(field.enum) && !field.enum.some(option=>JSON.stringify(option) === JSON.stringify(value))) add(2, `${path} 不在允许的选项中。`)
    if (typeof value === "number" && (field.minimum !== undefined && value < Number(field.minimum) || field.maximum !== undefined && value > Number(field.maximum))) add(2, `${path} 超出允许范围（${field.minimum ?? "不限"} 至 ${field.maximum ?? "不限"}）。`)
    if (Array.isArray(value) && field.items) value.forEach((item,index)=>check(item,field.items,`${path}[${index}]`,depth+1))
  }
  if (action.kind === "tool") {
    for (const key of [action.textParam, ...(input.images === "none" ? [] : [input.imageParam]), ...overrides].filter(Boolean).map(String)) if (!Object.hasOwn(properties,key)) add(2, `工具没有声明参数 ${key}，请重新选择绑定或覆盖参数。`)
    for (const [key,value] of Object.entries(args)) {
      if (Object.hasOwn(properties,key)) check(value,properties[key],key)
      else if (definition.additionalProperties === false) add(2, `工具不接受参数 ${key}。`)
    }
    for (const key of Array.isArray(definition.required) ? definition.required.map(String) : []) {
      if (key === action.textParam || input.images !== "none" && key === input.imageParam || input.mode === "parameters" && overrides.includes(key)) continue
      if (args[key] === undefined || args[key] === "") add(2, `缺少必填参数 ${key}，请填写默认值或设置输入绑定。`)
    }
  }
  if (reply.path && (!/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+|\[\d+\])*$/.test(String(reply.path)) || /(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|\[|$)/.test(String(reply.path)))) add(3, "结果字段格式不正确，请使用 data.text 或 data.images[0].url。")
  template(String(reply.template || ""), ["value"], 3)
  return issues.filter((issue,index)=>issues.findIndex(other=>other.step === issue.step && other.message === issue.message) === index)
}
