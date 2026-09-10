/**
 * Web 端消息/日志内容展示。
 *
 * 这里生成的 HTML 只包含本模块固定的标签和属性：输入正文会先转义，
 * 链接与图片地址也会经过协议校验，因此调用方可以安全地放进 v-html。
 * 这只是展示层解析，不会改写模型请求、日志快照或会话数据。
 */

type RichRecord = Record<string, unknown>

export interface ImageSource {
  src: string
  alt?: string
}

const MAX_TEXT_LENGTH = 240_000
const MAX_IMAGE_DATA_LENGTH = 12_000_000
const IMAGE_MIME = /^image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml)$/i
const DATA_IMAGE_PATTERN = /^data:(image\/[^;,]+)(?:;[^,]*)*;base64,([\s\S]*)$/i
const BASE64_SCHEME_PATTERN = /^base64:\/\/(?:([^,;]+)[,;])?([\s\S]+)$/i
// 只在正文中识别连续的 Base64 载荷；不把后面的普通说明文字一起吞进图片地址。
const RAW_IMAGE_PATTERN = /(data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml)(?:;[^,]*)*;base64,[A-Za-z0-9+/=_-]{16,}|base64:\/\/(?:image\/[A-Za-z0-9.+-]+[,;])?[A-Za-z0-9+/=_-]{16,})/gi

function record(value: unknown): RichRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RichRecord : {}
}

function text(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return String(value)
}

function normalizedMime(value: unknown, fallback = "image/png"): string {
  const mime = text(value).trim().toLowerCase()
  return IMAGE_MIME.test(mime) ? mime : fallback
}

function escapeHtml(value: unknown): string {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/\r|\n/g, "")
}

function validHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^blob:/i.test(value)
}

function dataImage(value: string, mimeHint = "image/png"): ImageSource | null {
  const source = value.trim()
  const data = source.match(DATA_IMAGE_PATTERN)
  if (data) {
    const mime = normalizedMime(data[1], mimeHint)
    const payload = normalizeBase64Payload(data[2])
    if (!payload || payload.length > MAX_IMAGE_DATA_LENGTH || !/^[A-Za-z0-9+/=_-]+$/.test(payload)) return null
    return { src: `data:${mime};base64,${payload}` }
  }
  const scheme = source.match(BASE64_SCHEME_PATTERN)
  if (!scheme) return null
  const mime = normalizedMime(scheme[1], mimeHint)
  const payload = normalizeBase64Payload(scheme[2])
  if (!payload || payload.length > MAX_IMAGE_DATA_LENGTH || !/^[A-Za-z0-9+/=_-]+$/.test(payload)) return null
  return { src: `data:${mime};base64,${payload}` }
}

function normalizeBase64Payload(value: string): string {
  const payload = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")
  if (!payload) return ""
  const remainder = payload.length % 4
  return remainder ? `${payload}${"=".repeat(4 - remainder)}` : payload
}

function hasImageMarker(source: RichRecord): boolean {
  const type = text(source.type || source.kind).toLowerCase()
  if (type.includes("image") || type === "inline_data" || type === "inlinedata") return true
  const mime = text(source.mimeType || source.mime_type || source.mediaType || source.media_type)
  if (IMAGE_MIME.test(mime)) return true
  if (source.image_url !== undefined || source.imageUrl !== undefined || source.inlineData !== undefined || source.inline_data !== undefined) return true
  for (const key of ["thumbnailDataUrl", "base64", "b64_json", "b64Json"]) if (source[key] !== undefined) return true
  const data = text(source.data)
  return /^data:image\//i.test(data) || /^base64:\/\//i.test(data)
}

function imageSource(value: unknown, mimeHint = "image/png", depth = 0, allowBareUrl = false): ImageSource | null {
  if (depth > 5 || value === null || value === undefined) return null
  if (typeof value === "string") {
    const source = value.trim()
    const inline = dataImage(source, mimeHint)
    if (inline) return inline
    if (validHttpUrl(source)) return { src: source }
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = imageSource(item, mimeHint, depth + 1, allowBareUrl)
      if (nested) return nested
    }
    return null
  }
  const source = record(value)
  const type = text(source.type || source.kind).toLowerCase()
  const hintedMime = normalizedMime(source.mimeType || source.mime_type || source.mediaType || source.media_type, mimeHint)
  const explicitImage = allowBareUrl || hasImageMarker(source)

  // OpenAI image_url / Responses input_image、以及常见的自定义 image 字段。
  for (const key of explicitImage ? ["image_url", "imageUrl", "url", "src", "source"] : ["image_url", "imageUrl"]) {
    if (source[key] === undefined) continue
    const nested = imageSource(source[key], hintedMime, depth + 1, explicitImage)
    if (nested) return nested
  }

  // Gemini inlineData、Claude base64 source 等结构。
  for (const key of ["inlineData", "inline_data", "data", "base64", "b64_json", "b64Json", "image", "result", "results", "candidates", "contents", "content", "parts", "outputs", "output"]) {
    if (source[key] === undefined) continue
    const candidate = source[key]
    if (typeof candidate === "string") {
      const inline = dataImage(candidate, hintedMime)
      if (inline) return inline
      const likelyImage = IMAGE_MIME.test(hintedMime) && (type.includes("image") || key !== "data" || source.mimeType || source.mime_type || source.mediaType || source.media_type)
      if (likelyImage) {
        const payload = normalizeBase64Payload(candidate)
        if (payload && payload.length <= MAX_IMAGE_DATA_LENGTH && /^[A-Za-z0-9+/=_-]+$/.test(payload)) return { src: `data:${hintedMime};base64,${payload}` }
      }
    } else {
      const nested = imageSource(candidate, hintedMime, depth + 1, explicitImage || key !== "content")
      if (nested) return nested
      if (key === "inlineData" || key === "inline_data") {
        const inlineRecord = record(candidate)
        const payload = normalizeBase64Payload(text(inlineRecord.data || inlineRecord.base64 || inlineRecord.b64_json || inlineRecord.b64Json))
        const mime = normalizedMime(inlineRecord.mimeType || inlineRecord.mime_type || inlineRecord.mediaType || inlineRecord.media_type, hintedMime)
        if (payload && payload.length <= MAX_IMAGE_DATA_LENGTH && /^[A-Za-z0-9+/=]+$/.test(payload)) return { src: `data:${mime};base64,${payload}` }
      }
    }
  }
  return null
}

/** 从一个响应对象收集所有图片，避免多图响应只显示第一张。 */
function imageSources(value: unknown, mimeHint = "image/png", depth = 0, allowBareUrl = false): ImageSource[] {
  if (depth > 6 || value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap(item => imageSources(item, mimeHint, depth + 1, allowBareUrl))
  if (typeof value === "string") {
    const image = imageSource(value, mimeHint, depth, allowBareUrl)
    return image ? [image] : []
  }
  const source = record(value)
  const direct = imageSource(source, mimeHint, depth, allowBareUrl)
  if (direct) return [direct]
  const output: ImageSource[] = []
  for (const key of ["images", "image", "image_url", "imageUrl", "content", "parts", "data", "result", "results", "candidates", "outputs", "output", "message", "delta", "inlineData", "inline_data"]) {
    if (source[key] === undefined) continue
    const childAllowUrl = allowBareUrl || ["images", "image", "data", "result", "results", "outputs", "output"].includes(key)
    output.push(...imageSources(source[key], mimeHint, depth + 1, childAllowUrl))
  }
  const seen = new Set<string>()
  return output.filter(item => {
    if (seen.has(item.src)) return false
    seen.add(item.src)
    return true
  })
}

function imageHtml(source: ImageSource, alt = "图片"): string {
  const safeAlt = text(alt).trim() || "图片"
  const src = escapeAttribute(source.src)
  const image = `<img class="yui-rich-image" src="${src}" alt="${escapeAttribute(safeAlt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
  return /^https?:\/\//i.test(source.src)
    ? `<a class="yui-rich-image-link" href="${src}" target="_blank" rel="noopener noreferrer nofollow" title="点击预览原图">${image}</a>`
    : image
}

function splitTableRow(line: string): string[] {
  let value = line.trim()
  if (value.startsWith("|")) value = value.slice(1)
  if (value.endsWith("|")) value = value.slice(0, -1)
  const cells: string[] = []
  let current = ""
  let escaped = false
  for (const character of value) {
    if (character === "|" && !escaped) {
      cells.push(current.trim())
      current = ""
    } else {
      current += character
    }
    escaped = character === "\\" && !escaped
    if (character !== "\\") escaped = false
  }
  cells.push(current.trim())
  return cells
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
}

function normalizeMarkdownMath(value: string): string {
  // 与服务端 HTML 渲染保持相同的常用定界符兼容；前端不执行公式，
  // 只保留可读的定界文本，避免把用户内容当作脚本或 HTML。
  let fenced = false
  return value.split("\n").map(line => {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      fenced = !fenced
      return line
    }
    if (fenced) return line
    return line.split(/(`+[^`]*`+)/g).map(segment => {
      if (segment.startsWith("`")) return segment
      return segment
        .replace(/\\\[/g, "$$")
        .replace(/\\\]/g, "$$")
        .replace(/\\\(/g, "$")
        .replace(/\\\)/g, "$")
    }).join("")
  }).join("\n")
}

function parsedImageJson(value: string): unknown | null {
  const source = value.trim()
  if (source.length < 2 || source.length > MAX_TEXT_LENGTH || !/^[\[{]/.test(source)) return null
  try {
    const parsed: unknown = JSON.parse(source)
    return hasRichImage(parsed) ? parsed : null
  } catch {
    return null
  }
}

function renderInline(value: string, references: Map<string, string>, depth = 0): string {
  if (depth > 3) return escapeHtml(value)
  const source = value.slice(0, MAX_TEXT_LENGTH)
  let output = ""
  let index = 0
  const appendText = (chunk: string) => { output += escapeHtml(chunk) }

  while (index < source.length) {
    // 行内代码优先，代码里的 Markdown 与图片地址都保持原样。
    if (source[index] === "`") {
      const end = source.indexOf("`", index + 1)
      if (end > index + 1) {
        output += `<code>${escapeHtml(source.slice(index + 1, end))}</code>`
        index = end + 1
        continue
      }
    }

    // Markdown 图片：支持带空格的 alt 与常见 title 尾缀。
    if (source.startsWith("![", index)) {
      const closeAlt = source.indexOf("]", index + 2)
      if (closeAlt > index + 2) {
        let urlStart = closeAlt + 1
        let url = ""
        let end = -1
        if (source[urlStart] === "(") {
          let cursor = urlStart + 1
          let nesting = 0
          for (; cursor < source.length; cursor += 1) {
            const character = source[cursor]
            if (character === "(" && source[cursor - 1] !== "\\") nesting += 1
            if (character === ")" && source[cursor - 1] !== "\\") {
              if (!nesting) { end = cursor; break }
              nesting -= 1
            }
          }
          if (end > urlStart) url = source.slice(urlStart + 1, end).trim().replace(/\s+["'](?:[^"']*)["']\s*$/, "")
        } else if (source[urlStart] === "[") {
          const closeRef = source.indexOf("]", urlStart + 1)
          if (closeRef > urlStart) {
            const reference = source.slice(urlStart + 1, closeRef).trim().toLowerCase() || source.slice(index + 2, closeAlt).trim().toLowerCase()
            url = references.get(reference) || ""
            end = closeRef
          }
        }
        const image = url ? imageSource(url) : null
        if (image && end > 0) {
          output += imageHtml(image, source.slice(index + 2, closeAlt))
          index = end + 1
          continue
        }
      }
    }

    // 直接返回的 data:image 或 base64:// 图片，不要求模型额外包一层 Markdown。
    if (source[index] === "d" || source[index] === "b") {
      RAW_IMAGE_PATTERN.lastIndex = index
      const match = RAW_IMAGE_PATTERN.exec(source)
      if (match && match.index === index) {
        const image = imageSource(match[0])
        if (image) {
          output += imageHtml(image)
          index += match[0].length
          continue
        }
      }
    }

    // markdown-it 的 linkify 行为：普通 http(s) 地址也可直接点击；
    // 代码、链接和图片在前面的分支中已经优先处理。
    if (source.startsWith("http://", index) || source.startsWith("https://", index)) {
      const rawUrl = source.slice(index).match(/^https?:\/\/[^\s<>]+/i)?.[0] || ""
      const trailing = rawUrl.match(/[),.;:!?，。；：！？）】》]+$/u)?.[0] || ""
      const href = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl
      if (href) {
        output += `<a class="yui-rich-link" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(href)}</a>`
        if (trailing) appendText(trailing)
        index += rawUrl.length
        continue
      }
    }

    // 链接与自动链接仅允许 http(s)/mailto，原始 HTML 一律按文本显示。
    if (source[index] === "<") {
      // 仅提取安全的 HTML 图片标签；其它 HTML 继续按文本显示，避免把回显当作可执行标记。
      const htmlImage = source.slice(index).match(/^<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>\s*/i)
      if (htmlImage) {
        const image = imageSource(htmlImage[2], "image/png", 0, true)
        if (image) {
          output += imageHtml(image)
          index += htmlImage[0].length
          continue
        }
      }
      const auto = source.slice(index).match(/^<(https?:\/\/[^\s>]+|mailto:[^\s>]+)>/i)
      if (auto) {
        const href = auto[1]
        output += `<a class="yui-rich-link" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(href)}</a>`
        index += auto[0].length
        continue
      }
    }
    if (source[index] === "[" && !source.startsWith("![", index)) {
      const closeText = source.indexOf("]", index + 1)
      if (closeText > index + 1 && source[closeText + 1] === "(") {
        const closeUrl = source.indexOf(")", closeText + 2)
        if (closeUrl > closeText) {
          const label = source.slice(index + 1, closeText)
          const href = source.slice(closeText + 2, closeUrl).trim().replace(/\s+["'](?:[^"']*)["']\s*$/, "")
          if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
            output += `<a class="yui-rich-link" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer nofollow">${renderInline(label, references, depth + 1)}</a>`
            index = closeUrl + 1
            continue
          }
        }
      }
    }

    // 常见强调语法。只在成对标记存在时转换，避免破坏普通下划线或星号文本。
    const emphasis = source.slice(index).match(/^(\*\*|__|~~|\*|_)(?=\S)([\s\S]+?)\1/)
    if (emphasis) {
      const marker = emphasis[1]
      const inner = renderInline(emphasis[2], references, depth + 1)
      output += marker === "~~" ? `<del>${inner}</del>` : marker.length === 2 ? `<strong>${inner}</strong>` : `<em>${inner}</em>`
      index += emphasis[0].length
      continue
    }

    // 反斜杠转义 Markdown 标点。
    if (source[index] === "\\" && /[*_~`\[\]()\\]/.test(source[index + 1] || "")) {
      appendText(source[index + 1])
      index += 2
      continue
    }
    appendText(source[index])
    index += 1
  }
  return output
}

function renderMarkdown(value: string, depth = 0): string {
  if (depth > 3) return `<p>${escapeHtml(value)}</p>`
  const normalized = normalizeMarkdownMath(value.slice(0, MAX_TEXT_LENGTH)).replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  const references = new Map<string, string>()
  for (const line of lines) {
    const definition = line.match(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+["'(].*)?$/)
    if (definition) references.set(definition[1].trim().toLowerCase(), definition[2])
  }

  const blocks: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim() || /^\s{0,3}\[[^\]]+\]:\s*\S+/.test(line)) { index += 1; continue }

    const fence = line.match(/^\s{0,3}(```+|~~~+)\s*([^ ]*)?.*$/)
    if (fence) {
      const marker = fence[1][0]
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^\\s{0,3}${marker}{${fence[1].length},}\\s*$`).test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      const language = text(fence[2]).trim().toLowerCase()
      blocks.push(`<pre class="yui-rich-code"><code${language ? ` class="language-${escapeAttribute(language)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`)
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInline(heading[2], references)}</h${level}>`)
      index += 1
      continue
    }

    if (index + 1 < lines.length && line.trim() && /^\s*(?:=+|-+)\s*$/.test(lines[index + 1])) {
      const level = lines[index + 1].trim().startsWith("=") ? 1 : 2
      blocks.push(`<h${level}>${renderInline(line.trim(), references)}</h${level}>`)
      index += 2
      continue
    }

    if (/^\s{0,3}(?:---+|___+|\*\s*\*\s*\*|(-\s*){3,})\s*$/.test(line)) {
      blocks.push("<hr>")
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""))
        index += 1
      }
      blocks.push(`<blockquote>${renderMarkdown(quote.join("\n"), depth + 1)}</blockquote>`)
      continue
    }

    if (index + 1 < lines.length && line.includes("|") && isTableDivider(lines[index + 1])) {
      const header = splitTableRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      const headHtml = header.map(cell => `<th>${renderInline(cell, references)}</th>`).join("")
      const bodyHtml = rows.map(row => `<tr>${header.map((_, cellIndex) => `<td>${renderInline(row[cellIndex] || "", references)}</td>`).join("")}</tr>`).join("")
      blocks.push(`<div class="yui-rich-table-wrap"><table class="yui-rich-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`)
      continue
    }

    const unordered = line.match(/^\s{0,3}[-+*]\s+(.+)$/)
    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/)
    if (unordered || ordered) {
      const orderedList = Boolean(ordered)
      const items: string[] = []
      while (index < lines.length) {
        const item = lines[index].match(orderedList ? /^\s{0,3}\d+[.)]\s+(.+)$/ : /^\s{0,3}[-+*]\s+(.+)$/)
        if (!item) break
        items.push(listItemHtml(item[1], references))
        index += 1
      }
      blocks.push(`<${orderedList ? "ol" : "ul"}>${items.join("")}</${orderedList ? "ol" : "ul"}>`)
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index]
      if (/^\s{0,3}(?:```+|~~~+|#{1,6}\s|>|[-+*]\s+|\d+[.)]\s+)/.test(next)) break
      if (index + 1 < lines.length && next.includes("|") && isTableDivider(lines[index + 1])) break
      if (/^\s{0,3}(?:---+|___+|\*\s*\*\s*\*|(-\s*){3,})\s*$/.test(next)) break
      paragraph.push(next)
      index += 1
    }
    blocks.push(`<p>${paragraph.map(item => renderInline(item, references)).join("<br>")}</p>`)
  }
  return blocks.join("") || "<p class=\"yui-rich-empty\">暂无内容</p>"
}

function objectText(value: RichRecord): string {
  for (const key of ["text", "content", "output_text", "outputText", "message"]) {
    if (typeof value[key] === "string") return value[key] as string
  }
  return ""
}

function hasImageField(value: RichRecord): boolean {
  return ["image_url", "imageUrl", "url", "src", "source", "inlineData", "inline_data", "data", "base64", "b64_json", "b64Json", "image", "result", "results", "candidates", "contents", "parts", "outputs", "output"].some(key => value[key] !== undefined)
}

function listItemHtml(value: string, references: Map<string, string>): string {
  const task = value.match(/^\[([ xX])\]\s+([\s\S]+)$/)
  if (!task) return `<li>${renderInline(value, references)}</li>`
  const checked = task[1].toLowerCase() === "x"
  return `<li class="yui-rich-task-item"><input class="yui-rich-task" type="checkbox" disabled${checked ? " checked" : ""}> <span>${renderInline(task[2], references)}</span></li>`
}

function prettyObject(value: unknown): string {
  try { return JSON.stringify(value, null, 2) || "" } catch { return text(value) }
}

/** 将文本、消息 content 数组或工具返回对象转成安全的可视化 HTML。 */
export function renderRichContent(value: unknown): string {
  if (value === null || value === undefined || value === "") return "<p class=\"yui-rich-empty\">暂无内容</p>"
  if (typeof value === "string") {
    const parsed = parsedImageJson(value)
    return parsed === null ? renderMarkdown(value) : renderRichContent(parsed)
  }
  if (typeof value === "number" || typeof value === "boolean") return `<p>${renderInline(String(value), new Map())}</p>`
  if (Array.isArray(value)) {
    const parts = value.map(item => renderRichContent(item)).filter(Boolean)
    return parts.length ? parts.join("") : "<p class=\"yui-rich-empty\">暂无内容</p>"
  }
  const source = record(value)
  const body = objectText(source)
  if (Array.isArray(source.parts)) return renderRichContent(source.parts)
  if (Array.isArray(source.content)) return renderRichContent(source.content)
  const images = imageSources(source)
  if (body && images.length && (typeof source.content !== "string" || hasImageField(source))) return `${renderRichContent(body)}${images.map(image => imageHtml(image, text(source.alt || source.title || "图片"))).join("")}`
  if (body) return renderRichContent(body)
  if (images.length) return images.map(image => imageHtml(image, text(source.alt || source.title || "图片"))).join("")
  return `<pre class="yui-rich-json">${escapeHtml(prettyObject(value))}</pre>`
}

/** 用于复制、会话标题和摘要的纯文本提取；图片用一个短占位符表示。 */
export function plainTextContent(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return ""
  if (typeof value === "string") {
    if (parsedImageJson(value) !== null) return "[图片]"
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(item => plainTextContent(item, depth + 1)).filter(Boolean).join("\n")
  const source = record(value)
  const body = objectText(source)
  if (Array.isArray(source.parts)) return plainTextContent(source.parts, depth + 1)
  if (Array.isArray(source.content)) return plainTextContent(source.content, depth + 1)
  const images = imageSources(source)
  if (body && images.length && (typeof source.content !== "string" || hasImageField(source))) return `${body}\n${"[图片]\n".repeat(images.length).trim()}`
  if (body) return body
  if (images.length) return "[图片]".repeat(images.length)
  return ""
}

export function hasRichImage(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) return false
  if (typeof value === "string") return Boolean(dataImage(value)) || /base64:\/\//i.test(value)
  if (Array.isArray(value)) return value.some(item => hasRichImage(item, depth + 1))
  const source = record(value)
  return imageSources(source).length > 0 || ("content" in source && hasRichImage(source.content, depth + 1)) || ("parts" in source && hasRichImage(source.parts, depth + 1))
}
