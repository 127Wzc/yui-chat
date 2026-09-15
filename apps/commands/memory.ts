import { deliverMessageChain } from "../../core/message-chain/delivery.js"
import { isGroupEvent } from "../../core/message/event-scope.js"
import { extractMessageContext } from "../../core/message/message-context.js"
import { memoryStore } from "../../memory/store.js"
import { configStore } from "../../config/store.js"
import { checkAccess } from "../../core/chat/access-control.js"
import { matchPluginCommand, pluginCommand, stripPluginCommand } from "../../core/message/command-prefixes.js"
import type { UnknownRecord } from "../../core/message/types.js"

function memoryMessageContext(e: UnknownRecord) {
  // 宿主 msg 可能把真实 @ 展示成昵称；有消息段时以原始文字段为准。
  const segments = Array.isArray(e.message) ? e.message : []
  const hasText = segments.some(value=>value && typeof value === "object" && (value as UnknownRecord).type === "text")
  return extractMessageContext(hasText ? {...e,msg:"",raw_message:""} : e)
}

type IndexedMemory = { id: string; text: string; scopeType: "user" | "user_group" }
const indexes = new Map<string, { expires: number; rows: IndexedMemory[] }>()
function indexKey(e: UnknownRecord, owner: string): string {
  return JSON.stringify([e.self_id, e.user_id, e.group_id, owner])
}
function remember(key: string, rows: IndexedMemory[]): void {
  for (const [id, entry] of indexes) if (entry.expires < Date.now()) indexes.delete(id)
  indexes.delete(key)
  if (indexes.size >= 500) indexes.delete(indexes.keys().next().value!)
  indexes.set(key, { expires: Date.now() + 15 * 60_000, rows })
}
function usage(master: boolean): string {
  const prefix = pluginCommand(master ? "管理记忆 [@成员或QQ号]" : "我的记忆")
  return [prefix, `${prefix} 添加 [内容]`, `${prefix} 个人 添加 [本群内容]`, `${prefix} 修改 [序号] [新内容]`, `${prefix} 删除 [序号]`, "方括号不用输入；默认添加到全局，序号以最近一次列表为准（15 分钟有效）。"].join("\n")
}
async function memoryRows(e: UnknownRecord, ownerId: string): Promise<IndexedMemory[]> {
  const global = await memoryStore.getManagedScope("user", ownerId)
  const globals = (Array.isArray(global.items) ? global.items : []) as UnknownRecord[]
  const local: UnknownRecord[] = []
  if (isGroupEvent(e) && typeof memoryStore.getGroupMemberWorkspace === "function") {
    for (let page = 1; page <= 2; page++) {
      const workspace = await memoryStore.getGroupMemberWorkspace(e.group_id, ownerId, { groupPage: page, pageSize: 100 })
      const group = workspace.groupMemory as UnknownRecord
      const rows = Array.isArray(group?.items) ? group.items as UnknownRecord[] : []
      local.push(...rows)
      if (rows.length < 100) break
    }
  }
  return [
    ...local.map(item => ({ id: String(item.id), text: String(item.text), scopeType: "user_group" as const })),
    ...globals.map(item => ({ id: String(item.id), text: String(item.text), scopeType: "user" as const })),
  ]
}

/** 个人本群与跨群记忆共用入口，目标身份在命令边界确定。 */
export async function runMemoryCommand(e: UnknownRecord, master = false): Promise<string> {
  if (master && e.isMaster !== true) return "只有主人可以管理他人的记忆。"
  if (!checkAccess(e, configStore.get()).ok) return ""
  let ownerId = String(e.user_id || "").trim()
  let body = stripPluginCommand(e.msg, master ? "管理记忆" : "我的记忆")
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
  let selectedScope: "user" | "user_group" = "user"
  const scopeMatch = body.match(/^(个人|本群|全局)(?:\s+([\s\S]*))?$/)
  if (scopeMatch) {
    selectedScope = scopeMatch[1] === "全局" ? "user" : "user_group"
    body = (scopeMatch[2] || "").trim()
    if (selectedScope === "user_group" && !isGroupEvent(e)) return "个人本群记忆请在对应群聊中操作。"
  }
  const key = indexKey(e, ownerId)
  const match = body.match(/^(添加|修改|删除)(?:\s+([\s\S]*))?$/)
  try {
    if (match) {
      const operation = match[1]
      const rest = (match[2] || "").trim()
      const parts = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/)
      if (!rest || operation === "修改" && !parts?.[2] || operation === "删除" && parts?.[2]) return usage(master)
      let target: IndexedMemory | undefined
      if (operation !== "添加") {
        const selector = parts![1]
        if (/^[1-9]\d*$/.test(selector)) {
          const snapshot = indexes.get(key)
          if (!snapshot || snapshot.expires < Date.now()) return "序号已过期，请先查看记忆列表。"
          target = snapshot.rows[Number(selector) - 1]
          if (!target) return "未找到该序号，请重新查看记忆列表。"
          const current = (await memoryRows(e, ownerId)).find(row => row.id === target!.id && row.scopeType === target!.scopeType)
          if (!current || current.text !== target.text) return "这条记忆已变化，请刷新列表后操作。"
        } else {
          // 兼容已有 ID 指令，但同样限定到目标用户和当前群。
          target = (await memoryRows(e, ownerId)).find(row => row.id === selector)
          if (!target) return "未找到该用户的这条记忆，请先查看列表。"
        }
        if (scopeMatch && target.scopeType !== selectedScope) return "序号不属于所选范围，请核对列表。"
      }
      const scopeType = target?.scopeType || selectedScope
      const scoped = { scopeType, ownerId, groupId: scopeType === "user_group" ? String(e.group_id) : "" }
      if (operation === "删除") {
        const result = scopeType === "user" ? await memoryStore.deleteManagedMemory("user", ownerId, target!.id)
          : await memoryStore.deleteScopedMemory({ ...scoped, memoryId: target!.id })
        if (result.ok) indexes.delete(key)
        return result.ok ? "已删除这条记忆，请刷新列表获取最新序号。" : "未找到这条记忆，请刷新列表。"
      }
      const content = operation === "添加" ? rest : parts![2].trim()
      if (content.length > 500) return "每条记忆最多 500 个字符，请精简后重试。"
      if (scopeType === "user_group" && typeof memoryStore.saveScopedMemory !== "function") return "当前存储不支持本群个人记忆。"
      const input = { ...scoped, text: content, ...(target ? { id: target.id } : {}) }
      const item = scopeType === "user" ? await memoryStore.saveManagedMemory(input) : await memoryStore.saveScopedMemory(input)
      if (item?.id) indexes.delete(key)
      return item?.id ? `已${operation}记忆\n${item.text}\n请刷新列表获取最新序号。` : "记忆未保存，请检查记忆功能配置。"
    }
    if (body && !/^[1-9]\d{0,3}$/.test(body)) return usage(master)
    const rows = await memoryRows(e, ownerId)
    const page = Number(body || 0)
    const totalPages = Math.max(1, Math.ceil(rows.length / 10))
    if (page > totalPages) return `页码超出范围，共 ${totalPages} 页。\n${usage(master)}`
    const indexed = rows.map((row, index) => ({ ...row, number: index + 1 }))
    const visible = page ? indexed.slice((page - 1) * 10, page * 10) : indexed
    const nodes = [{ nickname: "Yui · 记忆目录", parts: [{ type: "text" as const, text: `${master ? `用户 ${ownerId}` : "我的"}记忆\n个人 · 仅本群｜全局 · 跨群使用\n每个范围最多展示最近 200 条\n\n${usage(master)}` }] }]
    for (const [scope, title] of [["user_group", "个人记忆 · 本群"], ["user", "全局记忆 · 跨群"]] as const) {
      const items = visible.filter(row => row.scopeType === scope)
      if (!items.length) nodes.push({ nickname: `Yui · ${title}`, parts: [{ type: "text", text: `${title}\n暂无记忆${scope === "user_group" && !isGroupEvent(e) ? "（请在群聊查看）" : ""}。` }] })
      for (let offset = 0; offset < items.length; offset += 10) {
        const chunk = items.slice(offset, offset + 10)
        nodes.push({ nickname: `Yui · ${title}`, parts: [{ type: "text", text: `${title} · ${chunk[0].number}–${chunk.at(-1)!.number}\n━━━━━━━━━━━━\n${chunk.map(row => `[${row.number}] ${row.text}`).join("\n\n")}` }] })
      }
    }
    if (typeof e.reply === "function") {
      const receipt = await deliverMessageChain([{ type: "forward", nodes }], { e, config: configStore.get() })
      if (!["sent", "success", "accepted"].includes(String(receipt.status))) return "记忆转发未完整送达，请重试。"
      remember(key, rows)
      return ""
    }
    remember(key, rows)
    return nodes.map(node => node.parts[0].text).join("\n\n")
  } catch (error) {
    return `记忆操作失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 带统一前缀的只读快捷入口，真实提及或明确 QQ 号确定目标。 */
export async function runMentionMemoryCommand(e: UnknownRecord): Promise<string | false> {
  const context = memoryMessageContext(e)
  const match = matchPluginCommand(context.text.trim(), "(?:他的|她的|TA的|ta的)记忆(?:\\s+([\\s\\S]*))?")
  if (!match) return false
  if (e.isMaster !== true) return "只有主人可以查看他人的记忆。"
  const target = (match[1] || "").trim()
  if (context.mentions.length ? Boolean(target) : !/^\d{1,20}$/.test(target)) {
    return pluginCommand("他的记忆 [@成员或QQ号]") + "（她的记忆、TA的记忆也可；请只指定一位成员）"
  }
  const command = pluginCommand("管理记忆") + (target ? " " + target : "")
  const message = context.mentions.map(item => ({ type: "at", qq: item.qq }))
  return runMemoryCommand({ ...e, msg: command, message: [{ type: "text", text: command }, ...message] }, true)
}
