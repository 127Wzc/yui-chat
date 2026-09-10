/** 将外部名称收敛为可用于配置键、目录名和日志标识的稳定 ASCII 标识。 */
export function sanitizeIdentifier(value: unknown = "", maxLength = 80, fallback = ""): string {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength) || fallback
}

/** 短、稳定的 ASCII 哈希，用于显示标识去重而不是安全用途。 */
export function shortHash(value: unknown): string {
  let hash = 5381
  for (const char of String(value)) hash = ((hash * 33) ^ (char.codePointAt(0) || 0)) >>> 0
  return hash.toString(36).slice(0, 6)
}

/** 按扩展自身特征推导目录 ID，并在已占用集合中生成可复现的递增后缀。 */
export function deriveExtensionId(seeds: readonly unknown[] = [], fallback = "extension", used: readonly unknown[] = []): string {
  const taken = new Set(used.map(String))
  const stem = seeds
    .map(seed => sanitizeIdentifier(String(seed || "").trim().replace(/[\s_]+/g, "-"), 48).toLowerCase().replace(/-{2,}/g, "-"))
    .find(Boolean) || `${fallback}-${shortHash(seeds.join("|") || fallback)}`
  if (!taken.has(stem)) return stem
  for (let index = 2; ; index += 1) {
    const id = `${stem}-${index}`
    if (!taken.has(id)) return id
  }
}
