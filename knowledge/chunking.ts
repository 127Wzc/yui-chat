import crypto from "node:crypto"

type UnknownRecord = Record<string, unknown>

interface ChunkOptions extends UnknownRecord {
  targetChars?: unknown
  overlapChars?: unknown
  minChars?: unknown
}

interface KnowledgeChunk {
  content: string
  contentHash: string
}

function clean(value: unknown = ""): string {
  return String(value || "").replace(/\r\n/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

export function contentHash(value: unknown = ""): string {
  return crypto.createHash("sha256").update(clean(value)).digest("hex")
}

export function chunkText(value: unknown = "", options: ChunkOptions = {}): KnowledgeChunk[] {
  const target = Math.max(80, Math.min(1600, Number(options.targetChars) || 800))
  const overlap = Math.max(0, Math.min(Math.floor(target / 2), Number(options.overlapChars) || 120))
  const minimum = Math.max(1, Math.min(target, Number(options.minChars) || 80))
  const text = clean(value)
  if (!text) return []
  const chunks: KnowledgeChunk[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + target)
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf("。", end), text.lastIndexOf("！", end), text.lastIndexOf("？", end), text.lastIndexOf(".", end))
      if (boundary > cursor + minimum) end = boundary + 1
    }
    const content = text.slice(cursor, end).trim()
    if (content.length >= minimum || !chunks.length) chunks.push({ content, contentHash: contentHash(content) })
    if (end >= text.length) break
    cursor = Math.max(cursor + 1, end - overlap)
  }
  return chunks
}
