import crypto from "node:crypto"
import { cacheWebDeliveryMedia } from "../../core/media/media-cache.js"
import type { MessageAdapter } from "../../core/message-chain/adapter.js"
import type { OutboundPart, ResourceRef } from "../../core/message-chain/types.js"
import { cloneJsonValue } from "../../core/shared/json-values.js"

/** Web 会话出口：沿用通用投递校验和过滤，保留已接收内容供页面与历史展示。 */
export function createWebMessageAdapter(config: Record<string, unknown>, onDelivery?: (content: unknown) => void): MessageAdapter {
  const delivered: OutboundPart[] = []
  const mountPath = String((config.web as Record<string, unknown> | undefined)?.mountPath || "/yui-chat").replace(/\/$/, "")
  return {
    id: "web",
    getDisplayContent: () => cloneJsonValue(delivered),
    supports: () => true,
    canSend: context => !context.destination,
    async prepare(part, context, resolveResource) {
      if (context.destination) throw new Error("Web 对话只支持投递到当前网页。")
      async function prepare(item: OutboundPart): Promise<OutboundPart> {
        if (item.type === "forward") {
          const nodes = []
          for (const node of item.nodes) {
            const parts = []
            for (const child of node.parts) parts.push(await prepare(child) as typeof child)
            nodes.push({ ...node, parts })
          }
          return { ...item, nodes }
        }
        if (["image", "audio", "video", "file"].includes(item.type) && "source" in item) {
          const value = await resolveResource(item.source)
          const id = await cacheWebDeliveryMedia(value, { config, signal: context.signal, mimeType: item.mimeType || item.source.mimeType, name: item.name || item.source.name })
          const source: ResourceRef = { kind: "url", value: `${mountPath}/api/chat/media/${id}` }
          return { ...item, source }
        }
        return item
      }
      return { payload: await prepare(part), standalone: false, allowQuote: false }
    },
    async send(payload, context) {
      if (context.destination) throw new Error("Web 对话只支持投递到当前网页。")
      const content = (Array.isArray(payload) ? payload : [payload]) as OutboundPart[]
      const id = `web_${crypto.randomUUID()}`
      delivered.push(...content)
      onDelivery?.(cloneJsonValue(delivered))
      return { receipt: { message_id: id }, messageIds: [id] }
    },
  }
}
