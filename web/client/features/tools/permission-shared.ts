import { asRecord, type UnknownRecord } from "../../shared/data.js"

// 角色边界权限域：类型、常量与归一化，供 permission-panel 与其子组件共用；无运行时依赖，不产生导入环。

export interface RoleProfile extends UnknownRecord {
  allowedTools: string[]
  deniedTools: string[]
}

export interface OverrideEntry extends UnknownRecord {
  roles?: Record<string, boolean>
}

export interface BoundaryAccess extends UnknownRecord {
  roles: Record<string, RoleProfile>
  customPackages: Record<string, OverrideEntry>
  skillPackages: Record<string, OverrideEntry>
  mcpServers: Record<string, OverrideEntry>
}

export interface PermissionDraft {
  previewRole: string
  previewGroupId: string
  previewUserId: string
  roles: Record<string, RoleProfile>
  customPackages: Record<string, OverrideEntry>
  skillPackages: Record<string, OverrideEntry>
  mcpServers: Record<string, OverrideEntry>
}

export interface ToolItem extends UnknownRecord {
  name: string
  enabled?: boolean
}

export interface PackageItem extends UnknownRecord {
  id: string
  name?: string
  description?: string
  transport?: string
}

export interface PreviewRow extends UnknownRecord {
  name: string
  reason?: string
}

export interface PreviewResult extends UnknownRecord {
  role: string
  allowed: string[]
  blocked: PreviewRow[]
}

export interface AccessPreviewTool extends ToolItem {
  access?: { allowed?: boolean; reason?: string }
}

export interface MatrixDecision extends UnknownRecord {
  allowed?: boolean
}

export interface MatrixRow extends UnknownRecord {
  tool: ToolItem
  decisions?: Record<string, MatrixDecision>
}

export interface MatrixResult extends UnknownRecord {
  roles?: string[]
  rows?: MatrixRow[]
}

export interface PermissionConfigRoot extends UnknownRecord {
  tools?: { boundaryAccess?: BoundaryAccess }
}

export interface ToolsSlice extends UnknownRecord {
  tools?: ToolItem[]
  custom?: { catalog?: PackageItem[] }
  skills?: { catalog?: PackageItem[] }
  mcp?: { servers?: PackageItem[] }
}

export type OverrideBucket = "customPackages" | "skillPackages" | "mcpServers"

export const PREVIEW_ROLE_OPTIONS = [
  { value: "user", label: "普通用户" },
  { value: "groupAdmin", label: "管理员" },
  { value: "groupOwner", label: "群主" },
  { value: "master", label: "主人" },
]
export const BOUNDARY_ROLE_OPTIONS = PREVIEW_ROLE_OPTIONS
function uniqueList(values: unknown = []): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]
}

export function normalizeBoundaryAccess(input: unknown = {}): BoundaryAccess {
  const source = asRecord(input)
  const next: BoundaryAccess = { roles: {}, customPackages: {}, skillPackages: {}, mcpServers: {} }
  for (const role of BOUNDARY_ROLE_OPTIONS.map(item => item.value)) {
    const profile = asRecord(asRecord(source.roles)[role])
    next.roles[role] = { allowedTools: uniqueList(profile.allowedTools), deniedTools: uniqueList(profile.deniedTools) }
  }
  for (const bucket of ["customPackages", "skillPackages", "mcpServers"] as const) {
    for (const [id, entry] of Object.entries(asRecord(source[bucket]))) {
      const roles = asRecord(asRecord(entry).roles)
      next[bucket][id] = { roles: Object.fromEntries(BOUNDARY_ROLE_OPTIONS.filter(role => typeof roles[role.value] === "boolean").map(role => [role.value, roles[role.value] as boolean])) }
    }
  }
  return next
}

export function roleLabel(role: string): string {
  return PREVIEW_ROLE_OPTIONS.find(item => item.value === role)?.label || role
}

export function roleProfile(roles: Record<string, RoleProfile>, role: string): RoleProfile {
  roles[role] ||= { allowedTools: [], deniedTools: [] }
  roles[role].allowedTools ||= []
  roles[role].deniedTools ||= []
  return roles[role]
}
