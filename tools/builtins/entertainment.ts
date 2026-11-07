import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { EmojiLikeTool, GroupPokeTool } from "./group-admin.js"
import { replyMessageChain } from "../../core/message-chain/delivery.js"
import { MessageChainBuilder } from "../../core/message-chain/builder.js"
import type { UnknownRecord } from "../../core/message/types.js"

interface ReplyEvent extends UnknownRecord {
  reply?: (payload: unknown, quote?: boolean) => Promise<unknown> | unknown
}

interface EntertainmentContext {
  e?: ReplyEvent
  config?: UnknownRecord
}

export class SendDiceTool {
  name = "send_dice"
  source = "builtin"
  delivery = "media"
  requiresFinalReply = false
  execution = {
    effect: "non_idempotent",
    repeatPolicy: "explicit_only",
    supportsCount: true,
    countField: "count",
    maxCount: 5,
    operationFields: ["count"],
    promptCount: { keywords: ["骰子", "dice"], units: ["个", "次"], maxClauses: 4 },
    retryPolicy: "no_ambiguous_retry",
    maxAttempts: 1,
    operationFamily: "send_dice",
  }
  description = "Send one or more dice segments to current chat."
  parameters = {
    type: "object",
    properties: {
      count: { type: "number", description: "Dice count, max 5." },
    },
  }

  async execute(args: UnknownRecord = {}, context: EntertainmentContext = {}): Promise<UnknownRecord> {
    const count = Math.max(1, Math.min(Number(args.count || 1), 5))
    const builder = new MessageChainBuilder()
    for (let i = 0; i < count; i++) builder.dice()
    if (!context.e || !hostRuntime.canSendMessage(context.e)) throw new Error("当前适配器不支持发送骰子消息。")
    await replyMessageChain(builder.build(), { e: context.e, config: context.config, quote: true })
    return { status: "success", content: `已发送 ${count} 个骰子。`, executedCount: count, retryAllowed: false }
  }
}

export class SendRpsTool {
  name = "send_rps"
  source = "builtin"
  delivery = "media"
  requiresFinalReply = false
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["value"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1, operationFamily: "send_rps" }
  description = "Send a rock-paper-scissors segment to current chat."
  parameters = {
    type: "object",
    properties: {
      value: { type: "number", description: "1 rock, 2 scissors, 3 paper. Random when omitted." },
    },
  }

  async execute(args: UnknownRecord = {}, context: EntertainmentContext = {}): Promise<UnknownRecord> {
    const value = [1, 2, 3].includes(Number(args.value)) ? Number(args.value) : Math.ceil(Math.random() * 3)
    if (!context.e || !hostRuntime.canSendMessage(context.e)) throw new Error("当前适配器不支持发送猜拳消息。")
    await replyMessageChain(new MessageChainBuilder().rps(value).build(), { e: context.e, config: context.config, quote: true })
    return { status: "success", content: `已发送猜拳 ${value}。`, executedCount: 1, retryAllowed: false }
  }
}

export function createEntertainmentTools(): unknown[] {
  return [
    new EmojiLikeTool(),
    new GroupPokeTool(),
    new SendDiceTool(),
    new SendRpsTool(),
  ]
}
