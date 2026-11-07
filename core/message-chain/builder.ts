import type {
  MessageChain,
  AudioPart,
  ContentPart,
  ExtensionPart,
  FilePart,
  ForwardNode,
  ForwardPart,
  ImagePart,
  MentionPart,
  MusicPart,
  OutboundPart,
  ReplyPart,
  ResourcePart,
  ResourceRef,
  VideoPart,
  MediaInput,
} from "./types.js"
import { isJsonValue } from "./types.js"

/** 将插件已经取得的媒体值表达为资源引用；不下载、不创建宿主消息段。 */
export function mediaResourceFromValue(value: unknown): ResourceRef {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { kind: "bytes", value: Buffer.from(value).toString("base64") }
  if (value && typeof value === "object" && "kind" in value && "value" in value) return { ...value } as ResourceRef
  const uri = String(value ?? "").trim()
  const data = uri.match(/^data:([^;,]+);base64,([\s\S]*)$/i)
  if (data) return { kind: "bytes", value: data[2], mimeType: data[1] }
  if (/^base64:\/\//i.test(uri)) return { kind: "bytes", value: uri.slice(9) }
  return { kind: /^https?:\/\//i.test(uri) ? "url" : "path", value: uri }
}

/** 原生命令入口允许文字简写；结构化消息必须显式使用内部片段。 */
export function messageChainFromReply(value: unknown): MessageChain {
  if (!value) return []
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) throw new Error("结构化回复请使用 MessageChain 数组，媒体使用 source 资源引用。")
  return value.flatMap(item => {
    if (typeof item === "string") return item ? [{ type: "text" as const, text: item }] : []
    if (!item || typeof item !== "object" || typeof item.type !== "string") throw new Error("回复片段必须使用 MessageChain 格式。")
    return [item as ContentPart]
  })
}

/**
 * 消息链构造器。
 *
 * 它只负责组合内部消息片段，不负责权限、下载资源或调用宿主发送 API。
 * 后续新增语音、文件或平台专属片段时，应优先扩展这里和 `types.ts`，
 * 不要把 CQ 码或 `segment` 直接散落到工具和聊天流程中。
 */
export class MessageChainBuilder {
  private readonly parts: ContentPart[] = []

  /** 当前链中的片段数，便于日志和投递前检查。 */
  get length(): number {
    return this.parts.length
  }

  /** 追加一段普通文本。 */
  text(value: unknown): this {
    const text = String(value ?? "")
    if (text) this.parts.push({ type: "text", text })
    return this
  }

  /** 追加一个已通过 JSON 边界校验的结构化片段。 */
  json(value: unknown): this {
    if (isJsonValue(value)) this.parts.push({ type: "json", data: value })
    else this.text("[无法序列化的结构化内容]")
    return this
  }

  /** 追加平台无关的用户提及片段。 */
  mention(userId: string | number): this {
    const part: MentionPart = { type: "mention", userId: String(userId) }
    if (part.userId) this.parts.push(part)
    return this
  }

  /** 追加回复引用片段。 */
  reply(messageId: string | number, selectedText?: string): this {
    const part: ReplyPart = { type: "reply", messageId: String(messageId) }
    if (selectedText) part.selectedText = selectedText
    if (part.messageId) this.parts.push(part)
    return this
  }

  dice(): this { this.parts.push({ type: "dice" }); return this }
  rps(value: number): this { this.parts.push({ type: "rps", value }); return this }

  /** 追加图片资源引用。资源本体不在消息链中复制。 */
  image(source: MediaInput, options: Omit<ImagePart, "type" | "source"> = {}): this {
    this.parts.push({ type: "image", source: mediaResourceFromValue(source), ...options })
    return this
  }

  /** 追加音乐卡片片段；平台歌曲用 id，自定义卡片用 url/audio。 */
  music(part: Omit<MusicPart, "type">): this {
    const valid = part.platform === "custom" ? Boolean(part.url || part.audio) : Boolean(part.id)
    if (valid) this.parts.push({ type: "music", ...part })
    return this
  }

  /** 追加一条合并转发；节点内容仍使用统一消息片段。 */
  forward(nodes: readonly ForwardNode[]): this {
    const normalized = nodes.filter(node => node.parts.length).map(node => ({
      ...node,
      parts: node.parts.map(part => ({ ...part })),
    }))
    if (normalized.length) this.parts.push({ type: "forward", nodes: normalized } as ForwardPart)
    return this
  }

  /** 追加语音资源引用。 */
  audio(source: MediaInput, options: Omit<AudioPart, "type" | "source"> = {}): this {
    this.parts.push({ type: "audio", source: mediaResourceFromValue(source), ...options })
    return this
  }

  /** 追加视频资源引用。 */
  video(source: MediaInput, options: Omit<VideoPart, "type" | "source"> = {}): this {
    this.parts.push({ type: "video", source: mediaResourceFromValue(source), ...options })
    return this
  }

  /** 追加文件资源引用。 */
  file(source: MediaInput, options: Omit<FilePart, "type" | "source"> = {}): this {
    this.parts.push({ type: "file", source: mediaResourceFromValue(source), ...options })
    return this
  }

  /** 追加无法判断媒体类型的资源引用。 */
  resource(uri: string, source: ResourceRef, options: Omit<ResourcePart, "type" | "uri" | "source"> = {}): this {
    this.parts.push({ type: "resource", uri, source, ...options })
    return this
  }

  /** 保留平台扩展内容；未提供专用 Delivery 适配器时不会被直接发送。 */
  extension(namespace: string, name: string, data: unknown): this {
    if (isJsonValue(data)) this.parts.push({ type: "extension", namespace: String(namespace), name: String(name), data } as ExtensionPart)
    return this
  }

  /** 追加已有片段；调用方应在进入构造器前完成运行时校验。 */
  add(part: ContentPart): this {
    this.parts.push(part)
    return this
  }

  /** 判断当前链是否包含需要媒体适配器处理的片段。 */
  hasMedia(): boolean {
    return this.parts.some(part => ["image", "audio", "video", "file"].includes(part.type)
      || (part.type === "forward" && part.nodes.some(node => node.parts.some(item => ["image", "audio", "video", "file"].includes(item.type)))))
  }

  /** 合并另一个消息链，保持原链顺序。 */
  concat(parts: Iterable<ContentPart>): this {
    for (const part of parts) this.parts.push(part)
    return this
  }

  /** 返回可供模型或后续投递层处理的副本。 */
  build(): ContentPart[] {
    return this.parts.map(part => ({ ...part }))
  }

  /** 只在所有片段都可直接投递时返回发送链，否则返回空值。 */
  buildOutbound(): OutboundPart[] | null {
    return this.parts.every(part => part.type !== "json" && part.type !== "resource" && part.type !== "extension")
      ? this.parts.map(part => ({ ...part })) as OutboundPart[]
      : null
  }
}

export type MessageChainPart = ContentPart
