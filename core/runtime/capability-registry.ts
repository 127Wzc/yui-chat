import { configStore } from "../../config/store.js"
import { commandObserver } from "../../knowledge/command-observer.js"
import { memoryStore } from "../../memory/store.js"
import { toolRegistry } from "../../tools/support/registry.js"
import { chatService } from "../chat/chat-service.js"
import { recentContextStore } from "../chat/recent-context.js"
import { providerResolver } from "../../models/routing/provider-resolver.js"
import { buildPersonaDigest } from "../persona/persona-digest.js"
import { renderKindCatalog } from "../rendering/render-service.js"
import { getToolCommon } from "../../tools/support/contract.js"

type UnknownRecord = Record<string, unknown>

interface CapabilityDefinition extends UnknownRecord {
  id: string
  label: string
  layer: string
  owner: string
  configPaths: string[]
  commands: string[]
  apis: string[]
  description: string
}

interface CapabilityRuntime extends UnknownRecord {
  tools: {
    total: number
    enabled: number
    custom: number
    skill: number
    mcp: number
  }
  knowledge: UnknownRecord
  memory: UnknownRecord
  conversations: UnknownRecord
  context: UnknownRecord
  modelRouting: unknown
  persona: unknown
  extensions: unknown
  render: {
    kinds: number
    catalog: unknown
  }
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

const capabilityDefinitions: CapabilityDefinition[] = [
  {
    id: "first-person",
    label: "第一人称对话链路",
    layer: "core",
    owner: "core/first-person-service.js",
    configPaths: ["persona", "persona.trigger", "persona.output", "persona.initiativeGreeting", "response.segmentation", "chat.access", "context"],
    commands: ["#yui第一人称", "#yui设置AI第一人称xxx", "#yui第一人称概率20", "#yui第一人称戳一戳关闭", "#yui打招呼", "#yui本群闭嘴10分钟"],
    apis: ["/api/config", "/api/diagnostics"],
    description: "可编辑角色设定与系统运行规则、第一人称直呼/@/戳一戳触发、伪人概率参与、主动问候、文本/语音/图片回复、文本分段、群聊上下文和访问控制。",
  },
  {
    id: "model-workflows",
    label: "模型供应商与路由",
    layer: "models",
    owner: "models/routing/provider-resolver.js",
    configPaths: ["apiProviders", "models", "modelTasks", "chat.defaultTask", "mediaRecognition.recognitionModel"],
    commands: ["#yuichat"],
    apis: ["/api/providers", "/api/channels/test"],
    description: "自定义供应商、主回复模型任务、fallback 渠道和媒体识别增强模型。",
  },
  {
    id: "web-management",
    label: "独立 Web 管理端",
    layer: "web",
    owner: "web/http/app.js",
    configPaths: ["web.mountPath", "web.authToken", "web.publicBaseUrl", "web.publicBaseUrls"],
    commands: ["#yui面板"],
    apis: ["/", "/api/health", "/api/auth/quick-login", "/api/config", "/api/config/auth-token", "/api/config/backups", "/api/config/restore", "/api/runtime/cleanup-cache"],
    description: "挂载到 Yunzai 本体路由，支持主人命令签发一次性快捷登录、可选静态 token、浏览器短会话、手动配置包和校验回滚。",
  },
  {
    id: "tools-skills-mcp",
    label: "工具 / Skill / MCP",
    layer: "tools",
    owner: "tools/support/registry.js",
    configPaths: ["tools.enabledTools", "tools.boundaryAccess", "tools.policy", "mcp.servers"],
    commands: ["#yui工具权限", "#yui渲染帮助"],
    apis: ["/api/tools", "/api/tools/access-matrix", "/api/extensions", "/api/custom-tools", "/api/skills", "/api/mcp"],
    description: "内置工具、Custom/Skill 扩展、MCP 工具注册和权限矩阵。",
  },
  {
    id: "command-knowledge",
    label: "指令知识库",
    layer: "knowledge",
    owner: "knowledge/command-observer.js",
    configPaths: ["knowledge", "context.ignoreCommands"],
    commands: ["#yuihelp 怎么查体力"],
    apis: ["/api/knowledge", "/api/knowledge/digest", "/api/knowledge/quality", "/api/knowledge/rescan"],
    description: "静态扫描 Yunzai 已加载规则和帮助文档，旁路记录真实指令触发，供 AI 推荐命令，并审计索引质量。",
  },
  {
    id: "memory-context",
    label: "长期记忆与上下文",
    layer: "memory",
    owner: "memory/store.js",
    configPaths: ["memory", "context"],
    commands: [],
    apis: ["/api/memory", "/api/memory/captures", "/api/conversations"],
    description: "用户事实、episode、指定群本地消息采集、异步事实提炼、最近群聊上下文和第一人称链路注入。",
  },
  {
    id: "media-render-output",
    label: "媒体识别与图片渲染",
    layer: "core",
    owner: "core/render-service.js",
    configPaths: ["mediaRecognition", "response.render", "response.tts"],
    commands: ["#yui图片模式", "#yui语音模式", "#yui渲染Markdown", "#yui渲染动态"],
    apis: ["/api/output", "/api/runtime/cleanup-cache"],
    description: "远程图片安全缓存、原生 vision 输入、富聊天媒体缩略图、文本/图片/语音模式、帮助图和动态图片渲染。",
  },
  {
    id: "cache-lifecycle",
    label: "缓存与生命周期",
    layer: "runtime",
    owner: "core/lifecycle.js",
    configPaths: ["chat.conversationTtlMs", "mediaRecognition.remoteFetch.cacheTtlMs", "response.render.cacheTtlMs"],
    commands: ["#yui结束对话", "#yui结束全部对话", "#yui清理缓存"],
    apis: ["/api/runtime", "/api/runtime/end-all-conversations", "/api/runtime/cleanup-cache"],
    description: "会话、限流锁、MCP/WS disposers、媒体缓存和渲染缓存统一统计与清理。",
  },
]

function enabledByPath(config: UnknownRecord, path: string): boolean {
  const value = path.split(".").reduce<unknown>((cursor, key) => record(cursor)[key], config)
  if (value === undefined) return false
  if (typeof value === "object") return true
  return value !== false && value !== ""
}

function healthFor(definition: CapabilityDefinition, config: UnknownRecord, runtime: CapabilityRuntime): boolean {
  const persona = record(config.persona)
  const chat = record(config.chat)
  const modelTasks = record(config.modelTasks)
  const web = record(config.web)
  const knowledge = record(config.knowledge)
  const memory = record(config.memory)
  const mediaRecognition = record(config.mediaRecognition)
  const response = record(config.response)
  const render = record(response.render)
  if (definition.id === "first-person") return Boolean(persona.enabled && persona.respondToFirstPersonCall !== false)
  if (definition.id === "model-workflows") return Boolean(chat.defaultTask && modelTasks[text(chat.defaultTask)])
  if (definition.id === "web-management") return Boolean(web.enabled && web.mountPath)
  if (definition.id === "tools-skills-mcp") return runtime.tools.total > 0 && runtime.tools.enabled > 0
  if (definition.id === "command-knowledge") return knowledge.enabled !== false && Number(runtime.knowledge.commands || 0) >= 0
  if (definition.id === "memory-context") return memory.enabled !== false
  if (definition.id === "media-render-output") return mediaRecognition.enabled !== false || render.enabled !== false
  if (definition.id === "cache-lifecycle") return true
  return definition.configPaths.some(path => enabledByPath(config, path))
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

export async function buildCapabilityRegistry(): Promise<UnknownRecord> {
  const config = await configStore.load()
  const configValue = record(config)
  const tools = await toolRegistry.list()
  const routingDigest = providerResolver.buildRoutingDigest(config)
  const persona = await buildPersonaDigest(config)
  const extensions = toolRegistry.extensionDigest()
  const runtime = {
    tools: {
      total: tools.length,
      enabled: tools.filter(tool => tool.enabled).length,
      custom: tools.filter(tool => getToolCommon(tool).source === "custom").length,
      skill: Number(record(extensions.summary).markdownSkills || 0),
      mcp: tools.filter(tool => getToolCommon(tool).source === "mcp").length,
    },
    knowledge: commandObserver.stats(),
    memory: memoryStore.stats(),
    conversations: chatService.stats(),
    context: recentContextStore.stats(),
    modelRouting: routingDigest.summary,
    persona,
    extensions: extensions.summary,
    render: {
      kinds: renderKindCatalog.length,
      catalog: renderKindCatalog,
    },
  }
  const capabilities = capabilityDefinitions.map(definition => ({
    ...definition,
    enabled: healthFor(definition, configValue, runtime),
    configuredPaths: definition.configPaths.filter(path => enabledByPath(configValue, path)),
  }))
  const byLayer: Record<string, number> = {}
  for (const item of capabilities) byLayer[item.layer] = (byLayer[item.layer] || 0) + 1
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: capabilities.length,
      enabled: capabilities.filter(item => item.enabled).length,
      byLayer,
    },
    runtime,
    capabilities,
  }
}

export const capabilityRegistry = {
  definitions: capabilityDefinitions,
  build: buildCapabilityRegistry,
}
