type MediaRecord = Record<string, unknown>

const snapshotTruncationMarker = "…（日志已截断）"

function record(value: unknown): MediaRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as MediaRecord : {}
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function decodedBase64Bytes(value: string): number {
  const payload = value.replace(/\s+/g, "")
  if (!payload) return 0
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding)
}

/** 只改变日志页面上的显示文本；原始快照和真正发给模型的请求保持不变。 */
export function compactMediaDataForDisplay(value: unknown): unknown {
  if (typeof value === "string") {
    const match = value.match(/^data:([^;,]+)(?:;[^,]*)*;base64,([\s\S]*)$/i)
    if (!match) return value
    const truncated = match[2].includes(snapshotTruncationMarker)
    const payload = match[2].replace(snapshotTruncationMarker, "").replace(/\s+/g, "")
    const head = payload.slice(0, 12)
    const tail = truncated ? "" : payload.slice(-8)
    const fingerprint = !payload ? "空内容" : payload.length <= 24 ? payload : `${head}…${tail}`
    const size = truncated ? `已记录 ${formatBytes(payload.length)} Base64` : formatBytes(decodedBase64Bytes(payload))
    return `[Base64 ${match[1]} · ${size}${truncated ? " · 快照已截断" : ""} · ${fingerprint}]`
  }
  if (Array.isArray(value)) return value.map(item => compactMediaDataForDisplay(item))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as MediaRecord).map(([key, item]) => [key, compactMediaDataForDisplay(item)]))
}

function imageCountInContent(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + imageCountInContent(item), 0)
  const part = record(value)
  const type = String(part.type || "")
  if (type === "image_url" || type === "input_image") {
    const image = record(part.image_url)
    const imageUrl = typeof part.image_url === "string" ? part.image_url : image.url
    return String(imageUrl || "").trim() ? 1 : 0
  }
  if (type === "image") {
    const source = record(part.source)
    return String(source.value || source.data || source.inlineData || "").trim() ? 1 : 0
  }
  return part.content === undefined ? 0 : imageCountInContent(part.content)
}

export function modelMessageImageCount(message: unknown): number {
  return imageCountInContent(record(message).content)
}

export function modelMessagesImageCount(messages: unknown): number {
  return Array.isArray(messages) ? messages.reduce((total, message) => total + modelMessageImageCount(message), 0) : 0
}
