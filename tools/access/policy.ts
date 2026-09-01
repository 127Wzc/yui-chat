import { configStore } from "../../config/store.js"
import { roleAtLeast, resolveBoundaryRole, type BoundaryRole } from "./roles.js"
import { capabilityStore } from "./capability-store.js"
import { getToolCommon, isToolEnabledByConfig, toolProvenance } from "../support/contract.js"
import { isGroupEvent } from "../../core/message/event-scope.js"

type UnknownRecord = Record<string, unknown>

export interface ToolAccessContext {
  config?: unknown
  e?: unknown
  allowDisabledTool?: boolean
}

export interface ToolAccessDecision {
  allowed: boolean
  reason: string
  roles: string[]
  groups: string[]
  role?: BoundaryRole
}

interface BoundaryDecision extends Omit<ToolAccessDecision, "roles"> {
  role: BoundaryRole
}

interface BoundaryProfile {
  enabledCategories: string[]
  allowedSources: string[]
  allowedTools: string[]
  deniedTools: string[]
  allowExternalNetwork: boolean
  allowHighRisk: boolean
  allowAllEnabledTools: boolean
}

interface BoundaryBaseDecision {
  allowed: boolean
  explicit: boolean
  denied?: boolean
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function toolName(tool: unknown): string {
  return text(record(tool).name)
}

function senderRole(event: unknown): string {
  return text(record(record(event).sender).role)
}

function isAdminEvent(event: unknown = {}): boolean {
  const value = record(event)
  return value.isMaster === true || ["owner", "admin"].includes(senderRole(value))
}

function eventRoles(event: unknown = {}): string[] {
  const value = record(event)
  const roles = ["user"]
  if (value.isMaster === true) roles.push("master")
  if (isGroupEvent(value)) {
    roles.push("group", "groupMember")
    if (senderRole(value) === "owner") roles.push("groupOwner")
    if (isAdminEvent(value)) roles.push("groupAdmin")
  } else {
    roles.push("private")
  }
  return [...new Set(roles)]
}

function hasEnabledTool(config: unknown, tool: unknown): boolean {
  return isToolEnabledByConfig(config, tool)
}

function boundaryProfile(config: unknown, role: BoundaryRole): BoundaryProfile {
  const tools = record(record(config).tools)
  const boundary = record(tools.boundaryAccess)
  const roles = record(boundary.roles)
  const entry = record(roles[role])
  const stringList = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : []
  return {
    enabledCategories: stringList(entry.enabledCategories),
    allowedSources: stringList(entry.allowedSources),
    allowedTools: stringList(entry.allowedTools),
    deniedTools: stringList(entry.deniedTools),
    allowExternalNetwork: entry.allowExternalNetwork !== false,
    allowHighRisk: entry.allowHighRisk === true,
    allowAllEnabledTools: entry.allowAllEnabledTools === true,
  }
}

function boundaryOverride(config: unknown, tool: unknown): UnknownRecord | null {
  const tools = record(record(config).tools)
  const access = record(tools.boundaryAccess)
  const common = getToolCommon(tool)
  const provenance = toolProvenance(tool)
  if (common.source === "custom" && provenance.packageId) {
    const overrides = record(access.customPackages)
    return record(overrides[text(provenance.packageId)])
  }
  const sourceTool = record(tool)
  const serverName = text(provenance.serverName || record(sourceTool.mcp).serverName || sourceTool.serverName)
  if (common.source === "mcp" && serverName) {
    const overrides = record(access.mcpServers)
    return record(overrides[serverName])
  }
  return null
}

function boundaryBaseAllowed(profile: BoundaryProfile, tool: unknown): BoundaryBaseDecision {
  const sourceTool = record(tool)
  const common = getToolCommon(tool)
  const allowedTools = new Set(profile.allowedTools)
  const deniedTools = new Set(profile.deniedTools)
  const name = toolName(tool)
  if (deniedTools.has(name)) return { allowed: false, explicit: true, denied: true }
  // 工具发现本身只读且不携带业务权限；否则普通用户无法先发现自己有权限使用的工具，
  // 渐进式披露会被边界配置反向锁死。真正的工具仍在搜索结果和下一轮装载时逐一校验。
  if (name === "tool_search") return { allowed: true, explicit: true }
  if (profile.allowAllEnabledTools) return { allowed: true, explicit: false }
  if (allowedTools.has(name)) return { allowed: true, explicit: true }
  if (common.source === "builtin") {
    return { allowed: new Set(profile.enabledCategories).has(text(common.category)), explicit: false }
  }
  void sourceTool
  return { allowed: new Set(profile.allowedSources).has(text(common.source)), explicit: false }
}

function boundaryDecision(config: unknown, tool: unknown, context: ToolAccessContext): BoundaryDecision | null {
  const tools = record(record(config).tools)
  const boundary = record(tools.boundaryAccess)
  if (boundary.enabled !== true) return null

  const event = context.e || {}
  const role = resolveBoundaryRole(event)
  const profile = boundaryProfile(config, role)
  const override = boundaryOverride(config, tool)
  const base = boundaryBaseAllowed(profile, tool)
  const name = toolName(tool)
  const common = getToolCommon(tool)
  const policy = record(common.policy)
  const individual = capabilityStore.decision(event, name)

  if (individual === "deny") return { allowed: false, reason: `当前主体已单独禁止工具 ${name}。`, groups: [], role }
  if (base.denied) return { allowed: false, reason: `当前角色 ${role} 已单独禁止工具 ${name}。`, groups: [], role }

  const overrideAllowed = override?.enabled === false
    ? false
    : override?.minRole
      ? roleAtLeast(role, override.minRole)
      : false
  // 个人 allow 仅补充常规、已全局启用的工具；高风险/外网和工具自身硬策略仍由后续规则裁决。
  const individualAllowed = individual === "allow"
    && common.risk !== "high"
    && common.risk !== "external"
    && policy.highRisk !== true
    && policy.externalNetwork !== true
  const allowed = base.allowed || overrideAllowed || individualAllowed
  if (!allowed) return { allowed: false, reason: `当前角色 ${role} 未开放工具 ${name} 所在边界。`, groups: [], role }
  if (override?.enabled === false) return { allowed: false, reason: `工具 ${name} 所属扩展已被边界权限显式关闭。`, groups: [], role }
  if (!base.explicit && (policy.externalNetwork === true || common.risk === "external") && !profile.allowExternalNetwork) {
    return { allowed: false, reason: `当前角色 ${role} 未开放外网工具。`, groups: [], role }
  }
  if (!base.explicit && (policy.highRisk === true || common.risk === "high") && !profile.allowHighRisk) {
    return { allowed: false, reason: `当前角色 ${role} 未开放高风险工具。`, groups: [], role }
  }
  return { allowed: true, reason: "allowed by boundary access", groups: [], role }
}

/** 解释一次工具请求的完整权限决策；所有动态配置和宿主事件都在此处收窄。 */
export function explainToolPolicy(tool: unknown, context: ToolAccessContext = {}): ToolAccessDecision {
  const config = context.config || configStore.get()
  const tools = record(record(config).tools)
  const policyConfig = record(tools.policy)
  const common = getToolCommon(tool)
  const policy = record(common.policy)
  const event = context.e || {}
  const roles = eventRoles(event)
  const name = toolName(tool)

  if (tools.enabled !== true) return { allowed: false, reason: "工具调用已被全局关闭。", roles, groups: [] }
  if (!context.allowDisabledTool && !hasEnabledTool(config, tool)) {
    return { allowed: false, reason: `工具 ${name} 未启用。`, roles, groups: [] }
  }

  const groupDecision = boundaryDecision(config, tool, context)
  if (groupDecision && !groupDecision.allowed) return { ...groupDecision, roles }
  const groups = groupDecision?.groups || []
  const source = text(common.source)

  if (source === "custom" && policyConfig.allowCustomTools === false) {
    return { allowed: false, reason: "自定义工具调用已被策略关闭。", roles, groups }
  }
  if (source === "mcp" && policyConfig.allowMcpTools === false) {
    return { allowed: false, reason: "MCP 工具调用已被策略关闭。", roles, groups }
  }
  if ((policy.externalNetwork === true || common.risk === "external") && policyConfig.allowExternalNetwork === false) {
    return { allowed: false, reason: `工具 ${name} 需要外部网络访问，但策略未允许。`, roles, groups }
  }
  const boundary = record(tools.boundaryAccess)
  if (boundary.enabled !== true && (policy.highRisk === true || common.risk === "high") && policyConfig.highRiskRequiresMaster === true && record(event).isMaster !== true) {
    return { allowed: false, reason: `高风险工具 ${name} 需要主人权限。`, roles, groups }
  }
  if (policy.requiresMaster === true && record(event).isMaster !== true) {
    return { allowed: false, reason: `工具 ${name} 需要主人权限。`, roles, groups }
  }
  if (policy.requiresGroup === true && !isGroupEvent(event)) {
    return { allowed: false, reason: `工具 ${name} 只能在群聊中使用。`, roles, groups }
  }
  if (policy.requiresGroupAdmin === true && !isAdminEvent(event)) {
    return { allowed: false, reason: `工具 ${name} 需要主人或群管理员权限。`, roles, groups }
  }
  return { allowed: true, reason: "allowed", roles, groups }
}

/** 执行前的强制权限闸门；拒绝原因保留给调用方和链路日志。 */
export function assertToolAllowed(tool: unknown, context: ToolAccessContext = {}): true {
  const decision = explainToolPolicy(tool, context)
  if (!decision.allowed) throw new Error(decision.reason)
  return true
}
