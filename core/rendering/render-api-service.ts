import { resolveRenderRequest } from "./image-renderer-registry.js"
import {
  listImageRenderers,
  renderImageByConfiguredEngine,
  resolveRenderEngine,
} from "./render-service.js"
import { linkSafetyConfig } from "../network/link-safety-policy.js"

type UnknownRecord = Record<string, unknown>

interface RenderResult extends UnknownRecord {
  buffer?: unknown
}

interface PreviewBody extends UnknownRecord {
  format?: unknown
  data?: unknown
  includeImage?: unknown
}

interface RenderPreviewResult {
  format: string
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

function sampleInput(format = "markdown"): UnknownRecord {
  if (format === "html") return { title: "HTML", content: "<h1>Yui Chat</h1><p>统一主题的 HTML 内容。</p>" }
  if (format === "mindmap") return { title: "思维导图", content: "# Yui Chat\n## 模型\n## 工具\n## 渲染" }
  if (format === "text") return { title: "文本卡片", content: "Yui Chat 文本卡片。" }
  return { title: "Markdown", content: "# Markdown\n\n公式：$a^2+b^2=c^2$\n\n```mermaid\nflowchart LR\nA --> B\n```" }
}

function clampInput(input: unknown = {}, config: unknown = {}): UnknownRecord {
  const cfg = renderConfig(config)
  const maxChars = Math.max(1000, numberValue(cfg.maxPreviewChars || cfg.maxTextChars, 12000) || 12000)
  const serialized = JSON.stringify(input, (_key, value: unknown) => typeof value === "string" ? value.slice(0, maxChars) : value)
  return record(serialized ? JSON.parse(serialized) : {})
}

export async function renderPreview(body: PreviewBody = {}, config: unknown = {}): Promise<RenderPreviewResult> {
  const requested = text(body.format || "auto")
  const rawInput = isObject(body.data)
    ? body.data
    : sampleInput(requested)
  const resolved = resolveRenderRequest({ ...body, format: requested, data: rawInput })
  const { kind } = resolved
  if (!listImageRenderers(true).some(item => item.kind === kind)) throw new Error("预览支持文本卡片、Markdown、数学公式、思维导图和 HTML。")
  // HTML 不静默截断，以免破坏结构；渲染服务负责长度校验。
  const input = kind === "html" ? resolved.input : clampInput(resolved.input, config)
  const resolvedEngine = resolveRenderEngine(kind, "", config)
  const result = await renderImageByConfiguredEngine(kind, input, config) as RenderResult
  const buffer = result.buffer instanceof Uint8Array ? Buffer.from(result.buffer) : null
  if (!buffer || buffer.subarray(0, 8).toString("hex") !== pngHeader) throw new Error("渲染结果不是有效 PNG。")
  const meta = record(result.meta)
  const renderer = text(meta.renderer || meta.engine || "")
  const actualEngine = renderer === "html-puppeteer" ? "html" : text(meta.engine || resolvedEngine || "default")
  return {
    format: kind === "text-card" ? "text" : kind,
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
      allowPrivateHosts: safety.allowPrivateHosts,
      allowedUrlHosts: safety.screenshotAllowedHosts.map(text),
      maxHtmlChars: html.maxHtmlChars,
      timeoutMs: html.timeoutMs,
    },
    url: { enabled: record(cfg.url).enabled === true },
    catalog: listImageRenderers(true),
  }
}

export const renderApiService = {
  renderApiOverview,
  renderPreview,
}
