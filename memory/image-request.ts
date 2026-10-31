import type { UnknownRecord } from "../core/message/types.js"
import { groupKey, userKey } from "./scopes.js"

export interface MemoryImageSelection {
  scope: "self" | "user" | "users" | "group" | "all"
  userId?: string
  userIds?: string[]
}

export const MAX_MEMORY_IMAGE_USERS = 5

/** 逐个指定成员时按顺序去重，仅保留前五位。 */
export function limitMemoryImageSelection(selection: MemoryImageSelection): MemoryImageSelection {
  if (selection.scope !== "users" || !Array.isArray(selection.userIds)) return selection
  return { ...selection, userIds: [...new Set(selection.userIds)].slice(0, MAX_MEMORY_IMAGE_USERS) }
}

export interface MemoryImageRead {
  items: UnknownRecord[]
  complete: boolean
  warning?: string
}

/** 只依据本轮真实请求开启记忆附件，不让模型生成的绘图描述扩大读取范围。 */
export function isMemoryImageRequest(value: unknown): boolean {
  const text = String(value || "").trim()
  if (!/记忆/u.test(text) || !/(?:作图|画图|绘画|绘制|生图|画(?:一|张|个|幅)|生成.{0,12}(?:图|插画)|创作.{0,12}(?:图|画))/u.test(text)) return false
  // “记忆”也可能只是画作主题；只有主动要求读取／参考或明确指向个人记忆才附加全文。
  const referencesMemory = /(?:根据|依据|基于|按照|参考|参照|结合|利用|使用|读取|查询|查看|调取|提取|拿出|带上|附上|用(?!户))[^。！？!?；;\n]{0,120}记忆/u.test(text)
    || /(?:(?:我|我们|本人|自己|他|她|他们|她们|别人|其他人|对方|大家|所有人|每个人|本群)(?:的)?|(?:用户|成员|群友)的)\s*(?:(?:全部|所有|完整|全量|个人|长期|有效|本群|全局|的)\s*){0,5}记忆/u.test(text)
  if (!referencesMemory) return false
  // “不用提炼，直接带记忆全文作图”是否定压缩步骤，不能误判为禁止使用记忆。
  const usage = text.replace(/(?:不要|别|无需|不用|不必|不需要)\s*(?:再)?(?:提炼|总结|概括|压缩|截断)(?:记忆)?/gu, "")
  if (/(?:不要|别(?!人)|无需|不用|不必|禁止|不想|不愿|不需要|不希望).{0,24}(?:记忆|作图|画|生图)/u.test(usage)) return false
  if (/(?:举例|示例|假设|转发|引用|这句话|这句命令|解释|是否支持)/u.test(text)) return false
  if (/(?:能否|是否|可以|能不能|你能).{0,40}(?:吗|么|？|\?)\s*$/u.test(text) && !/(?:请|帮我|替我|给我)/u.test(text)) return false
  return true
}

export const MEMORY_IMAGE_HINT = "本轮要求依据记忆作图。直接调用 generate_image，prompt 只写绘图要求，不要先总结或复制记忆。工具会按真实请求者身份，将本人、主人指定成员、本群成员或全部用户范围内的全部有效个人记忆按来源附上全文；逐个指定超过5位时只使用前5位，不单独提示。选中范围内的记忆正文不用 memory_manage 分页，不提炼、不截断。无权限、对象不明或读取不完整时会明确失败，不能声称已使用全部记忆或已画好。"

/** 主人身份只取宿主事件；群管不因此获得他人的全量记忆读取权限。 */
export function assertMemoryImageSelection(event: UnknownRecord, selection: MemoryImageSelection): void {
  const caller = userKey(event)
  if (!caller || caller === "unknown") throw new Error("无法识别当前用户，未读取绘图参考记忆。")
  if (!["self", "user", "users", "group", "all"].includes(selection.scope)) throw new Error("绘图记忆范围无效。")
  if (selection.scope !== "user" && selection.userId !== undefined) throw new Error("指定用户时请使用 user 范围，不能覆盖本人或群体身份。")
  if (selection.scope !== "users" && selection.userIds !== undefined) throw new Error("指定多个用户时请使用 users 范围，不能覆盖本人或群体身份。")
  if (selection.scope === "user" && !/^[a-zA-Z0-9_.:-]{1,100}$/u.test(String(selection.userId || ""))) throw new Error("请指定一位有效的记忆所属用户。")
  if (selection.scope === "users") {
    if (!Array.isArray(selection.userIds) || !selection.userIds.length || selection.userIds.some(id => !/^[a-zA-Z0-9_.:-]{1,100}$/u.test(String(id || "")))) throw new Error("请指定有效的记忆所属用户。")
    if (selection.userIds.length > MAX_MEMORY_IMAGE_USERS) throw new Error(`一次最多指定 ${MAX_MEMORY_IMAGE_USERS} 位成员的记忆作图。`)
  }
  const ownSelection = selection.scope === "self" || (selection.scope === "user" && selection.userId === caller)
    || (selection.scope === "users" && selection.userIds?.every(id => id === caller))
  if (!ownSelection && event.isMaster !== true) throw new Error("只有主人可以使用他人、本群成员或全部用户的全量记忆作图。")
  if (selection.scope === "group" && !groupKey(event)) throw new Error("使用本群成员记忆作图，请在对应群聊中提出请求。")
}
