import { outboundPartTypes } from "./types.js"

/** 发送边界的运行时契约：只接受插件消息片段，不猜测宿主消息段。 */
type RecordValue = Record<string, unknown>

const outboundTypes = new Set<string>(outboundPartTypes)
const mediaTypes = new Set(["image", "audio", "video", "file"])
const resourceKinds = new Set(["url", "path", "bytes"])
const musicPlatforms = new Set(["qq", "163", "kugou", "migu", "kuwo", "custom"])

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim())
}

function validBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  // 单次字符扫描，避免重复分组在较大媒体上耗尽正则调用栈。
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))
}

export function validateOutboundMessageChain(value: unknown, options: { allowImplicitMention?: boolean } = {}): string[] {
  const issues: string[] = []
  const visit = (chain: unknown, path: string, nested: boolean): void => {
    if (!Array.isArray(chain) || !chain.length) { issues.push(`${path} 必须是非空 MessageChain 数组。`); return }
    for (const [index, raw] of chain.entries()) {
      const part = record(raw)
      const location = `${path}[${index}]`
      if (!outboundTypes.has(String(part.type))) { issues.push(`${location} 的 type 不支持：${String(part.type || "空")}。`); continue }
      if (Object.hasOwn(part, "data")) issues.push(`${location} 不能使用宿主 data 消息段，请使用插件消息结构。`)
      if (part.type === "text") {
        if (typeof part.text !== "string" || !part.text.length) issues.push(`${location} 缺少 text 字符串。`)
      } else if (part.type === "mention") {
        if (!(part.userId === undefined && options.allowImplicitMention) && !nonempty(part.userId)) issues.push(`${location} 缺少 userId。`)
        if (Object.hasOwn(part, "qq")) issues.push(`${location} 请使用 userId，不使用宿主 qq 字段。`)
      } else if (part.type === "reply") {
        if (!nonempty(part.messageId)) issues.push(`${location} 缺少 messageId。`)
      } else if (mediaTypes.has(String(part.type))) {
        const source = record(part.source)
        if (!resourceKinds.has(String(source.kind)) || !nonempty(source.value)) issues.push(`${location} 缺少有效的 source.kind / source.value 资源引用。`)
        if (["file", "url", "path", "src"].some(key => part[key] !== undefined && part[key] !== null && part[key] !== "")) issues.push(`${location} 媒体只能使用 source 资源引用，不能使用宿主 file/url/path/src 字段。`)
        if (nonempty(source.value) && /^https?:\/\//i.test(source.value) && source.kind !== "url") issues.push(`${location}.source 远程链接必须声明 kind=url。`)
        if (source.kind === "bytes" && nonempty(source.value) && !validBase64(source.value)) issues.push(`${location}.source.value 字节正文必须使用 Base64。`)
      } else if (part.type === "music") {
        if (!musicPlatforms.has(String(part.platform))) issues.push(`${location} 音乐 platform 不支持。`)
        if (part.platform === "custom" ? !nonempty(part.url) && !nonempty(part.audio) : !nonempty(part.id)) issues.push(`${location} 缺少音乐 id 或自定义 url/audio。`)
      } else if (part.type === "rps") {
        if (![1, 2, 3].includes(Number(part.value)) || typeof part.value !== "number") issues.push(`${location} 猜拳 value 只支持数字 1、2、3。`)
      } else if (part.type === "forward") {
        if (nested) { issues.push(`${location} 转发节点不能嵌套 forward。`); continue }
        if (!Array.isArray(part.nodes) || !part.nodes.length || part.nodes.length > 50) { issues.push(`${location}.nodes 必须包含 1–50 个节点。`); continue }
        for (const [nodeIndex, node] of part.nodes.entries()) visit(record(node).parts, `${location}.nodes[${nodeIndex}].parts`, true)
      }
    }
  }
  visit(value, "parts", false)
  return issues
}
