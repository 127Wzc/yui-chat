import { extractMessageContext } from "../message/message-context.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { actionRecord as record, type ActionDefinition, type ActionRecord } from "./contract.js"

export interface ImagePresetInput { text: string; targetId: string; variables: Record<string, string> }

/** 只解析绘图预设的输入；目标只用作素材，不改变发起人的身份或授权。 */
export async function prepareImagePresetInput(action: ActionDefinition, rawText: string, event: ActionRecord): Promise<ImagePresetInput> {
  const raw = String(rawText || "").trim()
  if (raw.length > 8000) throw new Error("动作输入最多 8,000 个字符")
  const promptMatch = raw.match(/(?:^|\s)-p(?:\s+([\s\S]*))?$/)
  if (promptMatch && !String(promptMatch[1] || "").trim()) throw new Error("请在 -p 后填写追加要求。")
  const text = promptMatch ? String(promptMatch[1]).trim() : ""
  let nameArgs = (promptMatch ? raw.slice(0, promptMatch.index) : raw).trim()
  const bot = record(event.bot)
  const botIds = new Set([String(event.self_id || ""), String(bot.uin || "")])
  const mention = extractMessageContext(event).mentions.find(item => /^\d{5,12}$/.test(item.qq) && !botIds.has(item.qq))?.qq || ""
  if (mention) nameArgs = nameArgs.replace(/^(?:@\S+|\[CQ:at,[^\]]+\])\s*/, "").trim()

  let explicitId = ""
  let manualName = ""
  const named = nameArgs.match(/^(?:昵称|名字|name|nickname)\s*[=:：]\s*([\s\S]+)$/i)
  const targeted = nameArgs.match(/^(?:qq|user|user_id)\s*[=:：]\s*(\d{5,12})(?:\s+(?:(?:昵称|名字|name|nickname)\s*[=:：]\s*)?([\s\S]+))?$/i)
  const numeric = nameArgs.match(/^@?(\d{5,12})(?:\s+(?:(?:昵称|名字|name|nickname)\s*[=:：]\s*)?([\s\S]+))?$/i)
  if (named) manualName = named[1].trim()
  else if (targeted || numeric) { explicitId = (targeted || numeric)![1]; manualName = String((targeted || numeric)![2] || "").trim() }
  else if (nameArgs) manualName = nameArgs
  const senderId = String(event.user_id || "")
  const senderName = String(record(event.sender).card || record(event.sender).nickname || event.nickname || senderId)
  const targetId = explicitId || mention || senderId
  let nickname = manualName || (targetId === senderId ? senderName : targetId)

  if (!manualName && targetId && targetId !== senderId && /\{\{\s*(?:name|nickname)\s*\}\}/.test(action.textTemplate)) {
    for (const [ownerValue, method] of [[event.group, "pickMember"], [event.bot, "pickFriend"]] as const) {
      const owner = record(ownerValue)
      if (typeof owner[method] !== "function") continue
      try {
        const person = record((owner[method] as (id: string) => unknown).call(ownerValue, targetId))
        let info = record(person.info)
        if (!Object.keys(info).length && typeof person.getInfo === "function") {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000) })
            info = record(await Promise.race([Promise.resolve((person.getInfo as () => unknown).call(person)), timeout]))
          } finally { if (timer) clearTimeout(timer) }
        }
        nickname = String(info.card || info.nickname || person.card || person.nickname || targetId)
        if (nickname !== targetId) break
      } catch (error) {
        hostRuntime.logger?.debug?.("[yui-chat] 动作预设昵称读取失败，继续尝试其他来源", error instanceof Error ? error.name : "unknown")
      }
    }
  }
  const group = record(event.group)
  return {
    text, targetId,
    variables: { nickname, name: nickname, qq: targetId, user_id: targetId, group_name: String(event.group_name || group.name || group.group_name || ""), group_id: String(event.group_id || ""), sender_nickname: senderName, sender_qq: senderId },
  }
}
