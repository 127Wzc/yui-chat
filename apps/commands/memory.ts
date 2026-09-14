import { extractMessageContext } from "../../core/message/message-context.js"
import { memoryStore } from "../../memory/store.js"
import { configStore } from "../../config/store.js"
import { checkAccess } from "../../core/chat/access-control.js"
import { pluginCommand, stripPluginCommand } from "../../core/message/command-prefixes.js"
import type { UnknownRecord } from "../../core/message/types.js"

function memoryMessageContext(e: UnknownRecord) {
  // 宿主 msg 可能把真实 @ 展示成昵称；有消息段时以原始文字段为准。
  const segments = Array.isArray(e.message) ? e.message : []
  const hasText = segments.some(value=>value && typeof value === "object" && (value as UnknownRecord).type === "text")
  return extractMessageContext(hasText ? {...e,msg:"",raw_message:""} : e)
}

function usage(master: boolean): string {
  const prefix = pluginCommand(master ? "管理记忆 用户ID或@成员" : "记忆")
  return [`${prefix} [页码]`, `${prefix} 添加 内容`, `${prefix} 修改 记忆ID 新内容`, `${prefix} 删除 记忆ID`].join("\n")
}

/** 只管理个人长期记忆；目标身份在命令边界确定，不使用群聊召回范围。 */
export async function runMemoryCommand(e: UnknownRecord, master = false): Promise<string> {
  if (master && e.isMaster !== true) return "只有主人可以管理他人的记忆。"
  if (!checkAccess(e, configStore.get()).ok) return ""
  let ownerId = String(e.user_id || "").trim()
  let body = stripPluginCommand(e.msg, master ? "管理记忆" : "记忆")
  if (master) {
    const context = memoryMessageContext(e)
    const targets = [...new Set(context.mentions.map(item=>String(item.qq)))]
    if (targets.length) {
      if (targets.length !== 1 || targets[0] === "all" || targets[0] === String(e.self_id || "")) return "请只 @ 一位要管理记忆的成员。"
      ownerId = targets[0]
      body = stripPluginCommand(context.text, "管理记忆")
    } else {
      const target = body.match(/^(\S+)(?:\s+([\s\S]*))?$/)
      if (!target || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(target[1])) return usage(true)
      ownerId = target[1]
      body = (target[2] || "").trim()
    }
  }
  if (!ownerId) return "无法识别当前用户，未读取或修改记忆。"
  const match = body.match(/^(添加|修改|删除)(?:\s+([\s\S]*))?$/)
  try {
    if (match) {
      const operation = match[1]
      const rest = (match[2] || "").trim()
      const parts = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/)
      if (!rest || operation === "修改" && !parts?.[2] || operation === "删除" && parts?.[2]) return usage(master)
      if (operation === "删除") {
        const result = await memoryStore.deleteManagedMemory("user", ownerId, rest)
        return result.ok ? `已删除记忆：${rest}` : "未找到该用户的这条记忆，请先查看列表。"
      }
      const content = operation === "添加" ? rest : parts![2].trim()
      if (content.length > 500) return "每条记忆最多 500 个字符，请精简后重试。"
      const item = await memoryStore.saveManagedMemory({scopeType:"user",ownerId,text:content,...(operation === "修改" ? {id:parts![1]} : {})})
      return item?.id ? `已${operation}记忆：${item.id}\n${item.text}` : "记忆未保存，请检查记忆功能配置。"
    }
    if (body && !/^[1-9]\d{0,3}$/.test(body)) return usage(master)
    const page = Number(body || 1)
    const workspace = await memoryStore.getManagedScope("user", ownerId)
    const items = Array.isArray(workspace.items) ? workspace.items as UnknownRecord[] : []
    const pages = Math.max(1, Math.ceil(items.length / 8))
    if (page > pages) return `页码超出范围，共 ${pages} 页。\n${usage(master)}`
    const rows = items.slice((page - 1) * 8, page * 8).map(item=>`${item.id}\n${item.text}`)
    return [`${master ? `用户 ${ownerId}` : "我的"}个人长期记忆 · ${page}/${pages} 页`, items.length >= 200 ? "展示最近 200 条" : `共 ${items.length} 条`, rows.length ? rows.join("\n\n") : "暂无长期记忆。", usage(master)].join("\n\n")
  } catch (error) {
    return `记忆操作失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 用户明确要求的 @ 快捷查看入口；只接受真实提及消息，不按昵称猜测身份。 */
export async function runMentionMemoryCommand(e: UnknownRecord): Promise<string | false> {
  const context = memoryMessageContext(e)
  if (!/^(?:他的|她的|TA的)记忆$/i.test(context.text.trim()) || !context.mentions.length) return false
  if (e.isMaster !== true) return "只有主人可以查看他人的记忆。"
  const message = context.mentions.map(item=>({type:"at",qq:item.qq}))
  return runMemoryCommand({...e,msg:pluginCommand("管理记忆"),message:[{type:"text",text:pluginCommand("管理记忆")},...message]},true)
}
