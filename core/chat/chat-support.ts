import type { UnknownRecord } from "../message/types.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"

export interface ModelRouteEntry {
  id: string
  name: string
  model: string
  provider: string
  adapter: string
  stream: boolean
}

export interface ModelRouteMetadataOptions {
  taskName?: unknown
  strategy?: unknown
  availableChannels?: unknown[]
  channel?: unknown
  attempt?: unknown
  round?: unknown
  phase?: unknown
}

export type UsageTotals = Record<string, number>

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 在最后一条用户消息前置运行时指令，同时保留原有视觉/多模态内容块。 */
function prependRuntimeInstruction(messages: UnknownRecord[], instruction: string): UnknownRecord[] {
  const lastUserIndex = [...messages].map(item => item.role).lastIndexOf("user")
  if (lastUserIndex < 0) return [...messages, { role: "user", content: instruction }]
  return messages.map((item, index) => {
    if (index !== lastUserIndex) return item
    if (Array.isArray(item.content)) {
      return { ...item, content: [{ type: "text", text: instruction }, ...item.content] }
    }
    const content = text(item.content)
    return { ...item, content: content ? `${instruction}\n\n${content}` : instruction }
  })
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function stepId(step: unknown = {}, index = 0): string {
  const value = record(step)
  return text(value.id || value.task || `step_${index + 1}`)
}

export function errorPayload(error: unknown): UnknownRecord {
  const value = record(error)
  return {
    name: text(value.name || "Error"),
    message: text(value.message || error || "unknown error"),
  }
}

export function channelAttemptError(channel: unknown = {}, error: unknown): UnknownRecord {
  const value = record(channel)
  const provider = record(value.provider)
  const modelConfig = record(value.modelConfig)
  return {
    channel: text(value.id || value.name),
    adapter: text(value.type),
    provider: text(provider.name || modelConfig.apiProvider),
    error: errorPayload(error),
  }
}

export function modelRouteEntry(channel: unknown = {}): ModelRouteEntry {
  const value = record(channel)
  const provider = record(value.provider)
  const modelConfig = record(value.modelConfig)
  return {
    id: text(value.id || value.name),
    name: text(value.name || value.id),
    model: text(value.model || modelConfig.modelIdentifier),
    provider: text(provider.name || provider.id || modelConfig.apiProvider || value.apiProvider),
    adapter: text(value.type || modelConfig.adapter),
    stream: Boolean(value.stream),
  }
}

export function modelRouteMetadata(options: ModelRouteMetadataOptions = {}): UnknownRecord {
  const candidates = options.availableChannels?.length ? options.availableChannels : [options.channel || {}]
  return {
    task: text(options.taskName),
    strategy: text(options.strategy),
    attempt: Math.max(1, number(options.attempt, 1)),
    round: Math.max(0, number(options.round)),
    phase: text(options.phase || "initial"),
    availableModels: candidates.map(modelRouteEntry),
    actualModel: modelRouteEntry(options.channel),
  }
}

export function isPermissionToolError(error: unknown): boolean {
  const message = text(record(error).message || error)
  return /权限|主人|群管理员|群聊|权限组|未启用|全局关闭|策略未允许/.test(message)
}

export function formatPermissionToolResult(toolName: unknown, error: unknown): string {
  const reason = text(record(error).message || error || "当前上下文没有权限执行该工具。")
  return [
    `权限不足：工具 ${text(toolName)} 未执行。`,
    `原因：${reason}`,
    "下一步：请让具备权限的主人/群管理员在当前会话中重新发起，或到 Web 工具权限里调整该工具的可见范围。",
  ].join("\n")
}

export function buildToolLimitFinalizationMessages(messages: UnknownRecord[] = [], reason = ""): UnknownRecord[] {
  const detail = reason ? `原因：${reason}。` : ""
  const instruction = `【工具收束】工具运行时要求结束工具阶段。${detail}不要再调用任何工具，必须只根据已经返回的工具结果给出最终可发送给用户的简洁答复；即使工具已经直接投递，也请用一句话说明处理结果，不要回复 <EMPTY>。`
  return prependRuntimeInstruction(messages, instruction)
}

/** 自动媒体投递完成后，让既有人格只基于真实回执自然续答一次。 */
export function buildAutomaticDeliveryContinuationMessages(messages: UnknownRecord[] = []): UnknownRecord[] {
  const instruction = [
    "【媒体投递后续答】本轮自动媒体投递已经结束，请以最近的工具结果和发送回执为准。",
    "不要再调用任何工具。继续遵循当前系统人格和对话语气，像自然聊天一样简短回应用户，不要机械汇报工具名、内部流程、链接或逐项数量，也不要重复发送媒体。",
    "可以结合用户原始意图和已选内容自然评价或承接话题；如果回执显示部分或全部失败，必须如实说明，不能声称全部发送成功。不要回复 <EMPTY>。",
  ].join("\n")
  return prependRuntimeInstruction(messages, instruction)
}

/** 工具结果返回模型后，允许继续调用工具；若结束则要求直接给出唯一最终回复。 */
export function buildAgentLoopContinuationMessages(messages: UnknownRecord[] = []): UnknownRecord[] {
  const instruction = [
    "【工具循环继续】未完成则继续调用必要工具；已完成则输出唯一的自然回复。",
    "不要重复投递、汇报内部流程或返回 <EMPTY>。",
  ].join("\n")
  return prependRuntimeInstruction(messages, instruction)
}

/** 搜索类工具完成后，统一要求模型通过 message_send 组装并投递结果。 */
export function buildSearchDeliveryMessages(messages: UnknownRecord[] = []): UnknownRecord[] {
  const instruction = [
    "【搜索结果统一发送】本轮已经获得搜索或检索工具的返回结果。",
    "你必须调用 message_send 把结果发送到当前会话，不得直接输出普通模型文本，也不得声称已经发送但不调用工具。",
    "请自行理解最近的原始工具结果：纯文字或 JSON 结论放进 text 片段；图片、音频、视频或文件地址放进对应媒体片段的 source，地址必须逐字复制自工具结果；多个结果按用户需求选择、组合并保持说明与资源的对应关系。",
    "如果最近结果来自 web_search，只把整理后的回答放进 text；运行时会自动在 parts 末尾追加包含全部搜索来源的 forward 合并转发，正文不要重复罗列来源链接。",
    "如果没有找到结果、没有可发送媒体或工具返回错误，也要调用 message_send，用 text 片段如实说明；不要编造资源，不要输出 CQ 码。",
    "如果 bilibili_media 返回 coverSource 和 source，必须把完整 coverSource 作为前置 image.source、完整 source 作为 video.source 原样复制；它们已经是本地 cache 资源，不要改写字段，也不要发送 B 站页面 URL。运行时会把封面留在图文消息中，并将视频本体自动拆成独立消息。",
  ].join("\n")
  return [...messages, { role: "user", content: instruction }]
}

export function buildMediaDeliveryCorrectionMessages(messages: UnknownRecord[] = [], responseText = "", mediaCodes: UnknownRecord[] = []): UnknownRecord[] {
  const types = [...new Set(mediaCodes.map(item => text(item.type)).filter(Boolean))].join("、") || "媒体"
  const instruction = [
    "【媒体发送纠正】上一轮模型输出包含媒体 CQ 码，但媒体 CQ 码不能作为普通文字发送。",
    `检测到类型：${types}。检索/MCP 返回的 URL 只是候选结果，不代表已经投递。`,
    "如果用户确实要求发送媒体，请从最近的工具结果里选出合适的资源，调用 message_send：把资源按顺序放进 parts，形如 {type:'image'|'audio'|'video'|'file',source:{kind:'url',value:<工具给出的地址>}}。地址必须原样复制，不能编造或猜测工具结果之外的资源，也不要输出 CQ 码。工具结果里没有任何媒体时不要调用媒体发送工具。",
    "完成工具调用后再给一句简洁的实际结果说明；如果没有可用媒体，不要伪造已发送，也不要再次输出任何媒体 CQ 码。",
    `上一轮原始输出：\n${text(responseText).slice(0, 6000)}`,
  ].join("\n")
  return [...messages, { role: "user", content: instruction }]
}

/** 媒体候选已经返回但模型没有继续调用 message_send 时，最多触发一次的纠正提示。 */
export function buildMediaSelectionCorrectionMessages(messages: UnknownRecord[] = [], responseText = ""): UnknownRecord[] {
  const instruction = [
    "【媒体选择纠正】用户要求把搜索或工具找到的媒体发给用户，但上一轮只完成了观察，没有完成实际投递。",
    "请从最近的工具结果里选出真正合适的资源，调用 message_send 把它放进 parts：形如 {type:'image'|'audio'|'video'|'file',source:{kind:'url',value:<工具给出的地址>}}；需要说明文字或艾特时追加 text、mention 片段。地址必须原样复制，不能编造或猜测。",
    "MCP 返回的地址或结构化结果只是观察结果，不能直接当作普通文本发送，也不能自行输出 CQ 码。若工具结果里没有可用媒体，请不要调用 message_send，并在最终回复中说明没有可发送的媒体。",
    `上一轮模型文本：\n${text(responseText).slice(0, 4000)}`,
  ].join("\n")
  return [...messages, { role: "user", content: instruction }]
}

export function hasSuccessfulMediaDelivery(toolChain: UnknownRecord[] = []): boolean {
  return toolChain.some(item => {
    if (item.delivery !== "media" || !["ok", "accepted"].includes(text(item.status))) return false
    const receiptStatus = text(item.receiptStatus || record(item.metadata).receiptStatus)
    return !receiptStatus || ["sent", "partial"].includes(receiptStatus)
  })
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 }
}

export function addUsage(total: UsageTotals, usage: unknown = {}): UsageTotals {
  const value = record(usage)
  for (const key of Object.keys(total)) total[key] += number(value[key])
  return total
}

export function mediaThumbnailsForResult(attachments: unknown[] = []): UnknownRecord[] {
  return attachments
    .map(item => record(item))
    .filter(item => item.kind === "image")
    .map((item): UnknownRecord | null => {
      const dataUrl = text(item.thumbnailDataUrl || item.preparedUrl || item.url)
      if (!/^data:image\//i.test(dataUrl)) return null
      return {
        dataUrl,
        source: item.source || "image",
        mimeType: item.mimeType || dataUrl.match(/^data:([^;,]+)/i)?.[1] || "",
        size: item.size || 0,
        label: item.source ? text(item.source) : "图片",
      } as UnknownRecord
    })
    .filter((item): item is UnknownRecord => item !== null)
    .slice(0, 3)
}

export function summarizeMediaForResult(media: unknown = null): UnknownRecord | null {
  if (!media) return null
  const value = record(media)
  const attachments = Array.isArray(value.attachments) ? value.attachments.map(item => record(item)) : []
  const base = record(value.base)
  const mentions = Array.isArray(base.mentions) ? base.mentions.map(item => record(item)) : []
  const quote = record(value.quote)
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics.map(item => record(item)) : []
  return {
    images: attachments.filter(item => item.kind === "image").length,
    records: attachments.filter(item => item.kind === "record" || item.kind === "audio").length,
    videos: attachments.filter(item => item.kind === "video").length,
    mentions: mentions.map(item => item.qq || item.userId).filter(Boolean).slice(0, 8),
    thumbnails: mediaThumbnailsForResult(attachments),
    quote: value.quote ? {
      text: quote.text,
      sender: quote.sender,
      messageId: quote.messageId,
    } : null,
    diagnostics: diagnostics.map(item => item.message || item.reason || text(item)).filter(Boolean).slice(0, 6),
  }
}

export function priorStepMessage(item: unknown): UnknownRecord | null {
  const value = record(item)
  if (value.status === "error") {
    const error = record(value.error)
    return {
      role: "assistant",
      content: `[${text(value.stepId)}/${text(value.channel || "unknown")} error] 上一步失败：${text(error.message || "unknown error")}`,
    }
  }
  if (!value.text) return null
  return { role: "assistant", content: `[${text(value.stepId)}/${text(value.channel)}] ${text(value.text)}` }
}

export function scopeFor(event: unknown, userId?: unknown): string {
  const value = record(event)
  const resolvedUserId = userId === undefined ? value.user_id : userId
  return isGroupEvent(value) ? `g:${groupIdFromEvent(value)}:${text(resolvedUserId)}` : `p:${text(resolvedUserId)}`
}
