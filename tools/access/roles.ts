import { isGroupEvent } from "../../core/message/event-scope.js"

type UnknownRecord = Record<string, unknown>

/** 工具边界支持的角色层级；顺序同时表示权限比较的最低级别。 */
export const boundaryRoles = ["user", "groupAdmin", "groupOwner", "master"] as const
export type BoundaryRole = (typeof boundaryRoles)[number]

export const boundaryRoleLabels: Record<BoundaryRole, string> = {
  user: "所有用户",
  groupAdmin: "管理员",
  groupOwner: "群主",
  master: "主人",
}

const roleRankMap: Record<BoundaryRole, number> = Object.fromEntries(
  boundaryRoles.map((role, index) => [role, index]),
) as Record<BoundaryRole, number>

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

/** 返回角色的稳定等级；未知角色按普通用户处理，避免越权。 */
export function roleRank(role: unknown = "user"): number {
  const key = text(role) as BoundaryRole
  return roleRankMap[key] ?? roleRankMap.user
}

/** 判断当前角色是否达到工具声明的最低角色。 */
export function roleAtLeast(role: unknown = "user", minRole: unknown = "user"): boolean {
  return roleRank(role) >= roleRank(minRole)
}

/** 从宿主事件中解析边界角色；事件对象只在此处从 unknown 收窄。 */
export function resolveBoundaryRole(event: unknown = {}): BoundaryRole {
  const value = record(event)
  const sender = record(value.sender)
  if (value.isMaster === true) return "master"
  if (isGroupEvent(value) && sender.role === "owner") return "groupOwner"
  if (isGroupEvent(value) && sender.role === "admin") return "groupAdmin"
  return "user"
}

/** 判断事件是否来自群主，用于需要群主身份的管理路径。 */
export function isGroupOwnerEvent(event: unknown = {}): boolean {
  const value = record(event)
  return isGroupEvent(value) && record(value.sender).role === "owner"
}
