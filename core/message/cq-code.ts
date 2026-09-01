import { hostRuntime } from "../runtime/host-runtime.js"

type UnknownRecord = Record<string, unknown>
type SegmentValue = string | UnknownRecord
interface SegmentAdapter {
  at?: (userId: string) => unknown
}
interface CqCodeOptions {
  segment?: SegmentAdapter
  removeUnsupported?: boolean
}

const CQ_CODE = /\[\s*CQ\s*[:,，]\s*([^,，\]\s]+)\s*[,，]([^\]]*)\]/gi
const MEDIA_CQ_TYPES = new Set(["image", "record", "audio", "video", "music"])

function decodeCQValue(value: unknown = ""): string {
  return String(value).replace(/&amp;/gi, "&").replace(/&#91;/gi, "[").replace(/&#93;/gi, "]").replace(/&#44;/gi, ",").replace(/&#58;/gi, ":")
}

function parseCQParams(source: unknown = ""): UnknownRecord {
  const params: UnknownRecord = {}
  for (const item of String(source).split(/[,，]/)) {
    const index = item.indexOf("=")
    if (index < 1) continue
    const key = item.slice(0, index).trim().toLowerCase()
    if (key) params[key] = decodeCQValue(item.slice(index + 1).trim())
  }
  return params
}

function isAtCode(type: unknown, params: UnknownRecord): boolean {
  return String(type).trim().toLowerCase() === "at" && /^\d+$/.test(String(params.id || params.qq || ""))
}

/** 判断文本中是否存在可以安全转换为原生消息片段的 @ CQ 码。 */
export function hasCQAtCode(text: unknown = ""): boolean {
  for (const match of String(text).matchAll(CQ_CODE)) if (isAtCode(match[1], parseCQParams(match[2]))) return true
  return false
}

/** 找出模型误以 CQ 码形式输出的媒体，供运行日志和纠错提示使用。 */
export function findUnsupportedMediaCQCodes(text: unknown = ""): Array<{ type: string; raw: string; params: UnknownRecord }> {
  return [...String(text).matchAll(CQ_CODE)]
    .filter(match => MEDIA_CQ_TYPES.has(String(match[1] || "").trim().toLowerCase()))
    .map(match => ({ type: String(match[1] || "").trim().toLowerCase(), raw: match[0], params: parseCQParams(match[2]) }))
}

/**
 * 将内部消息链的 mention 片段落到宿主原生消息段。
 *
 * 少数宿主的 `segment.at()` 会直接返回 CQ 文本；这种返回值不能再次作为
 * 普通字符串交给 `reply()`，否则用户会看到 `[CQ:at,...]`。统一退回 OneBot
 * 兼容的对象形态，让宿主适配器继续负责最终协议编码。
 */
export function createNativeAtSegment(userId: string, adapter?: SegmentAdapter): UnknownRecord {
  const segment = adapter || (hostRuntime as typeof hostRuntime & { segment?: SegmentAdapter }).segment
  if (typeof segment?.at === "function") {
    const generated = segment.at(userId)
    if (generated && typeof generated === "object" && !Array.isArray(generated)) return generated as UnknownRecord
  }
  return { type: "at", qq: userId }
}

/** 只转换受支持的 @ CQ 码；未知 CQ 默认移除，防止模型伪造宿主适配器片段。 */
export function convertCQCodes(text: unknown = "", options: CqCodeOptions = {}): string | SegmentValue[] {
  const source = String(text || "")
  const runtimeSegment = (hostRuntime as typeof hostRuntime & { segment?: SegmentAdapter }).segment
  const segment = options.segment || runtimeSegment
  const removeUnsupported = options.removeUnsupported !== false
  const parts: SegmentValue[] = []
  let lastIndex = 0
  let needsSpaceAfterAt = false

  const appendText = (value: unknown): void => {
    if (!value) return
    let output = String(value)
    if (needsSpaceAfterAt && !/^\s/.test(output)) output = ` ${output}`
    needsSpaceAfterAt = false
    const last = parts.at(-1)
    if (typeof last === "string") parts[parts.length - 1] = last + output
    else parts.push(output)
  }

  for (const match of source.matchAll(CQ_CODE)) {
    appendText(source.slice(lastIndex, match.index ?? lastIndex))
    const params = parseCQParams(match[2])
    if (isAtCode(match[1], params)) {
      const userId = String(params.id || params.qq)
      parts.push(createNativeAtSegment(userId, segment))
      needsSpaceAfterAt = true
    } else if (!removeUnsupported) appendText(match[0])
    lastIndex = (match.index ?? lastIndex) + match[0].length
  }
  appendText(source.slice(lastIndex))
  const compact = parts.filter(item => typeof item !== "string" || item)
  return compact.some(item => typeof item !== "string") ? compact : compact.join("")
}

/** 移除不支持的 CQ 码，同时保留最终阶段可转换的 @ 码。 */
export function stripUnsupportedCQCodes(text: unknown = ""): string {
  return String(text).replace(CQ_CODE, (code, type, rawParams) => isAtCode(type, parseCQParams(rawParams)) ? code : "")
}
