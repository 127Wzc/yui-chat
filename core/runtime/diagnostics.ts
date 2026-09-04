import fs from "node:fs/promises"
import path from "node:path"
import { adapterRegistry } from "../../models/adapters/registry.js"
import {
  hostedToolIds,
  modelToolAllowed,
  modelToolRoute,
} from "../../models/configuration/tool-policy.js"
import { providerResolver } from "../../models/routing/provider-resolver.js"
import { commandObserver } from "../../knowledge/command-observer.js"
import { memoryStore } from "../../memory/store.js"
import { groupCaptureStore } from "../../memory/group-capture.js"
import { mcpManager } from "../../mcp/index.js"
import { toolRegistry } from "../../tools/support/registry.js"
import { filterRegistry } from "../../filters/core/registry.js"
import { chatService } from "../chat/chat-service.js"
import { mediaCacheStats } from "../media/media-cache.js"
import { recentContextStore } from "../chat/recent-context.js"
import { sqliteClient } from "../storage/sqlite/client.js"
import { renderCacheStats, renderKindCatalog } from "../rendering/render-service.js"
import { responseStateStats } from "../chat/response-pipeline.js"
import { modelLogStore } from "../observability/model-log.js"
import { listMutedScopes, mutedStats } from "../chat/access-control.js"
import { personaTriggerStats } from "../persona/persona-trigger.js"
import { initiativeGreetingScheduler } from "../persona/initiative-greeting.js"
import { buildCapabilityRegistry } from "./capability-registry.js"
import { buildPersonaDigest } from "../persona/persona-digest.js"
import { linkSafetyConfig } from "../network/link-safety-policy.js"
import {
  cacheDir,
  configDir,
  configFile,
  configStore,
  dataDir,
  pluginRoot,
  tempDir,
  yunzaiRoot,
} from "../../config/store.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function array(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function replyTaskUsesOnlyHostedWebSearch(config: UnknownRecord): boolean {
  const tools = record(config.tools)
  const hostedOpenAI = record(record(tools.hosted).openai)
  if (
    tools.enabled !== true
    || record(tools.policy).allowExternalNetwork === false
    || hostedOpenAI.enabled === false
    || record(hostedOpenAI.webSearch).enabled === false
  ) return false
  const chat = record(config.chat)
  const taskName = text(chat.defaultTask || "replyer")
  const task = record(record(config.modelTasks)[taskName])
  const modelNames = Array.isArray(task.modelList) ? task.modelList.map(text).filter(Boolean) : []
  if (!modelNames.length) return false
  const models = array(config.models)
  return modelNames.every(modelName => {
    const model = models.find(item => text(item.name) === modelName)
    if (!model || text(model.adapter) !== "openai-responses") return false
    const source = modelToolRoute(model, "web_search").source
    return (source === "auto" || source === "hosted")
      && modelToolAllowed(model, hostedToolIds.webSearch)
  })
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

function addIssue(issues: UnknownRecord[], condition: unknown, level: string, area: string, message: string): void {
  if (condition) issues.push({ level, area, message })
}

function pathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export async function buildDiagnostics(): Promise<UnknownRecord> {
  const config = await configStore.load()
  const configValue = record(config)
  const adapterIds = adapterRegistry.listAdapters().map(item => item.id)
  const providers = await providerResolver.diagnostics(adapterIds)
  const configValidation = configStore.validate(config)
  const mediaCache = await mediaCacheStats()
  const renderCache = record(await renderCacheStats())
  const mcp = record(toolRegistry.mcpStatus())
  const custom = record(toolRegistry.customStatus())
  const skills = record(toolRegistry.skillStatus())
  const tools = await toolRegistry.list()
  const enabledTools = tools.filter(tool => tool.enabled)
  const filterImplementations = await filterRegistry.list()
  const customFilters = record(filterRegistry.customStatus())
  const extensionDigest = record(toolRegistry.extensionDigest())
  const capabilities = record(await buildCapabilityRegistry())
  const knowledgeDigest = record(commandObserver.digest({ limit: 12 }))
  const personaDigest = await buildPersonaDigest(config)
  const response = record(configValue.response)
  const linkSafety = linkSafetyConfig(configValue)
  const builtinTools = record(record(configValue.tools).builtin)
  const hostedOpenAITools = record(record(record(configValue.tools).hosted).openai)
  const imageSearchConfig = record(builtinTools.imageSearch)
  const webSearchConfig = record(builtinTools.webSearch)
  const webSearchRuntime = record(record(record(configValue.tools).runtimeVariables).web_search)
  const messageFiltering = record(response.messageFilters)
  const messageFilters = Array.isArray(messageFiltering.filters) ? messageFiltering.filters as UnknownRecord[] : []
  const rootTempDir = path.join(yunzaiRoot, "temp/yui-chat")
  const hostedWebSearchCoversReplyTask = replyTaskUsesOnlyHostedWebSearch(configValue)

  const paths = {
    pluginRoot,
    yunzaiRoot,
    configDir,
    configFile,
    dataDir,
    cacheDir,
    tempDir,
    mediaCacheDir: mediaCache.dir,
    renderCacheDir: renderCache.dir,
    rootTempDir,
    rootTempExists: await exists(rootTempDir),
    tempInsidePluginCache: pathInside(tempDir, cacheDir) && pathInside(cacheDir, pluginRoot),
    dataInsideYunzaiData: pathInside(dataDir, path.join(yunzaiRoot, "data")),
  }

  const safety = {
    webAuthTokenConfigured: Boolean(record(configValue.web).authToken),
    loginInGroup: Boolean(record(configValue.web).loginInGroup),
    publicBaseUrls: [
      ...(record(configValue.web).publicBaseUrl ? [record(configValue.web).publicBaseUrl] : []),
      ...(Array.isArray(record(configValue.web).publicBaseUrls) ? record(configValue.web).publicBaseUrls as unknown[] : []),
    ].filter(Boolean),
    accessTokenTtlMs: numberValue(record(configValue.web).accessTokenTtlMs),
    linkAllowPrivateHosts: linkSafety.allowPrivateHosts,
    trustedPrivateDnsBypass: linkSafety.trustedPrivateDnsBypass,
    renderHtmlEnabled: record(record(response.render).html).enabled === true,
    screenshotAllowedHostCount: linkSafety.screenshotAllowedHosts.length,
    boundaryAccessEnabled: Boolean(record(record(configValue.tools).boundaryAccess).enabled),
    initiativeGreetingScheduled: Boolean(record(record(configValue.persona).initiativeGreeting).scheduledEnabled),
    initiativeGreetingGroups: array(record(record(configValue.persona).initiativeGreeting).groups).length,
    privateChatEnabled: record(record(configValue.chat).access).privateChatEnabled !== false,
    accessMasterBypass: record(record(configValue.chat).access).masterBypass !== false,
    whitelistCount: array(record(record(configValue.chat).access).whitelist).length,
    blacklistCount: array(record(record(configValue.chat).access).blacklist).length,
    externalNetworkToolsAllowed: record(record(configValue.tools).policy).allowExternalNetwork !== false,
    openaiHostedToolsAllowed: record(configValue.tools).enabled === true && hostedOpenAITools.enabled !== false,
    hostedWebSearchAllowed: hostedOpenAITools.enabled !== false && record(hostedOpenAITools.webSearch).enabled !== false,
    hostedFileSearchAllowed: hostedOpenAITools.enabled !== false && record(hostedOpenAITools.fileSearch).enabled !== false,
    hostedToolSearchAllowed: hostedOpenAITools.enabled !== false && record(hostedOpenAITools.toolSearch).enabled !== false,
    imageSearchSources: Array.isArray(imageSearchConfig.enabledSources) ? imageSearchConfig.enabledSources.map(text) : [],
    imageSearchPixivR18: imageSearchConfig.pixivR18 === true,
    webSearchSources: Array.isArray(webSearchConfig.enabledSources) ? webSearchConfig.enabledSources.map(text) : [],
    webSearchBaiduConfigured: Boolean(webSearchRuntime.baiduApiKey),
    webSearchTavilyConfigured: Boolean(webSearchRuntime.tavilyApiKey),
    hostedWebSearchCoversReplyTask,
    customToolsAllowed: record(record(configValue.tools).policy).allowCustomTools !== false,
    mcpToolsAllowed: record(record(configValue.tools).policy).allowMcpTools !== false,
    subAgentEnabled: record(configValue.subAgent).enabled === true,
    subAgentMaxTasksPerDispatch: numberValue(record(configValue.subAgent).maxTasksPerDispatch),
    subAgentMaxConcurrency: numberValue(record(configValue.subAgent).maxConcurrency),
    subAgentMaxDurationMs: numberValue(record(configValue.subAgent).maxDurationMs),
    messageFiltersEnabled: messageFiltering.enabled !== false,
    messageFilters: messageFilters.length,
    messageFiltersActive: messageFilters.filter(filter => filter?.enabled === true).length,
    filterImplementations: filterImplementations.length,
  }
  const configRuntime = configStore.meta()

  const validation = record(configValidation)
  const issues: UnknownRecord[] = [
    ...array(validation.issues).map(issue => ({
      level: text(issue.level),
      area: text(issue.path) || "config",
      message: text(issue.message),
    })),
    ...array(record(providers).validation && record(record(providers).validation).issues),
  ]
  addIssue(issues, safety.loginInGroup, "warn", "web", "面板管理地址允许在群聊发送，请确认不会暴露公网入口")
  addIssue(issues, safety.linkAllowPrivateHosts, "warn", "link-safety", "链接安全策略允许访问任意私网地址，存在 SSRF 风险")
  addIssue(issues, safety.trustedPrivateDnsBypass, "warn", "link-safety", "可信资源允许私网 DNS 结果，请确认 QQ/Bilibili 实际解析环境")
  addIssue(issues, safety.renderHtmlEnabled && !safety.screenshotAllowedHostCount, "warn", "render", "HTML 后端已启用，但 URL 截图没有配置允许域名")
  addIssue(issues, safety.initiativeGreetingScheduled && !safety.initiativeGreetingGroups, "warn", "persona", "主动打招呼定时已开启但没有配置群号")
  addIssue(issues, enabledTools.some(tool => tool.name === "web_search") && !hostedWebSearchCoversReplyTask && !safety.webSearchBaiduConfigured && !safety.webSearchTavilyConfigured, "warn", "web-search", "web_search 已启用，但百度 AI 与 Tavily 均未配置 API Key")
  addIssue(issues, safety.imageSearchPixivR18, "warn", "image-search", "Pixiv R18 图片搜索已开启，请确认当前会话与平台规则允许投递")
  addIssue(issues, paths.rootTempExists, "warn", "paths", "根目录 temp/yui-chat 仍存在，应清理到插件内缓存目录")
  addIssue(issues, !paths.tempInsidePluginCache, "error", "paths", "插件临时目录不在 plugins/yui-chat/cache 内")
  addIssue(issues, !paths.dataInsideYunzaiData, "warn", "paths", "长期数据目录不在 Yunzai data 目录下")
  for (const item of array(toolRegistry.registryErrors)) {
    issues.push({ level: "warn", area: "tools", message: item.message || JSON.stringify(item) })
  }
  for (const item of array(mcp.errors)) {
    issues.push({ level: "warn", area: "mcp", message: `${item.server || "mcp"}：${item.error || item.message || ""}` })
  }
  for (const item of array(custom.errors)) {
    issues.push({ level: "warn", area: "custom-tools", message: item.error || item.message || JSON.stringify(item) })
  }
  for (const item of array(skills.errors)) {
    issues.push({ level: "warn", area: "skills", message: item.error || item.message || JSON.stringify(item) })
  }
  for (const item of filterRegistry.registryErrors || []) {
    issues.push({ level: "warn", area: "filters", message: item.message || JSON.stringify(item) })
  }
  for (const item of array(customFilters.errors)) {
    issues.push({ level: "warn", area: "custom-filters", message: item.error || item.message || JSON.stringify(item) })
  }

  return {
    ok: !issues.some(item => item.level === "error"),
    generatedAt: new Date().toISOString(),
    summary: {
      issueCount: issues.length,
      errorCount: issues.filter(item => item.level === "error").length,
      warnCount: issues.filter(item => item.level === "warn").length,
      providers: array(record(providers).channels).length,
      tools: tools.length,
      enabledTools: enabledTools.length,
      mcpClients: array(mcp.clients).length,
      mcpTools: array(mcp.tools).length,
      customTools: array(custom.loaded).length,
      markdownSkills: array(skills.catalog).filter(item => item.enabled === true && record(item.validation).ok === true).length,
      extensionErrors: numberValue(record(extensionDigest.summary).errors),
      mediaCacheFiles: numberValue(record(mediaCache).files),
      mediaCacheBytes: numberValue(record(mediaCache).bytes),
      renderCacheFiles: numberValue(renderCache.files),
      renderCacheBytes: numberValue(renderCache.bytes),
      renderKinds: renderKindCatalog.length,
      capabilities: numberValue(record(capabilities.summary).enabled),
      capabilityTotal: numberValue(record(capabilities.summary).total),
      commandExampleCoverageRatio: numberValue(record(knowledgeDigest.stats).exampleCoverageRatio),
      messageFilters: messageFilters.length,
      messageFiltersActive: messageFilters.filter(filter => filter?.enabled === true).length,
      filterImplementations: filterImplementations.length,
      customFilters: array(customFilters.loaded).length,
    },
    issues,
    paths,
    safety,
    configRuntime,
    providers,
    configValidation,
    tools: {
      total: tools.length,
      enabled: enabledTools.map(tool => tool.name),
      registryErrors: toolRegistry.registryErrors || [],
      boundaryAccess: config.tools?.boundaryAccess || {},
      hosted: config.tools?.hosted || {},
      custom,
      skills,
      mcp,
      extensionDigest,
    },
    filters: {
      total: filterImplementations.length,
      implementations: filterImplementations,
      custom: customFilters,
      registryErrors: filterRegistry.registryErrors || [],
    },
    capabilities,
    runtime: {
      chat: chatService.stats(),
      recentContext: recentContextStore.stats(),
      response: responseStateStats(),
      personaTrigger: personaTriggerStats(),
      initiativeGreeting: initiativeGreetingScheduler.stats(),
      access: {
        ...mutedStats(),
        mutedScopes: listMutedScopes(),
      },
      persona: personaDigest,
      knowledge: commandObserver.stats(),
      memory: memoryStore.stats(),
      groupCapture: await groupCaptureStore.summary(),
      mediaCache,
      renderCache,
      renderKinds: renderKindCatalog,
      mcp: mcpManager.status(),
      commandKnowledge: knowledgeDigest,
      storage: sqliteClient.status,
      logs: modelLogStore.stats(),
    },
  }
}
