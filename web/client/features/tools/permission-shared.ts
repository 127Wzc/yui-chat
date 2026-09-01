import { asRecord, type UnknownRecord } from "../../shared/data.js"
import { toolCommon } from "./shared.js"

// 角色边界权限域：类型、常量与归一化，供 permission-panel 与其子组件共用；无运行时依赖，不产生导入环。

export interface RoleProfile extends UnknownRecord {
  enabledCategories: string[]
  allowedSources: string[]
  allowedTools: string[]
  deniedTools: string[]
  allowExternalNetwork: boolean
  allowHighRisk: boolean
  allowAllEnabledTools: boolean
}

export interface OverrideEntry extends UnknownRecord {
  enabled?: boolean
  minRole?: string
}

export interface BoundaryAccess extends UnknownRecord {
  enabled: boolean
  roles: Record<string, RoleProfile>
  customPackages: Record<string, OverrideEntry>
  skillPackages: Record<string, OverrideEntry>
  mcpServers: Record<string, OverrideEntry>
}

export interface PermissionDraft {
  enabled: string
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
  { value: "user", label: "所有用户" },
  { value: "groupAdmin", label: "管理员" },
  { value: "groupOwner", label: "群主" },
  { value: "master", label: "主人" },
]
export const BOUNDARY_ROLE_OPTIONS = PREVIEW_ROLE_OPTIONS
export const EXTENSION_OVERRIDE_OPTIONS = [
  { value: "", label: "跟随角色默认" },
  ...BOUNDARY_ROLE_OPTIONS,
  { value: "disabled", label: "禁用" },
]
export const BOUNDARY_CATEGORY_ORDER = ["command", "memory", "media", "render", "social", "network", "schedule", "admin", "entertainment", "agent"]
export const BOUNDARY_SOURCE_OPTIONS = [
  { value: "custom", label: "本地扩展" },
  { value: "mcp", label: "MCP 服务" },
]

function uniqueList(values: unknown = []): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]
}

function defaultBoundaryAccess(): BoundaryAccess {
  return {
    enabled: true,
    roles: {
      user: {
        enabledCategories: ["command", "memory", "media", "render", "social", "schedule", "entertainment", "network"],
        allowedSources: [],
        allowedTools: [],
        deniedTools: [],
        allowExternalNetwork: true,
        allowHighRisk: false,
        allowAllEnabledTools: false,
      },
      groupAdmin: {
        enabledCategories: ["command", "memory", "media", "render", "social", "schedule", "entertainment", "network", "admin"],
        allowedSources: [],
        allowedTools: [],
        deniedTools: [],
        allowExternalNetwork: true,
        allowHighRisk: true,
        allowAllEnabledTools: false,
      },
      groupOwner: {
        enabledCategories: ["command", "memory", "media", "render", "social", "schedule", "entertainment", "network", "admin"],
        allowedSources: ["custom"],
        allowedTools: [],
        deniedTools: [],
        allowExternalNetwork: true,
        allowHighRisk: true,
        allowAllEnabledTools: false,
      },
      master: {
        enabledCategories: [],
        allowedSources: ["builtin", "custom", "mcp"],
        allowedTools: [],
        deniedTools: [],
        allowExternalNetwork: true,
        allowHighRisk: true,
        allowAllEnabledTools: true,
      },
    },
    customPackages: {},
    skillPackages: {},
    mcpServers: {},
  }
}

export function normalizeBoundaryAccess(input: unknown = {}): BoundaryAccess {
  const fallback = defaultBoundaryAccess()
  const source = asRecord(input)
  const next: BoundaryAccess = {
    enabled: source.enabled !== false,
    roles: {},
    customPackages: {},
    skillPackages: {},
    mcpServers: {},
  }
  for (const role of BOUNDARY_ROLE_OPTIONS.map(item => item.value)) {
    const sourceRole = asRecord(asRecord(source.roles)[role] || fallback.roles[role] || {})
    next.roles[role] = {
      enabledCategories: uniqueList(sourceRole.enabledCategories ?? fallback.roles[role]?.enabledCategories ?? []),
      allowedSources: uniqueList(sourceRole.allowedSources ?? fallback.roles[role]?.allowedSources ?? []),
      allowedTools: uniqueList(sourceRole.allowedTools ?? []),
      deniedTools: uniqueList(sourceRole.deniedTools ?? []),
      allowExternalNetwork: sourceRole.allowExternalNetwork !== false,
      allowHighRisk: sourceRole.allowHighRisk === true,
      allowAllEnabledTools: sourceRole.allowAllEnabledTools === true,
    }
  }
  for (const bucket of ["customPackages", "skillPackages", "mcpServers"]) {
    const entries = asRecord(source[bucket])
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== "object") continue
      const override = asRecord(entry)
      const target = next[bucket as "customPackages" | "skillPackages" | "mcpServers"]
      if (override.enabled === false) target[id] = { enabled: false }
      else if (override.minRole) target[id] = { enabled: true, minRole: String(override.minRole) }
    }
  }
  return next
}

export function roleLabel(role: string): string {
  return PREVIEW_ROLE_OPTIONS.find(item => item.value === role)?.label || role
}

export function roleProfile(roles: Record<string, RoleProfile>, role: string): RoleProfile {
  roles[role] ||= { enabledCategories: [], allowedSources: [], allowedTools: [], deniedTools: [], allowExternalNetwork: true, allowHighRisk: false, allowAllEnabledTools: false }
  roles[role].allowedTools ||= []
  roles[role].deniedTools ||= []
  return roles[role]
}

export function toggleInList(list: string[] | undefined, value: string): string[] {
  const next = new Set(list || [])
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return [...next]
}

export function draftToolAllowed(profile: RoleProfile, tool: ToolItem): boolean {
  const common = toolCommon(tool)
  if (profile.deniedTools?.includes(tool.name)) return false
  const explicit = profile.allowedTools?.includes(tool.name)
  let allowed = explicit || profile.allowAllEnabledTools
  if (!allowed && common.source === "builtin") allowed = profile.enabledCategories?.includes(String(common.category || ""))
  if (!allowed && common.source !== "builtin") allowed = profile.allowedSources?.includes(String(common.source || ""))
  if (!allowed) return false
  if (!explicit && common.policy?.externalNetwork && !profile.allowExternalNetwork) return false
  if (!explicit && (common.risk === "high" || common.policy?.highRisk || common.policy?.requiresMaster) && !profile.allowHighRisk) return false
  return true
}
