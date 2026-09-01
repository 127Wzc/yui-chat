type UnknownRecord = Record<string, unknown>
type RenderFunction = (input: UnknownRecord, config: UnknownRecord) => unknown

interface ImageRendererDefinition extends UnknownRecord {
  kind?: unknown
  label?: unknown
  toolName?: unknown
  command?: unknown
  description?: unknown
  aliases?: unknown
  engine?: unknown
  tags?: unknown
  render?: unknown
}

export interface ImageRendererCatalogEntry extends UnknownRecord {
  kind: string
  label: string
  toolName: string
  command: string
  description: string
  aliases: string[]
  engine: string
  tags: string[]
}

/**
 * 图片渲染器的轻量描述与执行入口。
 *
 * 类只负责保存渲染器元数据并暴露渲染函数，不负责缓存、权限检查或消息投递；
 * 这些职责分别由渲染缓存、交付层和工具访问策略处理。
 */
export class ImageRenderer {
  readonly kind: string
  readonly label: string
  readonly toolName: string
  readonly command: string
  readonly description: string
  readonly aliases: string[]
  readonly engine: string
  readonly tags: string[]
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
    this.engine = String(definition.engine || "sharp-svg")
    this.tags = Array.isArray(definition.tags) ? definition.tags.map(String) : []
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
      engine: this.engine,
      tags: this.tags,
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
  renderRendererRegistry[renderer.kind] = renderer
  renderKindLabels[renderer.kind] = renderer.label
  for (const alias of renderer.aliases || []) {
    renderRendererRegistry[alias] = renderer
    renderKindLabels[alias] = renderer.label
  }
  return renderer
}

export function unregisterImageRenderer(kind: unknown = ""): boolean {
  const current = renderRendererRegistry[normalizeRendererKey(kind)]
  if (!current) return false
  for (const key of [current.kind, ...(current.aliases || [])]) {
    delete renderRendererRegistry[key]
    delete renderKindLabels[key]
  }
  const index = renderKindCatalog.findIndex(item => item.kind === current.kind)
  if (index >= 0) renderKindCatalog.splice(index, 1)
  return true
}

export function listImageRenderers(): ImageRendererCatalogEntry[] {
  return renderKindCatalog.map(item => ({
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
