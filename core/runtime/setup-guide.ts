import path from "node:path"
import { configStore, cacheDir, tempDir } from "../../config/store.js"
import { commandObserver } from "../../knowledge/command-observer.js"
import { providerResolver } from "../../models/routing/provider-resolver.js"
import { toolRegistry } from "../../tools/support/registry.js"
import { getToolCommon } from "../../tools/support/contract.js"
import type { RuntimeConfigObject } from "../../config/types.js"

type UnknownRecord = Record<string, unknown>

interface WebChatTest {
  testedAt: string
  channel: string
  adapter: string
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function pathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

let latestWebChatTest: WebChatTest | null = null

export function recordWebChatTest(result: UnknownRecord = {}): WebChatTest {
  latestWebChatTest = {
    testedAt: new Date().toISOString(),
    channel: text(result.channel || ""),
    adapter: text(result.adapter || ""),
  }
  return latestWebChatTest
}

function step(id: string, title: string, status: string, detail: string, action: UnknownRecord = {}, guidance: UnknownRecord = {}): UnknownRecord {
  return {
    id,
    title,
    status,
    ready: status === "ready",
    detail,
    recommendation: guidance.recommendation || "",
    defaults: guidance.defaults || {},
    action: {
      label: action.label || "去配置",
      tab: action.tab || "overview",
      primary: Boolean(action.primary),
    },
  }
}

function summarize(steps: UnknownRecord[] = []): UnknownRecord {
  const ready = steps.filter(item => item.status === "ready").length
  const warn = steps.filter(item => item.status === "warn").length
  const todo = steps.filter(item => item.status === "todo").length
  const next = steps.find(item => item.status === "todo") || steps.find(item => item.status === "warn") || steps[0]
  return {
    total: steps.length,
    ready,
    warn,
    todo,
    percent: steps.length ? Math.round((ready / steps.length) * 100) : 0,
    next,
    overall: todo ? "todo" : warn ? "warn" : "ready",
  }
}

export async function buildSetupGuide(config: RuntimeConfigObject = configStore.getPublic()): Promise<UnknownRecord> {
  const configValue = record(config)
  const web = record(configValue.web)
  const chat = record(configValue.chat)
  const models = Array.isArray(configValue.models) ? configValue.models as UnknownRecord[] : []
  const apiProviders = Array.isArray(configValue.apiProviders) ? configValue.apiProviders as UnknownRecord[] : []
  const channels = Array.isArray(configValue.channels) ? configValue.channels as UnknownRecord[] : []
  const modelTasks = record(configValue.modelTasks)
  const replyer = record(modelTasks.replyer)
  const persona = record(configValue.persona)
  const toolsConfig = record(configValue.tools)
  const boundaryAccess = record(toolsConfig.boundaryAccess)
  const subAgent = record(configValue.subAgent)
  const knowledgeConfig = record(configValue.knowledge)
  const response = record(configValue.response)
  const render = record(response.render)
  const providerDigest = providerResolver.buildRoutingDigest(config)
  const routingPreview = record(providerResolver.buildTaskPreview(config, text(chat.defaultTask)))
  const tools = await toolRegistry.list()
  const enabledTools = tools.filter(tool => tool.enabled)
  const knowledge = commandObserver.stats()
  const usingMockOnly = models.every(model => model.adapter === "mock" || model.name === "mock")
  const availableChannelIds = new Set([
    ...models.map(model => text(model.name || "")),
    ...channels.map(channel => text(channel.id || channel.name || "")),
  ].filter(Boolean))
  const latestTest = latestWebChatTest
  const latestWebChatTestValid = Boolean(latestTest?.channel && availableChannelIds.has(latestTest.channel))
  const webChatTestReady = latestWebChatTestValid && !usingMockOnly
  const highRiskTools = enabledTools.filter(tool => {
    const common = getToolCommon(tool)
    if (tool.name === "dispatch_subagent" && subAgent.enabled !== true) return false
    return common.risk === "high" || record(common.policy).highRisk === true
  })
  const hasPublicUrl = Boolean(web.publicBaseUrl || (Array.isArray(web.publicBaseUrls) && web.publicBaseUrls.length))

  const steps = [
    step(
      "web-auth",
      "Web 认证",
      web.enabled && web.mountPath
        ? (web.loginInGroup ? "warn" : "ready")
        : "todo",
      web.enabled && web.mountPath
        ? `挂载 ${text(web.mountPath || "/yui-chat")}，${hasPublicUrl ? "已配置公开地址" : "使用本地地址"}；主人快捷登录可用${web.authToken ? "，静态 Token 登录已启用" : "，静态 Token 登录未启用"}。${web.loginInGroup ? "群聊发送管理地址已开启。" : ""}`
        : "需要启用 Web 面板并确认挂载路径。",
      { label: "检查 Web", tab: "advanced" },
      {
        recommendation: "优先由主人发送 #yui面板 获取一次性快捷链接；只有需要固定静态入口时才配置 authToken。",
        defaults: {
          挂载路径: web.mountPath || "/yui-chat",
          登录有效期: "24 小时",
          快捷链接有效期: "3 分钟",
        },
      },
    ),
    step(
      "provider-model",
      "模型渠道",
      usingMockOnly ? "todo" : "ready",
      usingMockOnly
        ? "当前仍是 mock 模型，先添加供应商、模型 ID 和 API Key。"
        : `已配置 ${apiProviders.length} 个供应商、${models.length} 个模型。`,
      { label: "配置模型", tab: "providers", primary: usingMockOnly },
      {
        recommendation: "普通用户优先选择预设服务商；自建或中转服务选择 OpenAI 兼容。API 地址通常以 /v1 结尾，模型 ID 以服务商控制台为准。",
        defaults: {
          接入方式: "服务商预设 / OpenAI 兼容",
          模型能力: "开启工具调用；模型支持图片时开启视觉",
          API地址示例: "https://服务商地址/v1",
        },
      },
    ),
    step(
      "model-routing",
      "模型路由",
      routingPreview.ok === false ? "warn" : (record(providerDigest).summary && record(record(providerDigest).summary).tasks ? "ready" : "todo"),
      routingPreview.ok === false
        ? `默认任务 ${text(chat.defaultTask || "-")} 存在 ${Array.isArray(routingPreview.issues) ? routingPreview.issues.length : 0} 个问题。`
        : `默认任务 ${text(chat.defaultTask || "-")}，${numberValue(routingPreview.candidateCount, 0)} 个候选模型。`,
      { label: "检查路由", tab: "providers" },
      {
        recommendation: "先只配置一个主模型即可；需要稳定性时再添加备用模型。主模型不能识图时，再开启视觉辅助。",
        defaults: {
          选择策略: "失败后切换",
          最大输出: numberValue(replyer.maxTokens, 1024),
          温度: replyer.temperature ?? 0.7,
        },
      },
    ),
    step(
      "persona",
      "第一人称人格",
      persona.enabled && persona.firstPerson ? "ready" : "todo",
      persona.firstPerson
        ? `${text(persona.firstPerson)}：直呼/${persona.respondToAt === false ? "不响应 @" : "@"}/戳一戳/主动问候链路可在此维护。`
        : "需要设置 AI 第一人称和角色设定。",
      { label: "配置人格", tab: "persona" },
      {
        recommendation: "默认人设与运行规则可以直接使用；需要时可分别调整，系统运行规则也能在助手人设页面一键恢复默认。",
        defaults: {
          助手称呼: persona.firstPerson || "埋埋",
          角色设定: "定义身份、关系和表达风格",
          系统运行规则: "默认维护工具、群聊、媒体和静默边界，可自定义并恢复默认",
          响应方式: "直呼名字和 @ 时回复",
        },
      },
    ),
    step(
      "tools",
      "工具与权限",
      enabledTools.length
        ? (highRiskTools.length && boundaryAccess.enabled !== true ? "warn" : "ready")
        : "todo",
      enabledTools.length
        ? `已启用 ${enabledTools.length} 个工具。${highRiskTools.length ? `高风险工具 ${highRiskTools.length} 个${boundaryAccess.enabled === true ? "，边界权限已开启。" : "，建议开启边界权限。"}` : "高风险工具未突出暴露。"}`
        : "需要选择内置工具、Custom/Skill/MCP 或工具预设。",
      { label: "管理工具", tab: "tools" },
      {
        recommendation: "首次配置只启用“核心”预设；联网、群管理等能力确认权限后再开。建议保持边界权限开启。",
        defaults: {
          工具预设: "核心",
          边界权限: "开启",
          高风险能力: "仅机器人主人使用",
        },
      },
    ),
    step(
      "knowledge",
      "指令知识库",
      knowledgeConfig.enabled === false
        ? "todo"
        : (knowledge.commands > 0 ? "ready" : "warn"),
      knowledgeConfig.enabled === false
        ? "知识库未开启，AI 暂不能检索指令帮助。"
        : `已索引 ${knowledge.commands || 0} 条指令，动态触发记录 ${knowledge.events || 0} 条。`,
      { label: "查看知识库", tab: "knowledge" },
      {
        recommendation: "保持指令知识库开启并先执行一次重新扫描，AI 才能准确推荐机器人命令。",
        defaults: {
          知识库: "开启",
          指令前缀: "# / *",
          首次操作: "重新扫描指令",
        },
      },
    ),
    step(
      "output-cache",
      "输出与缓存",
      pathInside(tempDir, cacheDir) && render.enabled !== false ? "ready" : "warn",
      pathInside(tempDir, cacheDir)
        ? `临时产物位于插件缓存目录；渲染服务 ${render.enabled === false ? "未开启" : "已开启"}。`
        : "临时目录不在插件缓存目录内，需要检查路径安全。",
      { label: "检查输出", tab: "persona" },
      {
        recommendation: "先使用文本回复和默认图片卡片；HTML/URL 截图属于高风险能力，保持关闭即可。",
        defaults: {
          默认输出: "文本",
          长文本: "自动转图片卡片",
          HTML截图: "关闭",
        },
      },
    ),
    step(
      "web-chat-test",
      "Web 对话验证",
      webChatTestReady ? "ready" : (usingMockOnly || latestTest ? "warn" : "todo"),
      webChatTestReady
        ? `最近一次测试成功：${latestTest?.channel || "默认模型"}，${latestTest?.testedAt || ""}。`
        : (usingMockOnly
            ? `${latestTest ? "Mock 对话已测试；" : ""}当前仍是 mock 模型，接入真实模型后再完成验证。`
            : (latestTest ? "上次测试使用的模型已不在当前配置中，请重新验证。" : "打开 Web 对话页发送一条测试消息，确认模型和人格回复正常。")),
      { label: "开始对话", tab: "chat", primary: !webChatTestReady },
      {
        recommendation: "先问一句简单问题确认基础回复，再测试第一人称与角色设定。Web 测试默认禁用工具且不写入长期记忆。",
        defaults: {
          测试问题: "你好，请用两句话介绍你自己，并告诉我当前能做什么。",
          工具调用: "关闭",
          长期记忆: "不写入",
        },
      },
    ),
  ]

  return {
    generatedAt: new Date().toISOString(),
    summary: summarize(steps),
    steps,
  }
}
