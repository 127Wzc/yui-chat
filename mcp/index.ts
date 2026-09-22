import path from "node:path"
import { isMcpToolSelected } from "./tool-selection.js"
import { resolveMcpEnv, resolveMcpHeaders, resolveMcpUrl } from "./transport-auth.js"
import { configStore, pluginRoot } from "../config/store.js"
import type { JsonValue } from "../core/message-chain/types.js"
import { isJsonValue } from "../core/message-chain/types.js"
import { redactErrorText } from "../core/shared/error-details.js"
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
  phase?: "sdk" | "connect" | "discover" | "execute" | "reconnect"
  updatedAt?: string
}

export interface McpDiscoveredTool {
  server: string
  originalName: string
  name: string
  description: string
  exposed: boolean
  /** 发现结果保留在目录中；断线时只标记不可用，不从目录抹掉。 */
  status?: "available" | "unavailable"
  error?: string
  lastSeenAt?: string
}

interface McpDiscovery {
  catalog: McpDiscoveredTool[]
  definitions: McpToolDefinition[]
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
  return redactErrorText(error instanceof Error ? error.message : String(error), 1000)
}

class McpUnavailableError extends Error {
  readonly code = "MCP_UNAVAILABLE"
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof McpUnavailableError) return true
  const source = record(error)
  const code = text(source.code).toUpperCase()
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE"].includes(code)) return true
  return /connection\s+(?:closed|lost|refused|reset|terminated)|transport(?:\s+(?:closed|error|failed|lost|disconnected)|.*not connected)|socket|network|fetch failed|disconnected|broken pipe|premature close|process exited/i.test(errorMessage(error))
}

function formatUnavailableError(serverName: string, toolName: string, reason: string): Error {
  const detail = reason.trim() || "连接尚未建立或已断开"
  return new McpUnavailableError(`MCP 工具 ${serverName}/${toolName} 当前不可用：${detail}。已保留工具配置，后续调用会自动重试连接。`)
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

async function loadSdk(): Promise<McpSdkModule> {
  const [clientModule, stdioModule, sseModule] = await Promise.all([
    importSdk("@modelcontextprotocol/sdk/client/index.js"),
    importSdk("@modelcontextprotocol/sdk/client/stdio.js"),
    importSdk("@modelcontextprotocol/sdk/client/sse.js"),
  ])
  return {
    Client: clientModule.Client as McpSdkModule["Client"],
    StdioClientTransport: stdioModule.StdioClientTransport as McpSdkModule["StdioClientTransport"],
    SSEClientTransport: sseModule.SSEClientTransport as McpSdkModule["SSEClientTransport"],
  }
}

async function connectServer(serverName: string, serverConfig: UnknownRecord, version: string, sdk: McpSdkModule): Promise<{ client: McpClient; transport: McpTransport }> {
  if (!sdk.Client) throw new Error("MCP SDK 缺少 Client")
  const client = new sdk.Client(
    { name: "yui-chat", version: version || "0.1.0" },
    { capabilities: {} },
  )
  const kind = transportKind(serverConfig)
  const configuredEnv = resolveMcpEnv(serverConfig.env)
  const scopedEnvironment = { ...process.env, ...configuredEnv }
  const headers = resolveMcpHeaders(serverConfig.headers, scopedEnvironment)
  const requestInit = Object.keys(headers).length ? { headers } : undefined
  let transport: McpTransport | null = null
  if (kind === "streamableHttp") {
    if (!serverConfig.url) throw new Error("Streamable HTTP MCP server must define url")
    const module = await importSdk("@modelcontextprotocol/sdk/client/streamableHttp.js")
    const Constructor = module.StreamableHTTPClientTransport as McpSdkModule["StreamableHTTPClientTransport"]
    if (!Constructor) throw new Error("MCP SDK 缺少 StreamableHTTPClientTransport")
    transport = new Constructor(new URL(resolveMcpUrl(serverConfig.url)), requestInit ? { requestInit } : undefined)
  } else if (kind === "sse") {
    if (!serverConfig.url || !sdk.SSEClientTransport) throw new Error("SSE MCP server must define url")
    transport = new sdk.SSEClientTransport(new URL(resolveMcpUrl(serverConfig.url)), requestInit
      ? { requestInit, eventSourceInit: { headers } }
      : undefined)
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
      env: scopedEnvironment,
    })
  }
  if (!client.connect || !transport) throw new Error(`MCP 服务 ${serverName} 的传输未创建`)
  try {
    await client.connect(transport)
  } catch (error) {
    try { await transport.close?.() } catch { /* 连接失败时仅清理临时传输。 */ }
    throw error
  }
  return { client, transport }
}

async function discoverClientTools(serverName: string, client: McpClient, serverConfig: UnknownRecord): Promise<McpDiscovery> {
  const catalog: McpDiscoveredTool[] = []
  const definitions: McpToolDefinition[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  do {
    const list = await client.listTools(cursor ? { cursor } : undefined)
    for (const tool of list.tools || []) {
      const adapter = new McpToolAdapter(serverName, client, tool, serverConfig)
      catalog.push({
        server: serverName,
        originalName: tool.name,
        name: adapter.name,
        description: adapter.description,
        exposed: isMcpToolSelected(serverConfig, tool.name),
      })
      definitions.push(tool)
    }
    cursor = list.nextCursor
    if (cursor && seenCursors.has(cursor)) throw new Error("MCP 工具分页游标重复")
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return { catalog, definitions }
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
interface McpAdapterHooks {
  reconnect?: () => Promise<McpClient | null>
  onFailure?: (error: unknown) => void
}

export class McpToolAdapter {
  readonly source = "mcp"
  readonly serverName: string
  private client: McpClient | null
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
  readonly hiddenFromModel: boolean
  readonly stickerExpressionChannel: UnknownRecord | null
  readonly pipeline: UnknownRecord | null
  readonly mcp: { serverName: string; originalName: string }
  private readonly hooks: McpAdapterHooks
  private unavailableReason = ""

  constructor(serverName: string, client: McpClient | null, tool: McpToolDefinition, serverConfig: UnknownRecord = {}, hooks: McpAdapterHooks = {}) {
    this.serverName = serverName
    this.client = client
    this.hooks = hooks
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
    this.hiddenFromModel = override.hiddenFromModel === true || serverConfig.hiddenFromModel === true
    this.stickerExpressionChannel = isRecord(override.stickerExpressionChannel)
      ? override.stickerExpressionChannel
      : isRecord(serverConfig.stickerExpressionChannel) ? serverConfig.stickerExpressionChannel : null
    this.pipeline = isRecord(override.pipeline) ? override.pipeline : isRecord(serverConfig.pipeline) ? serverConfig.pipeline : null
    this.mcp = { serverName, originalName: this.originalName }
  }

  /** 重新建立连接后复用原有工具对象，避免注册表丢失已经注入的工具。 */
  attachClient(client: McpClient): void {
    this.client = client
    this.unavailableReason = ""
  }

  /** 标记传输异常；工具定义仍保留在注册表中，下一次执行会触发恢复。 */
  markUnavailable(reason: string): void {
    this.client = null
    this.unavailableReason = reason.trim()
  }

  private async ensureClient(): Promise<McpClient> {
    if (this.client) return this.client
    if (this.hooks.reconnect) {
      const recovered = await this.hooks.reconnect()
      if (recovered) {
        this.attachClient(recovered)
        return recovered
      }
    }
    throw formatUnavailableError(this.serverName, this.originalName, this.unavailableReason)
  }

  private isReadOnly(): boolean {
    return text(this.execution.effect) === "read" || this.annotations.readOnlyHint === true
  }

  private async callTool(args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
    const client = await this.ensureClient()
    return client.callTool(
      { name: this.originalName, arguments: args },
      undefined,
      { signal: context.signal || context.agent?.signal },
    )
  }

  async execute(args: Record<string, unknown> = {}, context: ToolExecutionContext = {}): Promise<unknown> {
    // @modelcontextprotocol/sdk 1.29 的第二个参数是可选结果 schema，
    // 请求选项必须放在第三个参数；否则 signal 会被当成 schema。
    let result: unknown
    try {
      result = await this.callTool(args, context)
    } catch (error) {
      const transportFailure = isTransportFailure(error)
      if (transportFailure) this.hooks.onFailure?.(error)
      const signal = context.signal || context.agent?.signal
      // 只读查询可以安全地在连接异常后重连并重试一次；写入类工具只报告异常，
      // 避免请求已经抵达远端但回执丢失时产生重复副作用。
      if (transportFailure && !(error instanceof McpUnavailableError) && this.isReadOnly() && this.hooks.reconnect && !signal?.aborted) {
        try {
          const recovered = await this.hooks.reconnect()
          if (recovered) {
            this.attachClient(recovered)
            result = await this.callTool(args, context)
          } else {
            throw error
          }
        } catch (retryError) {
          if (isTransportFailure(retryError)) this.hooks.onFailure?.(retryError)
          throw formatUnavailableError(this.serverName, this.originalName, errorMessage(retryError))
        }
      } else {
        throw transportFailure
          ? formatUnavailableError(this.serverName, this.originalName, errorMessage(error))
          : new Error(`MCP 工具 ${this.serverName}/${this.originalName} 调用失败：${errorMessage(error)}`)
      }
    }
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
  catalog: McpDiscoveredTool[] = []
  errors: McpServerStatus[] = []
  initialized = false

  /**
   * 最近一次成功发现的定义只作为运行时缓存，不写入配置。
   * 它让短暂断线时仍能保留已经注入的工具契约；明确停用服务或全局 MCP
   * 时会清空缓存，避免把旧工具误认为仍然开放。
   */
  private readonly definitionsCache = new Map<string, McpToolDefinition[]>()
  private readonly catalogCache = new Map<string, McpDiscoveredTool[]>()
  private readonly recoveries = new Map<string, Promise<McpClient | null>>()
  private retryFailedServersTask: Promise<boolean> | null = null
  private lastRetryAt = 0

  async init(): Promise<void> {
    const config = await configStore.load()
    await this.closeConnections()
    this.tools = []
    this.catalog = []
    this.errors = []
    this.lastRetryAt = 0
    const mcp = record(config.mcp)
    if (mcp.enabled !== true) {
      this.clearCaches()
      this.initialized = false
      return
    }

    const servers = record(mcp.servers)
    let sdk: McpSdkModule
    try {
      sdk = await loadSdk()
    } catch (error) {
      const message = errorMessage(error)
      this.setError("__sdk__", message, "sdk")
      // SDK 暂时不可加载时也保留已发现的工具。执行时会返回明确异常，
      // 下一次调用仍可通过 recoverServer 重新尝试，而不会永久丢失注入状态。
      for (const [name, rawServerConfig] of Object.entries(servers)) {
        const serverConfig = record(rawServerConfig)
        if (serverConfig.enabled === false) {
          this.clearServerCache(name)
          continue
        }
        this.restoreUnavailableServer(name, serverConfig, message, "sdk")
      }
      this.clearCachesExcept(new Set(Object.keys(servers)))
      this.initialized = true
      return
    }

    for (const [name, rawServerConfig] of Object.entries(servers)) {
      const serverConfig = record(rawServerConfig)
      if (serverConfig.enabled === false) {
        this.clearServerCache(name)
        continue
      }
      let client: McpClient | null = null
      let transport: McpTransport | null = null
      let phase: McpServerStatus["phase"] = "connect"
      try {
        const connection = await connectServer(name, serverConfig, text(config.version), sdk)
        client = connection.client
        transport = connection.transport
        this.clients.set(name, client)
        this.transports.set(name, transport)
        phase = "discover"
        const discovered = await discoverClientTools(name, client, serverConfig)
        this.registerAvailableServer(name, client, discovered, serverConfig)
      } catch (error) {
        const message = errorMessage(error)
        this.clients.delete(name)
        this.transports.delete(name)
        this.restoreUnavailableServer(name, serverConfig, message, phase)
        try { await client?.close?.() } catch { /* best-effort：失败不影响主流程。 */ }
        try { await transport?.close?.() } catch { /* best-effort：失败不影响主流程。 */ }
      }
    }
    this.clearCachesExcept(new Set(Object.keys(servers)))
    this.initialized = true
  }

  getTools(): McpToolAdapter[] {
    return [...this.tools]
  }

  /**
   * 给模型工具列表、诊断和日常定格使用的轻量恢复入口。它只处理上次连接
   * 失败的服务，并用短暂冷却避免每轮对话重复建立连接；成功后调用方可以
   * 重新同步 getTools()，因此全开放模式在冷启动失败时也能恢复出工具。
   */
  async retryFailedServers(): Promise<boolean> {
    const config = await configStore.load()
    if (record(config.mcp).enabled !== true) return false
    const failedServers = [...new Set(this.errors
      .map(item => item.server)
      .filter(name => name && name !== "__sdk__"))]
    if (!failedServers.length) return false
    const running = this.retryFailedServersTask
    if (running) return running
    if (Date.now() - this.lastRetryAt < 5000) return false
    this.lastRetryAt = Date.now()
    const task = (async () => {
      let recovered = false
      for (const serverName of failedServers) {
        if (await this.recoverServer(serverName)) recovered = true
      }
      if (recovered) this.clearError("__sdk__")
      return recovered
    })()
    this.retryFailedServersTask = task
    try {
      return await task
    } finally {
      if (this.retryFailedServersTask === task) this.retryFailedServersTask = null
    }
  }

  /** 连接并发现单个服务，但不注册工具、不写配置，也不改变当前运行连接。 */
  async testServer(serverName: string, serverConfig: UnknownRecord): Promise<{ server: string; catalog: McpDiscoveredTool[]; exposed: string[]; elapsedMs: number }> {
    const startedAt = Date.now()
    const config = await configStore.load()
    const sdk = await loadSdk()
    const connection = await connectServer(serverName, serverConfig, text(config.version), sdk)
    try {
      const { catalog } = await discoverClientTools(serverName, connection.client, serverConfig)
      return {
        server: serverName,
        catalog,
        exposed: catalog.filter(item => item.exposed).map(item => item.originalName),
        elapsedMs: Date.now() - startedAt,
      }
    } finally {
      try { await connection.client.close?.() } catch { /* 测试连接结束时尽力关闭客户端。 */ }
      try { await connection.transport.close?.() } catch { /* 测试连接结束时尽力关闭传输。 */ }
    }
  }

  status(): UnknownRecord {
    return {
      initialized: this.initialized,
      clients: [...this.clients.keys()],
      tools: this.tools.map(tool => tool.name),
      catalog: this.catalog.map(tool => ({ ...tool })),
      errors: [...this.errors],
    }
  }

  async destroy(): Promise<void> {
    await this.closeConnections(true)
    this.tools = []
    this.catalog = []
    this.clearCaches()
    this.retryFailedServersTask = null
    this.lastRetryAt = 0
    this.initialized = false
  }

  private clearCaches(): void {
    this.definitionsCache.clear()
    this.catalogCache.clear()
  }

  private clearCachesExcept(servers: Set<string>): void {
    for (const name of this.definitionsCache.keys()) if (!servers.has(name)) this.definitionsCache.delete(name)
    for (const name of this.catalogCache.keys()) if (!servers.has(name)) this.catalogCache.delete(name)
  }

  private clearServerCache(serverName: string): void {
    this.definitionsCache.delete(serverName)
    this.catalogCache.delete(serverName)
    this.tools = this.tools.filter(tool => tool.serverName !== serverName)
    this.catalog = this.catalog.filter(tool => tool.server !== serverName)
    this.errors = this.errors.filter(item => item.server !== serverName)
  }

  private async closeConnections(recordErrors = false): Promise<void> {
    for (const [name, client] of this.clients) {
      try { await client.close?.() } catch (error) {
        if (recordErrors) this.setError(name, errorMessage(error), "connect")
      }
    }
    for (const [name, transport] of this.transports) {
      try { await transport.close?.() } catch (error) {
        if (recordErrors) this.setError(name, errorMessage(error), "connect")
      }
    }
    this.clients.clear()
    this.transports.clear()
  }

  private setError(server: string, error: string, phase: McpServerStatus["phase"] = "connect"): void {
    this.errors = this.errors.filter(item => item.server !== server)
    this.errors.push({ server, error, phase, updatedAt: new Date().toISOString() })
  }

  private clearError(server: string): void {
    this.errors = this.errors.filter(item => item.server !== server)
  }

  private adapterHooks(serverName: string): McpAdapterHooks {
    return {
      reconnect: () => this.recoverServer(serverName),
      onFailure: error => this.noteRuntimeFailure(serverName, error),
    }
  }

  private registerAvailableServer(serverName: string, client: McpClient, discovered: McpDiscovery, serverConfig: UnknownRecord): void {
    const lastSeenAt = new Date().toISOString()
    const catalog = discovered.catalog.map(item => ({ ...item, status: "available" as const, lastSeenAt }))
    this.definitionsCache.set(serverName, discovered.definitions.slice())
    this.catalogCache.set(serverName, catalog.map(item => ({ ...item })))
    this.catalog.push(...catalog)
    for (const tool of discovered.definitions.filter(item => isMcpToolSelected(serverConfig, item.name))) {
      this.tools.push(new McpToolAdapter(serverName, client, tool, serverConfig, this.adapterHooks(serverName)))
    }
    this.clearError(serverName)
  }

  private restoreUnavailableServer(serverName: string, serverConfig: UnknownRecord, reason: string, phase: McpServerStatus["phase"] = "reconnect"): void {
    const definitions = this.definitionsCache.get(serverName) || this.configuredFallbackDefinitions(serverConfig)
    const cachedCatalog = this.catalogCache.get(serverName) || []
    const catalog = cachedCatalog.length
      ? cachedCatalog.map(item => ({ ...item, status: "unavailable" as const, error: reason }))
      : definitions.map(tool => {
        const adapter = new McpToolAdapter(serverName, null, tool, serverConfig, this.adapterHooks(serverName))
        return {
          server: serverName,
          originalName: tool.name,
          name: adapter.name,
          description: adapter.description,
          exposed: isMcpToolSelected(serverConfig, tool.name),
          status: "unavailable" as const,
          error: reason,
        }
      })
    this.catalog.push(...catalog)
    for (const tool of definitions.filter(item => isMcpToolSelected(serverConfig, item.name))) {
      const adapter = new McpToolAdapter(serverName, null, tool, serverConfig, this.adapterHooks(serverName))
      adapter.markUnavailable(reason)
      this.tools.push(adapter)
    }
    this.setError(serverName, reason, phase)
  }

  /**
   * 冷启动首次连接失败时没有历史 tools/list 可复用，但名单模式和工具策略
   * 已经明确给出了工具名。先用宽松入参注册待恢复适配器，连接恢复后会用
   * 服务端最新定义更新目录；这样后续模型/定格触发本身就能成为重连机会。
   */
  private configuredFallbackDefinitions(serverConfig: UnknownRecord): McpToolDefinition[] {
    const names = new Set<string>()
    if (Array.isArray(serverConfig.allowedTools)) {
      for (const name of serverConfig.allowedTools) {
        const value = text(name).trim()
        if (value) names.add(value)
      }
    }
    for (const name of Object.keys(record(serverConfig.toolPolicies))) names.add(name)
    return [...names].map(name => ({
      name,
      description: `MCP 工具 ${name}（服务暂时不可用，恢复后重新发现参数）`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    }))
  }

  private noteRuntimeFailure(serverName: string, error: unknown, phase: McpServerStatus["phase"] = "execute"): void {
    const reason = errorMessage(error)
    this.setError(serverName, reason, phase)
    for (const tool of this.tools) {
      if (tool.serverName === serverName) tool.markUnavailable(reason)
    }
    const client = this.clients.get(serverName)
    const transport = this.transports.get(serverName)
    this.clients.delete(serverName)
    this.transports.delete(serverName)
    void Promise.resolve().then(() => client?.close?.()).catch(() => {})
    void Promise.resolve().then(() => transport?.close?.()).catch(() => {})
    this.catalog = this.catalog.map(item => item.server === serverName
      ? { ...item, status: "unavailable", error: reason }
      : item)
  }

  /**
   * 单个工具执行期间的按需恢复。使用按服务器去重的 Promise，避免并发消息
   * 同时创建多个连接；成功后直接把客户端挂回原适配器对象。
   */
  private async recoverServer(serverName: string): Promise<McpClient | null> {
    const running = this.recoveries.get(serverName)
    if (running) return running
    const task = this.recoverServerNow(serverName)
    this.recoveries.set(serverName, task)
    try {
      return await task
    } finally {
      if (this.recoveries.get(serverName) === task) this.recoveries.delete(serverName)
    }
  }

  private async recoverServerNow(serverName: string): Promise<McpClient | null> {
    const config = await configStore.load()
    const mcp = record(config.mcp)
    const servers = record(mcp.servers)
    const serverConfig = record(servers[serverName])
    if (mcp.enabled !== true || !Object.keys(serverConfig).length || serverConfig.enabled === false) return null
    let freshConnection: { client: McpClient; transport: McpTransport } | null = null
    try {
      const sdk = await loadSdk()
      freshConnection = await connectServer(serverName, serverConfig, text(config.version), sdk)
      const discovered = await discoverClientTools(serverName, freshConnection.client, serverConfig)
      const oldClient = this.clients.get(serverName)
      const oldTransport = this.transports.get(serverName)
      this.clients.set(serverName, freshConnection.client)
      this.transports.set(serverName, freshConnection.transport)
      const lastSeenAt = new Date().toISOString()
      const catalog = discovered.catalog.map(item => ({ ...item, status: "available" as const, lastSeenAt }))
      this.definitionsCache.set(serverName, discovered.definitions.slice())
      this.catalogCache.set(serverName, catalog.map(item => ({ ...item })))
      this.catalog = [...this.catalog.filter(item => item.server !== serverName), ...catalog]
      const selected = new Map(discovered.definitions
        .filter(item => isMcpToolSelected(serverConfig, item.name))
        .map(item => [item.name, item]))
      const current = this.tools.filter(tool => tool.serverName === serverName)
      for (const tool of current) {
        const definition = selected.get(tool.originalName)
        if (definition) tool.attachClient(freshConnection.client)
        else tool.markUnavailable("工具已不在服务端的最新发现列表中")
      }
      for (const [name, definition] of selected) {
        if (!current.some(tool => tool.originalName === name)) {
          this.tools.push(new McpToolAdapter(serverName, freshConnection.client, definition, serverConfig, this.adapterHooks(serverName)))
        }
      }
      this.clearError(serverName)
      if (oldClient && oldClient !== freshConnection.client) void Promise.resolve().then(() => oldClient.close?.()).catch(() => {})
      if (oldTransport && oldTransport !== freshConnection.transport) void Promise.resolve().then(() => oldTransport.close?.()).catch(() => {})
      return freshConnection.client
    } catch (error) {
      if (freshConnection) {
        try { await freshConnection.client.close?.() } catch { /* 恢复发现失败时仅清理临时连接。 */ }
        try { await freshConnection.transport.close?.() } catch { /* 恢复发现失败时仅清理临时传输。 */ }
      }
      this.noteRuntimeFailure(serverName, error, "reconnect")
      return null
    }
  }
}

export const mcpManager = new McpManager()
