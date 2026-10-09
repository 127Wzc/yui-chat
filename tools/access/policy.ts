import { assertPersonaPunishmentAvailable } from "./persona-punishment-policy.js"
import { configStore } from "../../config/store.js"
import { roleAtLeast, resolveBoundaryRole, type BoundaryRole } from "./roles.js"
import { explainResourceAccess } from "./resource-policy.js"
import { assertMemberOperation, memberTarget } from "./member-policy.js"
import { getToolCommon, isToolEnabledByConfig, toolProvenance } from "../support/contract.js"
import { isGroupEvent } from "../../core/message/event-scope.js"

type UnknownRecord = Record<string, unknown>

export interface ToolAccessContext {
  ignoreUserOverrides?: boolean
  args?: unknown
  config?: unknown
  e?: unknown
  allowDisabledTool?: boolean
  /** 仅由动作入口传入；每次决策都读取当前已保存动作，不接受参数中的角色覆盖。 */
  actionId?: string
  actionDelivery?: boolean
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
  defaulted?: boolean
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
  return value.isMaster === true || (isGroupEvent(value) && ["owner", "admin"].includes(senderRole(value)))
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

function boundaryDecision(config: unknown, tool: unknown, context: ToolAccessContext): BoundaryDecision {
  const common = getToolCommon(tool)
  const provenance = toolProvenance(tool)
  const bucket = common.source === "custom" ? "customPackages" : common.source === "mcp" ? "mcpServers" : ""
  const parentId = text(bucket === "customPackages" ? provenance.packageId : provenance.serverName)
  const result = explainResourceAccess(config, context.e, "tool", toolName(tool), bucket, parentId, context.ignoreUserOverrides, common.source === "builtin")
  return { ...result, groups: [] }
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

  if (policy.personaPunishment === true) {
    try { assertPersonaPunishmentAvailable(config, event) }
    catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : "人物处罚不可用", roles, groups: [] } }
  }
  if (policy.personaPunishmentRelease === true && !isAdminEvent(event)) return { allowed: false, reason: "解除人物处罚需要管理员或主人权限。", roles, groups: [] }

  let actionAuthorized = false
  if (context.actionId) {
    const actions = record(record(config).actions)
    const action = record(record(actions.items)[context.actionId])
    const actionRole = resolveBoundaryRole(event)
    const targetMatches = action.tool === name || (context.actionDelivery === true && name === "message_send")
    if (actions.enabled === false || action.enabled !== true || !targetMatches) {
      return { allowed: false, reason: "动作已停用、删除或执行目标已变化。", roles, groups: [] }
    }
    const scopeMatches = !(action.scope === "group" && !isGroupEvent(event)) && !(action.scope === "private" && isGroupEvent(event))
    if (!roleAtLeast(actionRole, action.minRole) || !scopeMatches) {
      return { allowed: false, reason: "当前角色或会话没有此动作的使用权限。", roles, groups: [] }
    }
    if (policy.requiresModelContext === true) {
      return { allowed: false, reason: "此工具需要模型会话，不能作为动作直接执行。", roles, groups: [] }
    }
    actionAuthorized = true
  }

  if (!actionAuthorized && tools.enabled !== true) return { allowed: false, reason: "工具调用已被全局关闭。", roles, groups: [] }
  if (!actionAuthorized && !context.allowDisabledTool && !hasEnabledTool(config, tool)) {
    return { allowed: false, reason: `工具 ${name} 未启用。`, roles, groups: [] }
  }

  const groupDecision = actionAuthorized ? null : boundaryDecision(config, tool, context)
  let selfService = false
  if (groupDecision && !groupDecision.allowed) {
    // 默认开放本人操作，但显式角色/个人禁止仍可关闭；执行时必须再次按真实参数判断。
    const supportsSelf = common.source === "builtin" && ["mute_user", "edit_card", "set_title"].includes(name)
    if (groupDecision.defaulted && supportsSelf) {
      if (context.args === undefined) selfService = true
      else {
        const args = record(context.args)
        const e = record(event)
        try {
          assertMemberOperation(text(policy.memberOperation), args, e)
          selfService = memberTarget(args, e) === String(e.user_id || record(e.sender).user_id || "")
            && (name !== "mute_user" || Number(args.seconds) > 0)
        } catch (error) {
          return { allowed: false, reason: error instanceof Error ? error.message : "本人操作不可用", roles, groups: [] }
        }
      }
    }
    if (!selfService) return { ...groupDecision, roles }
  }
  const groups = groupDecision?.groups || []
  const source = text(common.source)

  if (source === "custom" && policyConfig.allowCustomTools === false) {
    return { allowed: false, reason: "自定义工具调用已被策略关闭。", roles, groups }
  }
  // 注入名单是服务器硬边界，动作和调试入口也不能绕过。
  if (source === "mcp" && !isToolEnabledByConfig(config, tool)) {
    return { allowed: false, reason: "MCP 服务或此工具的注入已关闭。", roles, groups }
  }
  if (source === "mcp" && policyConfig.allowMcpTools === false) {
    return { allowed: false, reason: "MCP 工具调用已被策略关闭。", roles, groups }
  }
  if (policy.externalNetwork === true && policyConfig.allowExternalNetwork === false) {
    return { allowed: false, reason: `工具 ${name} 需要外部网络访问，但策略未允许。`, roles, groups }
  }
  if (!actionAuthorized && policy.requiresMaster === true && record(event).isMaster !== true) {
    return { allowed: false, reason: `工具 ${name} 需要主人权限。`, roles, groups }
  }
  if (policy.requiresGroup === true && !isGroupEvent(event)) {
    return { allowed: false, reason: `工具 ${name} 只能在群聊中使用。`, roles, groups }
  }
  if (policy.requiresGroupAdmin === true && !isAdminEvent(event)) {
    return { allowed: false, reason: `工具 ${name} 需要主人或群管理员权限。`, roles, groups }
  }
  if (context.args !== undefined && (policy.memberOperation || policy.requiresGroupAdmin)) {
    try { assertMemberOperation(text(policy.memberOperation || "manage"), record(context.args), record(event)) }
    catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : "操作对象无权限", roles, groups } }
  }
  return { allowed: true, reason: selfService || (policy.memberOperation && !isAdminEvent(event)) ? "仅限本人自助操作" : groupDecision?.reason || "动作角色授权允许", roles, groups }
}

/** 执行前的强制权限闸门；拒绝原因保留给调用方和链路日志。 */
export function assertToolAllowed(tool: unknown, context: ToolAccessContext = {}): true {
  const decision = explainToolPolicy(tool, context)
  if (!decision.allowed) throw new Error(decision.reason)
  return true
}
