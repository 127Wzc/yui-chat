import { getToolCommon } from "../../tools/support/contract.js"

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

/** 统一的保守 token 估算；没有供应商 tokenizer 时宁可少注入上下文，也不让工具轮次无限增长。 */
export function estimateTokens(value: unknown = ""): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value || "") || ""
  if (!serialized) return 0
  const cjk = (serialized.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  return Math.ceil(cjk / 1.7 + Math.max(0, serialized.length - cjk) / 4)
}

export function messageTokens(message: unknown = {}): number {
  const source = record(message)
  return estimateTokens(source.content) + estimateTokens(source.tool_calls) + estimateTokens(source.protocol) + 4
}

export function truncateTextToTokens(value: unknown = "", limit = 0): string {
  const source = text(value)
  if (limit <= 0 || estimateTokens(source) <= limit) return source
  const ratio = Math.max(0.05, limit / Math.max(1, estimateTokens(source)))
  const chars = Math.max(1, Math.floor(source.length * ratio) - 1)
  return `${source.slice(0, chars)}…`
}

function messageRole(message: unknown): string {
  return text(record(message).role)
}

function toolCallIds(message: unknown): string[] {
  const calls = record(message).tool_calls
  return Array.isArray(calls) ? calls.map(call => text(record(call).id)).filter(Boolean) : []
}

/**
 * 把消息切成不可拆分的原子单元。
 *
 * 同一批次里 assistant 声明的每个 tool_call 都必须有配对的 tool 结果，
 * 少一条就会让供应商直接拒绝请求。所以一次 assistant + 它名下的全部
 * tool 结果永远作为一个整体保留或整体丢弃，并且按 tool_call_id 归属，
 * 不依赖它们在数组里是否相邻。
 */
function groupAtomicUnits<T>(messages: readonly T[]): T[][] {
  const ownerByCallId = new Map<string, number>()
  messages.forEach((message, index) => {
    for (const id of toolCallIds(message)) ownerByCallId.set(id, index)
  })
  const buckets = new Map<number, T[]>()
  const order: number[] = []
  messages.forEach((message, index) => {
    const callId = text(record(message).tool_call_id)
    // 找不到归属的孤儿 tool 结果自成一组，可以被优先丢弃：它本身就不合法。
    const owner = messageRole(message) === "tool" && ownerByCallId.has(callId) ? ownerByCallId.get(callId) as number : index
    if (!buckets.has(owner)) { buckets.set(owner, []); order.push(owner) }
    buckets.get(owner)?.push(message)
  })
  return order.map(index => buckets.get(index) as T[])
}

function unitTokens(unit: readonly unknown[]): number {
  return unit.reduce<number>((sum, item) => sum + messageTokens(item), 0)
}

/** 压缩工具调用的出入参，但保留调用关系骨架（id、名称、配对）。 */
function compressToolPayloads<T>(unit: readonly T[], limit: number): T[] {
  return unit.map(message => {
    const source = record(message)
    if (messageRole(message) === "tool") {
      return { ...source, content: truncateTextToTokens(source.content, limit) } as T
    }
    const calls = source.tool_calls
    if (!Array.isArray(calls) || !calls.length) return message
    return {
      ...source,
      tool_calls: calls.map(call => {
        const item = record(call)
        const fn = record(item.function)
        if (!Object.hasOwn(item, "function")) return { ...item, arguments: truncateTextToTokens(item.arguments, limit) }
        return { ...item, function: { ...fn, arguments: truncateTextToTokens(fn.arguments, limit) } }
      }),
    } as T
  })
}

export function trimMessagesToBudget<T>(messages: readonly T[] = [], budget = 0): T[] {
  if (!budget) return []
  const kept: T[] = []
  let used = 0
  for (const unit of [...groupAtomicUnits(messages)].reverse()) {
    const tokens = unitTokens(unit)
    if (used + tokens > budget) continue
    kept.unshift(...unit)
    used += tokens
  }
  return kept
}

function scoreTool(tool: unknown, prompt = ""): number {
  const source = record(tool)
  const common = getToolCommon(source)
  const provenance = record(common.provenance)
  const tags = Array.isArray(common.tags) ? common.tags.map(text).join(" ") : ""
  // 模型定义中的参数说明同样是工具语义的一部分。许多内置/MCP 工具名和
  // 主描述为英文，而 action/字段描述使用中文；只检索主描述会让“撤回”
  // “禁言”等中文意图把已启用的正确工具错误挤出预算。
  const parameters = JSON.stringify(common.parameters || {})
  const haystack = [
    source.name,
    common.displayNameZh,
    common.description,
    common.descriptionZh,
    provenance.serverDescription || source.serverDescription,
    tags,
    parameters,
  ].map(text).join(" ").toLowerCase()
  const promptText = text(prompt).toLowerCase()
  const tagList = Array.isArray(common.tags) ? common.tags.map(item => text(item).toLowerCase()) : []
  const terms = promptText.match(/[\p{L}\p{N}_-]{2,}/gu) || []
  let score = 0
  for (const term of terms) if (haystack.includes(term)) score += Math.min(8, term.length)
  const cjkRuns = haystack.match(/[\u3400-\u9fff]+/g) || []
  for (const run of cjkRuns) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const phrase = run.slice(index, index + 2)
      if (promptText.includes(phrase)) score += 3
    }
  }
  if (source.name === "memory_manage" && /记住|记下|忘记|称呼|偏好|喜欢|讨厌|上次|之前|还记得/.test(promptText)) score += 100
  if (source.name === "knowledge_manage" && /指令|命令|怎么|如何|帮助|help|知识库|文档/.test(promptText)) score += 100
  if (/图片|图像|照片|视频|语音/.test(promptText) && (tags.includes("media") || /图片|图像|照片|图床|表情包/.test(haystack))) score += 50
  // 图片搜索和图片生成都带有“图片”字样，单靠通用媒体分数会让两者
  // 发生词义抢占。按动作词给出一个明确的首选，避免“搜一张”误触发生成。
  const imageCreationIntent = /(?:画(?!面|风|质)|绘(?:制|画)|生成|创作|制作|设计|改图|修图|生图|draw|generate|create|edit)/i.test(promptText)
  const imageSearchIntent = /(?:搜(?:图|一张|图片|图像|照片)|搜索(?:图片|图像|照片|表情包)|找(?:一张|图片|图像|照片)|图库|图片搜索|image\s*search|find (?:an? )?(?:image|picture|photo))/i.test(promptText)
  if (source.name === "generate_image" && imageCreationIntent) score += 120
  if (source.name === "image_media" && imageSearchIntent && !imageCreationIntent) score += 120
  // 明确要求联网或时效信息时，实时搜索应在首轮直接可用。否则它的参数
  // Schema 较大，容易在定义预算中排到后面，迫使模型先走一次 tool_search。
  // 这里只匹配强时效/网络信号，避免“搜张图片”等媒体意图被网页搜索抢走。
  const realtimeWebIntent = /(?:联网|上网|网上|网页|网络搜索|实时|最新|近期|新闻|时事|热搜|(?:当前|现在)(?:的)?(?:价格|状态|情况|进展|新闻|消息)|web\s*search|internet|online|latest|current|news)/i.test(promptText)
  const genericWebSearchIntent = /(?:搜索一下|搜一下|搜一搜|帮我搜|帮我查|查一下|查一查|检索|查询|找资料|search|look\s*up)/i.test(promptText)
  const specializedSearchIntent = /(?:图片|图像|照片|表情包|视频|语音|歌曲|音乐|哔哩哔哩|b站|bilibili|天气|气温|预报)/i.test(promptText)
  const realtimeWebTool = source.name === "web_search" || tagList.some(tag => ["web-search", "realtime", "news"].includes(tag))
  if (realtimeWebTool && (realtimeWebIntent || (genericWebSearchIntent && !specializedSearchIntent))) score += realtimeWebIntent ? 120 : 70
  return score
}

export function selectPromptTools<T>(tools: readonly T[] = [], prompt = "", selection: unknown = {}): T[] {
  const options = record(selection)
  if (options.enabled === false) return [...tools]
  const maxTools = Math.max(1, Number(options.maxTools) || 12)
  const tokenBudget = Math.max(100, Number(options.maxDefinitionTokens) || 1200)
  const ranked = [...tools]
    .map(tool => {
      const source = record(tool)
      const common = getToolCommon(source)
      return { tool, score: scoreTool(tool, prompt), tokens: estimateTokens({ name: source.name, description: common.description, parameters: common.parameters }) }
    })
    .sort((left, right) => right.score - left.score || text(record(left.tool).name).localeCompare(text(record(right.tool).name)))
  const selected: T[] = []
  let used = 0
  for (const item of ranked) {
    if (selected.length >= maxTools || used + item.tokens > tokenBudget) continue
    selected.push(item.tool)
    used += item.tokens
  }
  return selected
}

/** 一次预算压缩的结果，便于调用方在日志里如实反映发生了什么。 */
export interface PromptBudgetResult {
  messages: UnknownRecord[]
  compressed: boolean
  limit: number
  before: number
  after: number
  toolPayloadsCompressed: number
  unitsDropped: number
  messagesDropped: number
}

export interface PromptBudgetOptions {
  channel?: unknown
  maxTokens?: unknown
}

/**
 * 输入预算取值链：模型声明的上下文窗口优先，未声明时回落全局聊天预算。
 * 输出预留（任务 maxTokens）与安全边际从目标里扣除，避免输入顶满窗口把输出挤掉；
 * 估算器本身偏保守，安全边际固定为 200，不再单独配置。
 */
function inputTokenLimit(config: unknown, options: PromptBudgetOptions = {}): number {
  const chat = record(record(config).chat)
  const outputReserve = Math.max(0, Math.floor(Number(options.maxTokens) || 0))
  const safetyMargin = 200
  const windowTokens = Number(record(record(options.channel).modelConfig).contextWindowTokens)
  const target = Number.isFinite(windowTokens) && windowTokens >= 1024
    ? Math.floor(windowTokens)
    : Math.max(1000, Number(chat.inputTokenBudget) || 6000)
  return Math.max(1, target - outputReserve - safetyMargin)
}

/**
 * 只在整个会话超出窗口时才压缩。
 *
 * 未超窗口时原样返回：工具结果不再有独立上限，多轮调用可以完整保留。
 * 超窗口后分两阶段——先压缩工具调用的出入参（保留调用关系骨架），仍不
 * 够再从最旧开始整组丢弃历史。system 和最后一条 user 永远保留。
 *
 * 记忆提炼等孤立任务（runIsolatedModelTask）不走这里：它们的输入由任务
 * 自己的切块规则控制，显式传入的输出上限也优先于任务默认值。
 */
export function enforcePromptBudgetDetailed(messages: readonly UnknownRecord[] = [], config: unknown = {}, options: PromptBudgetOptions = {}): PromptBudgetResult {
  const limit = inputTokenLimit(config, options)
  const before = messages.reduce((sum, item) => sum + messageTokens(item), 0)
  const base: PromptBudgetResult = {
    messages: [...messages], compressed: false, limit, before, after: before,
    toolPayloadsCompressed: 0, unitsDropped: 0, messagesDropped: 0,
  }
  if (before <= limit) return base

  const units = groupAtomicUnits(messages)
  const isFixed = (unit: UnknownRecord[]): boolean => unit.some(item => text(item.role) === "system")
  const lastUserIndex = units.map(unit => unit.some(item => text(item.role) === "user")).lastIndexOf(true)

  // 阶段一：逐级压缩工具出入参，直到放得下或压无可压。
  let working = units.map(unit => [...unit])
  let toolPayloadsCompressed = 0
  for (const perMessageLimit of [800, 400, 200, 96]) {
    if (working.reduce((sum, unit) => sum + unitTokens(unit), 0) <= limit) break
    working = working.map((unit, index) => {
      if (isFixed(unit) || index === lastUserIndex) return unit
      const compressed = compressToolPayloads(unit, perMessageLimit)
      if (unitTokens(compressed) < unitTokens(unit)) toolPayloadsCompressed += 1
      return compressed
    })
  }

  // 阶段二：仍然超出时从最旧开始整组丢弃，保持调用与结果配对完整。
  let unitsDropped = 0
  let messagesDropped = 0
  let index = 0
  while (working.reduce((sum, unit) => sum + unitTokens(unit), 0) > limit && index < working.length) {
    if (isFixed(working[index]) || index === lastUserIndex) { index += 1; continue }
    messagesDropped += working[index].length
    unitsDropped += 1
    working[index] = []
    index += 1
  }

  const result = working.flat()
  return {
    messages: result,
    compressed: true,
    limit,
    before,
    after: result.reduce((sum, item) => sum + messageTokens(item), 0),
    toolPayloadsCompressed,
    unitsDropped,
    messagesDropped,
  }
}

export function enforcePromptBudget(messages: readonly UnknownRecord[] = [], config: unknown = {}, options: PromptBudgetOptions = {}): UnknownRecord[] {
  return enforcePromptBudgetDetailed(messages, config, options).messages
}

export function promptBudgetReport(messages: readonly UnknownRecord[] = [], tools: readonly UnknownRecord[] = []): { messages: number; tools: number } {
  return {
    messages: messages.reduce((sum, item) => sum + messageTokens(item), 0),
    tools: tools.reduce((sum, item) => sum + estimateTokens({ name: item.name, description: item.description, parameters: item.parameters }), 0),
  }
}
