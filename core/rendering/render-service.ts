import sharp from "sharp"
import { hostRuntime } from "../runtime/host-runtime.js"
import {
  ImageRenderer,
  listImageRenderers,
  normalizeRenderKind,
  registerImageRenderer,
  renderImageByKind,
  renderKindCatalog,
  renderKindLabels,
  renderRendererRegistry,
  unregisterImageRenderer,
} from "./image-renderer-registry.js"
import { cleanupRenderCache, persistRender, renderCacheStats } from "./render-cache.js"
import { buildFunctionPlotSvg } from "./function-plot.js"

type UnknownRecord = Record<string, unknown>

interface RenderConfig extends UnknownRecord {
  enabled: boolean
  engine: string
  cache: boolean
  cacheTtlMs: number
  width: number
  maxTextChars: number
  helpAsImage: boolean
  conversationListAsImage: boolean
  mediaThumbnails: boolean
  mediaThumbnailMaxCount: number
  mediaThumbnailMaxDataUrlChars: number
}

interface RenderInput extends UnknownRecord {}

interface MarkdownRow {
  type: string
  text?: string
  images?: ImagePreview[]
}

interface TextSection {
  title?: unknown
  content?: unknown
  lines?: unknown
  images?: unknown
}

interface ImagePreview {
  dataUrl: string
  label: string
}

interface MindMapNode {
  title: string
  depth: number
  children: MindMapNode[]
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

export {
  ImageRenderer,
  cleanupRenderCache,
  listImageRenderers,
  normalizeRenderKind,
  persistRender,
  registerImageRenderer,
  renderCacheStats,
  renderImageByKind,
  renderKindCatalog,
  renderKindLabels,
  renderRendererRegistry,
  unregisterImageRenderer,
}

const palette = {
  bg: "#f7f6ee",
  panel: "#ffffff",
  panelSoft: "#eef4f0",
  ink: "#1f2520",
  muted: "#667064",
  line: "#d9ded4",
  accent: "#257c6a",
  accentSoft: "#dff0ea",
  warn: "#a35d00",
  blue: "#2d5f8b",
  violet: "#7654a6",
  rose: "#a84f61",
  gold: "#a9842c",
}

function renderConfig(config: unknown = {}): RenderConfig {
  const response = record(record(config).response)
  return {
    enabled: true,
    engine: "sharp-svg",
    cache: true,
    cacheTtlMs: 24 * 60 * 60 * 1000,
    width: 1120,
    maxTextChars: 8000,
    helpAsImage: true,
    conversationListAsImage: true,
    mediaThumbnails: true,
    mediaThumbnailMaxCount: 3,
    mediaThumbnailMaxDataUrlChars: 800000,
    ...record(response.render),
  }
}

function escapeHtml(value: unknown = ""): string {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function wrapLine(line: unknown = "", maxVisual = 58): string[] {
  const chunks: string[] = []
  let current = ""
  let currentSize = 0
  for (const char of text(line)) {
    const size = char.charCodeAt(0) > 255 ? 2 : 1
    if (current && currentSize + size > maxVisual) {
      chunks.push(current)
      current = char
      currentSize = size
    } else {
      current += char
      currentSize += size
    }
  }
  chunks.push(current)
  return chunks
}

function wrapText(value: unknown = "", maxVisual = 58, maxChars = 8000): string[] {
  const safe = text(value || "").slice(0, Math.max(200, numberValue(maxChars, 8000)))
  const lines: string[] = []
  for (const raw of safe.split("\n")) {
    if (!raw) {
      lines.push("")
      continue
    }
    lines.push(...wrapLine(raw, maxVisual))
  }
  return lines
}

function textNode(line: unknown, x: number, y: number, opts: UnknownRecord = {}): string {
  const fill = text(opts.fill || palette.ink)
  const size = numberValue(opts.size, 26)
  const weight = opts.weight ? ` font-weight="${text(opts.weight)}"` : ""
  const family = opts.mono === true
    ? "Menlo, Consolas, 'Noto Sans SC', monospace"
    : "Inter, 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-family="${family}"${weight}>${escapeHtml(line)}</text>`
}

function compactText(value: unknown = "", max = 160): string {
  const compact = text(value || "").replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact
}

function parseMarkdownRows(markdown: unknown = "", opts: UnknownRecord = {}): MarkdownRow[] {
  const maxChars = Math.max(500, numberValue(opts.maxChars, 10000))
  const rows: MarkdownRow[] = []
  let inCode = false
  let codeLang = ""
  for (const rawLine of text(markdown || "").slice(0, maxChars).split("\n")) {
    const line = rawLine.replace(/\t/g, "  ")
    const fence = line.match(/^```(\S*)/)
    if (fence) {
      if (!inCode) {
        inCode = true
        codeLang = fence[1] || "code"
        rows.push({ type: "code-title", text: codeLang })
      } else {
        inCode = false
        codeLang = ""
        rows.push({ type: "gap" })
      }
      continue
    }
    if (inCode) {
      rows.push({ type: codeLang === "mermaid" ? "mermaid" : "code", text: line })
      continue
    }
    if (!line.trim()) {
      rows.push({ type: "gap" })
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      rows.push({ type: `h${heading[1].length}`, text: heading[2].trim() })
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      rows.push({ type: "list", text: line.replace(/^\s*[-*+]\s+/, "").trim() })
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      rows.push({ type: "list", text: line.replace(/^\s*\d+[.)]\s+/, "").trim() })
      continue
    }
    if (/^\s*>/.test(line)) {
      rows.push({ type: "quote", text: line.replace(/^\s*>\s?/, "").trim() })
      continue
    }
    if (/^\s*\$\$/.test(line) || /\$[^$]+\$/.test(line)) {
      rows.push({ type: "math", text: line.trim() })
      continue
    }
    rows.push({ type: "p", text: line.trim() })
  }
  return rows
}

function renderMarkdownRows(rows: MarkdownRow[] = [], width: number, config: unknown = {}): { body: string[]; height: number } {
  const cfg = renderConfig(config)
  const maxVisual = Math.max(30, Math.floor((width - 156) / 17))
  const body: string[] = []
  let y = 176
  for (const row of rows.length ? rows : [{ type: "p", text: "暂无内容" }]) {
    if (row.type === "gap") {
      y += 16
      continue
    }
    const wrapped = wrapText(row.text, row.type === "code" || row.type === "mermaid" ? Math.max(24, Math.floor(maxVisual * 0.82)) : maxVisual, cfg.maxTextChars)
    if (row.type === "h1" || row.type === "h2") {
      const size = row.type === "h1" ? 30 : 26
      body.push(`<rect x="56" y="${y - 30}" width="${width - 112}" height="${Math.max(50, wrapped.length * 38)}" rx="8" fill="${palette.accentSoft}"/>`)
      for (const line of wrapped) {
        body.push(textNode(line, 76, y, { size, fill: palette.accent, weight: 800 }))
        y += size + 12
      }
      y += 14
      continue
    }
    if (row.type === "h3" || row.type === "h4") {
      for (const line of wrapped) {
        body.push(textNode(line, 70, y, { size: 24, fill: palette.blue, weight: 700 }))
        y += 34
      }
      y += 6
      continue
    }
    if (row.type === "code-title") {
      body.push(`<rect x="56" y="${y - 27}" width="${width - 112}" height="42" rx="8" fill="#222821"/>`)
      body.push(textNode(row.text || "code", 76, y, { size: 20, fill: "#d8e6dc", weight: 700, mono: true }))
      y += 44
      continue
    }
    if (row.type === "code" || row.type === "mermaid" || row.type === "math") {
      const fill = row.type === "math" ? "#fbf6e5" : "#f2f4ef"
      const stroke = row.type === "math" ? "#ead9a8" : palette.line
      const height = Math.max(42, wrapped.length * 30 + 18)
      body.push(`<rect x="56" y="${y - 25}" width="${width - 112}" height="${height}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`)
      for (const line of wrapped) {
        body.push(textNode(line, 76, y, { size: 20, fill: row.type === "math" ? palette.warn : "#28312d", mono: row.type !== "math" }))
        y += 30
      }
      y += 22
      continue
    }
    if (row.type === "quote") {
      body.push(`<rect x="62" y="${y - 26}" width="6" height="${Math.max(36, wrapped.length * 32)}" rx="3" fill="${palette.violet}"/>`)
      for (const line of wrapped) {
        body.push(textNode(line, 84, y, { size: 22, fill: palette.muted }))
        y += 32
      }
      y += 8
      continue
    }
    for (const line of wrapped) {
      if (row.type === "list") {
        body.push(`<circle cx="72" cy="${y - 8}" r="5" fill="${palette.accent}"/>`)
        body.push(textNode(line, 92, y, { size: 23, fill: palette.ink }))
      } else {
        body.push(textNode(line, 70, y, { size: 23, fill: palette.ink }))
      }
      y += 33
    }
  }
  return { body, height: Math.max(360, y + 82) }
}

async function svgToPng(svg: string, kind: string, meta: UnknownRecord, config: unknown): Promise<UnknownRecord> {
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer()
  const cache = await persistRender(kind, buffer, meta, record(config)).catch(error => {
    hostRuntime.logger?.warn?.("[yui-chat] 渲染缓存写入失败", error)
    return null
  })
  return { buffer, cache }
}

function normalizeSections(input: RenderInput = {}): TextSection[] {
  if (Array.isArray(input.sections)) return input.sections as TextSection[]
  if (input.content) return [{ title: input.sectionTitle || "", lines: text(input.content).split("\n") }]
  return []
}

function safeDataImageUrl(value: unknown = "", config: unknown = {}): string {
  const cfg = renderConfig(config)
  const url = text(value || "")
  if (!/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(url)) return ""
  if (url.length > Math.max(1000, numberValue(cfg.mediaThumbnailMaxDataUrlChars, 800000))) return ""
  return url.replace(/\s+/g, "")
}

function normalizeSectionImages(images: unknown = [], config: unknown = {}): ImagePreview[] {
  const cfg = renderConfig(config)
  if (cfg.mediaThumbnails === false) return []
  const limit = Math.max(0, Math.min(6, numberValue(cfg.mediaThumbnailMaxCount, 3)))
  return (Array.isArray(images) ? images : [])
    .map(item => {
      const value = typeof item === "string" ? item : record(item)
      const dataUrl = safeDataImageUrl(typeof value === "string" ? value : value.dataUrl || value.url || value.preparedUrl, config)
      if (!dataUrl) return null
      return {
        dataUrl,
        label: compactText(typeof value === "object" ? value.label || value.source || value.mimeType || "图片" : "图片", 24),
      }
    })
    .filter((item): item is ImagePreview => Boolean(item))
    .slice(0, limit)
}

function imageStripNode(images: ImagePreview[] = [], x: number, y: number, width: number): { svg: string; height: number } {
  if (!images.length) return { svg: "", height: 0 }
  const gap = 16
  const itemCount = images.length
  const itemW = Math.max(190, Math.min(280, Math.floor((width - gap * (itemCount - 1)) / itemCount)))
  const itemH = 156
  const parts: string[] = []
  for (const [index, item] of images.entries()) {
    const ix = x + index * (itemW + gap)
    parts.push(`<rect x="${ix}" y="${y}" width="${itemW}" height="${itemH}" rx="8" fill="${palette.panelSoft}" stroke="${palette.line}" stroke-width="2"/>`)
    parts.push(`<image href="${item.dataUrl}" x="${ix + 8}" y="${y + 8}" width="${itemW - 16}" height="${itemH - 38}" preserveAspectRatio="xMidYMid meet"/>`)
    parts.push(textNode(item.label || `图片 ${index + 1}`, ix + 12, y + itemH - 12, { size: 16, fill: palette.muted }))
  }
  return { svg: parts.join("\n"), height: itemH + 22 }
}

export async function renderTextCard(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const cfg = renderConfig(config)
  if (cfg.enabled === false) throw new Error("图片渲染服务未启用。")
  const width = Math.min(1800, Math.max(720, numberValue(input.width || cfg.width, 1120)))
  const maxVisual = Math.max(28, Math.floor((width - 144) / 18))
  const sections = normalizeSections(input)
  const rows: MarkdownRow[] = []
  for (const section of sections) {
    if (section.title) rows.push({ type: "section", text: text(section.title) })
    const images = normalizeSectionImages(section.images, config)
    if (images.length) rows.push({ type: "images", images })
    const rawLines = Array.isArray(section.lines) ? section.lines : text(section.content || "").split("\n")
    for (const raw of rawLines) {
      for (const line of wrapText(raw, maxVisual, cfg.maxTextChars)) rows.push({ type: "line", text: line })
    }
    rows.push({ type: "gap" })
  }
  if (!rows.length) rows.push({ type: "line", text: "暂无内容" })

  const title = text(input.title || "Yui Chat").slice(0, 80)
  const subtitle = text(input.subtitle || "").slice(0, 120)
  const footer = text(input.footer || `Generated at ${new Date().toLocaleString("zh-CN", { hour12: false })}`).slice(0, 160)
  const headerHeight = subtitle ? 132 : 100
  let y = headerHeight + 42
  const body = []
  for (const row of rows) {
    if (row.type === "gap") {
      y += 12
      continue
    }
    if (row.type === "images") {
      const strip = imageStripNode(row.images, 72, y - 18, width - 144)
      body.push(strip.svg)
      y += strip.height
      continue
    }
    if (row.type === "section") {
      body.push(`<rect x="56" y="${y - 25}" width="${width - 112}" height="42" rx="7" fill="${palette.accentSoft}"/>`)
      body.push(textNode(row.text, 76, y, { size: 22, fill: palette.accent, weight: 700 }))
      y += 52
      continue
    }
    body.push(textNode(row.text, 72, y, { size: 24, fill: palette.ink }))
    y += 34
  }
  const height = Math.max(280, y + 86)
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${palette.bg}"/>
    <rect x="28" y="28" width="${width - 56}" height="${height - 56}" rx="10" fill="${palette.panel}" stroke="${palette.line}" stroke-width="2"/>
    <rect x="28" y="28" width="${width - 56}" height="${headerHeight}" rx="10" fill="${palette.panelSoft}"/>
    <rect x="28" y="${28 + headerHeight - 10}" width="${width - 56}" height="12" fill="${palette.panelSoft}"/>
    <circle cx="72" cy="74" r="18" fill="${palette.accent}"/>
    ${textNode(title, 104, 82, { size: 32, fill: palette.ink, weight: 800 })}
    ${subtitle ? textNode(subtitle, 104, 122, { size: 22, fill: palette.muted }) : ""}
    ${body.join("\n")}
    <line x1="56" y1="${height - 62}" x2="${width - 56}" y2="${height - 62}" stroke="${palette.line}" stroke-width="2"/>
    ${textNode(footer, 56, height - 30, { size: 18, fill: palette.muted })}
  </svg>`
  return svgToPng(svg, text(input.cacheKind || "text-card"), { title, subtitle, rows: rows.length }, config)
}

export async function renderChatCard(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const sender = record(input.sender)
  const scope = record(input.scope)
  const metadata = record(input.metadata)
  const media = record(input.media)
  const steps = records(input.steps)
  const suggestions = Array.isArray(input.suggestedResponses) ? input.suggestedResponses : []
  const sections: TextSection[] = [
    {
      title: "用户消息",
      lines: [
        `用户：${text(sender.name || sender.userId || "unknown")}`,
        scope.groupId ? `群聊：${text(scope.groupName || scope.groupId)}` : `私聊：${text(sender.userId || "unknown")}`,
        text(input.prompt || "空消息"),
      ],
    },
  ]
  const quote = record(input.quote)
  if (quote.text) {
    sections.push({
      title: "引用消息",
      lines: [
        `来自：${text(record(quote.sender).name || record(quote.sender).userId || "unknown")}`,
        text(quote.text),
      ],
    })
  }
  const mediaLines = []
  if (media.images) mediaLines.push(`图片：${text(media.images)} 张`)
  if (media.records) mediaLines.push(`语音：${text(media.records)} 条`)
  if (media.videos) mediaLines.push(`视频：${text(media.videos)} 条`)
  if (Array.isArray(media.mentions) && media.mentions.length) mediaLines.push(`提及：${media.mentions.map(text).join("、")}`)
  if (Array.isArray(media.diagnostics) && media.diagnostics.length) mediaLines.push(`媒体诊断：${media.diagnostics.slice(0, 3).map(text).join("；")}`)
  if (mediaLines.length || (Array.isArray(media.thumbnails) && media.thumbnails.length)) {
    sections.push({
      title: "媒体上下文",
      images: media.thumbnails,
      lines: mediaLines,
    })
  }
  sections.push({
    title: "AI 回复",
    lines: text(input.answer || input.content || "").split("\n").filter(Boolean),
  })
  if (steps.length) {
    sections.push({
      title: "模型流程",
      lines: steps.slice(0, 6).map(step => {
        const status = text(step.status || "ok")
        const cost = step.durationMs === undefined ? "" : ` · ${text(step.durationMs)}ms`
        return `${text(step.stepId || step.id || step.mode || "step")}：${text(step.channel || metadata.channel || "unknown")} / ${text(step.adapter || "-")} · ${status}${cost}`
      }),
    })
  } else if (metadata.channel || metadata.adapter || metadata.toolRounds) {
    sections.push({
      title: "模型信息",
      lines: [
        `渠道：${text(metadata.channel || "unknown")}`,
        metadata.adapter ? `适配器：${text(metadata.adapter)}` : "",
        metadata.toolRounds ? `工具轮次：${text(metadata.toolRounds)}` : "",
      ].filter(Boolean),
    })
  }
  if (suggestions.length) {
    sections.push({
      title: "建议回复",
      lines: suggestions.slice(0, 5).map((item, index) => `${index + 1}. ${text(item)}`),
    })
  }
  return renderTextCard({
    title: text(input.title || "Yui Chat 对话卡片"),
    subtitle: text(input.subtitle || `${metadata.source === "firstPerson" ? "第一人称" : "对话"} · ${metadata.channel || "unknown"}`),
    sections,
    footer: input.footer || "Yui Chat · Rich Chat Card",
    width: input.width,
    cacheKind: "chat-card",
  }, config)
}

export function commandHelpSections(matches: unknown[] = []): TextSection[] {
  if (!matches.length) return [{ title: "没有找到匹配指令", lines: ["可以换一种说法，或稍后等知识库完成扫描。"] }]
  const groups = matches.reduce<Record<string, UnknownRecord[]>>((acc, rawItem, index) => {
    const item = record(rawItem)
    const key = `${item.sectionRank ?? 99}:${item.sectionLabel || "其他功能"}`
    ;(acc[key] ||= []).push({ ...item, _order: index + 1 })
    return acc
  }, {})
  return Object.entries(groups).flatMap(([, rows]) => {
    const title = text(rows[0]?.sectionLabel || "其他功能")
    return [{
      title: `${title} · ${rows.length} 条`,
      lines: rows.flatMap(item => [
        `${item._order}. ${text(item.pluginName || "未知插件")} · ${text(item.description || "无描述")}`,
        `建议：${text(record(item.recommendation).command || item.suggestedCommand || item.example || item.fnc || "未知")}`,
        `理由：${text(record(item.recommendation).reason || item.reason || "匹配指令知识库")}`,
        record(item.recommendation).confidence ? `置信度：${text(record(item.recommendation).confidence)}` : "",
        (() => { const nextSteps = record(item.recommendation).nextSteps; return Array.isArray(nextSteps) && nextSteps.length ? `下一步：${nextSteps.slice(0, 3).map(text).join("；")}` : "" })(),
        (() => { const heads = Array.isArray(item.commandHeads) ? item.commandHeads : record(item.usageGuide).heads; return Array.isArray(heads) && heads.length ? `触发头：${heads.slice(0, 6).map(text).join("、")}` : "" })(),
        (() => { const hints = Array.isArray(item.parameterHints) ? item.parameterHints : record(item.usageGuide).parameters; return Array.isArray(hints) && hints.length ? `参数：${hints.slice(0, 4).map(hint => text(record(hint).name)).join("、")}` : "" })(),
        `权限：${text(item.permission || "all")}    事件：${text(item.event || "message")}    使用：${numberValue(item.usageCount)} 次`,
        Array.isArray(item.matchedTokens) && item.matchedTokens.length ? `关键词：${item.matchedTokens.slice(0, 10).map(text).join("、")}` : "",
        "",
      ].filter(Boolean)),
    }]
  })
}

export async function renderCommandHelp({ query = "", matches = [], stats = {}, config = {} }: UnknownRecord = {}): Promise<UnknownRecord> {
  const queryText = text(query)
  const matchList = Array.isArray(matches) ? matches : []
  const statValue = record(stats)
  const title = queryText ? `指令推荐：${queryText}` : "Yui Chat 指令帮助"
  const subtitle = `已索引 ${numberValue(statValue.commands, matchList.length)} 条指令，动态记录 ${numberValue(statValue.events)} 条`
  const sections = query
    ? commandHelpSections(matchList)
    : [
        {
          title: "常用入口",
          lines: [
            "#yuichat + 内容",
            "#yuihelp + 你想做的事",
            "#yui结束对话",
            "#yui面板",
            "#yui文本模式 / #yui图片模式 / #yui语音模式",
            "#yui渲染帮助",
          ],
        },
        {
          title: "能力索引",
            lines: [`指令知识库：${numberValue(statValue.commands)} 条指令，${numberValue(statValue.events)} 条触发记录`],
        },
      ]
  return renderTextCard({ title, subtitle, sections, footer: "Yui Chat · Command Knowledge" }, config)
}

function normalizeHelpGroups(input: RenderInput = {}): TextSection[] {
  const groups = records(input.groups)
  if (groups.length) {
    return groups.map(group => ({
      title: text(group.title || group.name || "帮助分组"),
      lines: (Array.isArray(group.commands) ? group.commands : Array.isArray(group.lines) ? group.lines : []).map(item => {
        if (typeof item === "string") return item
        const value = record(item)
        const command = text(value.command || value.cmd || value.example || "")
        const description = text(value.description || value.desc || value.label || "")
        const permission = value.permission ? ` / ${text(value.permission)}` : ""
        return [command, description ? `- ${description}` : "", permission].filter(Boolean).join(" ")
      }).filter(Boolean),
    })).filter(group => group.lines.length)
  }
  if (Array.isArray(input.sections)) return input.sections as TextSection[]
  return [
    {
      title: "聊天入口",
      lines: [
        "#yuichat + 内容 - 与 Yui Chat 对话",
        "#yuihelp + 需求 - 检索 Yunzai 指令知识库",
        "#yui结束对话 - 结束当前会话",
      ],
    },
    {
      title: "管理入口",
      lines: [
        "#yui面板 - 获取一次性 Web 管理端快捷登录链接",
        "#yui诊断 - 查看模型、工具、知识库和缓存状态",
        "#yui对话列表 - 查看当前活跃会话",
      ],
    },
    {
      title: "统一渲染",
      lines: [
        "render_image({ template, data }) - 模型工具统一入口",
        "#yui图片模式 - 聊天输出自动转为图片卡片",
        "#yui渲染帮助菜单 - 发送默认帮助菜单图",
      ],
    },
  ]
}

export async function renderHelpMenu(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const title = compactText(input.title || "Yui Chat 帮助菜单", 80)
  const subtitle = compactText(input.subtitle || "常用命令、管理入口和统一模板渲染", 140)
  const sections = normalizeHelpGroups(input)
  return renderTextCard({
    title,
    subtitle,
    sections,
    footer: input.footer || "Yui Chat · Help Menu Render",
    width: input.width,
    cacheKind: "help-menu",
  }, config)
}

export async function renderConversationList(rows: unknown[] = [], config: unknown = {}): Promise<UnknownRecord> {
  const sections = rows.length
    ? rows.map((rawRow, index) => {
        const row = record(rawRow)
        const scope = row.type === "group" ? `群 ${text(row.groupId)} / 用户 ${text(row.userId)}` : `私聊 ${text(row.userId)}`
        return {
          title: `${index + 1}. ${text(row.channel)} · ${scope}`,
          lines: [
            `${text(row.turns)} 轮 · ${text(row.historyMessages)} 条消息 · ${text(row.lastSeenAt || "未知时间")}`,
            `工具 ${numberValue(row.toolCalls)} 次 · Token ${numberValue(record(row.usage).total)}（输入 ${numberValue(record(row.usage).input)} / 输出 ${numberValue(record(row.usage).output)}）`,
            row.preview ? `最近：${text(row.preview)}` : "",
          ].filter(Boolean),
        }
      })
    : [{ title: "暂无活跃对话", lines: ["当前没有 Yui Chat 活跃对话。"] }]
  return renderTextCard({
    title: "Yui Chat 活跃对话",
    subtitle: rows.length ? `最多显示 ${rows.length} 个会话作用域` : "会话列表为空",
    sections,
    footer: "可用 #yui结束对话 结束当前对话，群聊中可用 #yui结束对话 @用户。",
  }, config)
}

export async function renderMarkdownDocument(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const cfg = renderConfig(config)
  if (cfg.enabled === false) throw new Error("图片渲染服务未启用。")
  const width = Math.min(1800, Math.max(760, numberValue(input.width || cfg.width, 1120)))
  const title = compactText(input.title || "Markdown 渲染", 80)
  const subtitle = compactText(input.subtitle || "支持 Markdown、代码块、公式文本和 Mermaid 源码卡片", 140)
  const rows = parseMarkdownRows(input.markdown || input.content || "", { maxChars: cfg.maxTextChars })
  const { body, height } = renderMarkdownRows(rows, width, config)
  const footer = compactText(input.footer || "Yui Chat · Markdown Render", 160)
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${palette.bg}"/>
    <rect x="28" y="28" width="${width - 56}" height="${height - 56}" rx="10" fill="${palette.panel}" stroke="${palette.line}" stroke-width="2"/>
    <rect x="28" y="28" width="${width - 56}" height="116" rx="10" fill="${palette.panelSoft}"/>
    <rect x="28" y="134" width="${width - 56}" height="14" fill="${palette.panelSoft}"/>
    <rect x="62" y="58" width="36" height="36" rx="8" fill="${palette.accent}"/>
    ${textNode(title, 116, 82, { size: 32, fill: palette.ink, weight: 800 })}
    ${textNode(subtitle, 116, 120, { size: 21, fill: palette.muted })}
    ${body.join("\n")}
    <line x1="56" y1="${height - 62}" x2="${width - 56}" y2="${height - 62}" stroke="${palette.line}" stroke-width="2"/>
    ${textNode(footer, 56, height - 30, { size: 18, fill: palette.muted })}
  </svg>`
  return svgToPng(svg, "markdown-document", { title, rows: rows.length }, config)
}

/** 使用受限数学表达式解析器绘制笛卡尔函数图，不执行用户提供的 JavaScript。 */
export async function renderFunctionPlot(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const { svg, meta } = buildFunctionPlotSvg(input)
  return svgToPng(svg, "function-plot", meta, config)
}

function parseMindMapNodes(markdown: unknown = ""): MindMapNode {
  const root: MindMapNode = { title: "思维导图", depth: 0, children: [] }
  const stack: MindMapNode[] = [root]
  for (const raw of text(markdown || "").split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^(#{1,5})\s+(.+)$/)
    const list = line.match(/^[-*+]\s+(.+)$/)
    const depth = heading ? heading[1].length : list ? Math.min(5, stack.length) : 0
    const title = compactText(heading ? heading[2] : list ? list[1] : line, 80)
    if (!title) continue
    if (!root.children.length && depth <= 1) {
      root.title = title
      stack.length = 1
      stack[0] = root
      continue
    }
    const node: MindMapNode = { title, depth, children: [] }
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return root
}

function flattenMindMap(root: MindMapNode): Array<{ title: string; children: Array<{ title: string; level: number }> }> {
  const branches = root.children.length ? root.children : [{ title: "暂无分支", depth: 1, children: [] }]
  const rows: Array<{ title: string; children: Array<{ title: string; level: number }> }> = []
  for (const branch of branches.slice(0, 8)) {
    const children: Array<{ title: string; level: number }> = []
    const walk = (node: MindMapNode, level = 0): void => {
      for (const child of node.children || []) {
        children.push({ title: child.title, level })
        if (children.length < 18) walk(child, level + 1)
      }
    }
    walk(branch)
    rows.push({ title: branch.title, children: children.slice(0, 18) })
  }
  return rows
}

export async function renderMindMap(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const cfg = renderConfig(config)
  if (cfg.enabled === false) throw new Error("图片渲染服务未启用。")
  const width = Math.min(1800, Math.max(960, numberValue(input.width || cfg.width || 1120, 1120)))
  const root = parseMindMapNodes(input.markdown || input.content || "")
  if (input.title) root.title = compactText(input.title, 80)
  const branches = flattenMindMap(root)
  const branchHeight = 76
  const childHeight = 34
  const columnX = 430
  const childX = 720
  const rootY = Math.max(180, 120 + Math.floor(branches.length * branchHeight / 2))
  let y = 120
  const rootLines = wrapText(root.title, 18, 120).slice(0, 3)
  const body = [
    `<rect x="58" y="${rootY - 54}" width="300" height="108" rx="12" fill="${palette.accent}" filter="url(#shadow)"/>`,
  ]
  rootLines.forEach((line, lineIndex) => {
    body.push(textNode(line, 86, rootY - 18 + lineIndex * 32, { size: 26, fill: "#ffffff", weight: 800 }))
  })
  for (const [index, branch] of branches.entries()) {
    const childrenHeight = Math.max(branchHeight, branch.children.length * childHeight + 24)
    const branchY = y + Math.floor(childrenHeight / 2)
    const color = [palette.blue, palette.violet, palette.rose, palette.gold, palette.accent][index % 5]
    body.push(`<path d="M358 ${rootY} C390 ${rootY}, 390 ${branchY}, ${columnX - 18} ${branchY}" fill="none" stroke="${color}" stroke-width="4"/>`)
    body.push(`<rect x="${columnX}" y="${branchY - 30}" width="250" height="60" rx="10" fill="${color}"/>`)
    wrapText(branch.title, 15, 100).slice(0, 2).forEach((line, lineIndex) => {
      body.push(textNode(line, columnX + 20, branchY - 4 + lineIndex * 25, { size: 20, fill: "#ffffff", weight: 700 }))
    })
    let childY = y + 24
    for (const child of branch.children) {
      const offset = Math.min(54, child.level * 22)
      body.push(`<path d="M${columnX + 250} ${branchY} C${columnX + 300} ${branchY}, ${childX - 28 + offset} ${childY - 8}, ${childX + offset} ${childY - 8}" fill="none" stroke="${palette.line}" stroke-width="3"/>`)
      body.push(`<rect x="${childX + offset}" y="${childY - 28}" width="${width - childX - offset - 60}" height="36" rx="8" fill="${palette.panelSoft}" stroke="${palette.line}"/>`)
      body.push(textNode(child.title, childX + offset + 16, childY - 3, { size: 18, fill: palette.ink }))
      childY += childHeight
    }
    y += childrenHeight + 22
  }
  const height = Math.max(420, y + 70)
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#1f2520" flood-opacity="0.14"/></filter></defs>
    <rect width="100%" height="100%" fill="${palette.bg}"/>
    <rect x="28" y="28" width="${width - 56}" height="${height - 56}" rx="10" fill="${palette.panel}" stroke="${palette.line}" stroke-width="2"/>
    ${body.join("\n")}
    ${textNode("Yui Chat · Mind Map Render", 56, height - 30, { size: 18, fill: palette.muted })}
  </svg>`
  return svgToPng(svg, "mind-map", { title: root.title, branches: branches.length }, config)
}

function normalizeWords(input: RenderInput = {}): Array<{ text: string; weight: number }> {
  if (Array.isArray(input.words)) {
    return input.words.map(item => {
      if (Array.isArray(item)) return { text: text(item[0] || ""), weight: numberValue(item[1], 1) }
      if (typeof item === "object") {
        const value = record(item)
        return { text: text(value.text || value.word || ""), weight: numberValue(value.weight || value.count, 1) }
      }
      return { text: text(item), weight: 1 }
    }).filter(item => item.text)
  }
  const counts = new Map()
  for (const token of text(input.text || "").match(/[\p{Script=Han}A-Za-z0-9_]{2,}/gu) || []) {
    counts.set(token, (counts.get(token) || 0) + 1)
  }
  return [...counts.entries()].map(([text, weight]) => ({ text, weight }))
}

export async function renderWordCloud(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const cfg = renderConfig(config)
  if (cfg.enabled === false) throw new Error("图片渲染服务未启用。")
  const width = Math.min(1800, Math.max(840, numberValue(input.width || cfg.width || 1120, 1120)))
  const words = normalizeWords(input).sort((a, b) => b.weight - a.weight).slice(0, 64)
  const maxWeight = Math.max(1, ...words.map(item => item.weight))
  const colors = [palette.accent, palette.blue, palette.violet, palette.rose, palette.gold, palette.ink]
  const body = []
  const cols = 4
  const cellW = (width - 120) / cols
  const startY = 150
  for (const [index, item] of words.entries()) {
    const row = Math.floor(index / cols)
    const col = index % cols
    const x = 70 + col * cellW + ((index * 37) % 28)
    const y = startY + row * 58 + ((index * 19) % 16)
    const size = Math.round(18 + (numberValue(item.weight, 1) / maxWeight) * 34)
    body.push(textNode(compactText(item.text, 18), x, y, { size, fill: colors[index % colors.length], weight: index < 10 ? 800 : 600 }))
  }
  const rows = Math.max(2, Math.ceil(Math.max(1, words.length) / cols))
  const height = Math.max(360, startY + rows * 58 + 86)
  const title = compactText(input.title || "动态词云", 80)
  const subtitle = compactText(input.subtitle || `共 ${words.length} 个关键词`, 120)
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${palette.bg}"/>
    <rect x="28" y="28" width="${width - 56}" height="${height - 56}" rx="10" fill="${palette.panel}" stroke="${palette.line}" stroke-width="2"/>
    <rect x="44" y="44" width="${width - 88}" height="76" rx="8" fill="${palette.panelSoft}"/>
    ${textNode(title, 70, 84, { size: 32, fill: palette.ink, weight: 800 })}
    ${textNode(subtitle, 70, 112, { size: 19, fill: palette.muted })}
    ${body.join("\n")}
    ${textNode("Yui Chat · Word Cloud Render", 56, height - 30, { size: 18, fill: palette.muted })}
  </svg>`
  return svgToPng(svg, "word-cloud", { title, words: words.length }, config)
}

export async function renderDynamicPanel(input: RenderInput = {}, config: unknown = {}): Promise<UnknownRecord> {
  const cfg = renderConfig(config)
  if (cfg.enabled === false) throw new Error("图片渲染服务未启用。")
  const width = Math.min(1800, Math.max(860, numberValue(input.width || cfg.width || 1120, 1120)))
  const title = compactText(input.title || "动态状态卡片", 80)
  const subtitle = compactText(input.subtitle || new Date().toLocaleString("zh-CN", { hour12: false }), 140)
  const metrics = records(input.metrics).slice(0, 8)
  const sections = records(input.sections).slice(0, 8)
  let y = 156
  const body = []
  const metricW = Math.floor((width - 112 - Math.max(0, metrics.length - 1) * 16) / Math.max(1, Math.min(4, metrics.length || 1)))
  for (const [index, metric] of metrics.entries()) {
    const col = index % 4
    const row = Math.floor(index / 4)
    const x = 56 + col * (metricW + 16)
    const my = y + row * 104
    body.push(`<rect x="${x}" y="${my}" width="${metricW}" height="84" rx="9" fill="${palette.panelSoft}" stroke="${palette.line}" stroke-width="2"/>`)
    body.push(textNode(compactText(metric.label || `指标 ${index + 1}`, 20), x + 18, my + 30, { size: 18, fill: palette.muted, weight: 700 }))
    body.push(textNode(compactText(metric.value ?? "-", 24), x + 18, my + 64, { size: 30, fill: [palette.accent, palette.blue, palette.rose, palette.gold][index % 4], weight: 800 }))
  }
  if (metrics.length) y += Math.ceil(metrics.length / 4) * 104 + 16
  for (const section of sections) {
    const lines = Array.isArray(section.lines) ? section.lines : text(section.content || "").split("\n")
    body.push(`<rect x="56" y="${y}" width="${width - 112}" height="${48 + Math.min(6, lines.length) * 30}" rx="8" fill="${palette.panel}" stroke="${palette.line}" stroke-width="2"/>`)
    body.push(textNode(compactText(section.title || "状态", 60), 76, y + 34, { size: 22, fill: palette.ink, weight: 800 }))
    let lineY = y + 68
    for (const line of lines.slice(0, 6)) {
      body.push(textNode(compactText(line, 90), 78, lineY, { size: 20, fill: palette.muted }))
      lineY += 30
    }
    y += 64 + Math.min(6, lines.length) * 30
  }
  const height = Math.max(360, y + 84)
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${palette.bg}"/>
    <rect x="28" y="28" width="${width - 56}" height="${height - 56}" rx="10" fill="${palette.panel}" stroke="${palette.line}" stroke-width="2"/>
    <rect x="28" y="28" width="${width - 56}" height="108" rx="10" fill="${palette.accent}"/>
    <rect x="28" y="118" width="${width - 56}" height="18" fill="${palette.accent}"/>
    ${textNode(title, 64, 76, { size: 34, fill: "#ffffff", weight: 800 })}
    ${textNode(subtitle, 64, 112, { size: 21, fill: "#e5f5ef" })}
    ${body.join("\n")}
    ${textNode(input.footer || "Yui Chat · Dynamic Render", 56, height - 30, { size: 18, fill: palette.muted })}
  </svg>`
  return svgToPng(svg, "dynamic-panel", { title, metrics: metrics.length, sections: sections.length }, config)
}

[
  {
    kind: "text-card",
    label: "文本卡片",
    toolName: "render_image",
    command: "#yui图片模式",
    description: "将普通文本或分段内容渲染为图片，适合长回复、摘要和说明卡片。",
    aliases: ["text", "card"],
    tags: ["reply", "text", "help"],
    render: renderTextCard,
  },
  {
    kind: "chat-card",
    label: "富聊天卡片",
    toolName: "render_image",
    command: "#yui图片模式 / 长文本自动转图",
    description: "把用户消息、引用、媒体摘要、模型流程和 AI 回复渲染为富聊天图片卡片。",
    aliases: ["rich-chat", "chat"],
    tags: ["reply", "chat", "rich"],
    render: renderChatCard,
  },
  {
    kind: "command-help",
    label: "指令帮助图",
    toolName: "render_image",
    command: "#yuihelp / #yui渲染帮助",
    description: "检索指令知识库并把推荐命令渲染成图片，适合帮助指令和引导问答。",
    aliases: ["help"],
    tags: ["help", "command", "knowledge"],
    render: (input: UnknownRecord, config: UnknownRecord) => renderCommandHelp({ ...input, config: input.config || config }),
  },
  {
    kind: "help-menu",
    label: "帮助菜单图",
    toolName: "render_image",
    command: "#yuihelp / #yui渲染帮助菜单",
    description: "把固定或动态分组的帮助菜单渲染成图片，适合插件帮助、功能入口和配置引导。",
    aliases: ["menu", "help-menu-card"],
    tags: ["help", "menu", "command"],
    render: renderHelpMenu,
  },
  {
    kind: "conversation-list",
    label: "会话列表图",
    toolName: "render_image",
    command: "#yui对话列表",
    description: "把会话列表行渲染成图片；真实运行时列表仍由 master-only 命令读取。",
    aliases: ["conversations"],
    tags: ["conversation", "runtime"],
    render: (input: UnknownRecord, config: UnknownRecord) => renderConversationList(Array.isArray(input.rows) ? input.rows : Array.isArray(input.conversations) ? input.conversations : [], config),
  },
  {
    kind: "markdown",
    label: "Markdown 图片",
    toolName: "render_image",
    command: "#yui渲染Markdown",
    description: "把 Markdown、公式文本、代码块和 Mermaid 源码卡片渲染成图片。",
    aliases: ["math", "math-markdown"],
    tags: ["markdown", "math", "mermaid"],
    render: renderMarkdownDocument,
  },
  {
    kind: "mindmap",
    label: "思维导图图片",
    toolName: "render_image",
    command: "#yui渲染思维导图",
    description: "把 Markdown 层级结构渲染成思维导图式图片。",
    aliases: ["markmap"],
    tags: ["markdown", "mindmap"],
    render: renderMindMap,
  },
  {
    kind: "function-plot",
    label: "函数图",
    toolName: "render_image",
    command: "#yui渲染函数图",
    description: "安全解析常用数学函数表达式并绘制笛卡尔函数图。",
    aliases: ["graph", "function-graph"],
    tags: ["math", "graph", "function"],
    render: renderFunctionPlot,
  },
  {
    kind: "word-cloud",
    label: "词云图片",
    toolName: "render_image",
    command: "#yui渲染词云",
    description: "根据关键词权重或原始文本生成词云图片。",
    aliases: ["wordcloud"],
    tags: ["wordcloud", "stats"],
    render: renderWordCloud,
  },
  {
    kind: "dynamic-panel",
    label: "动态面板图片",
    toolName: "render_image",
    command: "#yui渲染动态",
    description: "把指标、状态和多段说明渲染成动态状态面板图片。",
    aliases: ["dynamic"],
    tags: ["dashboard", "status", "help"],
    render: renderDynamicPanel,
  },
].forEach(registerImageRenderer)

export const renderService = {
  renderTextCard,
  renderChatCard,
  renderCommandHelp,
  renderHelpMenu,
  renderConversationList,
  renderMarkdownDocument,
  renderMindMap,
  renderWordCloud,
  renderDynamicPanel,
  renderImageByKind,
  normalizeRenderKind,
  renderKindCatalog,
  renderKindLabels,
  renderRendererRegistry,
  listImageRenderers,
  registerImageRenderer,
  unregisterImageRenderer,
  renderCacheStats,
  cleanupRenderCache,
}
