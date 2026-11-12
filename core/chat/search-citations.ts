import type { UnknownRecord } from "../message/types.js"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return String(value ?? "")
}

function citationUrl(value: string): string {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"))
    if (!/^https?:$/.test(url.protocol)) return ""
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key)
    url.searchParams.sort()
    return url.href
  } catch {
    // 非完整 URL 不作为来源匹配，保留模型原文。
    return ""
  }
}

const urlPattern = String.raw`https?:\/\/(?:[^\s<>()（），。！？；："'\x60]|\([^()\s]*\))+`
const markdown = (name: string) => String.raw`\[[^\]\r\n]+\]\(\s*<?(?<${name}>${urlPattern})>?(?:\s+"[^"\r\n]*")?\s*\)`
// 每个链接作为完整 token 处理，禁止在未匹配的链接内部继续替换网址前缀。
const citationTokens = new RegExp([
  String.raw`(?<code>\x60{3}[\s\S]*?\x60{3}|~~~[\s\S]*?~~~|\x60{1,2}[^\x60\r\n]*\x60{1,2})`,
  String.raw`(?<image>!\[[^\]\r\n]*\]\(\s*<?${urlPattern}>?(?:\s+"[^"\r\n]*")?\s*\))`,
  String.raw`[（(]\s*${markdown("wrappedMarkdown")}\s*[)）]`,
  markdown("markdown"),
  String.raw`[（(]\s*<?(?<wrappedUrl>${urlPattern})>?\s*[)）]`,
  String.raw`<(?<autolink>${urlPattern})>`,
  String.raw`(?<bare>${urlPattern})(?=$|[\s<>）），。！？；："'\x60)])`,
].join("|"), "giu")

/** 只压缩已知搜索来源；保留业务参数、无关链接、图片与代码中的 URL。 */
export function formatHostedSearchCitations(value: unknown, sourcesValue: unknown): string {
  const markers = new Map<string, string>()
  const seen = new Set<string>()
  for (const item of Array.isArray(sourcesValue) ? sourcesValue : []) {
    const raw = text(record(item).url).trim()
    const key = citationUrl(raw)
    if (!key || seen.has(raw)) continue
    seen.add(raw)
    if (!markers.has(key)) markers.set(key, String(seen.size).replace(/\d/g, digit => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(digit)]!))
  }
  if (!markers.size) return text(value).trim()
  return text(value).replace(citationTokens, (...args: unknown[]) => {
    const whole = text(args[0])
    const groups = record(args.at(-1))
    if (groups.code || groups.image) return whole
    const raw = text(groups.wrappedMarkdown || groups.markdown || groups.wrappedUrl || groups.autolink || groups.bare)
    const suffix = groups.bare ? raw.match(/[.,!?;:，。！？；：]+$/u)?.[0] || "" : ""
    const marker = markers.get(citationUrl(suffix ? raw.slice(0, -suffix.length) : raw))
    return marker ? marker + suffix : whole
  }).trim()
}

/** 来源转发原样保留，只整理 message_send 顶层的文字正文。 */
export function formatSearchMessageParts(parts: UnknownRecord[], hostedSources: unknown): UnknownRecord[] {
  const sources = [...(Array.isArray(hostedSources) ? hostedSources : [])]
  for (const part of parts) {
    if (part.type !== "forward") continue
    for (const node of Array.isArray(part.nodes) ? part.nodes : []) {
      const nodeParts = record(node).parts
      for (const item of Array.isArray(nodeParts) ? nodeParts : []) {
        if (record(item).type !== "text") continue
        for (const line of text(record(item).text).split(/\r?\n/u)) {
          const url = line.trim().replace(/^链接[：:]\s*/u, "")
          if (/^https?:\/\/\S+$/iu.test(url)) sources.push({ url })
        }
      }
    }
  }
  if (!sources.length) return parts
  return parts.map(part => {
    if (part.type !== "text" || typeof part.text !== "string") return part
    const cleaned = formatHostedSearchCitations(part.text, sources)
    if (cleaned === part.text.trim()) return part
    // 消息片段之间的空格、换行仍属于正文排版，不随引用清理而丢失。
    return { ...part, text: `${part.text.match(/^\s*/u)?.[0] || ""}${cleaned}${part.text.match(/\s*$/u)?.[0] || ""}` }
  })
}
