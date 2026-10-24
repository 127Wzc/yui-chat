import crypto from "node:crypto"

type UnknownRecord = Record<string, unknown>
interface ChunkOptions extends UnknownRecord { targetChars?: unknown; overlapChars?: unknown; minChars?: unknown; context?: unknown }
interface KnowledgeChunk { content: string; contentHash: string }
export const CHUNK_STRATEGY_VERSION = "semantic-blocks-v2"
function clean(value: unknown = ""): string {
  return String(value || "").replace(/\r\n?/g, "\n").trim()
}
export function contentHash(value: unknown = ""): string {
  return crypto.createHash("sha256").update(clean(value)).digest("hex")
}
export function chunkStrategyHash(options: UnknownRecord = {}): string {
  return contentHash(JSON.stringify([CHUNK_STRATEGY_VERSION, options.targetChars ?? 800, options.overlapChars ?? 120, options.minChars ?? 80, options.context ?? ""]))
}
/** 优先保留标题、段落、列表与围栏代码块；超长块才退到句子/字符边界。 */
export function chunkText(value: unknown = "", options: ChunkOptions = {}): KnowledgeChunk[] {
  const target = Math.max(80, Math.min(1600, Number(options.targetChars) || 800))
  const overlap = Math.max(0, Math.min(Math.floor(target / 2), Number(options.overlapChars ?? 120) || 0))
  const minimum = Math.max(1, Math.min(target, Number(options.minChars) || 80))
  const text = clean(value)
  if (!text) return []
  const context = clean(options.context).slice(0, Math.floor(target / 3))
  const capacity = Math.max(40, target - (context ? context.length + 1 : 0))
  const blocks: string[] = []
  let block: string[] = [], fence = ""
  for (const line of text.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1] || ""
    if (!fence && (marker || /^#{1,6}\s/u.test(line) || !line.trim())) {
      if (block.length) blocks.push(block.join("\n"))
      block = []
    }
    block.push(line)
    if (marker && !fence) fence = marker[0]
    else if (marker && marker[0] === fence) { fence = ""; blocks.push(block.join("\n")); block = [] }
  }
  if (block.length) blocks.push(block.join("\n"))
  const contents: string[] = []
  let pending = ""
  const flush = (): void => { if (pending.trim()) contents.push(pending.trim()); pending = "" }
  for (const raw of blocks) {
    const part = raw.trim()
    if (!part) continue
    if (part.length <= capacity) {
      if (pending && pending.length + part.length + 2 > capacity) flush()
      pending += `${pending ? "\n\n" : ""}${part}`
      continue
    }
    flush()
    let cursor = 0
    while (cursor < part.length) {
      let end = Math.min(part.length, cursor + capacity)
      if (end < part.length) {
        const prefix = part.slice(cursor, end)
        const boundary = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("。"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"), prefix.lastIndexOf(". "))
        if (boundary >= Math.min(minimum, capacity / 2)) end = cursor + boundary + 1
      }
      contents.push(part.slice(cursor, end).trim())
      if (end === part.length) break
      cursor = Math.max(cursor + 1, end - Math.min(overlap, Math.floor((end - cursor) / 2)))
    }
  }
  flush()
  // 短尾段允许保留；minimum 只参与边界选择，绝不能成为丢弃正文的条件。
  return contents.filter(Boolean).map(content => {
    const decorated = context ? `${context}\n${content}` : content
    return { content: decorated, contentHash: contentHash(decorated) }
  })
}
