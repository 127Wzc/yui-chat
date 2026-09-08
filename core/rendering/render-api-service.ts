import {
  listImageRenderers,
  renderImageByConfiguredEngine,
  normalizeRenderKind,
  resolveRenderEngine,
} from "./render-service.js"
import { linkSafetyConfig } from "../network/link-safety-policy.js"

type UnknownRecord = Record<string, unknown>

interface RenderResult extends UnknownRecord {
  buffer?: unknown
}

interface PreviewBody extends UnknownRecord {
  template?: unknown
  kind?: unknown
  data?: unknown
  input?: unknown
  includeImage?: unknown
}

interface RenderPreviewResult {
  kind: string
  engine: string
  requestedEngine?: string
  fallback?: boolean
  renderer?: string
  bytes: number
  imageBase64: string
}
const pngHeader = "89504e470d0a1a0a"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function renderConfig(config: unknown = {}): UnknownRecord {
  const root = record(config)
  const response = record(root.response)
  const render = record(response.render)
  return {
    enabled: true,
    maxPreviewChars: 12000,
    ...render,
  }
}

function sampleInput(kind = "text-card"): UnknownRecord {
  if (kind === "chat-card") {
    return {
      prompt: "帮我介绍一下 Yui Chat 的统一渲染能力",
      answer: "业务侧只需要选择 template 并传入 data，渲染服务会统一生成图片并交付到当前会话。",
      sender: { userId: "10001", name: "控制台预览" },
      scope: { type: "group", groupId: "20001", groupName: "Preview" },
      media: { images: 1, mentions: ["123456"] },
      metadata: { channel: "mock", adapter: "mock", toolRounds: 1 },
      steps: [{ stepId: "reply", channel: "mock", adapter: "mock", status: "ok", durationMs: 12 }],
    }
  }
  if (kind === "command-help") {
    return {
      query: "怎么查体力",
      matches: [{
        pluginName: "示例插件",
        description: "体力查询",
        suggestedCommand: "#体力",
        reason: "匹配体力查询意图",
        permission: "all",
        event: "message",
      }],
      stats: { commands: 1, events: 0 },
    }
  }
  if (kind === "help-menu") {
    return {
      title: "Yui Chat 帮助菜单",
      groups: [
        {
          title: "聊天入口",
          commands: [
            { command: "#yuichat 帮我总结一下", description: "发起 AI 对话" },
            { command: "#yuihelp 怎么查体力", description: "检索指令知识库" },
          ],
        },
        {
          title: "统一渲染",
          commands: [
            { command: "render_image({ template, data })", description: "模型工具统一入口", permission: "tool" },
            { command: "#yui图片模式", description: "聊天输出自动转图", permission: "all" },
          ],
        },
      ],
    }
  }
  if (kind === "conversation-list") {
    return {
      rows: [{
        channel: "mock",
        type: "group",
        groupId: "20001",
        userId: "10001",
        turns: 3,
        historyMessages: 6,
        lastSeenAt: "2026-06-08 12:00:00",
        preview: "Web 渲染预览生成的会话列表。",
      }],
    }
  }
  if (kind === "markdown") {
    return {
      title: "Markdown 渲染预览",
      markdown: "# 渲染工具\n\n- 帮助图\n- 动态面板\n\n```mermaid\nflowchart LR\nA[命令] --> B[渲染]\n```",
    }
  }
  if (kind === "mindmap") {
    return {
      title: "重构计划",
      markdown: "# Yui Chat\n## 渲染\n- 帮助图\n- 动态图\n## 扩展\n- Skill\n- MCP",
    }
  }
  if (kind === "word-cloud") {
    return {
      title: "能力词云",
      words: [
        { text: "渲染", weight: 8 },
        { text: "工具", weight: 7 },
        { text: "知识库", weight: 5 },
        { text: "模型", weight: 4 },
      ],
    }
  }
  if (kind === "dynamic-panel") {
    return {
      title: "动态面板",
      subtitle: "Web 预览",
      metrics: [
        { label: "渲染", value: "ready" },
        { label: "策略", value: "HTML → SVG" },
        { label: "后端", value: "sharp" },
      ],
      sections: [{ title: "说明", lines: ["动态图片渲染链路正常。"] }],
    }
  }
  return {
    title: "Yui Chat 渲染预览",
    subtitle: "Web Render Preview",
    content: "这是一张由新插件独立渲染服务生成的图片。",
  }
}

function clampInput(input: unknown = {}, config: unknown = {}): UnknownRecord {
  const cfg = renderConfig(config)
  const maxChars = Math.max(1000, numberValue(cfg.maxPreviewChars || cfg.maxTextChars, 12000) || 12000)
  const serialized = JSON.stringify(input, (_key, value: unknown) => typeof value === "string" ? value.slice(0, maxChars) : value)
  return record(serialized ? JSON.parse(serialized) : {})
}

export async function renderPreview(body: PreviewBody = {}, config: unknown = {}): Promise<RenderPreviewResult> {
  const kind = normalizeRenderKind(body.template || body.kind || "text-card")
  if (!listImageRenderers(true).some(item => item.kind === kind)) throw new Error("预览只支持公开模板：文本卡片、Markdown、思维导图。")
  const rawInput = isObject(body.data)
    ? body.data
    : isObject(body.input)
      ? body.input
      : sampleInput(kind)
  const input = clampInput(rawInput, config)
  const resolvedEngine = resolveRenderEngine(kind, "", config)
  const result = await renderImageByConfiguredEngine(kind, input, config) as RenderResult
  const buffer = result.buffer instanceof Uint8Array ? Buffer.from(result.buffer) : null
  if (!buffer || buffer.subarray(0, 8).toString("hex") !== pngHeader) throw new Error("渲染结果不是有效 PNG。")
  const meta = record(result.meta)
  const renderer = text(meta.renderer || meta.engine || "")
  const actualEngine = renderer === "html-puppeteer" ? "html" : text(meta.engine || resolvedEngine || "default")
  return {
    kind,
    engine: actualEngine,
    requestedEngine: text(meta.requestedEngine || resolvedEngine || "default"),
    fallback: meta.fallback === true,
    renderer,
    bytes: buffer.length,
    imageBase64: body.includeImage === false ? "" : buffer.toString("base64"),
  }
}

export async function renderApiOverview(config: unknown = {}): Promise<UnknownRecord> {
  const cfg = renderConfig(config)
  const html = record(cfg.html)
  const system = record(cfg.system)
  const safety = linkSafetyConfig(config)
  return {
    enabled: cfg.enabled !== false,
    engine: text(cfg.engine || "html"),
    system: {
      engine: text(system.engine || "html"),
    },
    html: {
      enabled: html.enabled === true,
      allowPrivateHosts: safety.allowPrivateHosts,
      allowedUrlHosts: safety.screenshotAllowedHosts.map(text),
      maxHtmlChars: html.maxHtmlChars,
      timeoutMs: html.timeoutMs,
    },
    catalog: listImageRenderers(true),
  }
}

export const renderApiService = {
  renderApiOverview,
  renderPreview,
}
