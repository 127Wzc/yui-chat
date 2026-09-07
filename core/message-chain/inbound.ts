import type { ContentPart, MessageChain, ResourceRef } from "./types.js"
import { isJsonValue } from "./types.js"

type UnknownRecord = Record<string, unknown>
const CQ_ATTRIBUTE_SEPARATOR = /,(?=(?:file|url|path|src|type|cache|proxy|timeout|id|qq|user_id|text|seq|name|file_name|fileName|file_size|duration|target|role|audio|video|image)=)/i

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function segmentData(value: unknown): UnknownRecord {
  const source = record(value)
  return record(source.data).type || Object.keys(record(source.data)).length ? record(source.data) : source
}

function decodeCq(value: string): string {
  const decoded = value.replace(/&amp;/g, "&").replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&#44;/g, ",")
  try { return decodeURIComponent(decoded) } catch { return decoded }
}

function resourceKind(value: string): ResourceRef["kind"] {
  if (/^https?:\/\//i.test(value)) return "url"
  if (/^(?:data:|base64:\/\/)/i.test(value)) return "base64"
  if (/^file:/i.test(value) || value.startsWith("/") || /^[a-z]:[\\/]/i.test(value)) return "file"
  return "platform"
}

function resource(value: unknown, mimeType?: unknown, sourceUri?: unknown): ResourceRef {
  const uri = text(value).trim()
  return {
    kind: resourceKind(uri),
    value: uri,
    ...(text(mimeType).trim() ? { mimeType: text(mimeType).trim().toLowerCase() } : {}),
    ...(text(sourceUri).trim() ? { sourceUri: text(sourceUri).trim() } : {}),
  }
}

function urlFrom(data: UnknownRecord): string {
  return text(data.url || data.file || data.path || data.src || data.image || data.audio || data.video).trim()
}

function extensionPart(namespace: string, name: string, value: UnknownRecord): ContentPart {
  const json = isJsonValue(value) ? value : {}
  return { type: "extension", namespace, name, data: json }
}

function addRawPart(parts: ContentPart[], type: string, data: UnknownRecord): void {
  switch (type) {
    case "text":
      if (text(data.text)) parts.push({ type: "text", text: text(data.text) })
      return
    case "image": {
      const value = urlFrom(data)
      if (value) parts.push({ type: "image", source: resource(value, data.mimeType), mimeType: text(data.mimeType) || undefined })
      return
    }
    case "record":
    case "voice":
    case "audio": {
      const value = urlFrom(data)
      if (value) parts.push({ type: "audio", source: resource(value, data.mimeType), mimeType: text(data.mimeType) || undefined })
      return
    }
    case "video": {
      const value = urlFrom(data)
      if (value) parts.push({ type: "video", source: resource(value, data.mimeType), mimeType: text(data.mimeType) || undefined })
      return
    }
    case "file": {
      const value = urlFrom(data)
      if (value) parts.push({ type: "file", source: resource(value, data.mimeType), mimeType: text(data.mimeType) || undefined, name: text(data.name || data.fileName) || undefined })
      return
    }
    case "at":
      if (text(data.qq || data.user_id)) parts.push({ type: "mention", userId: text(data.qq || data.user_id) })
      return
    case "reply":
    case "source": {
      const id = text(data.id || data.message_id || data.seq)
      if (id) parts.push({ type: "reply", messageId: id, selectedText: text(data.text) || undefined })
      return
    }
    default:
      parts.push(extensionPart("host", type || "unknown", data))
  }
}

function addCqParts(parts: ContentPart[], raw: string): void {
  let cursor = 0
  const pattern = /\[CQ:([^,\]]+)([^\]]*)]/g
  for (const match of raw.matchAll(pattern)) {
    const start = match.index ?? 0
    const before = raw.slice(cursor, start)
    if (before) parts.push({ type: "text", text: before })
    const attrs: UnknownRecord = {}
    // OneBot 的值通常会把逗号编码为 `&#44;`，但部分宿主会直接保留
    // data URL 中的逗号。只在逗号后确实出现“属性名=”时切分，避免
    // `data:image/png;base64,...` 被误拆成半个资源地址。
    for (const pair of match[2].replace(/^,/, "").split(CQ_ATTRIBUTE_SEPARATOR)) {
      const index = pair.indexOf("=")
      if (index > 0) attrs[pair.slice(0, index)] = decodeCq(pair.slice(index + 1))
    }
    addRawPart(parts, match[1], attrs)
    cursor = start + match[0].length
  }
  const tail = raw.slice(cursor)
  if (tail) parts.push({ type: "text", text: tail })
}

/**
 * 将宿主事件转换为唯一的内部消息链。
 *
 * CQ 码和 OneBot segment 只在这里被识别；后续人格、模型、工具和投递层
 * 只接收 MessageChain，避免每个子系统各自维护一套媒体/艾特解析逻辑。
 */
export function extractMessageChain(event: unknown = {}, prompt: unknown = ""): MessageChain {
  const e = record(event)
  const parts: ContentPart[] = []
  const primary = text(prompt || e.msg || e.raw_message || "")
  if (primary) addCqParts(parts, primary)
  const segments = Array.isArray(e.message) ? e.message : []
  for (const segment of segments) {
    const source = record(segment)
    const data = segmentData(segment)
    // 显式 prompt 已经过指令剥离/输入过滤，宿主 text 段不能再补回原正文。
    if (primary && text(source.type || data.type) === "text") continue
    addRawPart(parts, text(source.type || data.type), data)
  }
  const raw = text(e.raw_message || "")
  if (raw && raw !== primary && /\[CQ:/i.test(raw)) {
    const rawParts: ContentPart[] = []
    addCqParts(rawParts, raw)
    // prompt/message 段通常已经提供正文，只补齐 raw_message 中没有映射到宿主段的 CQ 媒体、@ 和引用。
    parts.push(...rawParts.filter(part => part.type !== "text"))
  } else if (!parts.length && raw && raw !== primary) {
    addCqParts(parts, raw)
  }
  return parts
}

export function stripMessageCodes(value: unknown = ""): string {
  return extractMessageChain({}, value)
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}
