type UnknownRecord = Record<string, unknown>

interface KnowledgeDocumentInput extends UnknownRecord {
  name?: unknown
  content?: unknown
  kind?: unknown
  metadata?: unknown
}

interface NormalizedKnowledgeDocument {
  name: string
  content: string
  metadata: UnknownRecord
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function normalizeKnowledgeDocuments({ name = "直接文本", content = "", kind = "text", metadata = {} }: KnowledgeDocumentInput = {}): NormalizedKnowledgeDocument[] {
  if (kind !== "json") return [{ name: String(name), content: String(content || ""), metadata: record(metadata) }]
  let parsed: unknown
  try { parsed = typeof content === "string" ? JSON.parse(content) : content } catch { throw new Error("JSON 知识来源必须是有效 JSON 文档数组") }
  if (!Array.isArray(parsed)) throw new Error("JSON 知识来源必须是文档数组")
  return parsed.map((item, index) => {
    const value = record(item)
    return {
    name: String(value.title || value.name || `${name} ${index + 1}`).slice(0, 500),
    content: String(value.content || value.text || ""),
    metadata: { ...record(metadata), ...record(value.metadata) },
    }
  }).filter(item => item.content.trim())
}
