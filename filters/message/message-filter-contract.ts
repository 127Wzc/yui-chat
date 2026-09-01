import type { UnknownRecord } from "../../core/message/types.js"

export type MessageFilterStageId = "input" | "output"

export interface MessageFilterStage {
  id: MessageFilterStageId
  label: string
  shortLabel: string
  description: string
  textBinding: string
  textLabel: string
}

export interface FilterSummary extends UnknownRecord {
  id: string
  displayName?: string
  displayNameZh?: string
  source?: string
  packageId?: string
  stages?: string[]
}

export const messageFilterStages: readonly MessageFilterStage[] = [
  {
    id: "input",
    label: "发送模型前",
    shortLabel: "输入过滤器",
    description: "在用户消息送入模型前改写、校验或拦截正文。",
    textBinding: "input.text",
    textLabel: "当前用户输入",
  },
  {
    id: "output",
    label: "回复发送前",
    shortLabel: "输出过滤器",
    description: "在模型生成回复后、实际发送前改写、拦截或转换正文。",
    textBinding: "response.text",
    textLabel: "当前回复正文",
  },
]

const stageOrder = new Map<MessageFilterStageId, number>(messageFilterStages.map((stage, index) => [stage.id, index]))

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function priorityOf(filter: UnknownRecord): number {
  const priority = Number(filter.priority)
  return Number.isInteger(priority) ? priority : 100
}

export function getMessageFilterStage(id: unknown = ""): MessageFilterStage | null {
  return messageFilterStages.find(stage => stage.id === text(id)) || null
}

export function listMessageFilterStages(): MessageFilterStage[] {
  return messageFilterStages.map(stage => ({ ...stage }))
}

export function isMessageFilterStage(id: unknown = ""): boolean {
  return stageOrder.has(text(id) as MessageFilterStageId)
}

// 展示与保存统一为：输入过滤器在前，输出过滤器在后；每个阶段内数字越小越靠前。
export function sortMessageFilters(filters: unknown[] = []): UnknownRecord[] {
  return filters
    .map((filter, index) => ({ filter: record(filter), index }))
    .sort((left, right) => {
      const leftStage = stageOrder.get(text(left.filter.stage) as MessageFilterStageId) ?? stageOrder.size
      const rightStage = stageOrder.get(text(right.filter.stage) as MessageFilterStageId) ?? stageOrder.size
      return leftStage - rightStage || priorityOf(left.filter) - priorityOf(right.filter) || left.index - right.index
    })
    .map(({ filter }) => filter)
}

export function messageFilterSourceMeta(tool: unknown = {}): { id: string; label: string; detail: string } {
  const value = record(tool)
  const source = text(value.source || "custom")
  if (source === "builtin") return { id: source, label: "内置", detail: "内置过滤器实现" }
  if (source === "custom") return { id: source, label: "Custom", detail: value.packageId ? `Custom · ${text(value.packageId)}` : "Custom 扩展" }
  if (source === "mcp") {
    const tags = Array.isArray(value.tags) ? value.tags.map(text) : []
    const server = value.serverName || tags.find(tag => tag !== "mcp")
    return { id: source, label: "MCP", detail: server ? `MCP · ${text(server)}` : "MCP 服务" }
  }
  if (source === "skill") return { id: source, label: "Skill 工具", detail: value.skillId ? `Skill · ${text(value.skillId)}` : "Skill 导出的可执行工具" }
  return { id: source, label: source, detail: text(value.packageId || source) }
}
