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
import { backgroundTaskService, type PublicBackgroundTask } from "../../core/scheduling/background-task-service.js"
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

/** 所有工具来源共用的注册表；只保存已归一化工具，不暴露原始动态对象。 */
export class ToolRegistry {
  readonly tools = new Map<string, NormalizedTool>()
  skillErrors: unknown[] = []
  customErrors: unknown[] = []
  registryErrors: RegistryError[] = []

  async init(): Promise<void> {
    this.tools.clear()
    this.registryErrors = []
    for (const tool of createBuiltinTools()) this.register(tool)
    const custom = await customToolManager.loadTools()
    this.customErrors = custom.errors
    for (const tool of custom.tools) this.register(tool)
    await mcpManager.init()
    for (const tool of mcpManager.getTools()) this.register(tool)
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
    return this.tools.get(name) || null
  }

  async list(context: RegistryExecutionContext | null = null): Promise<UnknownRecord[]> {
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
    const tool = this.tools.get(name)
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
      const runObservation = record(runContext.observability)
      const runTrace = runObservation.trace || observation.trace || null
      return tool.execute(toolArgs, {
        ...runContext,
        config,
        toolConfig,
        observability: {
          ...runObservation,
          trace: runTrace,
          toolCallId: text(runObservation.toolCallId || observation.toolCallId),
          modelCallId: text(runObservation.modelCallId || observation.modelCallId || record(runTrace).currentModelCallId),
        },
      })
    }
    if (execution.background && context.execution?.background !== false) {
      const task = backgroundTaskService.submit({
        name,
        runId: traceId(context),
        parentToolId: text(observation.toolCallId),
        config,
        execute: signal => invoke({
          ...context,
          agent: { ...record(context.agent), signal },
          signal,
          execution: { ...context.execution, background: false },
        }),
        onComplete: context.execution?.onBackgroundComplete,
      })
      return {
        status: "accepted",
        content: `已加入后台任务：${task.id}`,
        executedCount: 1,
        dispatched: true,
        retryAllowed: false,
        metadata: { background: true, taskId: task.id, parentToolId: task.parentToolId },
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
