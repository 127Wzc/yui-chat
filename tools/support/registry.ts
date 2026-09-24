import { configStore } from "../../config/store.js"
import type { RuntimeConfigObject } from "../../config/types.js"
import { mcpManager } from "../../mcp/index.js"
import { skillManager } from "../../skills/index.js"
import { createBuiltinTools } from "../builtins/index.js"
import { customToolManager } from "../custom/manager.js"
import {
  getToolCommon,
  isToolEnabledByConfig,
  modelToolLoadingGuide,
  normalizeTool,
  resolveToolExecutionPolicy,
  toolExecutionEffects,
  toolProvenance,
  toolSource,
  validateToolArguments,
  type NormalizedTool,
} from "./contract.js"
import { assertToolAllowed, explainToolPolicy, type ToolAccessContext } from "../access/policy.js"
import { buildToolAccessMatrix, type AccessMatrixOptions } from "../access/matrix.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { applyToolRuntimeConfigUpdate, maskToolRuntimeConfig, resolveToolRuntimeConfig } from "../../extensions/runtime-config.js"
import { backgroundTaskService, type BackgroundTaskLimitsProvider, type PublicBackgroundTask } from "../../core/scheduling/background-task-service.js"
import { modelToolAllowed } from "../../models/configuration/tool-policy.js"
import { normalizeEventScope } from "../../core/message/event-scope.js"
import type { ToolExecutionContext } from "./tool-contract.js"

type UnknownRecord = Record<string, unknown>

export interface RegistryExecutionContext extends ToolExecutionContext, ToolAccessContext {
  config?: RuntimeConfigObject
  excludeDeliveryModes?: string[]
  execution?: ToolExecutionContext["execution"] & {
    onBackgroundComplete?: (task: PublicBackgroundTask) => Promise<unknown> | unknown
  }
}

interface RegistryError {
  tool: string
  kept: string
  skipped: string
  message: string
}

class ToolArgumentError extends Error {
  readonly code = "TOOL_ARGUMENTS_INVALID"
  readonly retryAllowed = false
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

function traceId(context: RegistryExecutionContext): string {
  const observability = record(context.observability)
  const trace = record(observability.trace)
  return text(trace.id)
}

function catalogItems(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}

interface BackgroundQueueDescriptor {
  queueKey?: unknown
  channelId?: unknown
  maxConcurrent?: unknown
  maxQueue?: unknown
  retentionMs?: unknown
  limitsProvider?: BackgroundTaskLimitsProvider | null
}

function resolveBackgroundQueue(tool: NormalizedTool, args: UnknownRecord, context: RegistryExecutionContext, config: RuntimeConfigObject, toolConfig: Readonly<UnknownRecord>): BackgroundQueueDescriptor {
  const resolver = (tool as UnknownRecord).backgroundQueue
  if (typeof resolver !== "function") return {}
  try {
    const value = (resolver as (toolArgs: UnknownRecord, resolverContext: UnknownRecord) => unknown).call(tool, args, { ...context, config, toolConfig })
    const source = record(value)
    return {
      queueKey: source.queueKey,
      channelId: source.channelId,
      maxConcurrent: source.maxConcurrent,
      maxQueue: source.maxQueue,
      retentionMs: source.retentionMs,
      limitsProvider: typeof source.limitsProvider === "function" ? source.limitsProvider as BackgroundTaskLimitsProvider : null,
    }
  } catch (error) {
    hostRuntime.logger?.warn?.(`[yui-chat] 工具 ${tool.name} 后台队列配置读取失败`, error)
    return {}
  }
}

/** 所有工具来源共用的注册表；只保存已归一化工具，不暴露原始动态对象。 */
export class ToolRegistry {
  readonly tools = new Map<string, NormalizedTool>()
  skillErrors: unknown[] = []
  customErrors: unknown[] = []
  registryErrors: RegistryError[] = []
  private mcpToolsRevision = mcpManager.toolsRevision

  async init(): Promise<void> {
    this.tools.clear()
    this.registryErrors = []
    for (const tool of createBuiltinTools()) this.register(tool)
    const custom = await customToolManager.loadTools()
    this.customErrors = custom.errors
    for (const tool of custom.tools) this.register(tool)
    await mcpManager.init()
    for (const tool of mcpManager.getTools()) this.register(tool)
    this.mcpToolsRevision = mcpManager.toolsRevision
    await skillManager.refresh()
    this.skillErrors = skillManager.errors
    if (this.registryErrors.length) {
      hostRuntime.logger?.warn?.(
        `[yui-chat] ${this.registryErrors.length} 个同名工具被跳过：${this.registryErrors.map(item => item.tool).join(", ")}`,
      )
    }
  }

  async destroy(): Promise<void> {
    await customToolManager.dispose()
    await mcpManager.destroy()
    this.tools.clear()
    this.customErrors = []
    this.skillErrors = []
    this.registryErrors = []
  }

  /** MCP 首次连接失败时，在后续异步能力入口主动尝试恢复并同步新发现工具。 */
  async refreshMcpIfNeeded(): Promise<boolean> {
    const recovered = await mcpManager.retryFailedServers()
    const synchronized = this.syncMcpTools()
    return recovered || synchronized
  }

  private syncMcpTools(): boolean {
    if (this.mcpToolsRevision === mcpManager.toolsRevision) return false
    this.removeBySource("mcp")
    for (const tool of mcpManager.getTools()) this.register(tool)
    this.mcpToolsRevision = mcpManager.toolsRevision
    return true
  }

  /** 进入注册表时立即完成公共契约归一化；不合格工具不会进入执行集合。 */
  register(tool: unknown): void {
    const normalized = normalizeTool(tool)
    if (!normalized) return
    const existing = this.tools.get(normalized.name)
    if (existing) {
      this.registryErrors.push({
        tool: normalized.name,
        kept: toolSource(existing),
        skipped: toolSource(normalized),
        message: `工具 ${normalized.name} 已由 ${toolSource(existing)} 注册，跳过 ${toolSource(normalized)} 的同名工具`,
      })
      return
    }
    this.tools.set(normalized.name, normalized)
  }

  removeBySource(source: string): number {
    let count = 0
    for (const [name, tool] of this.tools) {
      if (toolSource(tool) === source) {
        this.tools.delete(name)
        count++
      }
    }
    return count
  }

  get(name: string): NormalizedTool | null {
    this.syncMcpTools()
    return this.tools.get(name) || null
  }

  async list(context: RegistryExecutionContext | null = null): Promise<UnknownRecord[]> {
    await this.refreshMcpIfNeeded()
    const config = await configStore.load()
    const toolsConfig = record(config.tools)
    const runtimeVariables = record(toolsConfig.runtimeVariables)
    return [...this.tools.values()].map(tool => {
      const modelGuide = modelToolLoadingGuide(tool)
      const common = getToolCommon(tool)
      return {
        name: tool.name,
        enabled: isToolEnabledByConfig(config, tool),
        common: {
          ...common,
          tags: stringList(common.tags),
          policy: { ...record(common.policy) },
          provenance: { ...toolProvenance(tool) },
        },
        runtimeConfig: maskToolRuntimeConfig(tool, runtimeVariables[tool.name]),
        modelDefinition: modelGuide.definition,
        modelPrompt: modelGuide.serialized,
        modelPromptCharacters: modelGuide.characters,
        modelTokenEstimate: modelGuide.estimatedTokens,
        modelPromptNote: modelGuide.note,
        ...(context ? { access: explainToolPolicy(tool, context) } : {}),
      }
    })
  }

  async getEnabledTools(config: RuntimeConfigObject | null = null): Promise<NormalizedTool[]> {
    await this.refreshMcpIfNeeded()
    const current = config || await configStore.load()
    if (record(current.tools).enabled !== true) return []
    return [...this.tools.values()].filter(tool => isToolEnabledByConfig(current, tool))
  }

  async getAllowedTools(context: RegistryExecutionContext = {}): Promise<NormalizedTool[]> {
    const enabledTools = await this.getEnabledTools(context.config || null)
    const excludedDeliveryModes = new Set(stringList(context.excludeDeliveryModes))
    return enabledTools.filter(tool => {
      const common = getToolCommon(tool)
      if (common.hiddenFromModel === true) return false
      if (excludedDeliveryModes.has(text(common.delivery || "silent"))) return false
      try {
        assertToolAllowed(tool, context)
        return true
      } catch {
        return false
      }
    })
  }

  // 按名字取工具（用于子代理的独立工具集）：仍经过权限校验，但不受 enabledTools 限制。
  getToolsByNames(names: string[] = [], context: RegistryExecutionContext = {}): NormalizedTool[] {
    this.syncMcpTools()
    const wanted = new Set(names)
    return [...this.tools.values()].filter(tool => {
      if (!wanted.has(tool.name)) return false
      if (getToolCommon(tool).hiddenFromModel === true) return false
      try {
        assertToolAllowed(tool, context)
        return true
      } catch {
        return false
      }
    })
  }

  async searchAllowedTools(query = "", context: RegistryExecutionContext = {}, limit = 8): Promise<UnknownRecord[]> {
    const allowed = await this.getAllowedTools(context)
    const normalizedQuery = text(query).toLowerCase()
    const terms = [...new Set([
      ...(normalizedQuery.match(/[\p{Script=Han}]/gu) || []),
      ...(normalizedQuery.match(/[a-z0-9][a-z0-9_-]{1,}/g) || []),
    ])]
    const score = (tool: NormalizedTool): number => {
      const common = getToolCommon(tool)
      const provenance = toolProvenance(tool)
      const haystack = `${tool.name} ${text(common.description)} ${text(common.descriptionZh)} ${stringList(common.tags).join(" ")} ${text(provenance.serverDescription)}`.toLowerCase()
      return terms.reduce((total, term) => total + (haystack.includes(term) ? Math.min(10, term.length + 2) : 0), 0)
    }
    return allowed
      .map(tool => ({ tool, score: score(tool) }))
      .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
      .map(({ tool, score: matchedScore }) => {
        const common = getToolCommon(tool)
        return {
          name: tool.name,
          score: matchedScore,
          description: common.description,
          descriptionZh: common.descriptionZh,
          category: common.category,
          source: common.source,
          risk: common.risk,
          tags: stringList(common.tags),
          parameters: common.parameters,
        }
      })
  }

  /** 执行前完成权限、参数、派发标记和后台队列接入。 */
  async execute(name: string, args: unknown = {}, context: RegistryExecutionContext = {}): Promise<unknown> {
    const tool = this.get(name)
    if (context.e && typeof context.e === "object") normalizeEventScope(context.e as UnknownRecord)
    const observation = record(context.observability)
    if (!tool) throw new Error(`Tool ${name} not found`)
    assertToolAllowed(tool, context)
    const config = context.config || configStore.get()
    const toolConfig = resolveToolRuntimeConfig(tool, config)
    const execution = resolveToolExecutionPolicy(tool, args).execution
    const toolArgs = record(args)
    const validation = validateToolArguments(tool, toolArgs)
    if (!validation.ok) throw new ToolArgumentError(`工具参数无效：${validation.issues.join("；")}`)

    // 派发标记时机由契约声明，而不是按工具名白名单：deferred 的工具自己
    // 在真正把请求交给宿主前调用 markDispatched，这样纯参数错误仍可被
    // 安全纠正一次，而结果不确定的副作用不会被重复执行。
    if (execution.effect !== toolExecutionEffects.read && execution.dispatchMarking !== "deferred") {
      context.execution?.markDispatched?.()
    }
    const invoke = async (runContext: RegistryExecutionContext = context): Promise<unknown> => {
      await runContext.execution?.beforeInvoke?.()
      const activeConfig = runContext.execution?.beforeInvoke ? configStore.get() : config
      const activeToolConfig = runContext.execution?.beforeInvoke ? resolveToolRuntimeConfig(tool, activeConfig) : toolConfig
      if (runContext.execution?.beforeInvoke) assertToolAllowed(tool, { ...runContext, config: activeConfig })
      const runObservation = record(runContext.observability)
      const runTrace = runObservation.trace || observation.trace || null
      return tool.execute(toolArgs, {
        ...runContext,
        config: activeConfig,
        toolConfig: activeToolConfig,
        observability: {
          ...runObservation,
          trace: runTrace,
          toolCallId: text(runObservation.toolCallId || observation.toolCallId),
          modelCallId: text(runObservation.modelCallId || observation.modelCallId || record(runTrace).currentModelCallId),
        },
      })
    }
    if (execution.backgroundSilent && context.execution?.background !== false) {
      const deadline = Date.now() + execution.timeoutMs
      let task: PublicBackgroundTask | undefined
      try {
        const queue = resolveBackgroundQueue(tool, toolArgs, context, config, toolConfig)
        task = backgroundTaskService.submit({
          name, runId: traceId(context), parentToolId: text(observation.toolCallId), config,
          ...queue,
          execute: async queueSignal => {
            if (Date.now() >= deadline) throw new Error("后台静默任务已过期")
            const signal = AbortSignal.any([queueSignal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
            const ensureAllowed = async () => {
              await context.execution?.beforeInvoke?.()
              signal.throwIfAborted()
              if (this.get(name) !== tool) throw new Error("后台工具已停用或重新加载")
              assertToolAllowed(tool, { ...context, config: configStore.get() })
            }
            const run = async () => {
              await ensureAllowed()
              const value = await invoke({
                ...context, signal, agent: { ...record(context.agent), signal },
                execution: { background: false, beforeInvoke: ensureAllowed },
              })
              await ensureAllowed()
              const result = record(value)
              if (result.isError === true || ["error", "failed"].includes(text(result.status)) || result.kind === "error") {
                throw new Error("后台工具返回失败结果")
              }
              const plan = record(record(result.metadata).messageSendPlan)
              if (record(getToolCommon(tool).autoDelivery).via === "message_send" && Array.isArray(plan.parts) && plan.parts.length) {
                if (!modelToolAllowed(record(context.channel).modelConfig, "message_send")) throw new Error("模型策略不允许后台投递")
                const agentTools = record(context.agent).allowedTools
                if (Array.isArray(agentTools) && !agentTools.includes("message_send")) throw new Error("当前代理不允许后台投递")
                const { executeDirectTool } = await import("./direct-execution.js")
                const delivery = await executeDirectTool("message_send", { parts: plan.parts }, {
                  ...context, config: configStore.get(), signal,
                  ...(context.actionId ? { actionDelivery: true } : {}),
                  agent: { ...record(context.agent), signal },
                  execution: { background: false, beforeInvoke: ensureAllowed },
                }, this)
                if (delivery.status !== "success") throw new Error("后台媒体投递失败")
                return { result: value, delivery: delivery.value }
              }
              return value
            }
            // 超时释放队列槽位；协作式取消信号同时传入工具和投递边界。
            return await new Promise((resolve, reject) => {
              const abort = () => reject(new Error("后台静默任务已取消或超时"))
              signal.addEventListener("abort", abort, { once: true })
              if (signal.aborted) { abort(); return }
              run().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
            })
          },
          onComplete: context.execution?.onBackgroundComplete,
        })
      } catch {
        // 装饰性动作允许在队列关闭或已满时丢弃，不让模型重试或打断主对话。
        hostRuntime.logger?.warn?.(`[yui-chat] 后台静默工具 ${name} 未入队`)
      }
      return {
        status: "accepted", content: "后台静默任务已处理；继续主对话，不等待、不汇报、不重复调用。",
        retryAllowed: false,
        metadata: { background: true, backgroundSilent: true, taskId: task?.id || "", backgroundStatus: task?.status || "dropped" },
      }
    }
    if (execution.background && context.execution?.background !== false) {
      const queue = resolveBackgroundQueue(tool, toolArgs, context, config, toolConfig)
      const task = backgroundTaskService.submit({
        name,
        runId: traceId(context),
        parentToolId: text(observation.toolCallId),
        config,
        queueKey: queue.queueKey,
        maxConcurrent: queue.maxConcurrent,
        maxQueue: queue.maxQueue,
        retentionMs: queue.retentionMs,
        limitsProvider: queue.limitsProvider,
        execute: signal => invoke({
          ...context,
          ...(queue.channelId ? { backgroundChannelId: text(queue.channelId) } : {}),
          agent: { ...record(context.agent), signal },
          signal,
          execution: { ...context.execution, background: false },
        }),
        onComplete: context.execution?.onBackgroundComplete,
      })
      if (execution.dispatchMarking === "deferred") context.execution?.markDispatched?.()
      const configuredBackgroundMessage = record(tool).backgroundMessage
      const requestedBackgroundMessage = typeof configuredBackgroundMessage === "string" && typeof toolArgs.startMessage === "string"
        ? toolArgs.startMessage.replace(/\s+/g, " ").trim().slice(0, 80)
        : ""
      const backgroundMessage = requestedBackgroundMessage
        || (typeof configuredBackgroundMessage === "string" ? configuredBackgroundMessage.trim().slice(0, 300) : "")
      // startMessage 只接收单行、简短的“任务已开始”提示，不得声称任务完成。
      // 需要最终回复时直接采用该提示，避免模型再生成一条重复确认。
      const autoSendBackgroundMessage = backgroundMessage && getToolCommon(tool).requiresFinalReply === false
      return {
        status: "accepted",
        content: backgroundMessage || `已加入后台任务：${task.id}`,
        executedCount: 1,
        dispatched: true,
        retryAllowed: false,
        metadata: {
          background: true,
          taskId: task.id,
          backgroundStatus: task.status,
          parentToolId: task.parentToolId,
          ...(autoSendBackgroundMessage && typeof record(context.e).reply === "function"
            ? { messageSendPlan: { parts: [{ type: "text", text: backgroundMessage }] } }
            : {}),
        },
      }
    }
    return invoke({
      ...context,
      observability: {
        ...observation,
        trace: observation.trace || null,
        toolCallId: text(observation.toolCallId),
        modelCallId: text(observation.modelCallId || record(observation.trace).currentModelCallId),
      },
    })
  }

  // 整体替换 + 校验运行变量；secret 占位值表示保留现值。
  applyRuntimeConfigUpdate(name: string, incoming: unknown, current: unknown): UnknownRecord {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Tool ${name} not found`)
    return applyToolRuntimeConfigUpdate(tool, incoming, current)
  }

  mcpStatus(): UnknownRecord {
    const config = configStore.get()
    const mcp = record(config.mcp)
    const servers = record(mcp.servers)
    return {
      enabled: mcp.enabled === true,
      ...mcpManager.status(),
      servers: Object.entries(servers).map(([name, rawValue]) => {
        const value = record(rawValue)
        return {
          name,
          enabled: value.enabled !== false,
          transport: value.transport || value.type || (value.url ? "sse" : value.command ? "stdio" : "unknown"),
        }
      }),
    }
  }

  customStatus(): UnknownRecord {
    const packageTools = new Map<string, UnknownRecord[]>()
    for (const tool of this.tools.values()) {
      const common = getToolCommon(tool)
      if (common.source !== "custom") continue
      const key = text(toolProvenance(tool).packageId) || "unknown"
      if (!packageTools.has(key)) packageTools.set(key, [])
      packageTools.get(key)?.push({ name: tool.name, common: { ...common, provenance: { ...toolProvenance(tool) } } })
    }
    const catalog = customToolManager.catalog.map(item => ({ ...item, loadedTools: packageTools.get(text(item.id)) || [] }))
    return {
      catalog,
      loaded: [...this.tools.values()].filter(tool => toolSource(tool) === "custom").map(tool => tool.name),
      errors: [...this.customErrors, ...this.registryErrors.filter(item => item.skipped === "custom")],
    }
  }

  skillStatus(): UnknownRecord {
    const catalog = skillManager.catalog.map(item => ({ ...item, loadedTools: [] }))
    return {
      catalog,
      loaded: skillManager.catalog.filter(item => item.enabled === true && record(item.validation).ok === true).map(item => text(item.id)),
      errors: [...this.skillErrors],
    }
  }

  extensionDigest(): UnknownRecord {
    const tools = [...this.tools.values()]
    const custom = this.customStatus()
    const skills = this.skillStatus()
    const mcp = this.mcpStatus()
    const bySource = (source: string): NormalizedTool[] => tools.filter(tool => toolSource(tool) === source)
    const catalogSummary = (value: unknown): UnknownRecord => {
      const catalog = catalogItems(value)
      return {
        packages: catalog.length,
        enabled: catalog.filter(item => item.enabled === true).length,
        invalid: catalog.filter(item => record(item.validation).ok === false).length,
        withWarnings: catalog.filter(item => stringList(record(item.validation).warnings).length > 0).length,
      }
    }
    const customCatalog = catalogItems(custom.catalog)
    const skillCatalog = catalogItems(skills.catalog)
    const mcpServers = Array.isArray(mcp.servers) ? mcp.servers : []
    const mcpClients = Array.isArray(mcp.clients) ? mcp.clients : []
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalTools: tools.length,
        customTools: bySource("custom").length,
        markdownSkills: skillCatalog.filter(item => item.enabled === true && record(item.validation).ok === true).length,
        mcpTools: bySource("mcp").length,
        customPackages: customCatalog.length,
        skillPackages: skillCatalog.length,
        mcpServers: mcpServers.length,
        mcpClients: mcpClients.length,
        errors: [
          ...catalogItems(custom.errors),
          ...catalogItems(skills.errors),
          ...catalogItems(mcp.errors),
          ...this.registryErrors,
        ].length,
      },
      custom: { ...catalogSummary(custom.catalog), loadedTools: custom.loaded || [], errors: custom.errors || [], catalog: custom.catalog || [] },
      skills: { ...catalogSummary(skills.catalog), loadedTools: skills.loaded || [], errors: skills.errors || [], catalog: skills.catalog || [] },
      mcp: {
        enabled: mcp.enabled === true,
        initialized: mcp.initialized === true,
        servers: mcp.servers || [],
        clients: mcp.clients || [],
        loadedTools: mcp.tools || [],
        errors: mcp.errors || [],
      },
    }
  }

  async accessMatrix(options: AccessMatrixOptions = {}): Promise<UnknownRecord> {
    return buildToolAccessMatrix([...this.tools.values()], options)
  }
}

export const toolRegistry = new ToolRegistry()
