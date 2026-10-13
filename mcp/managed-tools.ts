import crypto from "node:crypto"
function digest(value: string) { return crypto.createHash("sha256").update(value).digest("hex") }
import type { McpToolDefinition } from "./types.js"
import { isMcpToolSelected } from "./tool-selection.js"
export function mcpToolSchemaDigest(tool: McpToolDefinition): string {
  return digest(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }))
}
export function isMcpDefinitionSelected(config: Record<string, unknown>, tool: McpToolDefinition): boolean {
  return isMcpToolSelected(config, tool.name) && (!config.installationId || (config.reviewedToolSchemas as Record<string, string>)?.[tool.name] === mcpToolSchemaDigest(tool))
}
