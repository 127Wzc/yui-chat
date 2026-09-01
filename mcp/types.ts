import type { ToolOutput } from "../core/message-chain/types.js"
import type { ToolExecutionContext } from "../tools/support/tool-contract.js"

/** MCP 服务器返回的内容块；字段保持 unknown，统一由归一化器收窄。 */
export interface McpContentBlock {
  type?: unknown
  text?: unknown
  data?: unknown
  mimeType?: unknown
  uri?: unknown
  name?: unknown
  title?: unknown
  description?: unknown
  size?: unknown
  resource?: unknown
  [key: string]: unknown
}

/** MCP tools/call 的原始响应，不直接暴露给模型或投递层。 */
export interface McpCallToolResult {
  content?: unknown
  structuredContent?: unknown
  isError?: unknown
  [key: string]: unknown
}

/** MCP tools/list 返回的工具描述。 */
export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
  [key: string]: unknown
}

/** MCP 客户端最小协议，屏蔽具体 stdio/SSE/Streamable HTTP 传输。 */
export interface McpClient {
  /** 第三个参数专门承载取消信号，避免误把 SDK 校验参数当成请求选项。 */
  callTool: (request: { name: string; arguments: Record<string, unknown> }, resultSchema?: unknown, options?: { signal?: AbortSignal }) => Promise<McpCallToolResult>
  listTools: () => Promise<{ tools?: McpToolDefinition[] }>
  connect?: (transport: unknown) => Promise<void>
  close?: () => Promise<void>
}

/** 经过内部消息链归一化后的 MCP 观察结果。 */
export type McpToolResult = ToolOutput

/** MCP 工具执行上下文；仍允许宿主运行时附加 unknown 字段。 */
export interface McpToolExecutionContext extends ToolExecutionContext {
  signal?: AbortSignal
}
