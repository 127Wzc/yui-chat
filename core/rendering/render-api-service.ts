import fs from "node:fs/promises"
import path from "node:path"
import { tempDir } from "../../config/store.js"
import {
  listImageRenderers,
  renderCacheStats,
  renderImageByKind,
  normalizeRenderKind,
} from "./render-service.js"
import { renderMarkdownHtmlToPng, renderMarkmapHtmlToPng } from "./render-html-service.js"
import { linkSafetyConfig } from "../network/link-safety-policy.js"

type UnknownRecord = Record<string, unknown>

interface RenderResult extends UnknownRecord {
  buffer?: unknown
  cache?: unknown
}

interface PreviewBody extends UnknownRecord {
  template?: unknown
  kind?: unknown
  data?: unknown
  input?: unknown
  engine?: unknown
  includeImage?: unknown
}

interface RenderCacheRow {
  id: string
  kind: string
  size: number
  cachedAt: number
  meta: UnknownRecord
  imageUrl: string
}

interface RenderPreviewResult {
  kind: string
  engine: string
  bytes: number
  cache: UnknownRecord | null
  imageBase64: string
}

const renderCacheDir = path.join(tempDir, "render")
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

function compactText(value: unknown = "", max = 180): string {
  const valueText = text(value).replace(/\s+/g, " ").trim()
  return valueText.length > max ? `${valueText.slice(0, max - 3)}...` : valueText
}

function sampleInput(kind = "text-card"): UnknownRecord {
  if (kind === "chat-card") {
    return {
      prompt: "帮我介绍一下 Yui Chat 的统一渲染能力",
      answer: "业务侧只需要选择 template 并传入 data，渲染服务会统一生成图片、写入缓存并交付到当前会话。",
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
        { label: "缓存", value: "plugin" },
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

function publicCache(cache: unknown = null): UnknownRecord | null {
  if (!cache) return null
  const value = record(cache)
  const id = text(value.id)
  return {
    id,
    size: numberValue(value.size, 0),
    imageUrl: id ? `api/render/cache/${id}.png` : "",
  }
}

export async function renderPreview(body: PreviewBody = {}, config: unknown = {}): Promise<RenderPreviewResult> {
  const kind = normalizeRenderKind(body.template || body.kind || "text-card")
  const rawInput = isObject(body.data)
    ? body.data
    : isObject(body.input)
      ? body.input
      : sampleInput(kind)
  const input = clampInput(rawInput, config)
  const engine = text(body.engine).toLowerCase()
  const cfg = renderConfig(config)
  const htmlEnabled = record(cfg.html).enabled === true
  const resolvedEngine = engine || (kind === "markdown" ? text(cfg.markdownEngine || "svg") : kind === "mindmap" ? text(cfg.markmapEngine || "svg") : "svg")
  let result: RenderResult
  if (kind === "markdown" && (resolvedEngine === "html" || resolvedEngine === "auto")) result = await renderMarkdownHtmlToPng(input, config) as RenderResult
  else if (kind === "mindmap" && (resolvedEngine === "html" || (resolvedEngine === "auto" && htmlEnabled))) result = await renderMarkmapHtmlToPng(input, config) as RenderResult
  else result = await renderImageByKind(kind, input, record(config)) as RenderResult
  const buffer = Buffer.isBuffer(result.buffer) ? result.buffer : null
  if (!buffer || buffer.subarray(0, 8).toString("hex") !== pngHeader) throw new Error("渲染结果不是有效 PNG。")
  return {
    kind,
    engine: resolvedEngine || "default",
    bytes: buffer.length,
    cache: publicCache(result.cache),
    imageBase64: body.includeImage === false ? "" : buffer.toString("base64"),
  }
}

export async function renderApiOverview(config: unknown = {}): Promise<UnknownRecord> {
  const cfg = renderConfig(config)
  const html = record(cfg.html)
  const safety = linkSafetyConfig(config)
  return {
    enabled: cfg.enabled !== false,
    engine: text(cfg.engine || "sharp-svg"),
    markdownEngine: text(cfg.markdownEngine || "svg"),
    markmapEngine: text(cfg.markmapEngine || "svg"),
    html: {
      enabled: html.enabled === true,
      allowPrivateHosts: safety.allowPrivateHosts,
      allowedUrlHosts: safety.screenshotAllowedHosts.map(text),
      maxHtmlChars: html.maxHtmlChars,
      timeoutMs: html.timeoutMs,
    },
    catalog: listImageRenderers(),
    cache: await renderCacheStats(),
  }
}

export async function listRenderCache(options: { limit?: unknown } = {}): Promise<RenderCacheRow[]> {
  const entries = await fs.readdir(renderCacheDir, { withFileTypes: true }).catch(() => [])
  const rows: RenderCacheRow[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      const meta = record(JSON.parse(await fs.readFile(path.join(renderCacheDir, entry.name), "utf8")))
      const stat = await fs.stat(path.join(renderCacheDir, entry.name)).catch(() => null)
      const metaData = record(meta.meta)
      const id = text(meta.id)
      rows.push({
        id,
        kind: text(meta.kind),
        size: numberValue(meta.size, 0),
        cachedAt: numberValue(meta.cachedAt, stat?.mtimeMs || 0),
        meta: {
          title: compactText(metaData.title || metaData.url || metaData.file),
          engine: text(metaData.engine),
          rows: metaData.rows,
          words: metaData.words,
          metrics: metaData.metrics,
          sections: metaData.sections,
        },
        imageUrl: id ? `api/render/cache/${id}.png` : "",
      })
    } catch {
      // 缓存元数据是可丢弃的观测数据，单个文件损坏不应阻断缓存列表。
    }
  }
  rows.sort((a, b) => b.cachedAt - a.cachedAt)
  return rows.slice(0, Math.max(1, Math.min(200, numberValue(options.limit, 40) || 40)))
}

export async function readRenderCacheImage(id: unknown = ""): Promise<Buffer> {
  const safeId = text(id).replace(/\.png$/i, "")
  if (!/^[a-f0-9]{64}$/i.test(safeId)) throw new Error("无效的渲染缓存 ID。")
  const file = path.resolve(renderCacheDir, `${safeId}.png`)
  const base = path.resolve(renderCacheDir)
  if (!file.startsWith(`${base}${path.sep}`)) throw new Error("渲染缓存路径越界。")
  const buffer = Buffer.from(await fs.readFile(file))
  if (buffer.subarray(0, 8).toString("hex") !== pngHeader) throw new Error("缓存图片不是有效 PNG。")
  return buffer
}

export const renderApiService = {
  renderApiOverview,
  renderPreview,
  listRenderCache,
  readRenderCacheImage,
}
