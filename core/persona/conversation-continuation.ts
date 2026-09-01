import { extractMessageContext } from "../message/message-context.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import type { UnknownRecord } from "../message/types.js"

const CONTINUATION_WINDOW_MS = 5000
const MAX_WINDOWS = 1000

interface ContinuationWindow {
  userText: string
  botText: string
  deliveredAt: number
}

export interface ContinuationMatch {
  matched: boolean
  reason?: "media" | "cue" | "question-answer" | "keyword"
}

const windows = new Map<string, ContinuationWindow>()
const CONTINUATION_CUE = /^(?:那|那么|这个|那个|这些|那些|它|他|她|刚才|继续|然后|还有|另外|对了|所以|为什么|怎么|哪个|哪些|多少|能不能|可不可以|要是|如果|但是|不过|其实|等等|等下|换一个|再来|再说|具体|详细|举例|我是说|我的意思|不是|不对|对|是的|好的|好|行|可以|不行|算了|嗯|哦)(?:[\s，。！？!?、：:；;~～…]|$)/i
const BOT_QUESTION = /[？?]\s*$|(?:请问|能否|是否|要不要|需不需要|可不可以|有没有|多少|哪(?:个|些|里)|什么|怎么|为何|为什么|方便吗|可以吗).{0,16}[？?]?\s*$/i
const MEDIA_REQUEST = /(?:(?:发|传|上传|贴|给|提供|补|重新).{0,10}(?:图|图片|照片|截图|文件|视频|语音|录音)|(?:图|图片|照片|截图|文件|视频|语音|录音).{0,10}(?:发|传|上传|提供|看看|看下)|(?:看不到|没看到|无法看到).{0,8}(?:图|图片|内容)?)/i
const GENERIC_SEND_REQUEST = /(?:发来|发过来|传来|传过来|上传|提供一下|给我看看)/i
const COMMON_TERMS = new Set(["这个", "那个", "可以", "一下", "什么", "怎么", "需要", "还是", "然后", "用户", "我们", "你们", "他们"])

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function userId(event: unknown): string {
  const e = record(event)
  return text(e.user_id || record(e.sender).user_id).trim()
}

function windowKey(event: unknown): string {
  const id = userId(event)
  return isGroupEvent(event) ? `g:${groupIdFromEvent(event)}:${id}` : `p:${id}`
}

function prune(now = Date.now()): void {
  for (const [key, value] of windows) {
    if (now - value.deliveredAt > CONTINUATION_WINDOW_MS) windows.delete(key)
  }
  while (windows.size > MAX_WINDOWS) windows.delete(windows.keys().next().value as string)
}

function botIds(event: unknown): Set<string> {
  const e = record(event)
  const bot = record(e.bot)
  return new Set([e.self_id, ...(Array.isArray(bot.uin) ? bot.uin : [bot.uin])].map(text).filter(Boolean))
}

function mentionsAnotherMember(event: unknown, message: unknown): boolean {
  const context = extractMessageContext(event, message)
  const bots = botIds(event)
  return context.mentions.some(item => item.qq !== "all" && !bots.has(text(item.qq)))
}

function terms(value: unknown): Set<string> {
  const source = text(value).toLocaleLowerCase("zh-CN")
  const out = new Set<string>()
  for (const word of source.match(/[a-z\d][a-z\d_-]{2,}/gi) || []) out.add(word)
  for (const block of source.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < block.length - 1; index += 1) {
      const term = block.slice(index, index + 2)
      if (!COMMON_TERMS.has(term)) out.add(term)
    }
  }
  return out
}

function hasKeywordOverlap(current: unknown, previous: unknown): boolean {
  const currentTerms = terms(current)
  if (!currentTerms.size) return false
  const previousTerms = terms(previous)
  return [...currentTerms].some(term => previousTerms.has(term))
}

/** 仅在一轮对话回复真正发送完成后，开启一次很短的自然续聊机会。 */
export function armConversationContinuation(event: unknown, userText: unknown, botText: unknown): boolean {
  const key = windowKey(event)
  if (!key || !userId(event) || !text(botText).trim()) return false
  const deliveredAt = Date.now()
  prune(deliveredAt)
  windows.delete(key)
  windows.set(key, { userText: text(userText).trim(), botText: text(botText).trim(), deliveredAt })
  return true
}

/**
 * 判断当前消息是否明显承接刚才的机器人回复。命中后立即消费，续答本身不会再开启窗口。
 * 这里只使用本地文本和媒体线索，不产生额外模型调用。
 */
export function consumeConversationContinuation(event: unknown, message: unknown): ContinuationMatch {
  const now = Date.now()
  prune(now)
  const key = windowKey(event)
  const window = windows.get(key)
  if (!window || now - window.deliveredAt > CONTINUATION_WINDOW_MS || mentionsAnotherMember(event, message)) return { matched: false }

  const context = extractMessageContext(event, message)
  const current = text(context.text || message).trim()
  const hasMedia = Boolean(context.images.length || context.records.length || context.videos.length || context.files.length)
  let reason: ContinuationMatch["reason"]
  if (hasMedia && (MEDIA_REQUEST.test(window.botText) || GENERIC_SEND_REQUEST.test(window.botText))) reason = "media"
  else if (current && CONTINUATION_CUE.test(current)) reason = "cue"
  else if (current && current.length <= 80 && BOT_QUESTION.test(window.botText)) reason = "question-answer"
  else if (current && hasKeywordOverlap(current, `${window.userText}\n${window.botText}`)) reason = "keyword"
  if (!reason) return { matched: false }

  windows.delete(key)
  return { matched: true, reason }
}

export function clearConversationContinuationState(): number {
  const count = windows.size
  windows.clear()
  return count
}

export function conversationContinuationStats(): { windows: number; windowMs: number } {
  prune()
  return { windows: windows.size, windowMs: CONTINUATION_WINDOW_MS }
}
