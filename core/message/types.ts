import type { MessageChain } from "../message-chain/types.js"

/** 消息输入边界的未知记录；宿主事件必须先经过本地收窄再进入领域逻辑。 */
export type UnknownRecord = Record<string, unknown>

export interface MessageMediaItem extends UnknownRecord {
  type: string
  url: string
  source?: string
}

export interface MessageMention extends UnknownRecord {
  qq: string
  source?: string
}

export interface MessageReply extends UnknownRecord {
  id: string
  source?: string
}

export interface MessageContext {
  /** 唯一的有序内部消息链；下面字段只是便于查询的派生视图。 */
  chain: MessageChain
  text: string
  images: MessageMediaItem[]
  records: MessageMediaItem[]
  videos: MessageMediaItem[]
  files: MessageMediaItem[]
  mentions: MessageMention[]
  replies: MessageReply[]
  rawTypes: string[]
}

export interface OpenAiTextPart {
  type: "text"
  text: string
}

export interface OpenAiImagePart {
  type: "image_url"
  image_url: { url: string }
}

export type OpenAiUserContent = string | Array<OpenAiTextPart | OpenAiImagePart>
