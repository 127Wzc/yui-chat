const DAY = 86400000

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function memoryHalfLifeDays(item: UnknownRecord = {}): number {
  if (item.type === "profile" || item.pinned || String(item.fact_key || item.factKey || "").startsWith("identity.") || /身份|称呼|禁止/.test(String(item.tags || ""))) return Infinity
  if (item.scope_type === "user_group") return 90
  if (/^preference\./.test(String(item.fact_key || item.factKey || "")) || /偏好|习惯|preference|habit/i.test(String(item.tags || ""))) return 180
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
  return "cold"
}

/** 有效性不由热度决定；兼容旧来源标记，不推测恢复明确归档的记录。 */
export function validityFor(item: UnknownRecord = {}, now = Date.now()): string {
  const status = String(item.status || "")
  if (status === "deleted") return "deleted"
  if (status === "archived") {
    const reason = String(item.validity_reason || "")
    if (["superseded", "retracted", "pending", "duplicate"].includes(reason)) return reason
    if (item.source === "superseded") return "superseded"
    if (item.source === "duplicate-merged") return "duplicate"
    return "archived"
  }
  return Number(item.expires_at || 0) > 0 && Number(item.expires_at) <= now ? (item.validity_reason === "reference-window" ? "stale" : "expired") : "valid"
}

/** 与召回共用衰减规则；返回预测时间，不写回状态或改变置信度。 */
export function lifecycleFor(item: UnknownRecord = {}, now = Date.now()): UnknownRecord {
  const status = statusFor(item, now)
  const halfLife = memoryHalfLifeDays(item)
  const confirmed = Number(item.last_confirmed_at || item.updated_at || item.created_at || now)
  const expiresAt = Number(item.expires_at || 0)
  const threshold = ({ active: 0.7, warm: 0.35 } as Record<string, number>)[status]
  let nextTransitionAt = threshold && Number.isFinite(halfLife)
    ? Math.floor(confirmed - Math.log2(threshold) * halfLife * DAY) + 1 : 0
  let nextStatus = nextTransitionAt ? ({ active: "warm", warm: "cold" } as Record<string, string>)[status] : ""
  if (["active", "warm", "cold"].includes(status) && expiresAt > now && (!nextTransitionAt || expiresAt <= nextTransitionAt)) {
    nextTransitionAt = expiresAt
    nextStatus = "expired"
  }
  return {
    status, validity: validityFor(item, now), reason: String(item.validity_reason || ""),
    supersededBy: String(item.superseded_by || ""),
    previouslyHiddenByAge: !["archived", "deleted", "expired"].includes(status) && decayValue(item, now) < 0.15,
    decay: decayValue(item, now), halfLifeDays: Number.isFinite(halfLife) ? halfLife : null,
    lastConfirmedAt: confirmed, expiresAt, nextTransitionAt, nextStatus,
  }
}

export function expiryFor(type: unknown, config: UnknownRecord = {}, now = Date.now()): number | null {
  const retention = record(record(config).memory).retention
  const retentionConfig = record(retention)
  if (type === "short") return now + Math.max(1, Number(retentionConfig.shortTermHours) || 72) * 3600000
  if (type === "episode") return now + Math.max(1, Number(retentionConfig.episodeDays) || 90) * DAY
  return null
}
