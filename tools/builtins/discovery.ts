import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

interface ToolDiscoveryService {
  search?: (query: string, limit: number) => Promise<UnknownRecord[]> | UnknownRecord[]
}

interface DiscoveryContext extends ToolExecutionContext {
  toolDiscovery?: ToolDiscoveryService
}

/** 工具渐进式披露入口：只返回候选摘要，并把模型选择的工具装载到下一轮。 */
export class ToolSearchTool {
  name = "tool_search"
  source = "builtin"
  execution = { effect: "read", repeatPolicy: "bounded", polling: false, maxAttempts: 1 }
  description = "Search available tools by capability and load matching tools for the next round. Use this when the required tool is not currently visible."
  descriptionZh = "按能力搜索当前有权限使用的工具；需要某个未展示的工具时先调用本工具。"
  tags = ["tool-discovery", "progressive-disclosure"]
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 120, description: "能力、动作或工具关键词。" },
      limit: { type: "integer", minimum: 1, maximum: 12, description: "最多返回工具数，默认 6。" },
      load: { type: "boolean", description: "是否把返回的工具加入下一轮模型可用工具列表，默认 true。" },
    },
    required: ["query"],
  }

  async execute(args: UnknownRecord = {}, context: DiscoveryContext = {}): Promise<string | UnknownRecord> {
    const query = String(args.query || "").trim()
    if (!query) return "缺少工具搜索关键词。"
    const limit = Math.max(1, Math.min(12, Number(args.limit) || 6))
    const rows = await context.toolDiscovery?.search?.(query, limit) || []
    const load = args.load !== false
    // 完整工具定义会作为下一轮的 tools 字段注入；这里重复返回 parameters
    // 只会扩大上下文，尤其 MCP Schema 很大时会平白消耗数千字符。
    const tools = rows.map(item => ({
      name: String(item.name || ""),
      description: String(item.descriptionZh || item.description || ""),
      category: String(item.category || "unknown"),
      source: String(item.source || ""),
      risk: String(item.risk || ""),
    }))
    const loaded = load ? tools.map(item => item.name) : []
    return {
      status: "success",
      content: JSON.stringify({ query, tools, loaded, hint: load ? "匹配工具已加入下一轮，请直接调用需要的工具。" : "如需调用，请将 load 设为 true。" }),
      metadata: { discovery: true, loadTools: loaded },
      retryAllowed: false,
    }
  }
}

export function createDiscoveryTools() {
  return [new ToolSearchTool()]
}
