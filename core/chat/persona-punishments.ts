import path from "node:path"
import { randomUUID } from "node:crypto"
import { dataDir } from "../../config/store.js"
import { AtomicJsonRepository } from "../storage/atomic-json-repository.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import type { UnknownRecord } from "../message/types.js"

export interface PersonaPunishment {
  id: string
  userId: string
  groupId: string
  botId: string
  kind: "ignore" | "mute"
  reason: string
  startedAt: number
  until: number
  status: "active" | "uncertain" | "released"
}
const repository = new AtomicJsonRepository<PersonaPunishment[]>({
  file: path.join(dataDir, "persona-punishments.json"), defaultValue: [],
  validate(rows) {
    if (!Array.isArray(rows) || rows.some(row => !row.id || !/^[1-9]\d*$/.test(row.userId) || !["ignore", "mute"].includes(row.kind) || !["active", "uncertain", "released"].includes(row.status) || !Number.isFinite(row.until))) throw new Error("人物处罚记录格式无效")
  },
  onReadError: () => hostRuntime.logger?.error?.("[yui-chat] 人物处罚记录读取失败，已隔离损坏数据"),
})
let snapshot: PersonaPunishment[] = []
export async function loadPersonaPunishments(): Promise<void> { snapshot = await repository.load() }
export function punishmentScope(event: UnknownRecord): { userId: string; groupId: string; botId: string } {
  const sender = event.sender as UnknownRecord | undefined
  const bot = event.bot as UnknownRecord | undefined
  return { userId: String(event.user_id || sender?.user_id || ""), groupId: isGroupEvent(event) ? groupIdFromEvent(event) : "", botId: String(event.self_id || bot?.uin || "") }
}
export function personaIgnored(event: UnknownRecord): boolean {
  const scope = punishmentScope(event)
  return snapshot.some(row => row.kind === "ignore" && row.status === "active" && row.until > Date.now() && row.userId === scope.userId && row.groupId === scope.groupId && row.botId === scope.botId)
}
export async function listPersonaPunishments(): Promise<PersonaPunishment[]> {
  await loadPersonaPunishments()
  return snapshot.filter(row => row.status !== "released" && row.until > Date.now()).map(row => ({ ...row }))
}
/** 先持久化保守预留，再执行宿主副作用；并发请求不能叠加或延长处罚。 */
export async function reservePersonaPunishment(event: UnknownRecord, kind: "ignore" | "mute", seconds: number, reason: string): Promise<PersonaPunishment> {
  const now = Date.now()
  const scope = punishmentScope(event)
  const row: PersonaPunishment = { ...scope, id: randomUUID(), kind, reason, startedAt: now, until: now + seconds * 1000, status: kind === "ignore" ? "active" : "uncertain" }
  snapshot = await repository.update(rows => {
    const retained = rows.filter(item => item.status !== "released" && item.until > now)
    if (retained.some(item => item.userId === row.userId && item.groupId === row.groupId && item.botId === row.botId)) throw new Error("该用户仍处于处罚期，不允许叠加、延长或切换处罚。")
    if (retained.length >= 10000) throw new Error("人物处罚记录已达上限，请等待处罚结束。")
    return [...retained, row]
  })
  return row
}
export async function setPersonaPunishmentStatus(id: string, status: PersonaPunishment["status"]): Promise<void> {
  snapshot = await repository.update(rows => { const row = rows.find(item => item.id === id); if (!row) throw new Error("处罚记录不存在"); row.status = status })
}
