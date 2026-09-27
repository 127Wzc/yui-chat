type UnknownRecord = Record<string, unknown>
type RenderFunction = (input: UnknownRecord, config: UnknownRecord) => unknown

interface ImageRendererDefinition extends UnknownRecord {
  kind?: unknown
  label?: unknown
  toolName?: unknown
  command?: unknown
  description?: unknown
  aliases?: unknown
  tags?: unknown
  publicTemplate?: unknown
  render?: unknown
}

export interface ImageRendererCatalogEntry extends UnknownRecord {
  kind: string
  label: string
  toolName: string
  command: string
  description: string
  aliases: string[]
  tags: string[]
  publicTemplate: boolean
}

/**
 * 图片渲染器的轻量描述与执行入口。
 *
 * 类只负责保存渲染器元数据并暴露渲染函数，不负责缓存、权限检查或消息投递；
 * 这些职责分别由渲染引擎、交付层和工具访问策略处理。
 */
export class ImageRenderer {
  readonly kind: string
  readonly label: string
  readonly toolName: string
  readonly command: string
  readonly description: string
  readonly aliases: string[]
  readonly tags: string[]
  readonly publicTemplate: boolean
  readonly render: RenderFunction

  constructor(definition: ImageRendererDefinition = {}) {
    if (!definition.kind) throw new Error("ImageRenderer.kind is required")
    if (typeof definition.render !== "function") throw new Error(`ImageRenderer ${definition.kind} must define render(input, config)`)
    this.kind = String(definition.kind)
    this.label = String(definition.label || "")
    this.toolName = String(definition.toolName || "")
    this.command = String(definition.command || "")
    this.description = String(definition.description || "")
    this.aliases = Array.isArray(definition.aliases) ? definition.aliases.map(String) : []
    this.tags = Array.isArray(definition.tags) ? definition.tags.map(String) : []
    this.publicTemplate = definition.publicTemplate !== false
    this.render = definition.render as RenderFunction
  }

  catalogEntry(): ImageRendererCatalogEntry {
    return {
      kind: this.kind,
      label: this.label,
      toolName: this.toolName,
      command: this.command,
      description: this.description,
      aliases: this.aliases,
      tags: this.tags,
      publicTemplate: this.publicTemplate,
    }
  }
}

export const renderKindCatalog: ImageRendererCatalogEntry[] = []
export const renderRendererRegistry: Record<string, ImageRenderer> = {}
export const renderKindLabels: Record<string, string> = {}

function normalizeRendererKey(kind: unknown = ""): string {
  return String(kind || "").trim().toLowerCase().replace(/_/g, "-")
}

export function registerImageRenderer(definition: ImageRendererDefinition | ImageRenderer = {}): ImageRenderer {
  const renderer = definition instanceof ImageRenderer ? definition : new ImageRenderer(definition)
  unregisterImageRenderer(renderer.kind)
  const existing = renderKindCatalog.findIndex(item => item.kind === renderer.kind)
  const entry = renderer.catalogEntry()
  if (existing >= 0) renderKindCatalog.splice(existing, 1, entry)
  else renderKindCatalog.push(entry)
  renderRendererRegistry[normalizeRendererKey(renderer.kind)] = renderer
  renderKindLabels[normalizeRendererKey(renderer.kind)] = renderer.label
  for (const alias of renderer.aliases || []) {
    const key = normalizeRendererKey(alias)
    renderRendererRegistry[key] = renderer
    renderKindLabels[key] = renderer.label
  }
  return renderer
}

export function unregisterImageRenderer(kind: unknown = ""): boolean {
  const current = renderRendererRegistry[normalizeRendererKey(kind)]
  if (!current) return false
  for (const key of [current.kind, ...(current.aliases || [])]) {
    const normalized = normalizeRendererKey(key)
    delete renderRendererRegistry[normalized]
    delete renderKindLabels[normalized]
  }
  const index = renderKindCatalog.findIndex(item => item.kind === current.kind)
  if (index >= 0) renderKindCatalog.splice(index, 1)
  return true
}

export function listImageRenderers(publicOnly = false): ImageRendererCatalogEntry[] {
  return renderKindCatalog.filter(item => !publicOnly || item.publicTemplate).map(item => ({
    ...item,
    aliases: [...(item.aliases || [])],
    tags: [...(item.tags || [])],
  }))
}

export function normalizeRenderKind(kind: unknown = ""): string {
  const input = normalizeRendererKey(kind)
  if (!input || input === "card" || input === "text") return "text-card"
  return renderRendererRegistry[input]?.kind || input
}

export async function renderImageByKind(kind: unknown, input: UnknownRecord = {}, config: unknown = {}): Promise<unknown> {
  const normalized = normalizeRenderKind(kind)
  const renderer = renderRendererRegistry[normalized]
  if (renderer?.render) return renderer.render(input, config && typeof config === "object" && !Array.isArray(config) ? config as UnknownRecord : {})
  throw new Error(`未知图片渲染类型：${kind}`)
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return String(value ?? "")
}

export const renderInputFormats = ["auto", "html", "markdown", "mindmap", "text"] as const

/** 对外只接受 format + data.content；内部继续复用各领域渲染器。 */
export function resolveRenderRequest(args: UnknownRecord = {}): { kind: string; input: UnknownRecord } {
  const input = { ...record(args.data) }
  if (args.template !== undefined || args.kind !== undefined || input.html !== undefined || input.markdown !== undefined || input.formula !== undefined) {
    throw new Error("请使用 format 和 data.content 指定渲染格式及内容。")
  }
  let format = text(args.format || "auto").trim().toLowerCase()
  if (!(renderInputFormats as readonly string[]).includes(format)) throw new Error("支持的格式：auto、html、markdown、mindmap、text。")
  const content = text(input.content).trim()
  if (format === "auto") {
    if (Array.isArray(input.sections)) format = "text"
    else if (/^(?:<!doctype\s+html|<(?:html|head|body|style|div|main|section|article|header|footer|nav|aside|h[1-6]|p|span|a|img|ul|ol|li|table|thead|tbody|tr|td|th|pre|blockquote|figure|canvas|svg)\b)/i.test(content)) format = "html"
    else format = "markdown"
  }
  if (!content && !(format === "text" && Array.isArray(input.sections) && input.sections.length)) throw new Error("渲染内容不能为空。")
  if (format === "html") input.html = input.content
  if (format === "markdown" || format === "mindmap") input.markdown = input.content
  return { kind: format === "text" ? "text-card" : format, input }
}
