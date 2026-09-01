import { hostRuntime } from "../../core/runtime/host-runtime.js"
import type { UnknownRecord } from "../../core/message/types.js"

interface ReplyEvent extends UnknownRecord {
  reply?: (payload: unknown, quote?: boolean) => Promise<unknown> | unknown
}

interface EntertainmentContext {
  e?: ReplyEvent
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
    const payloads: unknown[] = []
    for (let i = 0; i < count; i++) {
      payloads.push(hostRuntime.segment?.dice ? hostRuntime.segment.dice() : `骰子：${Math.ceil(Math.random() * 6)}`)
    }
    if (!context.e?.reply) throw new Error("当前适配器不支持发送骰子消息。")
    await context.e.reply(payloads, true)
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
    const payload = hostRuntime.segment?.rps ? hostRuntime.segment.rps(value) : `猜拳：${["石头", "剪刀", "布"][value - 1]}`
    if (!context.e?.reply) throw new Error("当前适配器不支持发送猜拳消息。")
    await context.e.reply(payload, true)
    return { status: "success", content: `已发送猜拳 ${value}。`, executedCount: 1, retryAllowed: false }
  }
}

export function createEntertainmentTools(): unknown[] {
  return [
    new SendDiceTool(),
    new SendRpsTool(),
  ]
}
