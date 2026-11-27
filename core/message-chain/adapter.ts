import type { MessageChain, MessageDestination, OutboundPart, ResourceRef } from "./types.js"

/** 已完成授权的投递上下文；平台原始事件只由对应适配器解释。 */
export interface MessageAdapterContext {
  signal?: AbortSignal
  e?: Record<string, unknown>
  destination?: MessageDestination
  quote?: boolean
  quoteStandalone?: boolean
  replyOptions?: Record<string, unknown>
}

export interface PreparedMessagePart {
  payload: unknown
  standalone: boolean
  allowQuote: boolean
}

/** 只负责平台表达、发送与回执；校验、过滤和资源访问策略由投递器统一处理。 */
export interface MessageAdapter {
  readonly id: string
  /** Web 等会话出口提供已接收内容的副本，供同一会话写入队列保存。 */
  getDisplayContent?(): MessageChain
  supports(type: OutboundPart["type"]): boolean
  canSend(context: MessageAdapterContext): boolean
  prepare(part: OutboundPart, context: MessageAdapterContext, resolveResource: (source: ResourceRef) => Promise<string>): Promise<PreparedMessagePart>
  send(payload: unknown, context: MessageAdapterContext): Promise<{ receipt: unknown; messageIds: string[] }>
}
