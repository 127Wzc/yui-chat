const DAY = 86400000

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function memoryHalfLifeDays(item: UnknownRecord = {}): number {
  if (item.type === "profile" || item.pinned || String(item.fact_key || item.factKey || "").startsWith("identity.") || /身份|称呼|禁止/.test(String(item.tags || ""))) return Infinity
  if (item.scope_type === "user_group") return 90
  if (/偏好|习惯/.test(String(item.tags || ""))) return 180
  return 365
}

export function decayValue(item: UnknownRecord = {}, now = Date.now()): number {
  const halfLife = memoryHalfLifeDays(item)
  if (!Number.isFinite(halfLife)) return 1
  const confirmed = Number(item.last_confirmed_at || item.updated_at || item.created_at || now)
  return 2 ** (-Math.max(0, now - confirmed) / (halfLife * DAY))
}

export function statusFor(item: UnknownRecord = {}, now = Date.now()): string {
  const status = String(item.status || "")
  if (["deleted", "archived"].includes(status)) return status
  if (Number(item.expires_at || 0) > 0 && Number(item.expires_at) <= now) return "expired"
  const value = decayValue(item, now)
  if (value >= 0.7) return "active"
  if (value >= 0.35) return "warm"
  if (value >= 0.15) return "cold"
  return "archived"
}

export function expiryFor(type: unknown, config: UnknownRecord = {}, now = Date.now()): number | null {
  const retention = record(record(config).memory).retention
  const retentionConfig = record(retention)
  if (type === "short") return now + Math.max(1, Number(retentionConfig.shortTermHours) || 72) * 3600000
  if (type === "episode") return now + Math.max(1, Number(retentionConfig.episodeDays) || 90) * DAY
  return null
}
