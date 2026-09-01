import { commandObserver } from "../../knowledge/command-observer.js"
import { groupIdFromEvent, isGroupEvent } from "../../core/message/event-scope.js"
import { configStore } from "../../config/store.js"
import {
  renderImageByKind,
  renderKindCatalog,
  renderKindLabels,
  normalizeRenderKind,
} from "../../core/rendering/render-service.js"
import { renderHtmlToPng, renderMarkdownHtmlToPng, renderMarkmapHtmlToPng, renderUrlToPng } from "../../core/rendering/render-html-service.js"
import { deliverRenderedImage } from "../../core/rendering/render-delivery.js"
import type { UnknownRecord } from "../../core/message/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

interface RenderToolContext extends ToolExecutionContext {
  e?: UnknownRecord
  config?: UnknownRecord
}

type ToolArgs = UnknownRecord

interface RenderResult extends UnknownRecord {
  buffer: Uint8Array
  cache?: UnknownRecord
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function renderResult(value: unknown): RenderResult {
  const result = record(value)
  return { ...result, buffer: result.buffer instanceof Uint8Array ? result.buffer : new Uint8Array(), cache: record(result.cache) }
}

export function resolveRenderImageEngine(kind: unknown, requested: unknown, config: unknown = {}): "svg" | "html" {
  const normalized = normalizeRenderKind(kind)
  const response = record(record(config).response)
  const render = record(response.render)
  const html = record(render.html)
  const configured = normalized === "markdown" ? render.markdownEngine : normalized === "mindmap" ? render.markmapEngine : "svg"
  const engine = text(requested || configured || "svg").toLowerCase()
  if (engine === "html") return "html"
  if (normalized === "markdown" && engine === "auto") return "html"
  if (engine === "auto" && html.enabled === true) return "html"
  return "svg"
}

/** 渲染工具基类：统一渲染、缓存结果和消息交付；不负责模板算法与权限判断。 */
class BaseRenderTool {
  kind!: string
  message?: string
  source = "builtin"
  category = "render"
  risk = "low"
  tags = ["image", "render"]
  // 渲染通常会把图片交付到会话；同一份输入在一个请求内重复渲染只保留第一次。
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["kind", "title", "content", "sections", "html", "url", "send"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }

  constructor(meta: UnknownRecord = {}) {
    Object.assign(this, meta)
  }

  async render(args: ToolArgs = {}, context: RenderToolContext = {}): Promise<string> {
    const config = context.config || record(configStore.get())
    const result = renderResult(await renderImageByKind(this.kind, this.input(args, context), config))
    if (args.send === false) {
      const label = renderKindLabels[this.kind] || this.message || "图片"
      return `${label}渲染完成：${result.buffer.length} bytes${result.cache?.pngFile ? `\n缓存：${text(result.cache.pngFile)}` : ""}`
    }
    return deliverRenderedImage(result, context, {
      label: this.message || renderKindLabels[this.kind] || "图片",
      targetType: args.targetType,
      targetId: args.targetId,
      groupId: args.groupId,
      userId: args.userId,
    })
  }

  input(args: ToolArgs = {}, _context: RenderToolContext = {}): ToolArgs {
    return args
  }

  async execute(args: ToolArgs = {}, context: RenderToolContext = {}): Promise<string> {
    return this.render(args, context)
  }
}

export class RenderTextCardTool extends BaseRenderTool {
  name = "render_text_card"
  kind = "text-card"
  message = "渲染图片"
  description = "Render text or structured sections as a polished PNG card and optionally send it to the current chat."
  parameters = {
    type: "object",
    properties: {
      title: { type: "string", description: "Card title." },
      subtitle: { type: "string", description: "Optional subtitle." },
      content: { type: "string", description: "Plain text content. Used when sections are not provided." },
      sections: {
        type: "array",
        description: "Optional structured sections.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            lines: { type: "array", items: { type: "string" } },
          },
        },
      },
      send: { type: "boolean", description: "Whether to send the card image. Defaults to true." },
    },
    required: ["title"],
  }

  input(args: ToolArgs = {}): ToolArgs {
    return {
      title: args.title,
      subtitle: args.subtitle,
      content: args.content,
      sections: args.sections,
      footer: "Yui Chat · Render Tool",
    }
  }
}

export class RenderMarkdownDocumentTool extends BaseRenderTool {
  name = "generate_math_markdown"
  kind = "markdown"
  message = "Markdown 图片"
  source = "builtin"
  description = "Render a Markdown document as a polished PNG image with local KaTeX formulas and Mermaid diagrams. Auto uses the plugin-owned rich renderer; svg remains available as a lightweight fallback."
  tags = ["markdown", "math", "mermaid", "image"]
  parameters = {
    type: "object",
    properties: {
      title: { type: "string", description: "Document title." },
      subtitle: { type: "string", description: "Optional subtitle." },
      markdown: {
        type: "string",
        description: "Markdown content. Use $...$ or $$...$$ for formulas and fenced ```mermaid blocks for diagram source.",
      },
      engine: {
        type: "string",
        description: "Renderer: auto (default rich Markdown), html, or svg (lightweight fallback).",
      },
      send: { type: "boolean", description: "Whether to send the image. Defaults to true." },
    },
    required: ["title", "markdown"],
  }

  async execute(args: ToolArgs = {}, context: RenderToolContext = {}): Promise<string> {
    const config = context.config || record(configStore.get())
    const engine = resolveRenderImageEngine("markdown", args.engine, config)
    if (engine === "html") {
      const result = renderResult(await renderMarkdownHtmlToPng({
        title: args.title,
        subtitle: args.subtitle,
        markdown: args.markdown,
        footer: "Yui Chat · HTML Markdown Render Tool",
      }, config))
      if (args.send === false) {
        return `Markdown HTML 图片渲染完成：${result.buffer.length} bytes${result.cache?.pngFile ? `\n缓存：${text(result.cache.pngFile)}` : ""}`
      }
      return deliverRenderedImage(result, context, { label: "Markdown HTML 图片" })
    }
    return this.render(args, context)
  }

  input(args: ToolArgs = {}): ToolArgs {
    return {
      title: args.title,
      subtitle: args.subtitle,
      markdown: args.markdown,
      footer: "Yui Chat · Markdown Render Tool",
    }
  }
}

export class RenderMindMapTool extends BaseRenderTool {
  name = "generate_markmap"
  kind = "mindmap"
  message = "思维导图图片"
  source = "builtin"
  description = "Render a Markdown hierarchy as a mind map PNG image. Supports svg and optional HTML markmap engine."
  tags = ["mindmap", "markdown", "image"]
  parameters = {
    type: "object",
    properties: {
      title: { type: "string", description: "Mind map title." },
      markdown: {
        type: "string",
        description: "Standard Markdown hierarchy. Use # for root, ## for branches, ### and list items for details.",
      },
      engine: {
        type: "string",
        description: "Renderer: svg (default), html, or auto. html requires response.render.html.enabled.",
      },
      send: { type: "boolean", description: "Whether to send the image. Defaults to true." },
    },
    required: ["title", "markdown"],
  }

  async execute(args: ToolArgs = {}, context: RenderToolContext = {}): Promise<string> {
    const config = context.config || record(configStore.get())
    const render = record(record(config.response).render)
    const html = record(render.html)
    const engine = text(args.engine || render.markmapEngine || "svg").toLowerCase()
    if (engine === "html" || (engine === "auto" && html.enabled === true)) {
      const result = renderResult(await renderMarkmapHtmlToPng({
        title: args.title,
        markdown: args.markdown,
        footer: "Yui Chat · HTML Markmap Render Tool",
      }, config))
      if (args.send === false) {
        return `Markmap HTML 图片渲染完成：${result.buffer.length} bytes${result.cache?.pngFile ? `\n缓存：${text(result.cache.pngFile)}` : ""}`
      }
      return deliverRenderedImage(result, context, { label: "Markmap HTML 图片" })
    }
    return this.render(args, context)
  }

  input(args: ToolArgs = {}): ToolArgs {
    return { title: args.title, markdown: args.markdown }
  }
}

export class RenderWordCloudTool extends BaseRenderTool {
  name = "render_word_cloud"
  kind = "word-cloud"
  message = "词云图片"
  source = "builtin"
  description = "Render weighted keywords or text as a word cloud PNG image."
  tags = ["wordcloud", "image"]
  parameters = {
    type: "object",
    properties: {
      title: { type: "string", description: "Word cloud title." },
      subtitle: { type: "string", description: "Optional subtitle." },
      text: { type: "string", description: "Raw text. The renderer extracts repeated words when words is not provided." },
      words: {
        type: "array",
        description: "Weighted words. Items can be { text, weight }.",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            weight: { type: "number" },
          },
        },
      },
      send: { type: "boolean", description: "Whether to send the image. Defaults to true." },
    },
    required: ["title"],
  }

  input(args: ToolArgs = {}): ToolArgs {
    return {
      title: args.title,
      subtitle: args.subtitle,
      text: args.text,
      words: args.words,
    }
  }
}

export class RenderDynamicPanelTool extends BaseRenderTool {
  name = "render_dynamic_panel"
  kind = "dynamic-panel"
  message = "动态面板图片"
  source = "builtin"
  description = "Render a dynamic status/help dashboard PNG from metrics and sections."
  tags = ["dashboard", "help", "status", "image"]
  parameters = {
    type: "object",
    properties: {
      title: { type: "string", description: "Panel title." },
      subtitle: { type: "string", description: "Panel subtitle." },
      metrics: {
        type: "array",
        description: "Metric cards displayed at the top.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
          },
        },
      },
      sections: {
        type: "array",
        description: "Detailed text sections.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            lines: { type: "array", items: { type: "string" } },
          },
        },
      },
      send: { type: "boolean", description: "Whether to send the image. Defaults to true." },
    },
    required: ["title"],
  }

  input(args: ToolArgs = {}): ToolArgs {
    return {
      title: args.title,
      subtitle: args.subtitle,
      metrics: args.metrics,
      sections: args.sections,
    }
  }
}

export class RenderCommandHelpTool extends BaseRenderTool {
  name = "render_command_help"
  kind = "command-help"
  message = "指令帮助图片"
  source = "builtin"
  description = "Search command knowledge and render recommended Yunzai commands as a PNG help card."
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "User intent or command question." },
      limit: { type: "number", description: "Maximum result count." },
      send: { type: "boolean", description: "Whether to send the card image. Defaults to true." },
    },
    required: ["query"],
  }

  input(args: ToolArgs = {}): ToolArgs {
    const query = String(args.query || "").trim()
    const matches = commandObserver.findMatches(query, Number(args.limit) || 8)
    return { query, matches, stats: commandObserver.stats() }
  }
}

export class RenderHelpMenuTool extends BaseRenderTool {
  name = "render_help_menu"
  kind = "help-menu"
  message = "帮助菜单图片"
  source = "builtin"
  description = "Render grouped help commands as a PNG menu and optionally send it to the current chat."
  tags = ["help", "menu", "command", "image"]
  parameters = {
    type: "object",
    properties: {
      title: { type: "string", description: "Menu title." },
      subtitle: { type: "string", description: "Optional subtitle." },
      groups: {
        type: "array",
        description: "Help groups. Each group has title/name and commands/lines.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            name: { type: "string" },
            commands: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  command: { type: "string" },
                  description: { type: "string" },
                  permission: { type: "string" },
                },
              },
            },
            lines: { type: "array", items: { type: "string" } },
          },
        },
      },
      sections: {
        type: "array",
        description: "Alternative text sections in render_text_card format.",
        items: { type: "object" },
      },
      send: { type: "boolean", description: "Whether to send the image. Defaults to true." },
    },
  }

  input(args: ToolArgs = {}): ToolArgs {
    return {
      title: args.title,
      subtitle: args.subtitle,
      groups: args.groups,
      sections: args.sections,
      footer: "Yui Chat · Help Menu Render Tool",
    }
  }
}

export class RenderChatCardTool extends BaseRenderTool {
  name = "render_chat_card"
  kind = "chat-card"
  message = "富聊天卡片"
  source = "builtin"
  description = "Render a rich chat card with prompt, answer, quote/media summary, model workflow metadata, and suggested responses."
  tags = ["chat", "reply", "image", "render"]
  parameters = {
    type: "object",
    properties: {
      prompt: { type: "string", description: "User prompt or message." },
      answer: { type: "string", description: "Assistant answer." },
      sender: { type: "object", description: "Sender metadata, e.g. { userId, name }." },
      scope: { type: "object", description: "Chat scope metadata, e.g. { type, groupId, groupName }." },
      quote: { type: "object", description: "Quoted message summary." },
      media: { type: "object", description: "Media summary, e.g. { images, records, videos, mentions, diagnostics }." },
      metadata: { type: "object", description: "Model metadata, e.g. { channel, adapter, toolRounds, source }." },
      steps: { type: "array", description: "Workflow step summaries.", items: { type: "object" } },
      suggestedResponses: { type: "array", items: { type: "string" } },
      send: { type: "boolean", description: "Whether to send the image. Defaults to true." },
    },
    required: ["answer"],
  }

  input(args: ToolArgs = {}, context: RenderToolContext = {}): ToolArgs {
    const sender = record(context.e?.sender)
    const isGroup = isGroupEvent(context.e)
    return {
      prompt: args.prompt,
      answer: args.answer || args.content,
      sender: args.sender || {
        userId: String(context.e?.user_id || ""),
        name: sender.card || sender.nickname || context.e?.user_id || "",
      },
      scope: args.scope || {
        type: isGroup ? "group" : "private",
        groupId: isGroup ? groupIdFromEvent(context.e) : "",
      },
      quote: args.quote,
      media: args.media,
      metadata: args.metadata,
      steps: args.steps,
      suggestedResponses: args.suggestedResponses,
    }
  }
}

export class RenderConversationListTool extends BaseRenderTool {
  name = "render_conversation_list"
  kind = "conversation-list"
  message = "会话列表图"
  source = "builtin"
  description = "Render conversation rows as a PNG image. Runtime conversation reads are handled by the master-only #yui对话列表 command; this tool only renders rows passed in arguments."
  tags = ["conversation", "image", "render"]
  parameters = {
    type: "object",
    properties: {
      rows: {
        type: "array",
        description: "Conversation rows to render. Each row can include channel, type, groupId, userId, turns, historyMessages, lastSeenAt, and preview.",
        items: {
          type: "object",
          properties: {
            channel: { type: "string" },
            type: { type: "string" },
            groupId: { type: "string" },
            userId: { type: "string" },
            turns: { type: "number" },
            historyMessages: { type: "number" },
            lastSeenAt: { type: "string" },
            preview: { type: "string" },
          },
        },
      },
      send: { type: "boolean", description: "Whether to send the image. Defaults to true." },
    },
    required: ["rows"],
  }

  input(args: ToolArgs = {}): ToolArgs {
    return {
      rows: Array.isArray(args.rows) ? args.rows : [],
    }
  }
}

export class RenderImageTool extends BaseRenderTool {
  name = "render_image"
  source = "builtin"
  description = "Unified dynamic image renderer. Supports text cards, rich Markdown with local KaTeX/Mermaid, Markmap mind maps, safe Cartesian function plots, word clouds and status panels. For markdown formulas use $...$, $$...$$, \\(...\\), or \\[...\\]. Markdown auto uses the plugin-owned rich renderer; raw HTML and URL screenshots remain separately gated."
  tags = ["image", "render", "template", "dynamic"]
  parameters = {
    type: "object",
    properties: {
      template: {
        type: "string",
        enum: renderKindCatalog.map(item => item.kind),
        description: "Renderer template. Defaults to text-card.",
      },
      data: {
        type: "object",
        description: "Template data. Use title/content/sections for text-card; title/markdown for markdown or mindmap; expressions plus optional xMin/xMax/yMin/yMax for function-plot; query for command-help; prompt/answer for chat-card; words or text for word-cloud; metrics/sections for dynamic-panel; rows for conversation-list.",
      },
      engine: { type: "string", enum: ["auto", "svg", "html"], description: "markdown/mindmap renderer override. Defaults to the corresponding response.render setting." },
      send: { type: "boolean", description: "Whether to send the image. Defaults to true." },
      targetType: { type: "string", description: "Optional target type: group or user. Defaults to current chat. Requires master and response.render.delivery.allowTargetSend." },
      targetId: { type: "string", description: "Optional target group/user id. Requires master and response.render.delivery.allowTargetSend." },
    },
    required: [],
  }

  async execute(args: ToolArgs = {}, context: RenderToolContext = {}): Promise<string> {
    const kind = normalizeRenderKind(args.template || args.kind || "text-card")
    const config = context.config || record(configStore.get())
    const input: ToolArgs = {
      ...record(args.data),
      ...args,
      kind,
    }
    if (kind === "command-help") {
      const query = text(input.query || input.content).trim()
      input.query = query
      input.matches = commandObserver.findMatches(query, Number(input.limit) || 8)
      input.stats = commandObserver.stats()
    }
    const engine = resolveRenderImageEngine(kind, args.engine, config)
    let rawResult: unknown
    if (kind === "markdown" && engine === "html") rawResult = await renderMarkdownHtmlToPng(input, config)
    else if (kind === "mindmap" && engine === "html") rawResult = await renderMarkmapHtmlToPng(input, config)
    else rawResult = await renderImageByKind(kind, input, config)
    const result = renderResult(rawResult)
    const label = renderKindLabels[kind] || "图片"
    if (args.send === false) {
      return `${label}渲染完成：${result.buffer.length} bytes${result.cache?.pngFile ? `\n缓存：${text(result.cache.pngFile)}` : ""}`
    }
    return deliverRenderedImage(result, context, {
      label,
      targetType: args.targetType,
      targetId: args.targetId,
      groupId: args.groupId,
      userId: args.userId,
    })
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
      return `URL 截图完成：${result.buffer.length} bytes${result.cache?.pngFile ? `\n缓存：${text(result.cache.pngFile)}` : ""}`
    }
    return deliverRenderedImage(result, context, { label: "URL 截图" })
  }
}

export class RenderHtmlScreenshotTool {
  name = "render_html_screenshot"
  source = "builtin"
  category = "render"
  risk = "high"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["html", "name", "fullPage", "waitMs", "viewport", "send"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  tags = ["image", "render", "html", "screenshot"]
  policy = { requiresMaster: true, highRisk: true }
  description = "Render controlled HTML to a PNG screenshot and send it to the current chat. Disabled by default; intended for master-only rich help cards or dynamic image templates."
  parameters = {
    type: "object",
    properties: {
      html: { type: "string", description: "HTML document or fragment to render. Length is bounded by response.render.html.maxHtmlChars." },
      name: { type: "string", description: "Optional safe cache/debug name prefix." },
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
    required: ["html"],
  }

  async execute(args: ToolArgs = {}, context: RenderToolContext = {}): Promise<string> {
    const config = context.config || record(configStore.get())
    const result = renderResult(await renderHtmlToPng(text(args.html), args, config))
    if (args.send === false) {
      return `HTML 截图完成：${result.buffer.length} bytes${result.cache?.pngFile ? `\n缓存：${text(result.cache.pngFile)}` : ""}`
    }
    return deliverRenderedImage(result, context, { label: "HTML 截图" })
  }
}

export function createRenderTools(): unknown[] {
  return [
    new RenderImageTool(),
    new RenderHtmlScreenshotTool(),
    new RenderUrlScreenshotTool(),
  ]
}
