type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

/** 根据模型声明解析 embedding 维度，拒绝超出模型能力范围的覆盖值。 */
export function resolveEmbeddingDimensions(model: UnknownRecord = {}, requested = 0): number {
  const embedding = record(model.embedding)
  const defaultDimensions = Number(embedding.defaultDimensions || 0)
  const dimensions = Number(requested || defaultDimensions)
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error("embedding 模型必须声明有效维度")
  const allowed = Array.isArray(embedding.allowedDimensions) ? embedding.allowedDimensions.map(Number).filter(Number.isFinite) : []
  if (requested && embedding.supportsDimensionOverride === false && requested !== defaultDimensions) throw new Error("当前 embedding 模型不支持维度覆盖")
  if (allowed.length && !allowed.includes(dimensions)) throw new Error(`embedding 维度 ${dimensions} 不在模型允许范围内`)
  return dimensions
}

/** 校验供应商返回的向量数量、长度和数值，保证后续索引不会写入脏数据。 */
export function validateVectors(vectors: unknown = [], dimensions = 0, expectedCount = 0): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) throw new Error("embedding 返回向量数量不匹配")
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => !Number.isFinite(Number(value)))) throw new Error("embedding 返回了无效向量或错误维度")
  }
  return vectors.map(vector => (vector as unknown[]).map(Number))
}
