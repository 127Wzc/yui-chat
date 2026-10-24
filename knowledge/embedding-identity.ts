import crypto from "node:crypto"
import { configStore } from "../config/store.js"
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
/** 仅发布摘要；上游地址、协议、模型标识及配置变更均隔离缓存与向量复用。 */
export function embeddingIdentity(modelName: unknown): string {
  const config = configStore.get() as Record<string, any>
  const model = (config.models || []).find((item: Record<string, unknown>) => item.name === modelName)
  const provider = (config.apiProviders || []).find((item: Record<string, unknown>) => item.name === model?.apiProvider)
  return crypto.createHash("sha256").update(JSON.stringify(canonical(["embedding-v2", modelName, model || null, provider || null]))).digest("hex").slice(0, 24)
}
