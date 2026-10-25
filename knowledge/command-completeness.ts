import { createHash } from "node:crypto"
import { setImmediate } from "node:timers/promises"
import { cloneJsonValue } from "../core/shared/json-values.js"
import { inspectCommandRegexp } from "./command-regexp-examples.js"

type Row = Record<string, unknown>
type Dimension = "A" | "B" | "C" | "D" | "E" | "regexp"
export interface CommandDeduction { code: string; dimension: Dimension; points: number; field: string; reason: string; suggestion: string }
export interface CommandCompleteness {
  ruleVersion: string
  qualityScore: number
  issues: string[]
  deductions: CommandDeduction[]
  dimensions: Record<Dimension, { maximum: number; deducted: number }>
  scoreCap: number
  capReasons: string[]
  completenessStatus: "complete" | "incomplete" | "needs-review"
  verification: "verified" | "invalid" | "unverified" | "event-exempt"
  originalComparison: "not-provided"
  lengths: { body: number; regexp: number; total: number }
}

export const COMMAND_COMPLETENESS_ISSUE_LABELS: Record<string, string> = {
  "source-dead": "原始规则永不匹配", "source-invalid": "原始正则或 flags 无法编译",
  "source-internal": "规则疑似内部动态标识", "source-listener": "宽泛消息监听缺少独立触发条件", "source-event": "未提供事件信息",
  "source-fact": "正文采集字段缺失或与元数据不一致", "field-duplicate": "非示例字段重复", "field-order": "正文字段顺序不规范",
  "field-extra": "正文含额外或旧格式字段", "field-orphan": "正文含游离内容",
  "title-invalid": "标题缺失、使用函数名或残留正则片段", "missing-command": "正文缺少明确指令或触发说明",
  "command-fragment": "指令行残留正则片段", "missing-purpose": "用途缺失或过于空泛",
  "pending-purpose": "用途待核实", "missing-parameters": "缺少参数说明；无参数请明确写“无”", "pending-parameters": "参数说明待核实或仅为占位符",
  "body-length": "检索说明偏长", "body-noise": "正文含重复说明或通用套话", "missing-example": "缺少可靠具体示例",
  "example-invalid": "具体示例含占位符、函数名或正则片段", "example-mismatch": "具体示例不匹配原始正则",
  "example-unverified": "示例正则校验未完成", "example-count": "示例超过八条", "suggestion-sync": "建议指令与正文示例不一致",
  "examples-sync": "已有示例数组与正文不一致", "pending-verification": "资料仍有待核实内容", "regexp-length": "原始正则较长，占用检索正文",
}

const VERSION = "command-completeness-v3"
const limits: Record<Dimension, number> = { A: 20, B: 20, C: 15, D: 25, E: 20, regexp: 5 }
const labels = ["插件名称", "插件标识", "指令", "用途", "参数", "示例", "priority", "regexp", "regexpFlags", "权限", "别名", "前置条件", "可信状态"]
const pending = /待核实|待补充|待完善|无法确认|尚未确认/u
const placeholder = /<[^>\n]+>|[｛{](?:内容|数字|角色名|歌曲名|参数|QQ号|UID)[｝}]|\\[dws]|\(\?:|\$\^/iu
const fragment = /\$\^|\\[dws]|\(\?[!:<=]|(?:^|\n)\^|\$(?:$|\n)/u
const results = new Map<string, CommandCompleteness>()
const deferred = new Map<string, Row>()
let draining: Promise<void> | undefined
const string = (value: unknown): string => typeof value === "string" ? value : String(value ?? "")
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
const useful = (value: string): boolean => Boolean(value.trim()) && !/^(?:无|暂无|未知|不详|不适用|[-—?？]+)[。.!！]?$/u.test(value.trim())
const metadataFields = ["pluginName", "pluginKey", "priority", "regexp", "regexpFlags", "event", "fnc", "suggestedCommand", "examples"]

function inputs(command: Row): { metadata: Row; title: string; body: string; key: string } {
  // Prefer persisted facts over derived heads/examples added by recommendation helpers.
  const metadata = command.metadata && typeof command.metadata === "object" ? record(command.metadata) : command
  const title = string(command.title), body = string(command.retrievalText).replace(/\r\n?/gu, "\n")
  const facts = [...metadataFields.map(name => metadata[name]), Object.hasOwn(metadata, "suggestedCommand"), Object.hasOwn(metadata, "examples")]
  return { metadata, title, body, key: createHash("sha256").update(JSON.stringify([VERSION, title, body, facts])).digest("hex") }
}

/** Deterministic maintenance score; no model calls, writes, implicit exclusions or retrieval ranking. */
export function evaluateCommandCompleteness(command: Row, executeRegex = true): CommandCompleteness {
  const { metadata: m, title, body, key } = inputs(command)
  const cached = results.get(key)
  if (cached) return cloneJsonValue(cached)
  const fields = new Map<string, string[]>(), order: string[] = []
  const regexLines = string(m.regexp).split("\n").length
  let current = "", orphan = false
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*([^：:\n]{1,32})[：:](.*)$/u)
    // A multiline source regex may itself contain labels or URLs; consume its known physical line count.
    const regexContinuation = current === "regexp" && fields.get(current)!.at(-1)!.split("\n").length < regexLines
    if (match && !regexContinuation) {
      current = match[1].trim(); order.push(current)
      fields.set(current, [...(fields.get(current) || []), match[2]])
    } else if (current) {
      if (line.trim()) { const values = fields.get(current)!; values[values.length - 1] += "\n" + line }
    } else if (line.trim()) orphan = true
  }
  const section = (name: string): string => (fields.get(name) || []).join("\n").trim()
  const instruction = section("指令"), purpose = section("用途"), parameters = section("参数")
  const examples = fields.get("示例") || []
  const source = string(m.regexp), flags = string(m.regexpFlags), event = string(m.event), fnc = string(m.fnc)
  const nonText = /^(?:notice|request|meta_event)(?:\.|$)/u.test(event)
  const eventExamples = nonText && examples.length === 1 && /^无[（(][^\n]*事件触发[）)]$/u.test(examples[0])
  const pendingExamples = examples.length === 1 && pending.test(examples[0])
  const suggestion = string(m.suggestedCommand)
  const originalExamples = Array.isArray(m.examples) ? m.examples.map(string) : []
  const sampleValues = [...new Set([...(!pendingExamples && !eventExamples ? examples : []), ...(suggestion ? [suggestion] : []), ...originalExamples])]
  const check = inspectCommandRegexp(source, flags, nonText || pendingExamples ? [] : sampleValues, executeRegex)
  const deductions: CommandDeduction[] = [], capReasons: string[] = []
  const dimensions = Object.fromEntries(Object.entries(limits).map(([name, maximum]) => [name, { maximum, deducted: 0 }])) as CommandCompleteness["dimensions"]
  let scoreCap = 100
  const add = (code: string, dimension: Dimension, points: number, field: string, reason: string, suggestionText: string): void => {
    const applied = Math.min(points, limits[dimension] - dimensions[dimension].deducted)
    if (applied <= 0) return
    dimensions[dimension].deducted += applied
    deductions.push({ code, dimension, points: applied, field, reason, suggestion: suggestionText })
  }
  const cap = (maximum: number, reason: string): void => { scoreCap = Math.min(scoreCap, maximum); capReasons.push(reason) }

  if (["(?!)", "((?!))"].includes(source)) {
    add("source-dead", "A", 20, "regexp", "原始规则明确永不匹配", "检查源插件配置，修正后重新采集，或手动排除此条")
    cap(40, "原始规则永不匹配，最高 40 分")
  } else if (check.state === "invalid") {
    add("source-invalid", "A", 15, "regexp/regexpFlags", "原始正则或 flags 无法编译", "在源插件修正规则后重新采集，不让整理模型改写采集事实")
    cap(60, "原始正则无法编译，最高 60 分")
  } else if (/^[a-zA-Z0-9_-]+-plugin-[a-zA-Z0-9_-]+-\d+$/u.test(source)) {
    add("source-internal", "A", 5, "regexp", "规则形似内部动态占位符，尚不能证明是独立用户指令", "核对源插件的触发入口，确认后整理或手动排除")
  } else if (/^message(?:\.|$)/u.test(event) && ["", "(?:)", ".*", ".+", "^.*$", "^.+$", "^(.*)$", "^(.+)$", "^[\\s\\S]*$", "^[\\s\\S]+$", "^(?!#).*$"].includes(source)) {
    add("source-listener", "A", 10, "regexp", "普通消息使用宽泛监听规则，缺少独立触发条件", "核实入口及交互上下文，不能把任意匹配消息当成固定指令")
  }
  if (!event) add("source-event", "A", 5, "event", "未提供事件信息，无法确认触发类型", "重新采集外层事件声明")

  for (const [label, name] of [["插件名称", "pluginName"], ["插件标识", "pluginKey"], ["priority", "priority"], ["regexp", "regexp"], ["regexpFlags", "regexpFlags"]]) {
    if (["priority", "regexp", "regexpFlags"].includes(name) && !fields.has(label)) continue
    const expected = string(m[name] ?? (name === "priority" ? "未知" : ""))
    let actual = ["regexp", "插件名称", "插件标识"].includes(label) ? (fields.get(label) || []).join("\n") : section(label)
    if (name === "regexpFlags") {
      try { const decoded: unknown = JSON.parse(actual); if (typeof decoded === "string") actual = decoded } catch { /* Nonempty bare flags are compared without interpreting regex escapes. */ }
    }
    if (!fields.has(label) || actual !== expected || (name === "regexpFlags" && expected === "" && section(label) !== '""')) {
      add("source-fact", "B", 2, label, `${label}缺失或与采集元数据不一致`, "将正文该字段恢复为采集原值")
      if (name === "regexp" && fields.has(label)) cap(60, "正文正则与元数据不一致，最高 60 分")
    }
  }
  const duplicates = [...fields].filter(([name, values]) => name !== "示例" && values.length > 1).map(([name]) => name)
  if (duplicates.length) add("field-duplicate", "B", Math.min(3, duplicates.length), duplicates.join("、"), "非示例字段重复", "每类字段保留一处，示例可重复多行")
  const positions = order.filter(name => labels.includes(name)).map(name => labels.indexOf(name))
  if (positions.some((value, index) => index > 0 && value < positions[index - 1])) add("field-order", "B", 2, "retrievalText", "检索字段未按约定顺序组织", "按插件名称、标识、指令、用途、参数和示例组织，运行字段仅留在元数据")
  const extra = [...fields.keys()].filter(name => !labels.includes(name))
  if (extra.length) add("field-extra", "B", Math.min(3, extra.length), extra.join("、"), "正文包含额外或旧格式字段", "移除冗余标签，必要的已知特殊条件简写进用途")
  if (orphan) add("field-orphan", "B", 2, "retrievalText", "正文开头存在无法归入字段的游离内容", "使用逐行字段和值组织说明")

  if (!useful(title) || (fnc && title.trim() === fnc) || fragment.test(title)) add("title-invalid", "C", 5, "title", "标题缺失、直接使用函数名或残留明确正则片段", "改为简短可读的插件或业务功能名称")
  const readableInstruction = instruction.replace(/<[^>\n]+>|[｛{][^｝}\n]+[｝}]/gu, "").trim()
  if (!useful(readableInstruction) || pending.test(instruction) || (fnc && instruction === fnc)) add("missing-command", "C", 10, "指令", "未提供明确指令结构或触发方式", "填写明确触发文本、参数模板或事件/链接触发说明")
  else if (fragment.test(instruction)) add("command-fragment", "C", 8, "指令", "指令行残留明确的正则结构", "参考原规则还原指令模板，不修改原始正则")
  else if (nonText && !/事件|触发/u.test(instruction)) add("missing-command", "C", 5, "指令", "事件条目未说明事件触发形式", "写明实际事件触发方式")

  if (!useful(purpose)) add("missing-purpose", "D", 15, "用途", "用途缺失或仅有未知/无等空值", "说明用户可以用该功能完成什么操作")
  else if (pending.test(purpose)) add("pending-purpose", "D", 10, "用途", "真实用途仍待核实", "根据可核对资料补充，不能仅凭函数名编造")
  else if (/^(?:简单开发示例|插件功能|功能说明|待整理指令)[。！.!]?$/u.test(purpose)) add("missing-purpose", "D", 10, "用途", "用途只有空泛模板，无法辨认具体功能", "补充具体功能，不为凑字数重复问法")
  if (!parameters || /^(?:未知|不详|不适用|[-—?？]+)$/u.test(parameters)) add("missing-parameters", "D", 10, "参数", "未提供参数说明", "说明输入含义和必填性，无参数明确写“无”")
  else if (pending.test(parameters) || /^[<｛{](?:内容|数字|参数|文本)[>｝}]$/u.test(parameters)) add("pending-parameters", "D", 5, "参数", "参数含义待核实或仅有占位符", "结合业务证据解释参数，不从捕获组盲猜含义")
  const bodyText = [instruction, purpose, parameters, ...examples].join("\n")
  const bodyLength = Array.from(bodyText).length, regexLength = Array.from(source).length
  const lengthPenalty = bodyLength > 2000 ? 8 : bodyLength > 1000 ? 5 : bodyLength > 550 ? 3 : bodyLength > 350 ? 1 : 0
  const statements = [purpose, parameters, ...examples].flatMap(value => value.split("\n")).map(value => value.trim()).filter(Boolean)
  const repeated = statements.length - new Set(statements).size
  const noiseCount = [/插件已加载/u, /不保证存在或可用/u, /内部权限与宿主能力检查/u, /未声明额外角色限制/u].filter(pattern => pattern.test(bodyText)).length
  const noisePenalty = Math.min(3, repeated + noiseCount)
  // Repetition and inflated length describe the same clutter: apply the larger deduction once.
  if (lengthPenalty >= noisePenalty && lengthPenalty) add("body-length", "D", lengthPenalty, "指令/用途/参数/示例", `检索说明共 ${bodyLength} 字符，超过建议长度`, "精简重复说明和无关枚举，保留必要信息")
  else if (noisePenalty) add("body-noise", "D", noisePenalty, "用途/参数/示例", "正文含重复说明或通用套话", "删除重复内容，已知特殊条件简写即可")

  const invalidSamples = sampleValues.some(value => placeholder.test(value) || fragment.test(value) || (fnc && value === fnc))
  if (!nonText && !pendingExamples && check.state === "verified" && check.matches.some(value => !value)) cap(60, "具体发送示例不匹配，最高 60 分")
  let exampleError = false
  if (nonText) {
    if (!eventExamples) { exampleError = true; add("missing-example", "E", 10, "示例", "非文本事件缺少规范的事件示例说明，或填入了文本伪指令", "写为“无（通过实际事件触发）”，不编造发送命令") }
  } else if (!examples.length || examples.every(value => !value.trim()) || pendingExamples) {
    exampleError = true; add("missing-example", "E", 10, "示例", "尚无可靠具体发送示例", "核实后补充；无法确认时保留待核实说明及空建议指令")
  } else if (invalidSamples) {
    exampleError = true; add("example-invalid", "E", 10, "示例/suggestedCommand/examples", "具体发送示例含占位符、函数名或正则残片", "替换为可靠具体值，同步正文、建议指令及已有示例数组")
  } else if (check.state === "verified" && check.matches.some(value => !value)) {
    exampleError = true; add("example-mismatch", "E", 10, "示例/suggestedCommand/examples", "至少一个具体发送示例不匹配原始正则及 flags", "修正示例，不修改原正则来迁就示例")
  } else if (check.state === "unverified") {
    exampleError = true; add("example-unverified", "E", 10, "示例", check.reason === "timeout" ? "正则验证超时，不能判定为不匹配" : "正则验证超过数量、长度或批次预算，尚未完成", executeRegex ? "核实或精简源规则后重新采集/编辑；超时不代表规则无效" : "批次预算已用完，后台将继续校验；稍后刷新查看结果")
  }
  if (!exampleError && examples.length > 8) add("example-count", "E", 2, "示例", "具体示例超过八条", "保留最多八条代表性示例")
  const shouldBeEmpty = nonText || pendingExamples
  if ((Object.hasOwn(m, "suggestedCommand") && typeof m.suggestedCommand !== "string") || (shouldBeEmpty ? suggestion !== "" : Boolean(examples.length && examples[0] && suggestion !== examples[0]))) add("suggestion-sync", "E", 5, "suggestedCommand", shouldBeEmpty ? "事件或待核实条目的建议指令没有留空" : "建议指令与正文首条具体示例不同或类型不正确", "事件/待核实条目留空，普通条目同步首条具体示例")
  if (Object.hasOwn(m, "examples") && (!Array.isArray(m.examples) || m.examples.some(value => typeof value !== "string") || JSON.stringify(originalExamples) !== JSON.stringify(shouldBeEmpty ? [] : examples))) add("examples-sync", "E", 5, "metadata.examples", "已有示例数组与正文示例不一致", "同步已有数组；原来不存在时不要求新增")

  const regexPenalty = regexLength > 3000 ? 5 : regexLength > 1500 ? 3 : regexLength > 800 ? 2 : regexLength > 300 ? 1 : 0
  if (regexPenalty && fields.has("regexp")) add("regexp-length", "regexp", regexPenalty, "regexp", `原始正则共 ${regexLength} 字符，占用检索正文`, "检查源插件是否可精简重复结构或枚举，修正后重新采集；整理模型仍须完整保留原值")
  const reviewText = [...fields].filter(([name]) => !["插件名称", "插件标识", "priority", "regexp", "regexpFlags"].includes(name)).flatMap(([, values]) => values).join("\n") || body
  const needsReview = pending.test(reviewText) || check.state === "unverified" || deductions.some(item => item.code === "source-internal")
  const issues = [...new Set(deductions.map(item => item.code))]
  if (pending.test(reviewText)) issues.push("pending-verification")
  const grade: CommandCompleteness = {
    ruleVersion: VERSION, qualityScore: Math.max(0, Math.min(scoreCap, 100 - deductions.reduce((total, item) => total + item.points, 0))),
    issues, deductions, dimensions, scoreCap, capReasons,
    completenessStatus: needsReview ? "needs-review" : issues.length ? "incomplete" : "complete",
    verification: nonText ? "event-exempt" : pendingExamples || !examples.length ? "unverified" : check.state,
    originalComparison: "not-provided", lengths: { body: bodyLength, regexp: regexLength, total: Array.from(body).length },
  }
  if (results.size >= 10000) results.delete(results.keys().next().value!)
  results.set(key, grade)
  if (!executeRegex && check.state === "unverified") {
    if (deferred.size >= 10000) deferred.delete(deferred.keys().next().value!)
    deferred.set(key, { title, retrievalText: body, metadata: cloneJsonValue(Object.fromEntries(metadataFields.filter(name => Object.hasOwn(m, name)).map(name => [name, m[name]]))) })
  }
  return cloneJsonValue(grade)
}

async function drainDeferred(): Promise<void> {
  while (deferred.size) {
    await setImmediate()
    const [key, command] = deferred.entries().next().value!
    deferred.delete(key)
    results.delete(key)
    evaluateCommandCompleteness(command)
  }
}

/** Warm once per revision, yielding between small batches; adversarial catalogues have a total regex budget. */
export async function prepareCommandCompleteness(commands: readonly Row[], budgetMs = 1000): Promise<void> {
  const deadline = performance.now() + Math.max(0, Math.min(2000, budgetMs))
  let slice = performance.now()
  for (const command of commands) {
    evaluateCommandCompleteness(command, performance.now() < deadline)
    if (performance.now() - slice >= 8) { await setImmediate(); slice = performance.now() }
  }
  // Batch-budget deferrals finish cooperatively instead of permanently penalizing our own scheduling limit.
  if (deferred.size && !draining) draining = drainDeferred().finally(() => { draining = undefined })
}
