import path from "node:path"
import { configStore, pluginRoot } from "../config/store.js"
import type { JsonValue } from "../core/message-chain/types.js"
import { isJsonValue } from "../core/message-chain/types.js"
import type { McpClient, McpToolDefinition } from "./types.js"
import type { ToolExecutionContext } from "../tools/support/tool-contract.js"

type UnknownRecord = Record<string, unknown>
type McpTransportKind = "stdio" | "sse" | "streamableHttp"

interface McpTransport {
  close?: () => Promise<unknown> | unknown
}

interface SdkConstructor<T> {
  new (...args: unknown[]): T
}

interface McpSdkModule {
  Client?: SdkConstructor<McpClient>
  StdioClientTransport?: SdkConstructor<McpTransport>
  SSEClientTransport?: SdkConstructor<McpTransport>
  StreamableHTTPClientTransport?: SdkConstructor<McpTransport>
}

interface McpServerStatus {
  server: string
  error: string
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const source = record(value)
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(source)) if (isJsonValue(item)) result[key] = item
  return result
}

async function importSdk(specifier: string): Promise<UnknownRecord> {
  try {
    return await import(specifier) as UnknownRecord
  } catch (error) {
    throw new Error(`MCP SDK 未安装，请在 yui-chat 中安装 @modelcontextprotocol/sdk：${errorMessage(error)}`)
  }
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  const value = record(schema)
  return value.type ? value : { type: "object", properties: record(value.properties) }
}

function arrayFrom(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  if (typeof value === "string") return value.split(/[\n,，\s]+/).map(item => item.trim()).filter(Boolean)
  return []
}

function toolOverride(serverConfig: UnknownRecord, originalName: string, registeredName: string): UnknownRecord {
  const policies = record(serverConfig.toolPolicies)
  return record(policies[originalName] || policies[registeredName])
}

function transportKind(serverConfig: UnknownRecord): McpTransportKind {
  const configured = text(serverConfig.transport || serverConfig.type)
  if (configured === "stdio" || configured === "sse" || configured === "streamableHttp") return configured
  return serverConfig.url ? "sse" : "stdio"
}

/** MCP 工具适配器；协议字段在这里归一化，执行仍由通用 ToolRegistry 管控。 */
export class McpToolAdapter {
  readonly source = "mcp"
  readonly serverName: string
  readonly client: McpClient
  readonly name: string
  readonly originalName: string
  readonly description: string
  readonly displayNameZh: string
  readonly descriptionZh: string
  readonly serverDescription: string
  readonly parameters: Record<string, unknown>
  readonly annotations: Record<string, unknown>
  readonly category: string
  readonly categoryLabel: string
  readonly risk: string
  readonly delivery: string
  readonly requiresFinalReply: boolean | undefined
  readonly execution: UnknownRecord
  readonly executionByAction: UnknownRecord
  readonly tags: string[]
  readonly policy: UnknownRecord
  readonly pipeline: UnknownRecord | null
  readonly mcp: { serverName: string; originalName: string }

  constructor(serverName: string, client: McpClient, tool: McpToolDefinition, serverConfig: UnknownRecord = {}) {
    this.serverName = serverName
    this.client = client
    this.name = `mcp_${serverName}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_")
    this.originalName = tool.name
    const override = toolOverride(serverConfig, this.originalName, this.name)
    this.description = tool.description || `MCP tool ${tool.name} from ${serverName}`
    this.displayNameZh = text(override.displayNameZh || tool.displayNameZh || tool.nameZh)
    this.descriptionZh = text(override.descriptionZh || tool.descriptionZh || tool.nameZh || serverConfig.descriptionZh || serverConfig.description)
    this.serverDescription = text(serverConfig.descriptionZh || serverConfig.description)
    this.parameters = normalizeSchema(tool.inputSchema)
    this.annotations = record(tool.annotations)
    this.category = text(override.category || serverConfig.category) || "mcp"
    this.categoryLabel = text(override.categoryLabel || serverConfig.categoryLabel) || "MCP"
    this.risk = text(override.risk || serverConfig.risk) || "external"
    this.delivery = text(override.delivery || serverConfig.delivery) || "silent"
    const configuredFinalReply = override.requiresFinalReply ?? serverConfig.requiresFinalReply
    this.requiresFinalReply = typeof configuredFinalReply === "boolean" ? configuredFinalReply : undefined
    const annotationExecution = this.annotations.readOnlyHint === true
      ? { effect: "read", repeatPolicy: "bounded", retryPolicy: "safe" }
      : this.annotations.destructiveHint === true
        ? { effect: "destructive", repeatPolicy: "explicit_only", retryPolicy: "no_ambiguous_retry" }
        : this.annotations.idempotentHint === true
          ? { effect: "idempotent_write", repeatPolicy: "dedupe", retryPolicy: "no_ambiguous_retry" }
          : {}
    const configuredExecution = record(override.execution || serverConfig.execution)
    this.execution = Object.keys(configuredExecution).length ? configuredExecution : annotationExecution
    this.executionByAction = record(override.executionByAction || serverConfig.executionByAction)
    this.tags = [...new Set(["mcp", serverName, ...arrayFrom(serverConfig.tags), ...arrayFrom(override.tags)])]
    this.policy = {
      externalNetwork: true,
      ...record(serverConfig.policy),
      ...record(override.policy),
    }
    this.pipeline = isRecord(override.pipeline) ? override.pipeline : isRecord(serverConfig.pipeline) ? serverConfig.pipeline : null
    this.mcp = { serverName, originalName: this.originalName }
  }

  async execute(args: Record<string, unknown> = {}, context: ToolExecutionContext = {}): Promise<unknown> {
    // @modelcontextprotocol/sdk 1.29 的第二个参数是可选结果 schema，
    // 请求选项必须放在第三个参数；否则 signal 会被当成 schema。
    const result = await this.client.callTool(
      { name: this.originalName, arguments: args },
      undefined,
      { signal: context.signal || context.agent?.signal },
    )
    // 原文直通：接入哪些 MCP 服务器由管理员审查决定，运行时不做内容改写、
    // 裁剪或结构映射，避免不规范服务器的结果被清洗成空值。
    if (this.pipeline?.callable === true && isRecord(result)) {
      return { ...result, _pipeline: jsonRecord(this.pipeline) }
    }
    return result
  }
}

/** MCP 客户端生命周期和工具发现管理器；传输实现只停留在本适配器。 */
export class McpManager {
  readonly clients = new Map<string, McpClient>()
  readonly transports = new Map<string, McpTransport>()
  tools: McpToolAdapter[] = []
  errors: McpServerStatus[] = []
  initialized = false

  async init(): Promise<void> {
    const config = await configStore.load()
    this.tools = []
    this.errors = []
    const mcp = record(config.mcp)
    if (mcp.enabled !== true) {
      if (this.initialized) await this.destroy()
      return
    }
    if (this.initialized) await this.destroy()

    let sdk: McpSdkModule
    try {
      const [clientModule, stdioModule, sseModule] = await Promise.all([
        importSdk("@modelcontextprotocol/sdk/client/index.js"),
        importSdk("@modelcontextprotocol/sdk/client/stdio.js"),
        importSdk("@modelcontextprotocol/sdk/client/sse.js"),
      ])
      sdk = {
        Client: clientModule.Client as McpSdkModule["Client"],
        StdioClientTransport: stdioModule.StdioClientTransport as McpSdkModule["StdioClientTransport"],
        SSEClientTransport: sseModule.SSEClientTransport as McpSdkModule["SSEClientTransport"],
      }
    } catch (error) {
      this.errors.push({ server: "__sdk__", error: errorMessage(error) })
      this.initialized = false
      return
    }

    const servers = record(mcp.servers)
    for (const [name, rawServerConfig] of Object.entries(servers)) {
      const serverConfig = record(rawServerConfig)
      if (serverConfig.enabled === false) continue
      let client: McpClient | null = null
      let transport: McpTransport | null = null
      try {
        if (!sdk.Client) throw new Error("MCP SDK 缺少 Client")
        client = new sdk.Client(
          { name: "yui-chat", version: text(config.version) || "0.1.0" },
          { capabilities: {} },
        )
        const kind = transportKind(serverConfig)
        if (kind === "streamableHttp") {
          if (!serverConfig.url) throw new Error("Streamable HTTP MCP server must define url")
          const module = await importSdk("@modelcontextprotocol/sdk/client/streamableHttp.js")
          const Constructor = module.StreamableHTTPClientTransport as McpSdkModule["StreamableHTTPClientTransport"]
          if (!Constructor) throw new Error("MCP SDK 缺少 StreamableHTTPClientTransport")
          transport = new Constructor(new URL(text(serverConfig.url)))
        } else if (kind === "sse") {
          if (!serverConfig.url || !sdk.SSEClientTransport) throw new Error("SSE MCP server must define url")
          transport = new sdk.SSEClientTransport(new URL(text(serverConfig.url)))
        } else {
          if (!serverConfig.command || !sdk.StdioClientTransport) throw new Error("stdio MCP server must define command")
          const args = Array.isArray(serverConfig.args)
            ? serverConfig.args.map(arg => typeof arg === "string" && (arg.startsWith("./") || arg.startsWith("../")
              ? path.resolve(pluginRoot, arg)
              : text(arg)))
            : []
          transport = new sdk.StdioClientTransport({
            command: text(serverConfig.command),
            args,
            env: { ...process.env, ...record(serverConfig.env) },
          })
        }
        if (!client.connect || !transport) throw new Error("MCP 客户端传输未创建")
        await client.connect(transport)
        this.clients.set(name, client)
        this.transports.set(name, transport)
        const list = await client.listTools()
        for (const tool of list.tools || []) this.tools.push(new McpToolAdapter(name, client, tool, serverConfig))
      } catch (error) {
        this.errors.push({ server: name, error: errorMessage(error) })
        this.clients.delete(name)
        this.transports.delete(name)
        this.tools = this.tools.filter(tool => tool.serverName !== name)
        try { await client?.close?.() } catch { /* best-effort：失败不影响主流程。 */ }
        try { await transport?.close?.() } catch { /* best-effort：失败不影响主流程。 */ }
      }
    }
    this.initialized = true
  }

  getTools(): McpToolAdapter[] {
    return [...this.tools]
  }

  status(): UnknownRecord {
    return {
      initialized: this.initialized,
      clients: [...this.clients.keys()],
      tools: this.tools.map(tool => tool.name),
      errors: [...this.errors],
    }
  }

  async destroy(): Promise<void> {
    for (const [name, client] of this.clients) {
      try { await client.close?.() } catch (error) { this.errors.push({ server: name, error: errorMessage(error) }) }
    }
    for (const [name, transport] of this.transports) {
      try { await transport.close?.() } catch (error) { this.errors.push({ server: name, error: errorMessage(error) }) }
    }
    this.clients.clear()
    this.transports.clear()
    this.tools = []
    this.initialized = false
  }
}

export const mcpManager = new McpManager()
