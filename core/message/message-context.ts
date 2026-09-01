import type { MessageContext, OpenAiUserContent, UnknownRecord } from "./types.js"
import { extractMessageChain, stripMessageCodes } from "../message-chain/inbound.js"
export { stripMessageCodes } from "../message-chain/inbound.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function compactText(value: unknown = ""): string {
  return String(value).replace(/\s+/g, " ").trim()
}

function displayMediaUrl(value: unknown = ""): string {
  const url = String(value || "")
  if (/^data:/i.test(url)) return `${url.match(/^data:([^;,]+)/i)?.[1] || "data"} data-url`
  if (/^file:/i.test(url) || /^\/[^/]/.test(url) || /^[a-z]:[\\/]/i.test(url)) return "local-file-hidden"
  return url || "unknown"
}

function safeVisionImageUrl(value: unknown = ""): string {
  const url = String(value || "").trim()
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(url) || /^https?:/i.test(url)) return url
  return ""
}

/** 将宿主事件、CQ 码和原生消息段收敛为统一的文本、媒体、@ 与引用上下文。 */
export function extractMessageContext(event: unknown = {}, prompt: unknown = ""): MessageContext {
  const e = record(event)
  const chain = extractMessageChain(event, prompt)
  const out: MessageContext = {
    chain,
    text: chain.filter(part => part.type === "text").map(part => part.type === "text" ? part.text : "").join(" ").replace(/\s+/g, " ").trim(),
    images: [], records: [], videos: [], files: [], mentions: [], replies: [], rawTypes: [],
  }
  for (const part of chain) {
    if (part.type === "image" && part.source.value) {
      if (!out.images.some(item => item.url === part.source.value)) out.images.push({ type: "image", url: part.source.value, source: "chain" })
      out.rawTypes.push("image")
    } else if (part.type === "audio" && part.source.value) {
      if (!out.records.some(item => item.url === part.source.value)) out.records.push({ type: "record", url: part.source.value, source: "chain" })
      out.rawTypes.push("record")
    } else if (part.type === "video" && part.source.value) {
      if (!out.videos.some(item => item.url === part.source.value)) out.videos.push({ type: "video", url: part.source.value, source: "chain" })
      out.rawTypes.push("video")
    } else if (part.type === "file" && part.source.value) {
      if (!out.files.some(item => item.url === part.source.value)) out.files.push({ type: "file", url: part.source.value, source: "chain" })
      out.rawTypes.push("file")
    } else if (part.type === "mention") {
      if (!out.mentions.some(item => item.qq === part.userId)) out.mentions.push({ qq: part.userId, source: "chain" })
      out.rawTypes.push("at")
    } else if (part.type === "reply") {
      if (!out.replies.some(item => item.id === part.messageId)) out.replies.push({ id: part.messageId, source: "chain" })
      out.rawTypes.push("reply")
    } else if (part.type === "extension") {
      out.rawTypes.push(`${part.namespace}:${part.name}`)
    } else if (part.type !== "text") {
      out.rawTypes.push(part.type)
    }
  }
  out.text ||= stripMessageCodes(e.raw_message || e.msg || "")
  return out
}

export function summarizeMessageContext(context: Partial<MessageContext> = {}): string {
  const lines: string[] = []
  if (context.images?.length) lines.push(`图片 ${context.images.length} 张：${context.images.map(item => displayMediaUrl(item.url)).join("，")}`)
  if (context.records?.length) lines.push(`语音/录音 ${context.records.length} 条：${context.records.map(item => displayMediaUrl(item.url)).join("，")}`)
  if (context.videos?.length) lines.push(`视频 ${context.videos.length} 条：${context.videos.map(item => displayMediaUrl(item.url)).join("，")}`)
  if (context.files?.length) lines.push(`文件 ${context.files.length} 个：${context.files.map(item => displayMediaUrl(item.url)).join("，")}`)
  if (context.mentions?.length) lines.push(`提到了 QQ：${context.mentions.map(item => item.qq).join("，")}`)
  if (context.replies?.length) lines.push(`引用/回复消息 ID：${context.replies.map(item => item.id).join("，")}`)
  return lines.join("\n")
}

export function mentionsBot(event: unknown = {}, context: Partial<MessageContext> = {}): boolean {
  const e = record(event)
  const bot = record(e.bot)
  const selfId = String(e.self_id || bot.uin || "")
  if (!selfId) return false
  return Boolean(e.atBot || e.atme || context.mentions?.some(item => item.qq === selfId || item.qq === "all"))
}

export function buildOpenAiUserContent(text: unknown, context: Partial<MessageContext> = {}, allowVision = false): OpenAiUserContent {
  const summary = summarizeMessageContext(context)
  const body = [text, summary ? `\n消息附加内容：\n${summary}` : ""].filter(Boolean).join("\n")
  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{ type: "text", text: body || "空消息" }]
  if (allowVision) {
    for (const image of context.images || []) {
      const url = safeVisionImageUrl(image.url)
      if (url) content.push({ type: "image_url", image_url: { url } })
    }
  }
  const first = content[0]
  return content.length === 1 && first?.type === "text" ? first.text : content
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return compactText(JSON.stringify(content || ""))
  return content.map(part => {
    const source = record(part)
    if (source.type === "text") return String(source.text || "")
    if (source.type === "image_url") return `[图片：${displayMediaUrl(record(source.image_url).url)}]`
    return compactText(JSON.stringify(part))
  }).filter(Boolean).join("\n")
}
