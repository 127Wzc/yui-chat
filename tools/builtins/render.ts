import { resolveRenderRequest, renderInputFormats } from "../../core/rendering/image-renderer-registry.js"
import { configStore } from "../../config/store.js"
import { renderImageByConfiguredEngine, renderKindLabels } from "../../core/rendering/render-service.js"
import { renderUrlToPng } from "../../core/rendering/render-html-service.js"
import { deliverRenderedImage } from "../../core/rendering/render-delivery.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

interface RenderToolContext extends ToolExecutionContext {
  e?: UnknownRecord
  config?: UnknownRecord
}
type ToolArgs = UnknownRecord
interface RenderResult extends UnknownRecord { buffer: Uint8Array }
function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}
function text(value: unknown): string { return String(value ?? "") }
function renderResult(value: unknown): RenderResult {
  const result = record(value)
  return { ...result, buffer: result.buffer instanceof Uint8Array ? result.buffer : new Uint8Array() }
}

/** 所有内容格式共用一个工具权限与投递入口。 */
export class RenderImageTool {
  name = "render_image"
  source = "builtin"
  category = "render"
  risk = "low"
  policy = {}
  tags = ["HTML", "Markdown", "数学公式", "Mermaid", "思维导图", "文本卡片", "排版", "文档转图", "表格", "typesetting", "document-rendering"]
  description = "Use when the user asks to typeset supplied content as an image: documents, formulas, diagrams, tables or cards. This is document/layout rendering, NOT AI drawing or image generation. For requests to draw a character, illustration, scene, or edit an image, use generate_image. Do not replace requested artwork with a text card, even if generate_image is unavailable; report the limitation. Render HTML, Markdown, math formulas, Mermaid diagrams, mind maps or text cards as a PNG in the shared Yui Chat style. Use format plus data.content: auto (default) detects HTML markup vs Markdown; html renders HTML/CSS fragments or documents; markdown renders rich text, $...$ / $$...$$ / \\(...\\) / \\[...\\] formulas and fenced mermaid diagrams; mindmap renders Markdown hierarchies; text renders plain content or sections. Math and Mermaid belong to markdown, not separate formats. All formats follow render_image permissions. HTML always uses HTML rendering with no SVG fallback. For URL screenshots use render_url_screenshot."
  descriptionZh = "内容排版成图：将已有 HTML、Markdown、数学公式、Mermaid、思维导图、表格或文本排成图片，保留统一样式。人物、插画和场景创作请使用 generate_image。"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["format", "data", "send", "targetType", "targetId"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  parameters = {
    type: "object",
    properties: {
      format: { type: "string", enum: [...renderInputFormats], description: "auto, html, markdown, mindmap or text. Defaults to auto. Formulas and Mermaid use markdown." },
      data: {
        type: "object",
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          content: { type: "string", description: "HTML/CSS, Markdown (including delimited LaTeX and fenced Mermaid), a Markdown mind map, or plain text according to format." },
          sections: { type: "array", items: { type: "object" }, description: "Optional text-card sections with title and lines." },
          viewport: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } } },
          fullPage: { type: "boolean" },
          waitMs: { type: "number", description: "Optional bounded HTML wait." },
        },
      },
      send: { type: "boolean", description: "Send to current chat by default; false only renders." },
      targetType: { type: "string", description: "Optional group or user; requires master and response.render.delivery.allowTargetSend." },
      targetId: { type: "string", description: "Optional target id; requires master and response.render.delivery.allowTargetSend." },
    },
    required: ["data"],
  }
  async execute(args: ToolArgs = {}, context: RenderToolContext = {}): Promise<string> {
    const { kind, input } = resolveRenderRequest(args)
    const config = context.config || configStore.get()
    const result = renderResult(await renderImageByConfiguredEngine(kind, input, config))
    const label = renderKindLabels[kind] || "图片"
    if (args.send === false) return `${label}渲染完成：${result.buffer.length} bytes`
    return deliverRenderedImage(result, context, { label, targetType: args.targetType, targetId: args.targetId })
  }
}

export class RenderUrlScreenshotTool {
  name = "render_url_screenshot"
  source = "builtin"
  category = "render"
  risk = "high"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", targetFields: ["url"], operationFields: ["url", "fullPage", "waitMs", "viewport", "send"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  tags = ["image", "render", "url", "screenshot", "external"]
  policy = { requiresMaster: true, highRisk: true, externalNetwork: true }
  description = "Render an explicitly allowlisted http/https URL to a PNG screenshot and send it to the current chat. Disabled by default and restricted to master users."
  parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "HTTP/HTTPS URL to screenshot under security.linkSafety; the default policy allows all domains and private hosts, and administrators can restrict it." },
      fullPage: { type: "boolean", description: "Capture full page. Defaults to true." },
      waitMs: { type: "number", description: "Extra wait before screenshot, bounded by config timeout." },
      viewport: {
        type: "object",
        properties: {
          width: { type: "number" },
          height: { type: "number" },
        },
      },
      send: { type: "boolean", description: "Whether to send the screenshot image. Defaults to true." },
    },
    required: ["url"],
  }

  async execute(args: ToolArgs = {}, context: RenderToolContext = {}): Promise<string> {
    const config = context.config || record(configStore.get())
    const result = renderResult(await renderUrlToPng(text(args.url), args, config))
    if (args.send === false) {
      return `URL 截图完成：${result.buffer.length} bytes`
    }
    return deliverRenderedImage(result, context, { label: "URL 截图" })
  }
}

export function createRenderTools(): unknown[] {
  return [new RenderImageTool(), new RenderUrlScreenshotTool()]
}
