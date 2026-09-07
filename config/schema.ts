import { cloneJsonValue } from "../core/shared/json-values.js"

interface SchemaField {
  path: string
  label: string
  type: string
  advanced?: boolean
  description?: string
}

interface SchemaGroup {
  group: string
  fields: SchemaField[]
}

export const schema: SchemaGroup[] = [
  {
    group: "Logging",
    fields: [
      { path: "logging.level", label: "对话日志等级", type: "string", advanced: true },
      { path: "logging.history.detailRetentionDays", label: "日志详情保留天数", type: "number", advanced: true },
      { path: "logging.history.aggregateRetentionDays", label: "日志汇总保留天数", type: "number", advanced: true },
    ],
  },
  {
    group: "Web",
    fields: [
      { path: "web.enabled", label: "启用 Web 面板", type: "boolean" },
      { path: "web.mountPath", label: "挂载路径", type: "string" },
      { path: "web.authToken", label: "Web 静态访问令牌", type: "password", description: "可选；留空时关闭静态 Token 登录，主人仍可通过 #yui面板 获取一次性快捷链接。" },
      { path: "web.publicBaseUrl", label: "服务器地址前缀", type: "string", description: "可包含自定义域名、端口和路径前缀；#yui面板 会继续拼接 Web 挂载路由与一次性快捷码。" },
      { path: "web.publicBaseUrls", label: "备用服务器地址前缀", type: "json", advanced: true },
      { path: "web.port", label: "本体端口", type: "number" },
      { path: "web.accessTokenTtlMs", label: "登录态保留毫秒", type: "number" },
      { path: "web.loginInGroup", label: "允许群聊发送管理地址", type: "boolean" },
    ],
  },
  {
    group: "System",
    fields: [
      { path: "system.backups.maxFiles", label: "配置包最少保留份数", type: "number" },
      { path: "system.backups.maxAgeDays", label: "配置包保护天数", type: "number" },
    ],
  },
  {
    group: "Storage",
    fields: [
      { path: "storage.sqlite.enabled", label: "启用 SQLite 持久化", type: "boolean" },
      { path: "storage.sqlite.busyTimeoutMs", label: "SQLite 忙等待毫秒", type: "number" },
      { path: "storage.sqlite.synchronous", label: "SQLite 同步级别", type: "string" },
    ],
  },
  {
    group: "Chat",
    fields: [
      { path: "chat.defaultChannel", label: "默认渠道", type: "string" },
      { path: "chat.defaultTask", label: "默认模型任务", type: "string" },
      { path: "chat.maxHistoryMessages", label: "历史消息数", type: "number" },
      { path: "chat.conversationTtlMs", label: "会话保留毫秒", type: "number" },
      { path: "chat.maxConversationScopes", label: "最多会话作用域", type: "number" },
      { path: "chat.maxToolRounds", label: "最大工具轮次", type: "number" },
      { path: "chat.execution", label: "工具执行与后台任务限制", type: "json" },
      { path: "chat.inputTokenBudget", label: "聊天输入 Token 预算", type: "number", description: "未声明上下文窗口的模型共用的会话输入上限；模型单独声明 contextWindowTokens 后优先生效。" },
      { path: "chat.triggerPrefix", label: "聊天前缀", type: "string" },
      { path: "chat.helpPrefix", label: "帮助前缀", type: "string" },
      { path: "chat.lockTimeoutMs", label: "并发锁超时毫秒", type: "number" },
      { path: "chat.access", label: "对话访问控制", type: "json" },
    ],
  },
  {
    group: "Persona",
    fields: [
      { path: "persona.enabled", label: "启用第一人称人格链", type: "boolean" },
      { path: "persona.firstPerson", label: "AI 第一人称", type: "string" },
      { path: "persona.aliases", label: "AI 别名", type: "json" },
      { path: "persona.assistantLabel", label: "AI 名称", type: "string" },
      { path: "persona.respondToFirstPersonCall", label: "回应第一人称呼叫", type: "boolean" },
      { path: "persona.respondToAt", label: "回应 @ 机器人", type: "boolean" },
      { path: "persona.characterPrompt", label: "角色设定", type: "textarea", description: "定义身份、关系和表达风格。" },
      { path: "persona.runtimePrompt", label: "系统运行规则", type: "textarea", description: "定义工具、媒体、群聊和静默等模型运行约束；可在助手人设页面恢复源码默认值。" },
      { path: "persona.trigger", label: "第一人称触发策略", type: "json" },
      { path: "persona.trigger.ambient", label: "伪人参与策略", type: "json" },
      { path: "persona.trigger.poke", label: "戳一戳触发策略", type: "json" },
      { path: "persona.output", label: "第一人称输出策略", type: "json" },
      { path: "persona.initiativeGreeting", label: "主动打招呼", type: "json" },
    ],
  },
  {
    group: "Providers",
    fields: [
      { path: "apiProviders", label: "供应商列表", type: "json" },
      { path: "models", label: "模型列表", type: "json" },
      { path: "modelTasks", label: "模型任务配置", type: "json" },
    ],
  },
  {
    group: "SubAgent",
    fields: [
      { path: "subAgent.enabled", label: "启用子代理", type: "boolean" },
      { path: "subAgent.task", label: "子代理模型任务", type: "string" },
      { path: "subAgent.maxDepth", label: "最大递归深度", type: "number" },
      { path: "subAgent.maxTasksPerDispatch", label: "单次最多子任务", type: "number" },
      { path: "subAgent.maxConcurrency", label: "全局最大并发", type: "number" },
      { path: "subAgent.maxDurationMs", label: "单任务最长毫秒", type: "number" },
      { path: "subAgent.maxToolRounds", label: "最大工具轮次", type: "number" },
      { path: "subAgent.maxToolCallsPerRound", label: "每轮最多工具调用", type: "number" },
      { path: "subAgent.allowedTools", label: "允许工具", type: "json" },
      { path: "subAgent.systemPrompt", label: "子代理系统提示词", type: "textarea" },
    ],
  },
  {
    group: "Knowledge",
    fields: [
      { path: "knowledge.enabled", label: "启用指令知识库", type: "boolean" },
      { path: "knowledge.dynamicCapture", label: "动态记录真实触发", type: "boolean" },
      { path: "knowledge.commandPrefixes", label: "指令前缀列表", type: "json" },
      { path: "knowledge.excludedPlugins", label: "不参与检索的插件", type: "json" },
      { path: "knowledge.excludedCommands", label: "不参与检索的插件指令", type: "json" },
      { path: "knowledge.capturePrivate", label: "记录私聊指令", type: "boolean" },
      { path: "knowledge.captureGroups", label: "记录群聊指令", type: "boolean" },
      { path: "knowledge.maxEvents", label: "最多动态事件", type: "number" },
      { path: "knowledge.flushDelayMs", label: "动态事件写入延迟", type: "number" },
      { path: "knowledge.indexing.globalEmbeddingTokensPerDay", label: "知识库 embedding 每日 Token 预算", type: "number", advanced: true },
      { path: "knowledge.indexing", label: "知识索引与 embedding 预算", type: "json" },
      { path: "knowledge.retrieval", label: "知识检索与重排预算", type: "json" },
      { path: "knowledge.commandRetrieval", label: "指令混合检索策略", type: "json" },
    ],
  },
  {
    group: "Media",
    fields: [
      { path: "mediaRecognition.enabled", label: "启用媒体上下文识别", type: "boolean" },
      { path: "mediaRecognition.recognitionModel", label: "媒体识别增强模型", type: "string" },
      { path: "mediaRecognition.useAtAvatar", label: "无图片时允许解析 @ 用户头像", type: "boolean" },
      { path: "mediaRecognition.preferNativeVision", label: "优先使用模型原生多模态", type: "boolean" },
      { path: "mediaRecognition.includeQuotedMedia", label: "包含引用消息媒体", type: "boolean" },
      { path: "mediaRecognition.remoteFetch", label: "远程媒体下载与缓存策略", type: "json" },
    ],
  },
  {
    group: "Security",
    fields: [
      { path: "security.linkSafety.allowPrivateHosts", label: "所有用户链接允许访问私网", type: "boolean", advanced: true },
      { path: "security.linkSafety.trustedPrivateDnsBypass", label: "可信资源允许私网 DNS 结果", type: "boolean", advanced: true },
      { path: "security.linkSafety.screenshotAllowedHosts", label: "URL 截图允许域名", type: "json", advanced: true },
    ],
  },
  {
    group: "Skills",
    fields: [
      { path: "skills.disabled", label: "已停用的 Markdown Skills", type: "json" },
      { path: "skills.sources", label: "远程 Skill 来源", type: "json" },
    ],
  },
  {
    group: "Tools",
    fields: [
      { path: "tools.enabled", label: "启用工具调用", type: "boolean" },
      { path: "tools.enabledTools", label: "启用工具名", type: "json" },
      { path: "tools.customToolPackages", label: "自定义工具包提示", type: "json" },
      { path: "tools.runtimeVariables", label: "工具运行变量", type: "json" },
      { path: "tools.activePresets", label: "已应用工具预设", type: "json" },
      { path: "tools.policy", label: "工具调用策略", type: "json" },
      { path: "tools.hosted", label: "OpenAI 托管工具策略", type: "json" },
      { path: "tools.promptSelection", label: "工具提示词选择预算", type: "json" },
      { path: "tools.boundaryAccess", label: "工具边界权限", type: "json" },
      { path: "tools.builtin.websiteFetch", label: "网页读取配置", type: "json" },
      { path: "tools.builtin.imageSearch", label: "图片搜索渠道配置", type: "json" },
      { path: "tools.builtin.webSearch", label: "实时网络搜索渠道配置", type: "json" },
      { path: "tools.builtin.commandHandoff", label: "指令转交配置", type: "json" },
      { path: "tools.builtin.groupAdmin", label: "群管工具配置", type: "json" },
    ],
  },
  {
    group: "MCP",
    fields: [
      { path: "mcp.enabled", label: "启用 MCP", type: "boolean" },
      { path: "mcp.servers", label: "MCP 服务器配置", type: "json" },
      { path: "mcp.serverTemplate", label: "MCP Server 权限模板", type: "json" },
    ],
  },
  {
    group: "Response",
    fields: [
      { path: "response.quoteReply", label: "引用回复", type: "boolean" },
      { path: "response.defaultMode", label: "默认回复模式", type: "string" },
      { path: "response.replyConfirmType", label: "回复确认表情/文字", type: "number" },
      { path: "response.blockWords", label: "输出黑名单", type: "json" },
      { path: "response.promptBlockWords", label: "输入黑名单", type: "json" },
      { path: "response.messageFilters", label: "消息过滤器链", type: "json" },
      { path: "response.autoUsePicture", label: "长文本自动转图", type: "boolean" },
      { path: "response.autoUsePictureThreshold", label: "转图阈值", type: "number" },
      { path: "response.segmentation", label: "LLM 分段回复策略", type: "json" },
      { path: "response.render.chatCardAsImage", label: "图片模式富聊天卡片", type: "boolean" },
      { path: "response.render.markdownEngine", label: "Markdown 渲染引擎", type: "string" },
      { path: "response.render.markmapEngine", label: "思维导图渲染引擎", type: "string" },
      { path: "response.render.mediaThumbnails", label: "富聊天卡片媒体缩略图", type: "boolean" },
      { path: "response.render.mediaThumbnailMaxCount", label: "媒体缩略图最多张数", type: "number" },
      { path: "response.render.mediaThumbnailMaxDataUrlChars", label: "媒体缩略图最大 Data URL 字符", type: "number" },
      { path: "response.render.mediaThumbnail", label: "媒体缩略图压缩策略", type: "json" },
      { path: "response.render.delivery", label: "图片与媒体交付策略", type: "json" },
      { path: "response.render", label: "图片渲染服务配置", type: "json" },
      { path: "response.tts", label: "语音输出配置", type: "json" },
      { path: "response.drawHandoff", label: "绘图转交配置", type: "json" },
    ],
  },
  {
    group: "Memory",
    fields: [
      { path: "memory.enabled", label: "启用长期记忆", type: "boolean" },
      { path: "memory.injectProfile", label: "注入用户画像", type: "boolean" },
      { path: "memory.injectRelevantFacts", label: "注入相关记忆", type: "boolean" },
      { path: "memory.autoWriteBack", label: "自动写回（仅文件回退模式生效）", type: "boolean" },
      { path: "memory.relevantLimit", label: "检索条数", type: "number" },
      { path: "memory.maxEpisodesPerScope", label: "单会话 Episode 上限", type: "number" },
      { path: "memory.maxMemoriesPerOwner", label: "单主体记忆上限", type: "number" },
      { path: "memory.maxLoadedMemoriesPerOwner", label: "单主体加载上限", type: "number" },
      { path: "memory.cacheEntries", label: "记忆缓存条目", type: "number" },
      { path: "memory.flushDelayMs", label: "记忆写回延迟毫秒", type: "number" },
      { path: "memory.promptBudgetChars", label: "记忆注入字符预算", type: "number" },
      { path: "memory.retrieval.embeddingTokensPerDay", label: "记忆 embedding 每日 Token 预算", type: "number", advanced: true },
      { path: "memory.retention", label: "短期与 episode 保留策略", type: "json" },
      { path: "memory.retrieval", label: "记忆检索与 Token 预算", type: "json" },
      { path: "memory.groupCapture.consolidation.maxTokens", label: "群提炼单次输出 Token 上限", type: "number", advanced: true },
      { path: "memory.groupCapture.consolidation.schedule.mode", label: "群记忆提炼调度模式", type: "string", advanced: true, description: "interval 保持扫描间隔；time 每天在固定时间运行；cron 按五段本地 Cron 运行。" },
      { path: "memory.groupCapture.consolidation.schedule.time", label: "群记忆提炼固定时间", type: "string", advanced: true, description: "本地时间 HH:mm，仅在 time 模式生效。" },
      { path: "memory.groupCapture.consolidation.schedule.cron", label: "群记忆提炼 Cron", type: "string", advanced: true, description: "五段本地 Cron：分 时 日 月 周，仅在 cron 模式生效。" },
      { path: "memory.groupCapture", label: "指定群消息采集与异步提炼", type: "json", advanced: true },
    ],
  },
  {
    group: "Context",
    fields: [
      { path: "context.recentMessageCount", label: "最近消息条数（同时拉取并注入）", type: "number" },
      { path: "context.captureGroups", label: "记录群聊最近消息", type: "boolean" },
      { path: "context.capturePrivate", label: "记录私聊最近消息", type: "boolean" },
      { path: "context.ignoreCommands", label: "忽略指令消息", type: "boolean" },
      { path: "context.maxScopes", label: "最多最近上下文作用域", type: "number" },
      { path: "context.scopeTtlMs", label: "最近上下文保留毫秒", type: "number" },
    ],
  },
]

const configTabs = [
  {
    id: "setup",
    label: "启动向导",
    description: "完成 Web 登录、模型渠道、默认任务和基础回复策略。",
    groups: ["Web", "Storage", "Security", "Chat", "Providers", "SubAgent", "Response"],
  },
  {
    id: "persona",
    label: "人格与上下文",
    description: "维护第一人称、记忆、最近上下文和媒体输入链路。",
    groups: ["Persona", "Memory", "Context", "Media"],
  },
  {
    id: "extensions",
    label: "工具与扩展",
    description: "管理内置工具、Custom、Skill、MCP 和边界权限。",
    groups: ["Tools", "MCP"],
  },
  {
    id: "knowledge",
    label: "指令知识库",
    description: "配置静态扫描、动态旁路采集和 AI 指令推荐。",
    groups: ["Knowledge"],
  },
]

const groupDescriptions: Record<string, string> = {
  Web: "独立挂载路由、长期认证令牌和浏览器短会话。",
  Chat: "对话入口、默认模型任务、会话生命周期和访问控制。",
  Storage: "SQLite 权威状态库和可重建向量索引的可靠性设置。",
  Security: "统一管理用户链接、私网 DNS 例外和 URL 截图允许域名。",
  Persona: "第一人称人格、群聊提示词、静默回复和自然输出策略。",
  Providers: "模型供应商、模型实例、任务路由和渠道 fallback。",
  SubAgent: "子代理模型任务、工具白名单和执行资源边界。",
  Knowledge: "扫描 Yunzai 指令规则，旁路记录真实触发过的命令，用于 AI 推荐指令。",
  Media: "归一化图片、引用、语音、视频和 @ 头像，支持原生 vision 或辅助识别链路。",
  Tools: "内置工具、Custom/Skill/MCP 可见性、边界权限和高风险策略。",
  MCP: "MCP server 注册、传输方式、风险标签和单工具策略覆盖。",
  Response: "文本/图片/语音输出、长文本转图、渲染缓存和绘图转交。",
  Memory: "长期记忆、用户画像、相关事实注入和自动写回。",
  Context: "最近聊天上下文缓冲、注入范围和指令过滤。",
}

const typeControlMap: Record<string, string> = {
  boolean: "switch",
  string: "input",
  number: "number",
  password: "password",
  textarea: "textarea",
  json: "json",
}

function slug(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function fieldHint(field: SchemaField = {} as SchemaField): string {
  if (field.description) return field.description
  if (field.type === "json") return "结构化配置，建议在对应功能页编辑；高级模式可直接修改 JSON。"
  if (field.type === "password") return "敏感配置，Web 面板会按密码控件展示。"
  if (field.path?.includes("enabled")) return "开关类配置，保存后立即参与运行时判断。"
  if (field.path?.includes("TtlMs") || field.path?.includes("TimeoutMs")) return "时间单位为毫秒。"
  return ""
}

function fieldAdvanced(field: SchemaField = {} as SchemaField): boolean {
  if (field.advanced !== undefined) return Boolean(field.advanced)
  const path = String(field.path || "")
  if (field.type === "json") return true
  if (/prompt|instruction|fallback|states|headers|query|params/i.test(path)) return true
  if (/cooldown|interval|delay|ttl|timeout|max|min|probability|threshold|quality|chars|bytes/i.test(path)) return true
  if (/allowPrivateHosts|blacklist|whitelist|toolPolicies/i.test(path)) return true
  return false
}

function enrichField(field: SchemaField, group: string, index: number) {
  return {
    ...field,
    id: `${slug(group)}-${field.path.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`,
    group,
    order: index,
    control: typeControlMap[field.type] || "input",
    sensitive: field.type === "password" || /token|key|secret|password/i.test(field.path),
    structured: field.type === "json",
    advanced: fieldAdvanced(field),
    description: fieldHint(field),
  }
}

function sectionFor(group: SchemaGroup, index: number) {
  const fields = group.fields.map((field, fieldIndex) => enrichField(field, group.group, fieldIndex))
  return {
    id: slug(group.group),
    group: group.group,
    title: group.group,
    order: index,
    description: groupDescriptions[group.group] || "",
    fieldCount: fields.length,
    sensitiveCount: fields.filter(field => field.sensitive).length,
    structuredCount: fields.filter(field => field.structured).length,
    advancedCount: fields.filter(field => field.advanced).length,
    paths: fields.map(field => field.path),
    fields,
  }
}

export const schemaSections = schema.map(sectionFor)

export const schemaManifest = {
  version: "0.1.0",
  style: "maimai-inspired-config-layout",
  description: "Yui Chat 配置元数据。保留原始 schema，同时提供 tabs/sections/fields 供 Web 面板渐进式渲染。",
  tabs: configTabs.map((tab, index) => ({
    ...tab,
    order: index,
    sections: tab.groups.map(group => slug(group)),
  })),
  sections: schemaSections,
  summary: {
    tabs: configTabs.length,
    sections: schemaSections.length,
    fields: schemaSections.reduce((sum, section) => sum + section.fieldCount, 0),
    sensitiveFields: schemaSections.reduce((sum, section) => sum + section.sensitiveCount, 0),
    structuredFields: schemaSections.reduce((sum, section) => sum + section.structuredCount, 0),
    advancedFields: schemaSections.reduce((sum, section) => sum + section.advancedCount, 0),
  },
}

export function getSchemaManifest() {
  return cloneJsonValue(schemaManifest)
}
