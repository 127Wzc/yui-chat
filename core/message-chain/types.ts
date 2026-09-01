/** 可安全跨越模型、工具和持久化边界的 JSON 值。 */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** 资源引用的来源类别，不代表当前已经获得投递权限。 */
export type ResourceKind = "url" | "file" | "cache" | "base64" | "platform"

/**
 * 资源引用。
 *
 * `value` 只表示 URL、缓存键或平台资源标识；MCP 内联正文只能短暂放在
 * `inlineData`，进入模型、日志或持久化前必须由序列化器移除，进入投递层前
 * 则应先物化到媒体缓存。这样资源定位和资源正文不会混为一谈。
 */
export interface ResourceRef {
  kind: ResourceKind
  value: string
  mimeType?: string
  name?: string
  size?: number
  sourceUri?: string
  /** 仅供归一化/媒体物化阶段使用，禁止直接发送给模型或写入日志。 */
  inlineData?: string
}

/** 普通文本片段。 */
export interface TextPart {
  type: "text"
  text: string
}

/** 只供模型/工具处理的结构化片段，不可直接投递。 */
export interface JsonPart {
  type: "json"
  data: JsonValue
}

/** 平台无关的用户提及片段。 */
export interface MentionPart {
  type: "mention"
  userId: string
}

/** 平台无关的回复引用片段。 */
export interface ReplyPart {
  type: "reply"
  messageId: string
  selectedText?: string
}

/** 所有媒体/资源片段共享的描述字段。 */
export interface ResourcePartBase {
  source: ResourceRef
  mimeType?: string
  name?: string
  description?: string
}

export interface ImagePart extends ResourcePartBase {
  type: "image"
}

export interface AudioPart extends ResourcePartBase {
  type: "audio"
}

export interface VideoPart extends ResourcePartBase {
  type: "video"
}

export interface FilePart extends ResourcePartBase {
  type: "file"
}

export interface ResourcePart extends ResourcePartBase {
  type: "resource"
  uri: string
}

/** 音乐平台标识；custom 表示自带跳转/试听地址的自定义卡片。 */
export type MusicPlatform = "qq" | "163" | "kugou" | "migu" | "kuwo" | "custom"

/**
 * 音乐卡片片段。
 *
 * 对应 OneBot 的 music 消息段：平台歌曲用 platform + id，自定义卡片用
 * custom + url/audio/title/image/singer。它是平台专属能力，无法用通用
 * 媒体片段表达，所以单独建模而不是硬塞成 audio。
 */
export interface MusicPart {
  type: "music"
  platform: MusicPlatform
  id?: string
  url?: string
  audio?: string
  title?: string
  singer?: string
  image?: string
}

/** 合并转发节点内允许出现的消息片段；禁止递归嵌套转发。 */
export type ForwardNodePart =
  | TextPart
  | MentionPart
  | ReplyPart
  | ImagePart
  | AudioPart
  | VideoPart
  | FilePart
  | MusicPart

/** 平台无关的合并转发节点，投递边界再转换成 OneBot/Yunzai node。 */
export interface ForwardNode {
  parts: readonly ForwardNodePart[]
  nickname?: string
  userId?: string
  time?: number
}

/** 一条合并转发消息。多个节点作为一次 message_send 投递。 */
export interface ForwardPart {
  type: "forward"
  nodes: readonly ForwardNode[]
}

/** 第三方平台或扩展协议暂时无法映射时的保留片段；默认不可直接投递。 */
export interface ExtensionPart {
  type: "extension"
  namespace: string
  name: string
  data: JsonValue
}

/** 可交给模型观察或由运行时继续处理的内部内容片段。 */
export type ContentPart =
  | TextPart
  | JsonPart
  | MentionPart
  | ReplyPart
  | ImagePart
  | AudioPart
  | VideoPart
  | FilePart
  | MusicPart
  | ForwardPart
  | ResourcePart
  | ExtensionPart

/** 唯一的内部消息表示；输入、模型和宿主输出都通过它交换有序内容。 */
export type MessageChain = readonly ContentPart[]

/** 平台适配器允许直接投递给用户的内容子集。 */
export type OutboundPart = Exclude<ContentPart, JsonPart | ResourcePart | ExtensionPart>

/** 工具结果的生命周期语义。 */
export type ToolOutputKind = "observation" | "delivery" | "action" | "error"

export interface DeliveryTarget {
  platform: string
  accountId?: string
  conversationId: string
  messageId?: string
  type?: "group" | "user"
}

export interface PartDeliveryReceipt {
  index: number
  type: ContentPart["type"]
  status: "sent" | "failed"
  messageId?: string
  error?: string
}

export interface DeliveryReceipt {
  id: string
  status: "sent" | "partial" | "failed" | "pending"
  partCount: number
  sentCount: number
  failedCount: number
  parts?: readonly PartDeliveryReceipt[]
  messageIds?: readonly string[]
  target?: DeliveryTarget
  error?: string
}

export interface ToolOutput {
  kind: ToolOutputKind
  chain: MessageChain
  structuredContent?: JsonValue
  isError: boolean
  issues: string[]
  receipt?: DeliveryReceipt
  /** 供运行时和可观测性使用的非敏感执行元数据。 */
  metadata?: Record<string, JsonValue>
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!value || typeof value !== "object") return false
  return Object.values(value).every(isJsonValue)
}
