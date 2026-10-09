import { builtinDefaultAllowed, builtinPublicTools } from "./role-presets.js"
import { capabilityStore } from "./capability-store.js"
import { resolveBoundaryRole } from "./roles.js"

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}
}
function list(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : [] }

/** 工具和 Skill 共用角色授权；风险、分类和来源只用于说明，不参与授权。 */
export function explainResourceAccess(config: unknown, event: unknown, resourceType: string, id: string, parentType = "", parentId = "", ignoreUserOverrides = false, builtin = false) {
  const role = resolveBoundaryRole(event)
  const boundary = record(record(record(config).tools).boundaryAccess)
  const profile = record(record(boundary.roles)[role])
  const entry = record(record(boundary[resourceType === "tool" ? parentType : resourceType])[resourceType === "tool" ? parentId : id])
  const roleGrant = record(entry.roles)[role]
  const individual = ignoreUserOverrides ? "" : capabilityStore.decision(event, id, resourceType, parentType, parentId)
  if (individual === "deny") return { allowed: false, reason: "此用户已被单独禁止使用此能力。", role }
  if (individual === "allow") return { allowed: true, reason: "用户单独允许（覆盖角色及包/服务的角色规则）", role }
  if ((resourceType === "tool" && list(profile.deniedTools).includes(id)) || roleGrant === false) {
    return { allowed: false, reason: `角色 ${role} 已明确禁止此能力。`, role }
  }
  if (resourceType === "tool" && list(profile.allowedTools).includes(id)) return { allowed: true, reason: "角色工具授权", role }
  if (roleGrant === true) return { allowed: true, reason: "角色扩展授权", role }
  const builtinDefault = builtin && resourceType === "tool" ? builtinDefaultAllowed(id, role) : undefined
  if (builtinDefault !== undefined) return { defaulted: true, allowed: builtinDefault,
    reason: builtinDefault ? (builtinPublicTools.has(id) ? "默认所有角色可用（操作范围仍受限制）" : "内置工具默认角色允许") : "内置工具默认未向此角色开放，可单独授权。", role }
  return { defaulted: true, allowed: role === "master", reason: role === "master" ? "默认仅主人可用" : "此角色尚未开放此能力，默认仅主人可用。", role }
}
