import { configStore } from "../../config/store.js"
import { explainToolPolicy, type ToolAccessDecision } from "./policy.js"
import { boundaryRoles, type BoundaryRole } from "./roles.js"
import { getToolCommon, isToolEnabledByConfig, toolProvenance } from "../support/contract.js"

type UnknownRecord = Record<string, unknown>

export const accessMatrixRoles = boundaryRoles

export interface AccessMatrixQuery {
  userId?: string
  groupId?: string
}

export interface AccessMatrixOptions extends AccessMatrixQuery {
  roles?: string[]
}

export interface AccessMatrixRow {
  tool: UnknownRecord
  decisions: Partial<Record<BoundaryRole, ToolAccessDecision>>
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

/** 为管理台生成稳定的角色预览事件，不执行真实工具。 */
export function previewToolEvent(role = "user", query: AccessMatrixQuery = {}): UnknownRecord {
  const base: UnknownRecord = {
    user_id: query.userId || "10001",
    group_id: query.groupId || "20001",
    sender: { role: "member" },
  }
  if (role === "master") return { ...base, isMaster: true, isGroup: true, sender: { role: "owner" } }
  if (role === "groupOwner") return { ...base, isGroup: true, sender: { role: "owner" } }
  if (role === "groupAdmin") return { ...base, isGroup: true, sender: { role: "admin" } }
  return { ...base, isGroup: true, sender: { role: "member" } }
}

function bump(map: Record<string, number>, key: unknown): void {
  const value = text(key) || "unknown"
  map[value] = (map[value] || 0) + 1
}

interface AccessSummary {
  role: string
  total: number
  enabled: number
  allowed: number
  denied: number
  deniedEnabled: number
  allowedBySource: Record<string, number>
  allowedByCategory: Record<string, number>
  allowedByRisk: Record<string, number>
  deniedReasons: Record<string, number>
}

function summarizeDecisions(rows: AccessMatrixRow[], role: BoundaryRole): AccessSummary {
  const summary: AccessSummary = {
    role,
    total: rows.length,
    enabled: 0,
    allowed: 0,
    denied: 0,
    deniedEnabled: 0,
    allowedBySource: {},
    allowedByCategory: {},
    allowedByRisk: {},
    deniedReasons: {},
  }
  for (const row of rows) {
    const tool = row.tool
    const common = record(tool.common)
    const decision = row.decisions[role]
    if (tool.enabled === true) summary.enabled++
    if (decision?.allowed) {
      summary.allowed++
      bump(summary.allowedBySource, common.source)
      bump(summary.allowedByCategory, common.categoryLabel || common.category)
      bump(summary.allowedByRisk, common.riskLabel || common.risk)
    } else {
      summary.denied++
      if (tool.enabled === true) summary.deniedEnabled++
      bump(summary.deniedReasons, decision?.reason || "unknown")
    }
  }
  return summary
}

/** 只计算各角色的可见性矩阵，供 Web 管理台展示和审计，不触发任何工具。 */
export async function buildToolAccessMatrix(tools: unknown[] = [], options: AccessMatrixOptions = {}): Promise<UnknownRecord> {
  const config = await configStore.load()
  const roles = (Array.isArray(options.roles) && options.roles.length ? options.roles : [...accessMatrixRoles])
    .map(String)
    .filter((role): role is BoundaryRole => boundaryRoles.includes(role as BoundaryRole))
  const query = {
    userId: options.userId || "10001",
    groupId: options.groupId || "20001",
  }
  const events = Object.fromEntries(roles.map(role => [role, previewToolEvent(role, query)])) as Record<BoundaryRole, UnknownRecord>
  const rows: AccessMatrixRow[] = tools.map(tool => {
    const common = getToolCommon(tool)
    const item: UnknownRecord = {
      name: text(record(tool).name),
      enabled: isToolEnabledByConfig(config, tool),
      common: {
        ...common,
        tags: stringList(common.tags),
        policy: { ...record(common.policy) },
        provenance: { ...toolProvenance(tool) },
      },
    }
    return {
      tool: item,
      decisions: Object.fromEntries(roles.map(role => [
        role,
        explainToolPolicy(tool, { e: events[role] }),
      ])) as Partial<Record<BoundaryRole, ToolAccessDecision>>,
    }
  })
  const publicConfig = configStore.getPublic()
  const publicTools = record(publicConfig.tools)
  return {
    roles,
    query,
    policy: publicTools.policy,
    summaries: Object.fromEntries(roles.map(role => [role, summarizeDecisions(rows, role)])),
    rows,
  }
}
